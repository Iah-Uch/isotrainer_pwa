/* Service worker with stale-while-revalidate for fast loads + auto updates */
const CACHE_NAME = 'cardiomax-pwa-v3';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/app.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
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
    await self.clients.claim();
  })());
});

// Stale-while-revalidate for all GET requests
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Only handle same-origin requests. Let the browser fetch cross-origin
  // resources (e.g., CDN scripts/workers, camera streams) directly to avoid
  // CORS/opaque caching issues that can break things like qr-scanner workers.
  const reqUrl = new URL(request.url);
  if (reqUrl.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    const networkFetch = fetch(request).then(async (res) => {
      if (res && res.ok) await cache.put(request, res.clone());
      return res;
    }).catch(() => undefined);

    // Return cached immediately if present; else fall back to network
    if (cached) {
      // Trigger update in background
      event.waitUntil(networkFetch);
      return cached;
    }
    // No cache: try network, then offline fallbacks
    const res = await networkFetch;
    if (res) return res;
    if (request.mode === 'navigate') return cache.match('/app.html') || cache.match('/index.html');
    return new Response('', { status: 504, statusText: 'Offline' });
  })());
});

// Allow page to trigger immediate activation
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
