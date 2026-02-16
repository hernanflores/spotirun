const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { parsePace } = require('./lib/pace-tempo');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const APP_BASE_URL = process.env.APP_BASE_URL;

if (!SPOTIFY_CLIENT_ID || !APP_BASE_URL) {
  console.error('Missing required env vars: SPOTIFY_CLIENT_ID and APP_BASE_URL');
  process.exit(1);
}

let APP_ORIGIN;
try {
  APP_ORIGIN = new URL(APP_BASE_URL).origin;
} catch {
  console.error('APP_BASE_URL must be an absolute URL, e.g. http://localhost:3000');
  process.exit(1);
}

const REDIRECT_URI = `${APP_ORIGIN}/callback`;
const SPOTIFY_ACCOUNTS_BASE = 'https://accounts.spotify.com';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

const SCOPES = ['playlist-modify-private', 'user-read-private', 'user-top-read'];
const MAX_SPOTIFY_RETRIES = 2;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const generatePlaylistRateLimiter = new Map();

const cookieBaseOptions = {
  sameSite: IS_PROD ? 'lax' : 'lax',
  secure: IS_PROD,
  path: '/'
};
const authCookieOptions = {
  ...cookieBaseOptions,
  httpOnly: true
};

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);

function makeRandomString(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

function setShortCookie(res, name, value, maxAgeMs) {
  res.cookie(name, value, {
    ...authCookieOptions,
    maxAge: maxAgeMs
  });
}

function clearAuthCookies(res) {
  const names = ['sp_state', 'sp_code_verifier', 'sp_access_token', 'sp_refresh_token'];
  for (const name of names) {
    res.clearCookie(name, {
      ...authCookieOptions,
      maxAge: 0
    });
  }
}

function safeEqualStrings(a, b) {
  const aBuf = Buffer.from(String(a), 'utf8');
  const bBuf = Buffer.from(String(b), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  const referer = req.get('referer');
  let requestOrigin = null;

  if (origin) {
    requestOrigin = origin;
  } else if (referer) {
    try {
      requestOrigin = new URL(referer).origin;
    } catch {
      return res.status(403).json({
        error: 'Invalid CSRF origin',
        user_message: 'Invalid request origin. Refresh and try again.'
      });
    }
  } else {
    return res.status(403).json({
      error: 'Missing CSRF origin',
      user_message: 'Missing request origin. Refresh and try again.'
    });
  }

  if (requestOrigin !== APP_ORIGIN) {
    return res.status(403).json({
      error: 'CSRF origin mismatch',
      user_message: 'Request origin mismatch. Please use this app directly.'
    });
  }

  next();
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim() !== '') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rateLimitGeneratePlaylist(req, res, next) {
  const now = Date.now();
  const clientIp = getClientIp(req);
  const bucket = generatePlaylistRateLimiter.get(clientIp);

  if (!bucket || now >= bucket.resetAt) {
    generatePlaylistRateLimiter.set(clientIp, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS
    });
    return next();
  }

  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
    res.set('Retry-After', String(Math.max(1, retryAfterSec)));
    return res.status(429).json({
      error: 'Rate limit exceeded',
      user_message: 'Too many playlist generation attempts. Please wait a minute and try again.'
    });
  }

  bucket.count += 1;
  next();
}

async function spotifyTokenRequest(params) {
  const body = new URLSearchParams(params);

  const resp = await fetch(`${SPOTIFY_ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Spotify token request failed: ${resp.status} ${text}`);
  }

  return resp.json();
}

