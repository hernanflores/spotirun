const params = new URLSearchParams(window.location.search);
const url = params.get('url');
const cadence = params.get('cadence');
const bpm = params.get('bpm');
const mode = params.get('mode');
const tracks = params.get('tracks');

const link = document.getElementById('playlistLink');
const message = document.getElementById('message');
const backBtn = document.getElementById('backBtn');

if (!url) {
  link.textContent = 'Missing playlist URL';
  link.removeAttribute('href');
} else {
  link.href = url;
}

const parts = [];
if (cadence) parts.push(`Cadence estimate: ${cadence} SPM.`);
if (bpm) parts.push(`Target tempo: ${bpm} BPM${mode === 'half_time' ? ' (half-time)' : ''}.`);
if (tracks) parts.push(`Tracks selected: ${tracks}.`);
message.textContent = parts.join(' ');

backBtn.addEventListener('click', () => {
  window.location.href = '/app';
});
