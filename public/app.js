const form = document.getElementById('playlistForm');
const submitBtn = document.getElementById('submitBtn');
const logoutBtn = document.getElementById('logoutBtn');
const errorEl = document.getElementById('error');
const paceEl = document.getElementById('pace');
const durationEl = document.getElementById('durationMin');
const distanceEl = document.getElementById('distanceKm');
const explicitOkEl = document.getElementById('explicitOk');

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

distanceEl.addEventListener('input', syncDurationDistanceHint);
durationEl.addEventListener('input', syncDurationDistanceHint);
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
    explicit_ok: explicitOkEl.checked
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
      tracks: String(data.stats.tracks || ''),
      minutes: String(data.stats.minutes || '')
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