class HttpError extends Error {
  constructor(status, message, userMessage) {
    super(message);
    this.status = status;
    this.userMessage = userMessage || 'Something went wrong.';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function spotifyApiRequest(accessToken, endpoint, options = {}, retryCount = 0) {
  const resp = await fetch(`${SPOTIFY_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (resp.ok) {
    if (resp.status === 204) return null;
    const text = await resp.text();
    return safeJsonParse(text) || {};
  }

  const rawBody = await resp.text();
  const body = safeJsonParse(rawBody);
  const spotifyMessage = body?.error?.message || body?.error_description || rawBody || 'Spotify request failed';

  if ((resp.status === 429 || resp.status >= 500) && retryCount < MAX_SPOTIFY_RETRIES) {
    const retryAfterSec = Number(resp.headers.get('retry-after'));
    const delayMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 400 * (retryCount + 1);
    await sleep(delayMs);
    return spotifyApiRequest(accessToken, endpoint, options, retryCount + 1);
  }

  if (resp.status === 429) {
    throw new HttpError(429, `Spotify rate limit: ${spotifyMessage}`, 'Spotify is rate-limiting requests. Please try again in a moment.');
  }

  if (resp.status >= 500) {
    throw new HttpError(502, `Spotify upstream error: ${spotifyMessage}`, 'Spotify is temporarily unavailable. Please retry.');
  }

  throw new HttpError(resp.status, `Spotify API ${endpoint} failed: ${spotifyMessage}`, spotifyMessage);
}

async function refreshAccessTokenIfNeeded(req, res) {
  let accessToken = req.cookies.sp_access_token;
  const refreshToken = req.cookies.sp_refresh_token;

  if (accessToken) {
    return accessToken;
  }

  if (!refreshToken) {
    return null;
  }

  const tokenData = await spotifyTokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: SPOTIFY_CLIENT_ID
  });

  const expiresInSec = Number(tokenData.expires_in || 3600);
  setShortCookie(res, 'sp_access_token', tokenData.access_token, expiresInSec * 1000);

  if (tokenData.refresh_token) {
    setShortCookie(res, 'sp_refresh_token', tokenData.refresh_token, 30 * 24 * 60 * 60 * 1000);
  }

  accessToken = tokenData.access_token;
  return accessToken;
}

function computeTargetDurationMs({ paceMinPerKm, distanceKm, durationMin }) {
  if (Number.isFinite(distanceKm) && distanceKm > 0 && Number.isFinite(paceMinPerKm) && paceMinPerKm > 0) {
    return distanceKm * paceMinPerKm * 60 * 1000;
  }

  if (Number.isFinite(durationMin) && durationMin > 0) {
    return durationMin * 60 * 1000;
  }

  return 45 * 60 * 1000;
}

function normalizeGeneratePayload(body) {
  const paceRaw = body?.pace;
  const distanceKmRaw = body?.distance_km ?? body?.distanceKm;
  const durationMinutesRaw = body?.duration_minutes ?? body?.durationMin;
  const explicitOkRaw = body?.explicit_ok;
  const pace = paceRaw == null ? '' : String(paceRaw).trim();

  const durationMinutes = durationMinutesRaw == null || durationMinutesRaw === '' ? NaN : Number(durationMinutesRaw);
  if (!Number.isNaN(durationMinutes) && (!Number.isFinite(durationMinutes) || durationMinutes <= 0)) {
    throw new HttpError(400, 'Invalid duration_minutes', 'duration_minutes must be a positive number.');
  }

  const distanceKm = distanceKmRaw == null || distanceKmRaw === '' ? NaN : Number(distanceKmRaw);
  if (!Number.isNaN(distanceKm) && (!Number.isFinite(distanceKm) || distanceKm <= 0)) {
    throw new HttpError(400, 'Invalid distance_km', 'distance_km must be a positive number.');
  }

  if (!Number.isNaN(distanceKm) && distanceKm > 0 && !pace) {
    throw new HttpError(400, 'Missing pace for distance', 'Pace is required when distance is provided.');
  }

  return {
    pace,
    durationMinutes,
    distanceKm,
    explicitOk: Boolean(explicitOkRaw)
  };
}

async function getUserTopTracks(accessToken, maxTracks = 100) {
  const tracks = [];
  const limit = 50;

  for (let offset = 0; offset < maxTracks; offset += limit) {
    const remaining = Math.min(limit, maxTracks - offset);
    const query = new URLSearchParams({
      limit: String(remaining),
      offset: String(offset),
      time_range: 'medium_term'
    });

    const data = await spotifyApiRequest(accessToken, `/me/top/tracks?${query.toString()}`);
    const items = data.items || [];
    tracks.push(...items);

    if (items.length < remaining) {
      break;
    }
  }

  return tracks;
}

function pickTracksForDuration(tracks, targetDurationMs) {
  const shuffled = [...tracks];
  shuffled.sort(() => Math.random() - 0.5);

  const selectedUris = [];
  let totalDuration = 0;
  let extraAfterTarget = 0;
  const maxExtraTracksAfterTarget = 2;
  let reachedTargetDuration = false;

  for (const track of shuffled) {
    selectedUris.push(track.uri);
    totalDuration += Number(track.duration_ms || 0);

    if (!reachedTargetDuration && totalDuration >= targetDurationMs) {
      reachedTargetDuration = true;
      continue;
    }

    if (reachedTargetDuration) {
      extraAfterTarget += 1;
      if (extraAfterTarget >= maxExtraTracksAfterTarget) {
        break;
      }
    }
  }

  return { selectedUris, totalDuration };
}

function sanitizeTopTrack(track) {
  return {
    id: track.id,
    name: track.name,
    artists: (track.artists || []).map((artist) => artist.name).filter(Boolean),
    explicit: Boolean(track.explicit),
    duration_ms: Number(track.duration_ms || 0),
    popularity: Number(track.popularity || 0),
    uri: track.uri,
    spotify_url: track.external_urls?.spotify || null
  };
}

app.get('/auth/login', (req, res) => {
  const state = makeRandomString(24);
  const codeVerifier = makeRandomString(64);
  const codeChallenge = sha256Base64Url(codeVerifier);

  setShortCookie(res, 'sp_state', state, 10 * 60 * 1000);
  setShortCookie(res, 'sp_code_verifier', codeVerifier, 10 * 60 * 1000);

  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SCOPES.join(' '),
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge
  });

  res.redirect(`${SPOTIFY_ACCOUNTS_BASE}/authorize?${authParams.toString()}`);
});

async function handleAuthCallback(req, res) {
  try {
    const { code, state } = req.query;
    const expectedState = req.cookies.sp_state;
    const codeVerifier = req.cookies.sp_code_verifier;

    if (!code || !state || !expectedState || !codeVerifier) {
      clearAuthCookies(res);
      return res.status(400).send('OAuth callback missing required values.');
    }

    if (!safeEqualStrings(state, expectedState)) {
      clearAuthCookies(res);
      return res.status(400).send('Invalid OAuth state.');
    }

    const tokenData = await spotifyTokenRequest({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
      client_id: SPOTIFY_CLIENT_ID
    });

    const expiresInSec = Number(tokenData.expires_in || 3600);
    setShortCookie(res, 'sp_access_token', tokenData.access_token, expiresInSec * 1000);

    if (tokenData.refresh_token) {
      setShortCookie(res, 'sp_refresh_token', tokenData.refresh_token, 30 * 24 * 60 * 60 * 1000);
    }

    res.clearCookie('sp_state', authCookieOptions);
    res.clearCookie('sp_code_verifier', authCookieOptions);

    return res.redirect('/app');
  } catch (err) {
    console.error(err);
    return res.status(500).send('Authentication failed.');
  }
}

app.get('/callback', handleAuthCallback);
app.get('/auth/callback', handleAuthCallback);

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    uptime_sec: Math.round(process.uptime()),
    env: NODE_ENV
  });
});

app.get('/api/session', async (req, res) => {
  try {
    const accessToken = await refreshAccessTokenIfNeeded(req, res);
    res.json({ connected: Boolean(accessToken) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ connected: false, error: 'Unable to verify session.' });
  }
});

app.get('/api/top-tracks', async (req, res) => {
  try {
    const accessToken = await refreshAccessTokenIfNeeded(req, res);
    if (!accessToken) {
      return res.status(401).json({
        error: 'Not authenticated with Spotify.',
        user_message: 'Connect Spotify before fetching top tracks.'
      });
    }

    const limitRaw = req.query.limit;
    const explicitRaw = req.query.explicit_ok;
    const limitNum = Number(limitRaw);
    const limit = Number.isFinite(limitNum) ? Math.max(1, Math.min(50, Math.trunc(limitNum))) : 20;
    const explicitOk = String(explicitRaw || '').toLowerCase() === 'true';

    const topTracks = await getUserTopTracks(accessToken, 100);
    const filtered = topTracks.filter((track) => {
      if (!track || !track.id || !track.uri) return false;
      if (!explicitOk && track.explicit) return false;
      return true;
    });

    const preview = filtered.slice(0, limit).map(sanitizeTopTrack);

    return res.json({
      source: 'top_tracks',
      total_available: filtered.length,
      returned: preview.length,
      explicit_ok: explicitOk,
      tracks: preview
    });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const userMessage = err instanceof HttpError ? err.userMessage : 'Failed to load top tracks.';
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`top-tracks error (${status}): ${errorMessage}`);
    return res.status(status).json({ error: errorMessage, user_message: userMessage });
  }
});

app.post('/api/logout', requireSameOrigin, (req, res) => {
  clearAuthCookies(res);
  res.status(204).send();
});

app.post('/api/generate-playlist', requireSameOrigin, rateLimitGeneratePlaylist, async (req, res) => {
  try {
    const accessToken = await refreshAccessTokenIfNeeded(req, res);
    if (!accessToken) {
      return res.status(401).json({ error: 'Not authenticated with Spotify.', user_message: 'Connect Spotify before generating a playlist.' });
    }

    const normalized = normalizeGeneratePayload(req.body || {});

    let paceMinPerKm = NaN;
    if (normalized.pace) {
      try {
        paceMinPerKm = parsePace(normalized.pace);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : 'Invalid pace', 'Invalid pace. Use formats like 5:30 or 5.5 min/km.');
      }
    }

    const targetDurationMs = computeTargetDurationMs({
      paceMinPerKm,
      distanceKm: normalized.distanceKm,
      durationMin: normalized.durationMinutes
    });

    const topTracks = await getUserTopTracks(accessToken, 100);
    const tracks = topTracks.filter((track) => {
      if (!track || !track.id || !track.uri) return false;
      if (!normalized.explicitOk && track.explicit) return false;
      return true;
    });

    const { selectedUris, totalDuration } = pickTracksForDuration(tracks, targetDurationMs);

    if (selectedUris.length === 0) {
      return res.status(404).json({
        error: 'No suitable favorite tracks found.',
        user_message: 'No favorite tracks matched your explicit-content setting. Try allowing explicit tracks.'
      });
    }

    const me = await spotifyApiRequest(accessToken, '/me');
    const durationMinutesRounded = Math.round(targetDurationMs / 60000);
    const playlistName = `Run Mix • ${durationMinutesRounded}min • Top Tracks`;
    const playlistDescription = 'Generated from your Spotify top tracks.';

    const playlist = await spotifyApiRequest(accessToken, `/users/${encodeURIComponent(me.id)}/playlists`, {
      method: 'POST',
      body: JSON.stringify({
        name: playlistName,
        description: playlistDescription,
        public: false
      })
    });

    for (let i = 0; i < selectedUris.length; i += 100) {
      const chunk = selectedUris.slice(i, i + 100);
      await spotifyApiRequest(accessToken, `/playlists/${playlist.id}/tracks`, {
        method: 'POST',
        body: JSON.stringify({ uris: chunk })
      });
    }

    return res.json({
      playlist_url: playlist.external_urls.spotify,
      playlist_id: playlist.id,
      stats: {
        tracks: selectedUris.length,
        minutes: Math.round(totalDuration / 60000),
        source: 'top_tracks'
      }
    });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const userMessage = err instanceof HttpError ? err.userMessage : 'Failed to generate playlist. Please try again.';
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(`generate-playlist error (${status}): ${errorMessage}`);
    res.status(status).json({ error: errorMessage, user_message: userMessage });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/done', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'done.html'));
});

app.listen(PORT, () => {
  console.log(`SpotiRun listening on ${APP_BASE_URL} (port ${PORT})`);
});
