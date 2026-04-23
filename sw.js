const CACHE = 'macro-v3';
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

  const skipHosts = [
    'stlouisfed.org', 'finnhub.io', 'cnn.io',
    'allorigins.win', 'corsproxy.io', 'codetabs.com',
    'cors.eu.org', 'proxy.cors.sh', 'thingproxy.freeboard.io',
    'proxy.corsfix.com', 'api.cors.lol',
    'stooq.com', 'query1.finance.yahoo.com', 'query2.finance.yahoo.com',
    'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
    'fonts.googleapis.com', 'fonts.gstatic.com',
  ];
  if (skipHosts.some(h => url.hostname.includes(h))) {
    return;
  }

  // App shell: NETWORK-FIRST — always try fresh first
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req).then(r => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return r;
      }).catch(() => caches.match(req))
    );
  }
});
