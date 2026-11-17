import {translate as t} from './localization.js';
import {followMediaVisibility, playNativeVideo} from './native-video.js';
import {createStoryBack} from './story-ui.js';

const nativeArt = new URL('./art/', import.meta.url);
const core = new URL('finale/', nativeArt);
const translated = new URL('lang/ru/finale/', nativeArt);
const gapMs = 255;

async function read(directory) {
  const response = await fetch(new URL('index.json', directory));
  if (!response.ok) throw new Error('The campaign finale is unavailable');
  return response.json();
}

function node(tag, className, label) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (label) element.textContent = label;
  return element;
}

export async function playCampaignFinale(id, {language, music, effects, onClick}) {
  const english = await read(core);
  const russian = language === 'ru' ? await read(translated).catch(() => null) : null;
  const ending = english.endings[id];
  if (!ending) return;
  const locale = russian?.endings[id];
  const film = locale?.film ? new URL(locale.film, translated) : new URL(ending.film, core);
  const story = locale?.story ?? ending.story;
  const clips = (locale?.narration ?? ending.narration).map(part => ({
    file: new URL(part.file, locale?.narration ? translated : core),
    duration: part.duration,
  }));
  const voicesLength = clips.reduce((ms, part) => ms + part.duration, Math.max(0, clips.length - 1) * gapMs);
  const credits = (russian?.credits ?? english.credits)[ending.episode];
  const humanMusic = new URL('story/credits-2.m4a', nativeArt);
  const orcMusic = new URL('orc-music.m4a', core);
  const picture = new URL(ending.race + '.webp', core);

  await new Promise(resolve => {
    const dialog = node('dialog', 'story-media campaign-finale');
    const content = node('div', 'story-media-content');
    dialog.setAttribute('aria-label', t('Victory'));
    dialog.dataset.mission = id;
    let phase;
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      phase?.abort();
      dialog.close();
      dialog.remove();
      resolve();
    }
    function setPhase(name) {
      phase?.abort();
      phase = new AbortController();
      dialog.dataset.phase = name;
      content.replaceChildren();
      return phase.signal;
    }
    const back = createStoryBack(() => { onClick?.(); close(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.append(content, back);
    document.body.append(dialog);
    dialog.showModal();

    function textStage(isCredits) {
      const signal = setPhase(isCredits ? 'credits' : 'finale');
      const advance = isCredits ? close : () => textStage(true);
      const next = node('button', 'war-button positive finale-next', t('Continue'));
      next.type = 'button';
      next.addEventListener('click', () => { onClick?.(); advance(); }, {signal});
      const stage = node('div', 'finale-art');
      const clip = node('div', 'finale-clip');
      const roll = node('div', 'finale-roll');
      stage.style.backgroundImage = 'url("' + (isCredits ? new URL('story/credits-1.webp', nativeArt) : picture) + '")';
      const lines = (isCredits ? credits : story).split('\n');
      for (const line of lines) roll.append(node('p', null, line));
      clip.append(roll);
      stage.append(clip);
      content.replaceChildren(stage);
      content.append(next);

      const theme = new Audio();
      theme.volume = music;
      followMediaVisibility(theme, signal);
      let orcTrack = !isCredits && ending.race === 'orc';
      function startTheme() {
        if (!music) return;
        theme.src = (orcTrack ? orcMusic : humanMusic).href;
        theme.play().catch(() => {});
      }
      theme.addEventListener('ended', () => {
        if (!isCredits) orcTrack = !orcTrack;
        startTheme();
      }, {signal});
      startTheme();

      let animation;
      let timer;
      let rolling = false;
      let spoken = isCredits || !effects || !clips.length;
      let scrolled = false;
      function readyForNext() {
        if (spoken && scrolled && !signal.aborted) advance();
      }
      function resize() {
        if (!rolling || signal.aborted) return;
        const scale = stage.clientWidth / 640;
        const from = clip.clientHeight;
        const line = parseFloat(getComputedStyle(roll).lineHeight);
        const to = Math.max(0, roll.scrollHeight - line / 2);
        const steps = Math.max(1, Math.round((from + to) / scale));
        const duration = steps * (isCredits ? 40 : Math.floor(voicesLength / steps) || 100);
        const oldDuration = animation?.effect.getTiming().duration;
        const completed = oldDuration ? animation.currentTime / oldDuration : 0;
        animation?.cancel();
        animation = roll.animate([
          {transform: 'translateY(' + from + 'px)'},
          {transform: 'translateY(-' + to + 'px)'},
        ], {duration, easing: 'steps(' + steps + ')', fill:'both'});
        animation.currentTime = Math.min(duration, completed * duration);
        if (document.hidden) animation.pause();
        animation.addEventListener('finish', () => { scrolled = true; readyForNext(); }, {once:true});
      }
      const observer = new ResizeObserver(resize);
      observer.observe(clip);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) animation?.pause();
        else animation?.play();
      }, {signal});
      signal.addEventListener('abort', () => {
        animation?.cancel();
        observer.disconnect();
        clearTimeout(timer);
      }, {once:true});
      const startScroll = () => {
        if (rolling || signal.aborted) return;
        rolling = true;
        resize();
      };
      if (spoken) {
        startScroll();
        return;
      }

      const narrator = new Audio();
      narrator.volume = effects;
      followMediaVisibility(narrator, signal);
      let part = 0;
      let waitingForPage = false;
      function nextPart() {
        part++;
        if (part === clips.length) {
          spoken = true;
          readyForNext();
        } else {
          timer = setTimeout(playPart, gapMs);
        }
      }
      function playPart() {
        if (signal.aborted) return;
        if (document.hidden) {
          waitingForPage = true;
          return;
        }
        waitingForPage = false;
        narrator.src = clips[part].file.href;
        playVoice();
      }
      function playVoice() {
        narrator.play().then(() => {
          retry.hidden = true;
          startScroll();
        }).catch(error => {
          if (signal.aborted) return;
          if (error.name === 'NotAllowedError') retry.hidden = false;
          else {
            startScroll();
            nextPart();
          }
        });
      }
      const retry = node('button', 'war-button story-start', t('Play'));
      retry.type = 'button';
      retry.hidden = true;
      retry.addEventListener('click', () => {
        if (music && theme.paused) theme.play().catch(() => {});
        playVoice();
      }, {signal});
      content.append(retry);
      narrator.addEventListener('ended', nextPart, {signal});
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && waitingForPage) playPart();
      }, {signal});
      playPart();
    }

    const signal = setPhase('film');
    const next = node('button', 'war-button positive finale-next', t('Continue'));
    next.type = 'button';
    const advance = () => { if (!signal.aborted) textStage(false); };
    next.addEventListener('click', () => { onClick?.(); advance(); }, {signal});
    playNativeVideo(content, {
      src: film.href, volume: effects, signal, playLabel: t('Play'), onEnd: advance, onError: advance,
    });
    content.append(next);
  });
}
