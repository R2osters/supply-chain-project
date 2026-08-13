/**
 * Service worker for the driver's screen.
 *
 * Its job is narrow and worth stating precisely, because service workers attract claims they do
 * not deliver: this one makes the page *open* without a network, so a driver who reaches a depot
 * with no coverage can still start tracking. It does not track in the background. A service
 * worker has no access to geolocation, and Periodic Background Sync is Chrome-only, throttled to
 * roughly hourly, and useless for a moving truck. The offline queue in IndexedDB is what actually
 * bridges a coverage gap; this only removes the blank "no internet" page in front of it.
 *
 * Position uploads are deliberately never cached or replayed here. Duplicating a POST from a
 * stale cache would write positions the phone never took.
 */

const CACHE = 'scip-drive-v1';

// The pin, the manifest and the page itself. Next.js chunk names are content-hashed and change on
// every build, so they are picked up at runtime by the fetch handler instead of being listed.
const SHELL = ['/drive', '/icon-192.png', '/icon-512.png', '/drive.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one 404 during development does not fail the whole install and leave
      // the worker permanently unregistered.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never serve an API response from cache. A cached fleet position is a truck shown somewhere it
  // is not, which is worse than an error.
  if (url.pathname.includes('/api/')) return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // A navigation with nothing cached for that exact URL still gets the driver screen,
        // which is the only page in this scope.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/drive');
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
