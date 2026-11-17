import {readJson} from './map-renderer.js';
import {followMediaVisibility, playNativeVideo} from './native-video.js';

const ACT_STARTS = new Set([0, 8, 14, 22, 1, 9, 15, 23, 29, 35, 41, 47, 28, 34, 40, 46]);
const assets = new URL('./art/acts/', import.meta.url);
const russianAssets = new URL('ru/', assets);
const catalogs = new Map();

function catalog(folder) {
  if (!catalogs.has(folder)) {
    catalogs.set(folder, readJson(new URL('index.json', folder)).catch(() => {
      catalogs.delete(folder);
      return {};
    }));
  }
  return catalogs.get(folder);
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function image(path, className) {
  const picture = node('img', className);
  picture.alt = '';
  picture.src = path;
  return picture;
}

function showStage(dialog, content, language, phase) {
  const button = node('button', 'act-next war-button', language === 'ru'
    ? (phase === 'movie' ? 'Пропустить' : 'Далее')
    : (phase === 'movie' ? 'Skip' : 'Continue'));
  button.type = 'button';
  button.dataset.actNext = '';
  dialog.dataset.phase = phase;
  dialog.replaceChildren(content, button);
  button.focus({preventScroll: true});
}

function waitForDismiss(dialog, signal, closing, begin) {
  return new Promise(resolve => {
    let ending = false;
    let cleanup = () => {};
    function finish() {
      if (ending) return;
      ending = true;
      cleanup();
      dialog.removeEventListener('click', click);
      dialog.removeEventListener('cancel', cancel);
      signal.removeEventListener('abort', finish);
      const fade = signal.aborted || !closing ? 0 : closing;
      if (fade) dialog.classList.add('act-closing');
      setTimeout(resolve, fade);
    }
    function click(event) {
      if (!event.target.closest('.story-start')) finish();
    }
    function cancel(event) {
      event.preventDefault();
      finish();
    }
    dialog.addEventListener('click', click);
    dialog.addEventListener('cancel', cancel);
    signal.addEventListener('abort', finish, {once: true});
    if (signal.aborted) finish();
    else cleanup = begin(finish);
  });
}

function playCard(dialog, stage, sound, {volume, routeMedia}, signal, language) {
  showStage(dialog, stage, language, 'card');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  return waitForDismiss(dialog, signal, reduced ? 0 : 400, finish => {
    const playback = new AbortController();
    const audio = new Audio(new URL(sound + '.m4a', assets));
    if (routeMedia) routeMedia(audio, 'effects', {signal:playback.signal});
    else audio.volume = volume;
    audio.muted = volume === 0;
    audio.preload = volume ? 'auto' : 'none';
    const showMap = setTimeout(() => dialog.classList.add('act-visible'), reduced ? 0 : 1000);
    const cue = setTimeout(() => {
      if (!document.hidden && volume) audio.play().catch(() => {});
    }, reduced ? 0 : 1600);
    const automatic = setTimeout(finish, 6400);
    followMediaVisibility(audio, playback.signal);
    return () => {
      clearTimeout(showMap);
      clearTimeout(cue);
      clearTimeout(automatic);
      playback.abort();
    };
  });
}

function playMovie(dialog, source, {volume, routeMedia}, signal, language, clip) {
  const stage = node('div', 'act-film');
  dialog.classList.remove('act-closing');
  dialog.dataset.clip = clip;
  showStage(dialog, stage, language, 'movie');
  return waitForDismiss(dialog, signal, 0, finish => {
    const playback = new AbortController();
    const video = playNativeVideo(stage, {
      src: source, signal: playback.signal, volume,
      routeMedia,
      playLabel: language === 'ru' ? 'Воспроизвести' : 'Play', onEnd: finish, onError: finish,
    });
    const fail = setTimeout(() => { if (video.readyState < 2) finish(); }, 8000);
    return () => {
      clearTimeout(fail);
      playback.abort();
    };
  });
}

export function createActInterlude() {
  let lastAct;
  let lastMovie;
  let playing;

  async function play(id, {language = 'en', volume = 1, routeMedia} = {}) {
    if (!ACT_STARTS.has(id) || lastAct === id || playing) return false;
    const controller = new AbortController();
    playing = controller;
    let dialog;
    try {
      const maybeRussian = language === 'ru' ? catalog(russianAssets) : {};
      const [original, localized] = await Promise.all([catalog(assets), maybeRussian]);
      const act = original[id];
      if (!act || controller.signal.aborted) return false;
      const label = localized[id] ?? act;
      const captions = localized[id] ? russianAssets : assets;
      const artwork = image(new URL(id + '.webp', assets), 'act-art');
      const text = image(new URL(id + '-text.webp', captions), 'act-caption');
      await Promise.all([artwork.decode(), text.decode()]);
      if (controller.signal.aborted) return false;
      const frame = node('div', 'act-frame');
      const heading = node('h1', 'act-heading', label.label + '. ' + label.title);
      heading.id = 'act-heading';
      frame.append(artwork, text, heading);

      dialog = node('dialog', 'act-interlude');
      dialog.dataset.actMission = String(id);
      document.body.append(dialog);
      dialog.showModal();
      const audio = {volume:Math.min(1, Math.max(0, Number(volume) || 0)), routeMedia};
      if ((id === 28 || id === 29) && lastMovie !== 'introx_m.mp4') {
        lastMovie = 'introx_m.mp4';
        dialog.setAttribute('aria-label', language === 'ru' ? 'За Тёмным Порталом' : 'Beyond the Dark Portal');
        await playMovie(dialog, new URL(lastMovie, language === 'ru' ? russianAssets : assets),
          audio, controller.signal, language, 'portal-intro');
      }
      if (controller.signal.aborted) return false;
      lastAct = id;
      delete dialog.dataset.clip;
      dialog.removeAttribute('aria-label');
      dialog.setAttribute('aria-labelledby', heading.id);
      await playCard(dialog, frame, act.sound, audio, controller.signal, language);
      if (act.movie && act.movie !== lastMovie && !controller.signal.aborted) {
        lastMovie = act.movie;
        dialog.removeAttribute('aria-labelledby');
        dialog.setAttribute('aria-label', label.title);
        await playMovie(dialog, new URL(act.movie, assets), audio, controller.signal, language, 'act-film');
      }
      return true;
    } catch {
      return false;
    } finally {
      dialog?.remove();
      playing = undefined;
    }
  }

  return {play, close: () => playing?.abort()};
}
