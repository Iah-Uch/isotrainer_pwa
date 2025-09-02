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

// No 'fetch' handler: allow default browser network behavior with server cache headers.

// Keep message handler to allow future 'skipWaiting' triggers if needed.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
