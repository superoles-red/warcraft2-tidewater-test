import {currentLanguage, missionLabel, setLanguage, translate as t} from './localization.js';

const storageKey = 'tidewater-campaign-progress-v1';
const campaignOrder = ['orc', 'human', 'xorc', 'xhuman'];
const names = {human: 'Human Campaign', orc: 'Orc Campaign', xhuman: 'Human Campaign', xorc: 'Orc Campaign'};
const episodes = {human: 'Tides of Darkness', orc: 'Tides of Darkness', xhuman: 'Beyond the Dark Portal', xorc: 'Beyond the Dark Portal'};

function loadProgress() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return {
      last: Number.isInteger(stored.last) ? stored.last : null,
      lastQuick: typeof stored.lastQuick?.id === 'string' ? stored.lastQuick : null,
      recent: campaignOrder.includes(stored.recent) ? stored.recent : null,
      scores: Object.fromEntries(Object.entries(stored.scores ?? {}).filter(([id, score]) =>
        /^\d+$/.test(id) && Number(id) < 52 && Number.isSafeInteger(score) && score >= 0)),
      completed: Array.isArray(stored.completed)
        ? stored.completed.filter(id => Number.isInteger(id) && id >= 0 && id < 52)
        : [],
    };
  } catch { return {last: null, lastQuick: null, recent: null, completed: [], scores: {}}; }
}

