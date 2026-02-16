const params = new URLSearchParams(window.location.search);
const url = params.get('url');
const tracks = params.get('tracks');
const minutes = params.get('minutes');

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
if (tracks) parts.push(`Tracks selected: ${tracks}.`);
if (minutes) parts.push(`Approx length: ${minutes} minutes.`);
message.textContent = parts.join(' ');

backBtn.addEventListener('click', () => {
  window.location.href = '/app';
});
