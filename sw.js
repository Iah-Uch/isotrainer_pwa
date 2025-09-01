/* Simple service worker for PWA caching */
const CACHE_NAME = 'cardiomax-pwa-v2';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/js/main.js',
  '/js/session.js',
  '/js/charts.js',
  '/js/state.js',
  '/js/utils.js',
  '/js/ble.js',
  '/js/ui-fab.js',
  '/js/qr.js',
  '/js/pwa.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE_ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Network-first for HTML to get latest shell
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try { return await fetch(request); }
        catch { return await caches.match('/index.html'); }
      })()
    );
    return;
  }
  // Cache-first for static assets
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});

// Optional: listen for skip waiting
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
