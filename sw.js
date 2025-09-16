/* Service Worker: network-only. Fetch latest from network and clear caches on install/activate. */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Clear caches from previous SW versions.
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Ensure caches are empty on activation.
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Fetch: always bypass HTTP cache and avoid storing.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only handle same-origin GET requests; ignore others.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const u = new URL(request.url);
      // Add a short-lived cache-busting param to ensure fresh fetches.
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
      // Return as-is (server headers may still include caching; SW bypasses storing).
      return res;
    } catch (err) {
      // If network fails, let the request fall back (may still fail).
      return fetch(request, { cache: 'no-store' });
    }
  })());
});

// Allow future 'skipWaiting' triggers if needed.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
