const form = document.getElementById('playlistForm');
const submitBtn = document.getElementById('submitBtn');
const logoutBtn = document.getElementById('logoutBtn');
const errorEl = document.getElementById('error');
const paceEl = document.getElementById('pace');
const durationEl = document.getElementById('durationMin');
const distanceEl = document.getElementById('distanceKm');
const energyEl = document.getElementById('energyLevel');
const energyTextEl = document.getElementById('energyText');
const halfTimeFeelEl = document.getElementById('halfTimeFeel');
const explicitOkEl = document.getElementById('explicitOk');
const previewTextEl = document.getElementById('previewText');

const ENERGY_LABELS = {
  1: 'easy',
  2: 'steady',
  3: 'balanced',
  4: 'hard',
  5: 'very hard'
};

function parsePaceInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (raw.includes(':')) {
    const parts = raw.split(':');
    if (parts.length !== 2) return null;
    const min = Number(parts[0]);
    const sec = Number(parts[1]);
    if (!Number.isFinite(min) || !Number.isFinite(sec) || min <= 0 || sec < 0 || sec >= 60) return null;
    return min + sec / 60;
  }

  const decimal = Number(raw);
  if (!Number.isFinite(decimal) || decimal <= 0) return null;
  return decimal;
}

function estimateCadence(pace) {
  if (!Number.isFinite(pace)) return null;
  if (pace <= 4.25) return 182;
  if (pace <= 4.75) return 178;
  if (pace <= 5.25) return 174;
  if (pace <= 5.75) return 170;
  if (pace <= 6.25) return 166;
  if (pace <= 6.75) return 162;
  if (pace <= 7.5) return 158;
  return 154;
}

function targetTempo(cadence, halfTime) {
  if (!Number.isFinite(cadence)) return null;
  return halfTime ? Math.round(cadence / 2) : cadence;
}

function updatePreview() {
  const pace = parsePaceInput(paceEl.value);
  const cadence = estimateCadence(pace);
  const tempo = targetTempo(cadence, halfTimeFeelEl.checked);

  if (!pace || !cadence || !tempo) {
    previewTextEl.textContent = 'Enter a valid pace (e.g. 5:30 or 5.5) to see cadence and BPM.';
    return;
  }

  previewTextEl.textContent = `Cadence estimate: ${cadence} SPM. Target tempo: ${tempo} BPM${halfTimeFeelEl.checked ? ' (half-time)' : ''}.`;
}

function updateEnergyText() {
  const value = Number(energyEl.value);
  const label = ENERGY_LABELS[value] || 'balanced';
  energyTextEl.textContent = `Energy: ${value} (${label})`;
}

function syncDurationDistanceHint() {
  const hasDistance = Boolean(distanceEl.value);
  const hasDuration = Boolean(durationEl.value);

  if (hasDistance) {
    durationEl.disabled = true;
    durationEl.classList.add('muted-input');
    return;
  }

  durationEl.disabled = false;
  durationEl.classList.remove('muted-input');

  if (hasDuration) {
    distanceEl.disabled = true;
    distanceEl.classList.add('muted-input');
    return;
  }

  distanceEl.disabled = false;
  distanceEl.classList.remove('muted-input');
}

async function checkSession() {
  const resp = await fetch('/api/session');
  if (!resp.ok) {
    throw new Error('Unable to validate Spotify session.');
  }

  const data = await resp.json();
  if (!data.connected) {
    window.location.href = '/';
  }
}

checkSession().catch((err) => {
  errorEl.textContent = err.message;
});

paceEl.addEventListener('input', updatePreview);
halfTimeFeelEl.addEventListener('change', updatePreview);
energyEl.addEventListener('input', updateEnergyText);
distanceEl.addEventListener('input', syncDurationDistanceHint);
durationEl.addEventListener('input', syncDurationDistanceHint);
updatePreview();
updateEnergyText();
syncDurationDistanceHint();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Generating...';

  const payload = {
    pace: document.getElementById('pace').value.trim(),
    distance_km: document.getElementById('distanceKm').value || undefined,
    duration_minutes: document.getElementById('durationMin').value || undefined,
    energy: Number(energyEl.value),
    explicit_ok: explicitOkEl.checked,
    feel: halfTimeFeelEl.checked ? 'half_time' : 'step'
  };

  try {
    const resp = await fetch('/api/generate-playlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.user_message || data.error || 'Failed to generate playlist.');
    }

    const params = new URLSearchParams({
      url: data.playlist_url,
      cadence: String(data.stats.cadenceSpm || ''),
      bpm: String(data.stats.tempo || ''),
      mode: payload.feel,
      tracks: String(data.stats.tracks || '')
    });

    window.location.href = `/done?${params.toString()}`;
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Generate Playlist';
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
});
