// Service worker — caches the app shell so the PWA launches offline.
// Data is NEVER cached: /api/* is always network-only (the DB is the source
// of truth). Bump CACHE_VERSION when the shell file list changes.

const CACHE_VERSION = 'ft-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // POST/PUT/DELETE always hit the network

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // ignore cross-origin

  // API: always network-only, never cached. The CSV export is a real download,
  // so let it fail natively when offline (a synthetic JSON body would masquerade
  // as a .csv); everything else gets a JSON 503 the app understands.
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/export.csv') return;
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(JSON.stringify({ error: 'offline', offline: true }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    return;
  }

  // App shell + code (navigations, app.js, styles.css): network-first so fresh
  // logic always wins when online, but fall back to cache after a short timeout
  // so a slow / lossy / captive-portal launch is still instant from cache.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, '/index.html'));
    return;
  }
  if (url.pathname === '/app.js' || url.pathname === '/styles.css') {
    event.respondWith(networkFirst(request, null));
    return;
  }

  // Other static assets (icons, manifest): stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

// Race the network against the cached copy: use the network when it returns a
// good response promptly, otherwise serve cache (offline OR slow network).
function networkFirst(request, fallbackKey) {
  const cached = caches.match(fallbackKey || request);
  return Promise.race([
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, copy));
          return res;
        }
        return null;
      })
      .catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
  ]).then((res) => res || cached.then((c) => c || fetch(request)));
}
