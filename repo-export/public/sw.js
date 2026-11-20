// App-shell cache only. No offline write queue on purpose (out of scope) -- writes just fail
// clearly with "no connection" when offline (see api.js). This only makes the shell load fast
// and tolerates brief offline moments for re-reading data already fetched this session.
const CACHE = 'crm-shell-v1';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/api.js', '/constants.js',
  '/views/rep.js', '/views/manager.js', '/manifest.json',
  '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never cache/intercept writes
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return; // always go to the network for data

  // App shell: cache-first, falling back to network, so launch is instant and brief offline
  // moments don't block showing the UI the person already loaded.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) caches.open(CACHE).then((cache) => cache.put(request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
