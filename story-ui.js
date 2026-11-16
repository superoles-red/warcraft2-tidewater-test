import {currentLanguage, translate as t} from './localization.js';
import {followMediaVisibility, playNativeVideo} from './native-video.js';

const labels = {
  en: {
    story: 'Story', intro: 'Replay Introduction', credits: 'Show Credits', demo: 'Replay Demo',
    play: 'Play', unavailable: 'This story cannot be loaded. Connect to the internet and try again.',
  },
  ru: {
    story: 'История', intro: 'Вступление', credits: 'Об авторах', demo: 'Демо',
    play: 'Воспроизвести', unavailable: 'Не удалось загрузить материалы. Проверьте подключение и попробуйте снова.',
  },
};

const asset = name => new URL('./art/' + name, import.meta.url).href;
const localized = () => labels[currentLanguage()] || labels.en;

export function createStoryBack(close) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'story-back';
  button.setAttribute('aria-label', t('Back'));
  button.addEventListener('click', close);
  return button;
}

export function createStoryUi({show, control, back, onDemo, gain = () => 1, onMediaChange = () => {}}) {
  function media(kind, title, fill) {
    const opener = document.activeElement;
    const layer = document.createElement('dialog');
    const content = document.createElement('div');
    const lifetime = new AbortController();
    const {signal} = lifetime;
    layer.className = 'story-media story-media--' + kind;
    layer.setAttribute('aria-label', title);
    content.className = 'story-media-content';
    const close = () => {
      if (signal.aborted) return;
      lifetime.abort();
      layer.close();
      layer.remove();
      onMediaChange(false);
      opener?.focus({preventScroll: true});
    };
    layer.addEventListener('cancel', event => {
      event.preventDefault();
      close();
    }, {signal});
    layer.append(content, createStoryBack(close));
    document.body.append(layer);
    layer.showModal();
    onMediaChange(true);
    fill(content, signal, close);
  }

  function intro() {
    media('intro', localized().intro, (content, signal, close) => {
      const feedback = document.createElement('p');
      const folder = currentLanguage() === 'ru' ? 'story/intro-ru.mp4' : 'story/intro.mp4';
      feedback.className = 'story-message';
      feedback.setAttribute('role', 'status');
      feedback.hidden = true;
      content.append(feedback);
      playNativeVideo(content, {
        src: asset(folder), signal, volume: gain('effects'), poster: asset('story/intro-poster.webp'),
        playLabel: localized().play, onEnd: close,
        onError() {
          feedback.textContent = localized().unavailable;
          feedback.hidden = false;
        },
      });
    });
  }

  function credits() {
    media('credits', localized().credits, (content, signal, close) => {
      const stage = document.createElement('div');
      stage.className = 'story-credits-stage';
      stage.style.backgroundImage = 'url("' + asset('story/credits-1.webp') + '")';
      const clip = document.createElement('div');
      clip.className = 'story-credits-clip';
      const roll = document.createElement('div');
      roll.className = 'story-credits-roll';
      const audio = new Audio();
      audio.volume = gain('music');
      followMediaVisibility(audio, signal);
      let track = 1;
      const playTrack = () => {
        audio.src = asset('story/credits-' + track + '.m4a');
        if (audio.volume) audio.play().catch(() => {});
      };
      audio.addEventListener('ended', () => {
        track = track === 1 ? 2 : 1;
        playTrack();
      }, {signal});
      playTrack();
      clip.append(roll);
      stage.append(clip);
      content.append(stage);

      let animation;
      let page = 0;
      let pages = [];
      let geometry;

      function resize() {
        if (!pages.length) return;
        const scale = stage.clientWidth / 640;
        stage.style.setProperty('--credits-title-size', Math.max(17, 35 * scale) + 'px');
        stage.style.setProperty('--credits-body-size', Math.max(14, 17 * scale) + 'px');
        stage.style.setProperty('--credits-line', Math.max(16, 25 * scale) + 'px');
        stage.style.setProperty('--credits-gap', 94 * scale + 'px');
        const start = clip.clientHeight * (194 / 275);
        const end = roll.scrollHeight + 2;
        const next = [start, end, scale].join(':');
        if (geometry === next) return;
        geometry = next;
        const elapsed = animation?.currentTime / animation?.effect.getTiming().duration || 0;
        animation?.cancel();
        const duration = (start + end) * 40 / scale;
        animation = roll.animate([
          {transform: 'translate3d(0,' + start + 'px,0)'},
          {transform: 'translate3d(0,-' + end + 'px,0)'},
        ], {duration, fill: 'both', easing: 'linear'});
        animation.currentTime = elapsed * duration;
        if (document.hidden) animation.pause();
        animation.addEventListener('finish', () => {
          if (signal.aborted) return;
          page++;
          if (page < pages.length) render();
          else close();
        }, {once: true});
      }

      function render() {
        animation?.cancel();
        animation = geometry = undefined;
        stage.style.backgroundImage = 'url("' + asset('story/credits-' + (page + 1) + '.webp') + '")';
        const {title, body} = pages[page];
        const heading = document.createElement('h2');
        heading.textContent = title;
        const names = document.createElement('div');
        names.className = 'story-credits-names';
        for (const line of body) {
          const row = document.createElement('div');
          row.textContent = line.trim() || ' ';
          if (line.startsWith('\t')) row.className = 'story-credits-indent';
          names.append(row);
        }
        roll.replaceChildren(heading, names);
        resize();
      }

      const observer = new ResizeObserver(resize);
      observer.observe(stage);
      observer.observe(roll);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) animation?.pause();
        else animation?.play();
      }, {signal});
      signal.addEventListener('abort', () => {
        observer.disconnect();
        animation?.cancel();
      }, {once: true});
      const path = currentLanguage() === 'ru' ? 'story/credits-ru.json' : 'story/credits.json';
      fetch(asset(path), {signal}).then(response => {
        if (!response.ok) throw new Error('Credits could not be loaded');
        return response.json();
      }).then(data => {
        if (signal.aborted) return;
        pages = data;
        render();
      }).catch(() => {
        if (signal.aborted) return;
        const feedback = document.createElement('p');
        feedback.className = 'story-message';
        feedback.setAttribute('role', 'status');
        feedback.textContent = localized().unavailable;
        content.append(feedback);
      });
    });
  }

  function open() {
    const copy = localized();
    const actions = [
      control(copy.intro, intro, {raw: true}),
      control(copy.credits, credits, {raw: true}),
      control(copy.demo, () => onDemo(open), {raw: true}),
    ];
    show('story', copy.story, actions, back);
  }

  return {open};
}
