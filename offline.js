if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      document.documentElement.dataset.offline = 'ready';
      window.dispatchEvent(new Event('tidewater:offline-ready'));
    })
    .catch(() => { document.documentElement.dataset.offline = 'unavailable'; });
}
