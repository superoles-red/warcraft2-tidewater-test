const manifestUrl = new URL('./assets.json', import.meta.url);
const scopePath = new URL('./', import.meta.url).pathname;
const languagePrefix = code => 'tidewater-pilot:' + scopePath + ':language:' + code + ':';
const languageCache = (code, pack) => languagePrefix(code) + pack.release;
const installedFlag = code => new URL('./art/lang/' + code + '/.installed', import.meta.url);
const languageDownloads = new Map();
let manifest;
let registration;
const service = navigator.serviceWorker;
let pageController = service?.controller;
let checking;
let reloading = false;
let lastCheck = -Infinity;
let titleTimer;

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

function atMainMenu() {
  const front = document.getElementById('front');
  const dialog = document.getElementById('modal');
  return front && !front.hidden && front.dataset.screen === 'main' &&
    (!dialog?.open || dialog.dataset.layout === 'update');
}

function reloadUpdatedPage() {
  const previous = pageController;
  pageController ??= service.controller;
  if (!previous || !service.controller || service.controller === previous) return false;
  if (!reloading && !document.hidden && atMainMenu()) {
    reloading = true;
    location.reload();
  }
  return true;
}

function waitForWorker(next, done) {
  return new Promise(resolve => {
    const timeout = setTimeout(() => finish(false), 90000);
    function finish(result) {
      clearTimeout(timeout);
      next.removeEventListener('statechange', check);
      service.removeEventListener('controllerchange', check);
      resolve(result);
    }
    function check() {
      if (done()) finish(true);
      else if (next.state === 'redundant') finish(false);
    }
    next.addEventListener('statechange', check);
    service.addEventListener('controllerchange', check);
    check();
  });
}

function askToActivate(next) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => finish(false), 2000);
    function finish(accepted) {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(accepted);
    }
    channel.port1.onmessage = event => finish(event.data === true);
    next.postMessage('tidewater:apply-update', [channel.port2]);
  });
}

async function prepareUpdate(automatic) {
  const worker = await registration;
  const current = service?.controller;
  if (!worker || !current) return 'unavailable';
  if (reloadUpdatedPage()) return 'updated';
  if (!worker.waiting && !worker.installing) {
    if (!navigator.onLine) return 'unavailable';
    if (automatic && performance.now() - lastCheck < 30000) return 'current';
    lastCheck = performance.now();
    await worker.update();
  }

  const next = worker.installing || worker.waiting;
  if (!next) return reloadUpdatedPage() ? 'updated' : 'current';
  const loaded = await waitForWorker(next, () => ['installed','activating','activated'].includes(next.state));
  if (!loaded) return 'unavailable';
  if (service.controller !== current) return reloadUpdatedPage() ? 'updated' : 'current';
  if (!atMainMenu()) return 'deferred';
  if (next.state === 'installed' && !await askToActivate(next)) {
    return reloadUpdatedPage() ? 'updated' : 'deferred';
  }
  const applied = await waitForWorker(next, () => service.controller !== current);
  return applied && reloadUpdatedPage() ? 'updated' : 'unavailable';
}

function checkForUpdate(automatic = false) {
  checking ??= prepareUpdate(automatic).catch(() => 'unavailable').finally(() => { checking = undefined; });
  return checking;
}

function autoUpdate() {
  clearTimeout(titleTimer);
  if (!document.hidden && atMainMenu()) {
    checkForUpdate(true);
    titleTimer = setTimeout(autoUpdate, 60000);
  }
}

window.TidewaterOffline = Object.freeze({languagePack, installLanguage, deleteLanguage, checkForUpdate});

if (service) {
  registration = service.register('./sw.js', {updateViaCache: 'none'});
  service.addEventListener('controllerchange', () => {
    if (!reloadUpdatedPage()) autoUpdate();
  });
  service.addEventListener('message', event => {
    if (event.data === 'tidewater:check-menu' &&
        event.source?.scriptURL === new URL('./sw.js', import.meta.url).href) {
      event.ports[0]?.postMessage(atMainMenu());
    }
  });
  window.addEventListener('tidewater:home', autoUpdate);
  window.addEventListener('pageshow', autoUpdate);
  window.addEventListener('online', () => { lastCheck = -Infinity; autoUpdate(); });
  document.addEventListener('visibilitychange', autoUpdate);
  registration.then(() => service.ready)
    .then(() => {
      document.documentElement.dataset.offline = 'ready';
      window.dispatchEvent(new Event('tidewater:offline-ready'));
    })
    .catch(() => { document.documentElement.dataset.offline = 'unavailable'; });
}
