const CACHE = 'macro-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Never cache API data — always go to network.
  const apiHosts = ['stlouisfed.org', 'finnhub.io', 'cnn.io', 'allorigins.win', 'corsproxy.io', 'codetabs.com'];
  if (apiHosts.some(h => url.hostname.includes(h))) {
    return; // default fetch behavior
  }

  // App shell: cache-first
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(cached =>
        cached || fetch(req).then(r => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return r;
        }).catch(() => cached)
      )
    );
  }
});
