# SpotiRun

> **Archived:** This project is no longer under active development.

## Why This Project Was Archived

SpotiRun was intended to build running playlists whose song tempo and energy
matched a runner's pace. That is no longer practical using only Spotify's Web
API.

Spotify deprecated its Audio Features and Recommendations endpoints and
restricted them for development-mode applications and new Web API use cases.
Those endpoints supplied per-track tempo and energy data and allowed
recommendations to be filtered by attributes such as `target_tempo` and
`target_energy`. Spotify's supported Search API cannot query or filter tracks
by either attribute.

The implementation in this repository therefore does not match songs to a
runner's pace. It uses pace and distance only to calculate the desired playlist
duration, then randomly selects songs from the user's Spotify top tracks until
that duration is reached. The local cadence and target-tempo utilities are not
connected to Spotify track selection.

Implementing the original concept now requires a separate, appropriately
licensed source of BPM and energy metadata, plus a reliable way to map that
catalogue to Spotify tracks. That would no longer be a Spotify-only application
and would materially increase its operational and licensing complexity, so the
project has been archived. The documentation below is retained for historical
reference.

Minimal Node 20 + Express + vanilla JS app that generates a Spotify running playlist from pace (min/km).

## Architecture Summary

- Client (`public/*.html`, `public/*.js`)
  - Plain HTML + vanilla JS only.
  - Sends form data to `/api/generate-playlist`.
  - No `localStorage` / `sessionStorage`; state is in-memory only.
- Server (`server.js`)
  - Spotify OAuth Authorization Code with PKCE.
  - Keeps OAuth state, PKCE verifier, access token, and refresh token only in HTTP-only cookies.
  - Calls Spotify Web API to fetch user's top tracks, create playlist, and add tracks.

## OAuth Scopes (Minimum)

- `playlist-modify-private`
  - Create private playlists and add tracks.
- `user-read-private`
  - Read `/me` to get the Spotify user ID for playlist creation endpoint.
- `user-top-read`
  - Read `/me/top/tracks` to build playlist from user's favorites.

## Endpoints

- `GET /` - Landing page.
- `GET /app` - Playlist form page.
- `GET /done` - Result page.
- `GET /auth/login` - Start Spotify OAuth PKCE flow.
- `GET /callback` - OAuth callback (registered in Spotify Dashboard).
- `GET /auth/callback` - Backward-compatible alias to callback.
- `GET /api/session` - Session/auth check.
- `GET /api/top-tracks` - Debug preview of favorite tracks used for playlist generation.
- `POST /api/generate-playlist` - Create playlist from user's top tracks (duration/distance aware).
- `POST /api/logout` - Clear auth cookies.
- `GET /health` - Liveness endpoint.

## Setup

1. Create a Spotify app in the Spotify Developer Dashboard.
2. Configure Redirect URIs:
   - Local: `http://localhost:3000/callback`
   - Production: `https://<domain>/callback`
3. Create `.env` from `.env.example`.
4. Install and run:

```bash
npm install
npm run dev
```

## Environment Variables

- `SPOTIFY_CLIENT_ID` (required)
- `APP_BASE_URL` (required), example: `http://localhost:3000`
- `PORT` (optional, default `3000`)
- `NODE_ENV` (optional, use `production` in prod)

## Security Safeguards Implemented

- PKCE + OAuth state:
  - `sp_code_verifier` and `sp_state` stored in HTTP-only cookies with short TTL (10 min).
  - State is validated on callback with timing-safe compare.
- Token handling:
  - Access and refresh tokens are only in HTTP-only cookies.
  - No token persistence in browser storage or database.
  - Tokens are never logged.
- Cookie flags (dev vs prod):
  - `httpOnly: true` for auth/session cookies.
  - `sameSite: 'lax'`.
  - `secure: false` in dev, `secure: true` in production (`NODE_ENV=production`).
- CSRF protection for state-changing endpoints:
  - `POST /api/generate-playlist` and `POST /api/logout` require same-origin `Origin`/`Referer` checks.
- Rate limiting:
  - In-memory limiter on `POST /api/generate-playlist` (10 requests/min per IP).
- Upstream resilience:
  - Spotify API retries for transient errors (429/5xx), max 2 retries.

## Debugging Top Tracks

- Endpoint: `GET /api/top-tracks`
- Query params:
  - `limit` (optional, `1..50`, default `20`)
  - `explicit_ok` (optional, `true|false`, default `false`)
- Example:

```bash
curl -s "http://localhost:3000/api/top-tracks?limit=10&explicit_ok=true"
```

## Deploy

### Production Checklist

- Use HTTPS end-to-end and set `NODE_ENV=production`.
- Set `APP_BASE_URL` to your public origin (no trailing path), e.g. `https://run.example.com`.
- Register Spotify Redirect URI exactly as `https://run.example.com/callback`.
- Ensure reverse proxy forwards `X-Forwarded-For` (used for rate limiting).
- Keep app stateless; do not add token persistence.
- Monitor `GET /health` with your platform health checks.

### Example Production Env

```dotenv
SPOTIFY_CLIENT_ID=your_client_id
APP_BASE_URL=https://your-domain.com
NODE_ENV=production
PORT=3000
```

## Common OAuth Pitfalls (And How This App Avoids Them)

- Redirect URI mismatch
  - Pitfall: Spotify rejects callback if URI doesn’t match exactly.
  - Mitigation: app uses `APP_BASE_URL + /callback`; README provides exact local/prod values.
- Missing/weak CSRF state validation
  - Pitfall: login CSRF/account mix-up.
  - Mitigation: random `state` cookie, validated on callback before token exchange.
- PKCE verifier loss
  - Pitfall: code exchange fails if verifier is not retained.
  - Mitigation: short-lived HTTP-only cookie stores verifier during OAuth round-trip.
- Token exposure in browser storage/logs
  - Pitfall: token theft through XSS or logs.
  - Mitigation: HTTP-only cookies only; no local/session storage; no token logging.
- CSRF on cookie-authenticated POST endpoints
  - Pitfall: third-party site triggers authenticated actions.
  - Mitigation: strict same-origin checks for POST API endpoints.
