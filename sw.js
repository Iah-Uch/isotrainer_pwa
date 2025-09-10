/* Network-only Service Worker: no caching. Always fetch latest from network.
   Also clears any existing caches on install/activate. */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Clear all existing caches from previous SW versions
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Double ensure caches are empty on activation
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Fetch: always bypass HTTP cache and avoid storing
self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only handle same-origin GET requests; leave others alone
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const u = new URL(request.url);
      // Add a short-lived cache-busting param to ensure fresh fetches
      u.searchParams.set('_sw_nocache', Date.now().toString());
      const req = new Request(u.toString(), {
        method: 'GET',
        headers: request.headers,
        cache: 'no-store',
        credentials: request.credentials,
        redirect: request.redirect,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        mode: request.mode,
        integrity: request.integrity,
      });
      const res = await fetch(req);
      // Return as-is (headers may still include server caching, but SW bypassed storing)
      return res;
    } catch (err) {
      // If network fails, let the request fall back (may still  fail)
      return fetch(request, { cache: 'no-store' });
    }
  })());
});

// Keep message handler to allow future 'skipWaiting' triggers if needed.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
