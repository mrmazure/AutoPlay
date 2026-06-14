const CACHE = 'radiobox-autoplay-v6';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/manifest.json',
  '/favicon.png',
  '/rt_logo_head.png',
  '/js/main.js',
  '/js/player.js',
  '/js/queue.js',
  '/js/ui.js',
  '/js/waveform.js',
  '/js/audio-output.js',
  '/js/mix-editor.js',
  '/js/playlist-io.js',
  '/js/fs-access.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Stratégie « réseau d'abord » : on sert toujours la dernière version en ligne,
// et le cache ne sert que de secours quand l'internaute est hors-ligne.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // On garde une copie fraîche (même origine uniquement) pour l'offline.
        if (new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