function saveProgress(progress) {
  try { localStorage.setItem(storageKey, JSON.stringify(progress)); } catch {}
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function createCampaignUi(root, campaigns, actions) {
  const stage = root.querySelector('.front-content');
  const title = root.querySelector('.front-heading');
  const back = root.querySelector('.front-back');
  const update = root.querySelector('.front-update');
  const feedback = root.querySelector('.front-feedback');
  const progress = loadProgress();
  const ordered = campaignOrder.map(id => campaigns.find(campaign => campaign.id === id)).filter(Boolean);
  let backAction;

  const playSound = () => actions.click();
  const findMission = id => campaigns.flatMap(campaign =>
    campaign.missions.map(mission => ({...mission, campaign: campaign.id}))).find(mission => mission.id === id);

  function control(label, next, options = {}) {
    const element = node('button', options.raw ? label : t(label), 'war-button');
    element.type = 'button';
    if (options.tone) element.classList.add(options.tone);
    if (options.disabled) element.disabled = true;
    if (options.id != null) element.dataset.mission = options.id;
    if (options.campaign) element.dataset.campaign = options.campaign;
    if (options.dropdown) element.classList.add('dropdown');
    if (!options.disabled) element.addEventListener('click', () => { playSound(); next(); });
    return element;
  }

  function show(kind, heading, content, prev = null) {
    root.hidden = false;
    root.dataset.screen = kind;
    title.textContent = t(heading);
    title.hidden = !heading;
    stage.replaceChildren(...content);
    backAction = prev;
    back.hidden = !prev;
    back.setAttribute('aria-label', t('Back'));
    update.hidden = kind !== 'main';
    update.textContent = t('Update');
    feedback.hidden = kind !== 'settings';
    feedback.textContent = t('Feedback');
  }

  back.addEventListener('click', () => {
    playSound();
    backAction?.();
  });
  update.addEventListener('click', () => {
    playSound();
    actions.update();
  });

  function home() {
    const resume = findMission(progress.last);
    const controls = [
      ...(resume ? [control('Continue', () => confirm(resume, true), {tone:'positive'})] : []),
      ...(progress.lastQuick && actions.fast ? [control('Continue', () =>
        actions.fast(home, show, control, progressAccess, progress.lastQuick), {tone:'positive'})] : []),
      control('Campaign', chooseCampaign),
      ...(actions.fast ? [control('Custom Scenario', () => actions.fast(home, show, control, progressAccess))] : []),
      control('Settings', settings),
    ];
    controls[0]?.classList.add('recent');
    show('main', '', controls);
    window.dispatchEvent(new Event('tidewater:home'));
  }

  function chooseCampaign() {
    const content = [];
    const recent = progress.recent ?? findMission(progress.last)?.campaign ?? ordered[0]?.id;
    for (const campaign of ordered) {
      if (!campaign.race || campaign.id === 'orc' || campaign.id === 'xorc') {
        const label = episodes[campaign.id];
        if (!content.some(element => element.dataset.episode === label)) {
          const heading = node('h2', t(label));
          heading.dataset.episode = label;
          content.push(heading);
        }
      }
      const option = control(names[campaign.id], () => chapters(campaign), {campaign: campaign.id});
      if (recent === campaign.id) option.classList.add('recent');
      content.push(option);
    }
    show('campaigns', 'Campaign', content, home);
  }

  function chapters(campaign) {
    const list = node('div', null, 'mission-list');
    for (const [index, mission] of campaign.missions.entries()) {
      const playable = index === 0 || progress.completed.includes(campaign.missions[index - 1].id) ||
        progress.completed.includes(mission.id);
      const item = control(missionLabel(mission).title, () => confirm({...mission, campaign: campaign.id}), {
        raw: true, id: mission.id, disabled: !playable,
      });
      list.append(item);
    }
    const title = `${t(campaign.race ? 'Orcs' : 'Humans')} - ${t(episodes[campaign.id])}`;
    show('missions', title, [list], chooseCampaign);
  }

  function confirm(mission, resume = false) {
    const campaign = campaigns.find(item => item.id === mission.campaign);
    const brief = [
      node('p', t(episodes[mission.campaign]), 'accent'),
      node('p', missionLabel(mission).title),
    ];
    if (!resume && progressAccess.active())
      brief.push(node('p', t('The previous battle will be replaced.'), 'warning'));
    actions.confirm(resume ? 'Continue the game?' : 'Start a new game?', brief, [
      [resume ? 'Continue' : 'Start', async () => {
        actions.dismiss();
        show('loading', 'Loading mission…', []);
        try {
          const {world, restored} = await actions.load(mission.id, resume);
          if (!restored) await actions.act?.(world.mission);
          briefing(world.mission, restored);
        } catch (error) {
          show('loading', 'Unable to load the mission', [node('p', error.message)], () => chapters(campaign));
        }
      }, 'positive', true],
      ['Back', actions.dismiss, 'negative', true],
    ]);
  }

  function briefing(mission, resume = false) {
    if (resume) {
      launch(mission);
      return;
    }
    const localized = missionLabel(mission);
    const goals = node('ul', null, 'briefing-goals');
    for (const goal of localized.objectives ?? []) goals.append(node('li', goal));
    const briefing = node('div', null, 'briefing-layout');
    const scene = node('figure', null, 'briefing-scene');
    const article = node('article', null, 'briefing-text');
    article.setAttribute('aria-label', localized.title);
    article.tabIndex = 0;
    const picture = node('img', null, 'briefing-illustration');
    const faction = mission.campaign === 'orc' || mission.campaign === 'xorc' ? 'orc' : 'human';
    const group = mission.number >= 12 ? 3 : mission.number >= 8 ? 2 : mission.number >= 5 ? 1 : 0;
    picture.src = `./art/briefing/${faction}-${group}.webp`;
    root.style.setProperty('--briefing-art', `url('${picture.src}')`);
    picture.alt = '';
    picture.addEventListener('error', () => picture.remove(), {once:true});
    scene.append(picture);
    if (localized.story) article.append(node('p', localized.story));
    if (goals.children.length) {
      const caption = node('figcaption', null, 'briefing-objectives');
      caption.append(node('h2', t('Objectives')), goals);
      scene.append(caption);
    }
    briefing.append(scene, article);
    show('briefing', localized.title, [briefing, control('Play', () => launch(mission), {tone:'positive'})], () => {
      actions.stopBriefing(true);
      chapters(campaigns.find(campaign => campaign.id === mission.campaign));
    });
    actions.briefing(mission.id);
  }

  function launch(mission) {
    if (campaignOrder.includes(mission.campaign)) {
      progress.last = mission.id;
      progress.lastQuick = null;
      progress.recent = mission.campaign;
      saveProgress(progress);
    }
    root.hidden = true;
    actions.stopBriefing();
    actions.play(mission);
  }

  function settings() {
    show('settings', 'Settings', [
      control('Sound', () => actions.sound(settings)),
      control('Language', languages),
      control('Story', () => actions.story({show, control, back:settings})),
      control('Files', () => actions.files(settings, progressAccess)),
      control('About the game', about),
    ], home);
  }

  async function languages() {
    const language = window.TidewaterOffline;
    const pack = await language?.languagePack('ru').catch(() => null);
    async function use(value) {
      try {
        await setLanguage(value);
        actions.language();
        languages();
      } catch (error) {
        actions.confirm('Language unavailable', [node('p', error.message)], [['OK', actions.dismiss, 'positive']]);
      }
    }
    const english = control('English', () => use('en'), {raw:true});
    const russian = control('Русский', () => {
      if (pack?.installed || !language || !pack) return use('ru');
      const size = new Intl.NumberFormat(currentLanguage(), {maximumFractionDigits:1}).format(pack.bytes / 1000000);
      actions.confirm('Download language?', [node('p', `${size} ${t('MB of storage required')}`)], [
        ['Download', async () => {
          actions.dismiss();
          show('loading', 'Downloading language…', []);
          try {
            await language.installLanguage('ru');
            await use('ru');
          } catch (error) {
            languages();
            actions.confirm('Language unavailable', [node('p', error.message)], [['OK', actions.dismiss, 'positive']]);
          }
        }, 'positive'],
        ['Back', actions.dismiss, 'negative'],
      ]);
    }, {raw:true});
    (currentLanguage() === 'ru' ? russian : english).classList.add('recent');
    const rows = [english, russian];
    if (pack?.installed) rows.push(control('Delete Russian', () => {
      actions.confirm('Delete Russian?', [], [
        ['Delete', async () => {
          actions.dismiss();
          await language.deleteLanguage('ru');
          await use('en');
        }, 'negative'],
        ['Back', actions.dismiss],
      ]);
    }));
    show('settings', 'Language', rows, settings);
  }

  function about() {
    show('about', 'About the game', [
      node('p', t('The original Warcraft II rules and artwork, adapted for touch screens.')),
      node('p', t('Thanks to the Tidewater contributors and everyone supporting community adaptations and an open internet.')),
    ], settings);
  }

  const progressAccess = {
    active() { return progress.last != null || progress.lastQuick != null; },
    saveQuick(record) {
      progress.lastQuick = record;
      progress.last = null;
      saveProgress(progress);
    },
    exportProgress() {
      return {...progress, completed: [...progress.completed]};
    },
    importProgress(record) {
      if (!record || (record.last != null && !findMission(record.last)) ||
          (record.recent != null && !campaignOrder.includes(record.recent)) ||
          !Array.isArray(record.completed) || record.completed.some(id => !findMission(id))) return false;
      const updated = {
        last: record.last ?? null, recent: record.recent ?? findMission(record.last)?.campaign ?? null,
        lastQuick: null,
        completed: [...new Set(record.completed)],
        scores: {},
      };
      try { localStorage.setItem(storageKey, JSON.stringify(updated)); }
      catch { return false; }
      Object.assign(progress, updated);
      actions.imported();
      return true;
    },
  };

  return {
    home, confirm, briefing, launch, progress: progressAccess,
    close() { root.hidden = true; },
    open: () => !root.hidden,
    scoreTotal(mission, missionScore) {
      const chapter = campaigns.find(campaign => campaign.id === mission?.campaign);
      if (!chapter) return missionScore;
      const prior = chapter.missions.filter(item => item.number < mission.number);
      return prior.reduce((total, item) => total + (progress.scores[item.id] || 0), missionScore);
    },
    recordResult(outcome, mission, nextId, missionScore) {
      if (mission?.campaign === 'quick') {
        progress.lastQuick = null;
        saveProgress(progress);
        return;
      }
      if (!mission || progress.last !== mission.id) return;
      if (outcome === 'victory') {
        if (!progress.completed.includes(mission.id)) progress.completed.push(mission.id);
        if (Number.isSafeInteger(missionScore)) progress.scores[mission.id] = missionScore;
        progress.last = Number.isInteger(nextId) ? nextId : null;
      } else progress.last = null;
      saveProgress(progress);
    },
    next(id) {
      const mission = findMission(id);
      if (mission) confirm(mission);
    },
  };
}
