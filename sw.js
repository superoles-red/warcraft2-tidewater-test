const BUILD = '0603f6b851cefe8e';
const SCOPE = new URL(self.registration.scope);
const PREFIX = 'tidewater-pilot:' + SCOPE.pathname + ':';
const CACHE = PREFIX + BUILD;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch(new URL('assets.json', SCOPE), {cache: 'no-store'});
    if (!response.ok) throw new Error('The Tidewater file list is unavailable');
    const manifest = await response.json();
    if (manifest.release !== BUILD) throw new Error('The Tidewater worker and file list do not match');
    const cache = await caches.open(CACHE);
    await cache.addAll(manifest.files.map(file =>
      new Request(new URL(file.path, SCOPE), {integrity: file.integrity})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const {request} = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== SCOPE.origin ||
      !url.pathname.startsWith(SCOPE.pathname) || request.headers.has('range')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = request.mode === 'navigate'
      ? await cache.match(new URL('index.html', SCOPE))
      : await cache.match(request, {ignoreSearch: true});
    return cached || fetch(request);
  })());
});
