const manifestUrl = new URL('./assets.json', import.meta.url);
const scopePath = new URL('./', import.meta.url).pathname;
const languagePrefix = code => 'tidewater-pilot:' + scopePath + ':language:' + code + ':';
const languageCache = (code, pack) => languagePrefix(code) + pack.release;
const installedFlag = code => new URL('./art/lang/' + code + '/.installed', import.meta.url);
const languageDownloads = new Map();
let manifest;
let registration;

async function getPack(code) {
  manifest ??= fetch(manifestUrl).then(response => {
    if (!response.ok) throw new Error('Language file list is unavailable');
    return response.json();
  }).catch(error => {
    manifest = undefined;
    throw error;
  });
  return (await manifest).localePacks?.[code];
}

async function languagePack(code) {
  const pack = await getPack(code);
  if (!pack) return null;
  const installed = Boolean(await caches.match(installedFlag(code), {cacheName: languageCache(code, pack)}));
  return {bytes: pack.bytes, installed};
}

async function installLanguage(code) {
  if (languageDownloads.has(code)) return languageDownloads.get(code);
  const download = (async () => {
    const pack = await getPack(code);
    if (!pack) throw new Error('Language pack is unavailable');
    const cache = await caches.open(languageCache(code, pack));
    if (await cache.match(installedFlag(code))) return;
    await cache.addAll(pack.files.map(file => new Request(new URL(file.path, manifestUrl), {
      integrity: file.integrity, cache: 'reload',
    })));
    await cache.put(installedFlag(code), new Response('ready'));
  })();
  languageDownloads.set(code, download);
  try { await download; } finally { languageDownloads.delete(code); }
}

async function deleteLanguage(code) {
  await languageDownloads.get(code)?.catch(() => {});
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith(languagePrefix(code))).map(key => caches.delete(key)));
}

async function checkForUpdate() {
  try {
    const service = navigator.serviceWorker;
    const current = service.controller;
    const worker = await registration;
    if (!worker || !current) return 'unavailable';
    await worker.update();
    if (service.controller === current) {
      const next = worker.installing || worker.waiting;
      if (!next) return 'current';
      const activated = await new Promise(resolve => {
        const timeout = setTimeout(() => finish(false), 90000);
        function finish(result) {
          clearTimeout(timeout);
          next.removeEventListener('statechange', check);
          service.removeEventListener('controllerchange', check);
          resolve(result);
        }
        function check() {
          if (service.controller !== current) finish(true);
          else if (next.state === 'redundant') finish(false);
        }
        next.addEventListener('statechange', check);
        service.addEventListener('controllerchange', check);
        check();
      });
      if (!activated) return 'unavailable';
    }
    location.reload();
    return 'updated';
  } catch { return 'unavailable'; }
}

window.TidewaterOffline = Object.freeze({languagePack, installLanguage, deleteLanguage, checkForUpdate});

if ('serviceWorker' in navigator) {
  registration = navigator.serviceWorker.register('./sw.js', {updateViaCache: 'none'});
  registration.then(() => navigator.serviceWorker.ready)
    .then(() => {
      document.documentElement.dataset.offline = 'ready';
      window.dispatchEvent(new Event('tidewater:offline-ready'));
    })
    .catch(() => { document.documentElement.dataset.offline = 'unavailable'; });
}
