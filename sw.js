const BUILD = '6e19f46678ea1d76';
const SCOPE = new URL(self.registration.scope);
const PREFIX = 'tidewater-pilot:' + SCOPE.pathname + ':';
const CACHE = PREFIX + BUILD;
const LIST = new URL('assets.json', SCOPE);
const ENTRY = new URL('index.html', SCOPE);
let manifest;

async function getManifest(cache) {
  manifest ??= await (await cache.match(LIST))?.json();
  return manifest;
}

async function mediaRange(response, range) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const body = await response.blob();
  const size = body.size;
  const start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Range': start > end ? 'bytes */' + size : 'bytes ' + start + '-' + end + '/' + size,
  });
  if (start > end) return new Response(null, {status: 416, headers});
  headers.set('Content-Type', body.type || 'application/octet-stream');
  headers.set('Content-Length', end - start + 1);
  return new Response(body.slice(start, end + 1), {status: 206, headers});
}

async function downloadOptional(cache, url, catalog) {
  const file = catalog?.optional?.find(entry => url.pathname === new URL(entry.path, SCOPE).pathname);
  if (!file) return null;
  const target = new URL(file.path, SCOPE);
  let response;
  try { response = await fetch(new Request(target, {integrity: file.integrity, cache: 'reload'})); }
  catch { return new Response(null, {status: 503}); }
  if (response.ok) {
    try { await cache.put(target, response.clone()); } catch {}
  }
  return response;
}

async function previousRelease() {
  for (const key of (await caches.keys()).reverse()) {
    if (!key.startsWith(PREFIX) || key === CACHE || key.startsWith(PREFIX + 'language:')) continue;
    const candidate = await caches.open(key);
    const list = await candidate.match(LIST);
    if (list) return {cache:candidate, catalog:await list.json()};
  }
  return {cache:null, catalog:null};
}

async function cacheFiles(cache, files, previous, oldFiles = []) {
  const integrity = new Map(oldFiles.map(file => [file.path, file.integrity]));
  for (let offset = 0; offset < files.length; offset += 24) {
    const batch = files.slice(offset, offset + 24);
    const requests = await Promise.all(batch.map(async file => {
      const url = new URL(file.path, SCOPE);
      if (integrity.get(file.path) === file.integrity) {
        const existing = await previous?.match(url);
        if (existing) {
          await cache.put(url, existing);
          return null;
        }
      }
      return new Request(url, {integrity: file.integrity, cache: 'reload'});
    }));
    await cache.addAll(requests.filter(Boolean));
  }
}

async function prepareCore(cache, catalog, {cache:previous, catalog:previousList}) {
  await cacheFiles(cache, catalog.files, previous, previousList?.files);
  const optional = new Map((previousList?.optional ?? []).map(file => [file.path, file.integrity]));
  if (previous) {
    for (const file of catalog.optional ?? []) {
      if (optional.get(file.path) !== file.integrity) continue;
      const url = new URL(file.path, SCOPE);
      const existing = await previous.match(url);
      if (existing) await cache.put(url, existing);
    }
  }
}

async function prepareLanguages(previous, catalog) {
  for (const [code, pack] of Object.entries(catalog.localePacks ?? {})) {
    const oldPack = previous?.localePacks?.[code];
    if (!oldPack || oldPack.release === pack.release) continue;
    const prefix = PREFIX + 'language:' + code + ':';
    const oldKey = prefix + oldPack.release;
    const newKey = prefix + pack.release;
    const flag = new URL('art/lang/' + code + '/.installed', SCOPE);
    if (!await caches.match(flag, {cacheName:oldKey}) || await caches.match(flag, {cacheName:newKey})) continue;
    const oldCache = await caches.open(oldKey);
    const newCache = await caches.open(newKey);
    try {
      await cacheFiles(newCache, pack.files, oldCache, oldPack.files);
      if (await caches.match(flag, {cacheName:oldKey})) await newCache.put(flag, new Response('ready'));
      else await caches.delete(newKey);
    } catch (error) {
      await caches.delete(newKey);
      throw error;
    }
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const response = await fetch(LIST, {cache: 'no-store'});
    if (!response.ok) throw new Error('The Tidewater file list is unavailable');
    const catalog = await response.clone().json();
    if (catalog.release !== BUILD) throw new Error('The Tidewater worker and file list do not match');
    const cache = await caches.open(CACHE);
    try {
      const previous = await previousRelease();
      await prepareCore(cache, catalog, previous);
      await prepareLanguages(previous.catalog, catalog);
      await cache.put(LIST, response);
      // Previously installed pages expect the replacement to activate on its own.
      if (!self.registration.active || !previous.catalog?.updateProtocol) await self.skipWaiting();
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
});

function menuReady(client) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => finish(false), 800);
    function finish(ready) {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(ready);
    }
    channel.port1.onmessage = event => finish(event.data === true);
    try { client.postMessage('tidewater:check-menu', [channel.port2]); }
    catch { finish(false); }
  });
}

async function allWindowsAtMenu() {
  const clients = (await self.clients.matchAll({type:'window', includeUncontrolled:true})).filter(client => {
    const url = new URL(client.url);
    return url.pathname === SCOPE.pathname || url.pathname === ENTRY.pathname;
  });
  return (await Promise.all(clients.map(menuReady))).every(Boolean);
}

let activation;
self.addEventListener('message', event => {
  if (event.data !== 'tidewater:apply-update' || !event.ports[0]) return;
  activation ??= (async () => {
    if (!await allWindowsAtMenu()) return false;
    const previous = await previousRelease();
    await prepareLanguages(previous.catalog, await getManifest(await caches.open(CACHE)));
    if (!await allWindowsAtMenu()) return false;
    await self.skipWaiting();
    return true;
  })().catch(() => false).finally(() => { activation = undefined; });
  event.waitUntil(activation.then(ready => event.ports[0].postMessage(ready)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE &&
        !key.startsWith(PREFIX + 'language:'))
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const {request} = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== SCOPE.origin ||
      !url.pathname.startsWith(SCOPE.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (request.mode === 'navigate' && (url.pathname === SCOPE.pathname || url.pathname === ENTRY.pathname)) {
      return (await cache.match(ENTRY)) || fetch(request);
    }
    let response = await cache.match(url, {ignoreSearch: true});
    if (!response) {
      const code = /^art\/lang\/([^/]+)\//.exec(url.pathname.slice(SCOPE.pathname.length))?.[1];
      const catalog = await getManifest(cache);
      const pack = code && catalog?.localePacks?.[code];
      if (pack) {
        response = await caches.match(url, {cacheName: PREFIX + 'language:' + code + ':' + pack.release});
      } else {
        response = await downloadOptional(cache, url, catalog);
      }
    }
    if (!response) return fetch(request);
    const range = request.headers.get('range');
    return range && response.ok ? (await mediaRange(response, range)) || fetch(request) : response;
  })());
});
