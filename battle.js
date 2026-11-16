import {createTidewater} from './engine.js';
import {createMapRenderer, readImage, readJson, eraDirectory} from './map-renderer.js';
import {createCampaignUi} from './campaign-ui.js';
import {checkpointKey, createCheckpointStore} from './checkpoint-store.js';
import {commandLabel, currentLanguage, missionLabel, setLanguage, translate as t, unitLabel} from './localization.js';

const byId = id => document.getElementById(id);
const game = byId('game');
const minimap = byId('minimap');
const selection = byId('selection');
const commands = byId('commands');
const detail = byId('command-detail');
const modal = byId('modal');
const cancelGlyph = 91;
const tickMs = 40;
const checkpointUpdates = new Set(['smart','move','target','build','train','upgrade','research','cancel','returnGoods','cast']);
const costNames = ['Gold', 'Lumber', 'Oil'];
const unitNames = {0: 'Footman', 1: 'Grunt', 2: 'Peasant', 3: 'Peon', 58: 'Farm', 59: 'Pig Farm',
  60: 'Barracks', 61: 'Barracks', 74: 'Town Hall', 75: 'Great Hall', 92: 'Gold Mine'};
const targetIcons = {move: 83, attack: 116, repair: 85, harvest: 86, patrol: 184};
const targetSlots = {move: 0, attack: 2, repair: 3, harvest: 4, patrol: 3};
const clamp = (value, max) => Math.max(0, Math.min(max, value));

const resourceFields = [
  ['gold', 'Gold'], ['lumber', 'Lumber'], ['oil', 'Oil'], ['food', 'Food'],
];

function button(label, activate, tone = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = tone ? 'war-button ' + tone : 'war-button';
  element.textContent = label;
  element.addEventListener('click', activate);
  return element;
}

function description(command) {
  return (command.cost ?? []).flatMap((cost, index) => cost ? [`${cost} ${t(costNames[index])}`] : []).join(' · ');
}

function priceLabel(command) {
  const price = description(command);
  return price ? `${commandLabel(command)} — ${price}` : commandLabel(command);
}

function commandKey(command) {
  return [command.op, command.action, command.kind, command.spell].join(':');
}

function createInterface({
  initialWorld, request, getRect, createCamera, onWorld, onError, action, active, onBox, onFrame,
}) {
  const {mapEdgeRoom} = window.WarcraftPresentation;
  const camera = createCamera();
  const viewport = window.WarcraftIndependentCameraPilot.viewport;
  let world = initialWorld;
  let view;
  let queued = Promise.resolve();
  let remembered = [];
  const pressed = new Map();
  const geometry = {};
  function sizeWorld() {
    Object.assign(geometry, {
      ...viewport, active: true, fullWorld: true, cameraX: 0, cameraY: 0, maxX: 0, maxY: 0,
      mapWidth: world.width, mapHeight: world.height,
      world: {left: 0, top: 0, right: world.width * world.tileSize, bottom: world.height * world.tileSize},
    });
    geometry.width = Math.max(viewport.width, geometry.world.right);
    geometry.height = Math.max(viewport.height, geometry.world.bottom);
    camera.reset();
    view = undefined;
    pressed.clear();
    remembered = [];
  }
  sizeWorld();

  function run(command) {
    const operation = queued.then(async () => {
      const next = await request(command);
      world = {
        ...next,
        visible: next.visible ?? world.visible,
        explored: next.explored ?? world.explored,
        mission: next.mission ?? world.mission,
      };
      if (['loadMission', 'loadScenario', 'loadDemo', 'restart', 'restoreCheckpoint'].includes(command.op)) sizeWorld();
      onWorld(world, command);
      return world;
    });
    queued = operation.catch(onError);
    return operation;
  }

  function frame(time) {
    const {width, height} = getRect();
    if (width > 0 && height > 0) view = camera.frame(geometry, width, height, time, null, mapEdgeRoom);
    return view;
  }

  function clientToNativePoint(event, rect) {
    if (!view) return null;
    const scale = view.width / rect.width;
    const x = view.visibleGlobal.x + (event.clientX - rect.left) * scale;
    const y = view.visibleGlobal.y + (event.clientY - rect.top) * scale;
    return {x, y, pixelsPerCssPixel: scale,
      padding: x < 0 || y < 0 || x >= geometry.world.right || y >= geometry.world.bottom};
  }

  function send(command) {
    run(command).catch(() => {});
  }

  function checkpoint() {
    const operation = queued.then(() => request({op:'saveCheckpoint'}));
    queued = operation.catch(() => {});
    return operation;
  }

  function nativeMove(x, y) {
    const start = pressed.get(0);
    if (start && !action.target()) onBox({x1: start.x, y1: start.y, x2: x, y2: y});
  }

  function nativeButton(down, id, x, y) {
    if (down) {
      pressed.set(id, {x, y});
      return;
    }
    const start = pressed.get(id);
    pressed.delete(id);
    if (!start) return;
    onBox(null);
    if (id === 1) {
      if (action.placement()) action.cancelPlacement();
      else send({op: 'smart', x, y});
    } else if (action.target()) {
      action.finishTarget(x, y);
    } else if (Math.hypot(start.x - x, start.y - y) <= 5) {
      send({op: 'select', x, y, radius: Math.min(12, Math.ceil(7 * view.width / getRect().width))});
    } else {
      const left = Math.min(start.x, x), right = Math.max(start.x, x);
      const top = Math.min(start.y, y), bottom = Math.max(start.y, y);
      const ids = world.units.filter(unit => unit.owner === world.player && unit.hp > 0 &&
        unit.x < right && unit.x + unit.width > left && unit.y < bottom && unit.y + unit.height > top)
        .slice(0, 9).map(unit => unit.id);
      send({op: 'selectIds', ids});
    }
  }

  const input = {
    commandSelectionV15: true,
    explicitBuildingPlacement: true,
    state: () => ({
      inGame: active(), modal: modal.open, inputAllowed: active(),
      dialogOpen: modal.open, selectionCount: world.selection.length,
      targetPending: Boolean(action.target()), buildingPending: Boolean(action.placement()),
    }),
    now: () => performance.now(),
    getNativeGeometry: () => geometry,
    clientToNativePoint,
    nativeMove,
    nativeButton,
    panTiles(dx, dy) { camera.move(dx * 32, dy * 32, performance.now()); onFrame(); },
    beginPan: (...args) => camera.begin(...args),
    panPixels(...args) { camera.move(...args); onFrame(); },
    endPan(...args) { camera.end(...args); onFrame(); },
    stopPan() { camera.stop(); onFrame(); },
    clearSelection: () => send({op: 'selectIds', ids: []}),
    retainsTouchSelection: () => true,
    rememberTouchSelection() { remembered = [...world.selection]; },
    orderWithTouchSelection(x, y) {
      send({op: 'selectIds', ids: remembered});
      send({op: 'smart', x, y});
    },
    buildingWorldPoint: (x, y) => ({x, y}),
    getBuildingContext: () => action.placement()?.key,
    previewBuilding: point => action.preview(point),
    confirmBuilding: () => false,
    requestActionCancellation: () => { action.cancelPlacement(); return true; },
    cancelPendingInput() { pressed.clear(); onBox(null); },
  };
  return {
    frame, run, input, send, checkpoint,
    centerOn(x, y, options = {useEdgeRoom:true}) { camera.centerOn(x, y, options); onFrame(); },
    get world() { return world; },
    get view() { return view; },
    get cameraMoving() { return camera.active; },
  };
}

function artwork(meta, atlas) {
  const make = (source, label) => {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    if (!source) return canvas;
    const [x, y, w, h] = source;
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.drawImage(atlas, x, y, w, h, 0, 0, w, h);
    if (label) canvas.dataset.art = label;
    return canvas;
  };
  return {
    resource(name) { return make(meta.resources[name], name); },
    icon(id) { return make(meta.icons[id], id); },
    portrait(kind) { return make(meta.icons[meta.portraits[kind] ?? kind], kind); },
    portraitId(kind) { return meta.portraits[kind] ?? kind; },
  };
}

async function bytes(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Can't load ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

function makeAudio() {
  let files = {};
  let languageFiles = {};
  let race = 'human';
  let music;
  let narration;
  let audioContext;
  let unlocked = false;
  let mediaActive = false;
  const cache = new Map();
  readJson('./art/audio.json').then(source => { files = source; }).catch(() => {});
  const musicSource = () => files['music-' + race]?.[0] ?? files.music?.[0];
  const audioPath = path => './art/' + path;
  const clip = key => {
    const localized = languageFiles[key];
    if (localized?.length) return localized.map(path => './art/lang/ru/' + path);
    return (files[key] ?? []).map(audioPath);
  };
  const getVolume = (key, fallback) => {
    try {
      const value = localStorage.getItem('tidewater-pilot-' + key);
      return value == null ? fallback : clamp(Number(value) || 0, 1);
    } catch { return fallback; }
  };
  const volumes = {music: getVolume('music', .6), effects: getVolume('effects', .8)};
  function sync() {
    if (!unlocked || !musicSource()) return;
    if (!music) {
      music = new Audio();
      music.loop = true;
      music.preload = 'auto';
    }
    const source = audioPath(musicSource());
    if (music.getAttribute('src') !== source) music.src = source;
    music.volume = volumes.music;
    if (document.hidden || mediaActive || !volumes.music) music.pause();
    else music.play().catch(() => {});
  }
  function activate() {
    const Context = window.AudioContext || window.webkitAudioContext;
    unlocked = true;
    if (!audioContext && Context) audioContext = new Context();
    audioContext?.resume().catch(() => {});
    sync();
  }
  async function play(key, fallback) {
    const preferred = clip(key);
    const paths = preferred.length ? preferred : clip(fallback);
    if (!unlocked || !audioContext || !paths?.length || !volumes.effects || document.hidden) return;
    const file = paths[Math.floor(Math.random() * paths.length)];
    try {
      if (!cache.has(file))
        cache.set(file, fetch(file).then(response => response.arrayBuffer())
          .then(buffer => audioContext.decodeAudioData(buffer)));
      const data = await cache.get(file);
      if (document.hidden || audioContext.state !== 'running') return;
      const source = audioContext.createBufferSource();
      const gain = audioContext.createGain();
      gain.gain.value = volumes.effects;
      source.buffer = data;
      source.connect(gain).connect(audioContext.destination);
      source.start();
    } catch {
      cache.delete(file);
    }
  }
  function change(key, value) {
    volumes[key] = value;
    try { localStorage.setItem('tidewater-pilot-' + key, value); } catch {}
    if (key === 'music') sync();
  }
  function stopBriefing() {
    narration?.pause();
    narration = undefined;
  }
  function briefing(id) {
    stopBriefing();
    const path = clip('briefing-' + id)[0];
    if (!path || !unlocked) return;
    narration = new Audio(path);
    narration.volume = volumes.effects;
    narration.play().catch(() => {});
  }
  window.addEventListener('pointerdown', activate, {passive: true, capture: true});
  window.addEventListener('pointerup', activate, {passive: true, capture: true});
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audioContext?.suspend().catch(() => {});
    else if (unlocked) audioContext?.resume().catch(() => {});
    sync();
    if (document.hidden) narration?.pause();
    else narration?.play().catch(() => {});
  });
  return {
    play, change, volumes, briefing, stopBriefing,
    media(active) { mediaActive = active; sync(); },
    race(value) { race = value; sync(); },
    async language() {
      languageFiles = currentLanguage() === 'ru'
        ? await readJson('./art/lang/ru/audio.json').catch(() => ({})) : {};
    },
  };
}

async function start() {
  const audio = makeAudio();
  await setLanguage().catch(() => setLanguage('en'));
  audio.language();
  byId('loading-text').textContent = 'Loading the game files…';
  const [data, patch, uiMeta, uiAtlas] = await Promise.all([
    bytes('./game/War2Dat.mpq'), bytes('./game/War2Patch.mpq'),
    readJson('./art/ui.json'), readImage('./art/ui.webp'),
  ]);
  const request = await createTidewater(data, patch, {wasmUrl: new URL('./tidewater_web.wasm', import.meta.url)});
  const initialWorld = await request({op: 'campaigns'});
  const campaigns = initialWorld.campaigns;
  if (!Array.isArray(campaigns)) throw new Error('The campaign list is unavailable.');
  const direct = new URLSearchParams(location.search).get('mission');
  const directMode = direct != null && /^\d+$/.test(direct) &&
    campaigns.some(c => c.missions.some(m => m.id === Number(direct)));
  const checkpoints = createCheckpointStore();
  let checkpointEpoch = 0;
  let checkpointWork = Promise.resolve();
  let savingCheckpoint;
  let checkpointTime = 0;
  let checkpointSoon = false;
  let savedCamera;
  let renderer;
  const defaultArt = artwork(uiMeta, uiAtlas);
  let art = defaultArt;
  let canvasRect = game.getBoundingClientRect();
  let frameRequested = false;
  let nextTick = 0;
  let battleActive = false;
  let loadingMission = false;
  let demoReturn;
  let demoBack;
  let nextDemo = 1;
  let acts;
  let tickTimer;
  let stepPending = false;
  let stopped = false;
  let outcomeShown = false;
  let selectionKey = '';
  let commandGroup = null;
  let armed = null;
  let aim = null;
  let placement = null;
  let placementTile = null;
  let selectBox = null;
  let lastPortrait = null;
  let notice = null;
  let infoKey = '';
  let panelKey = '';
  const showHud = visible => {
    for (const id of ['hud-top', 'selection', 'minimap', 'command-area']) byId(id).hidden = !visible;
  };
  function setting(name, fallback) {
    try {
      const value = localStorage.getItem('tidewater-pilot-' + name);
      return value == null ? fallback : value === 'true';
    } catch { return fallback; }
  }
  function setSetting(name, value) {
    try { localStorage.setItem('tidewater-pilot-' + name, value); } catch {}
  }

  const resourceValues = Object.fromEntries(resourceFields.map(([key, label]) => {
    const item = document.createElement('span');
    const value = document.createElement('span');
    item.className = 'resource';
    item.title = t(label);
    item.append(art.resource(key), value);
    byId('resources').append(item);
    return [key, value];
  }));

  const adapter = createInterface({
    initialWorld, request,
    getRect: () => canvasRect,
    createCamera: () => WarcraftIndependentCameraPilot.createCamera(WarcraftSmoothCamera.createCamera({
      panTiles: () => false,
      viewport: {...WarcraftIndependentCameraPilot.viewport, reference: WarcraftIndependentCameraPilot.referenceViewport},
    })),
    onWorld, onError,
    onBox(box) { selectBox = box; scheduleFrame(); },
    onFrame: scheduleFrame,
    active: () => battleActive && !demoReturn && !loadingMission && !stopped && !document.hidden && !outcomeShown,
    action: {
      target: () => aim,
      placement: () => placement,
      cancelPlacement,
      preview: previewBuilding,
      finishTarget(x, y) {
        if (!aim) return;
        const {action, spell} = aim;
        aim = null;
        adapter.send({op: 'target', action, spell, x, y});
        updateHud(adapter.world);
      },
    },
  });
  const controls = createWarcraftDuneControls({...adapter.input, canvasElement: game}, () => canvasRect).enable();
  const front = createCampaignUi(byId('front'), campaigns, {
    click: () => audio.play('button'),
    confirm: showModal,
    dismiss: closeModal,
    load: loadMission,
    play: () => playMission(),
    briefing: id => audio.briefing(id),
    stopBriefing: () => audio.stopBriefing(),
    async act(mission) {
      const {createActInterlude} = await import('./act-interlude.js');
      acts ??= createActInterlude();
      audio.media(true);
      try {
        await acts.play(mission.id, {
          language: currentLanguage(), volume: audio.volumes.effects,
        });
      } finally { audio.media(false); }
    },
    async story(view) {
      try {
        const {createStoryUi} = await import('./story-ui.js');
        createStoryUi({
          ...view, onDemo: startDemo,
          gain: kind => audio.volumes[kind],
          onMediaChange: active => audio.media(active),
        }).open();
      } catch {
        showModal('Story', [text(t('Media unavailable'))], [['Back', closeModal, 'negative']]);
      }
    },
    sound: back => showSound(() => { closeModal(); back(); }),
    language: updateLanguage,
    imported: discardCheckpoint,
    async fast(back, show, control, progress, resume) {
      const {openQuickBattle} = await import('./quick-battle-ui.js');
      await openQuickBattle({
        show, control, confirm:showModal, dismiss:closeModal, back, resume,
        load: loadQuickBattle,
        active: () => progress.active(),
        complete: record => progress.saveQuick(record),
        fog: () => setting('fog', true),
        stop: () => { front.close(); playMission(); },
      });
    },
    async update() {
      const message = text(t('Checking for updates…'));
      showModal('Update', [message], [['Back', closeModal, 'negative']]);
      try {
        const result = await window.TidewaterOffline?.checkForUpdate();
        const statuses = {current:'You have the latest version.', updated:'The update is ready.',
          unavailable:'Updates are unavailable right now.'};
        message.textContent = t(statuses[result] || statuses.unavailable);
      } catch (error) {
        message.textContent = error.message;
      }
    },
    async files(back, progress) {
      const {openFiles} = await import('./files-ui.js');
      openFiles({confirm:showModal, dismiss:closeModal, back, progress, translate:t, campaigns});
    },
  });

  function updateLanguage() {
    audio.language();
    for (const [id, label] of [['menu-button', 'Menu'], ['place-button', 'Place'], ['cancel-placement', 'Cancel']]) {
      byId(id).textContent = t(label);
    }
    for (const [field, label] of resourceFields) resourceValues[field].parentElement.title = t(label);
    infoKey = panelKey = '';
    if (battleActive) updateHud(adapter.world);
  }

  function loadMission(id, resume = false) { return loadBattle({op:'loadMission', id}, resume); }

  async function startDemo(returnToStory) {
    if (demoReturn) return;
    demoReturn = returnToStory;
    try {
      const {createStoryBack} = await import('./story-ui.js');
      await loadBattle({op:'loadDemo', id:nextDemo, seed:crypto.getRandomValues(new Uint32Array(1))[0]});
      nextDemo = nextDemo % 4 + 1;
      demoBack = createStoryBack(() => {
        audio.play('button');
        stopDemo();
      });
      byId('battle').append(demoBack);
      front.close();
      playMission(false);
    } catch {
      stopDemo();
      showModal('Demo', [text(t('Media unavailable'))], [['Back', closeModal, 'negative']]);
    }
  }

  function stopDemo() {
    const returnToStory = demoReturn;
    demoReturn = undefined;
    battleActive = false;
    clearTimeout(tickTimer);
    tickTimer = undefined;
    demoBack?.remove();
    demoBack = undefined;
    showHud(false);
    returnToStory?.();
  }

  function centerDemo(world) {
    const [x, y] = world.mission.start;
    adapter.centerOn((x + 7) * world.tileSize, (y + 6) * world.tileSize, {useEdgeRoom:false});
  }

  async function loadQuickBattle(entry, options, resume = false) {
    const {readScenarioMap} = await import('./scenarios/data.js');
    const pud = await readScenarioMap(entry);
    const {world} = await loadBattle({op:'loadScenario', id:entry.id, title:entry.title,
      description:entry.description, pud, options}, resume);
    return world;
  }

  function discardCheckpoint() {
    ++checkpointEpoch;
    if (!directMode) checkpointWork = checkpointWork.then(() => checkpoints.clear()).catch(() => {});
  }

  function saveCheckpoint(force = false) {
    if (directMode || demoReturn || !battleActive || loadingMission || outcomeShown) return Promise.resolve();
    if (savingCheckpoint) return savingCheckpoint;
    const now = performance.now();
    if (!force && now - checkpointTime < (checkpointSoon ? 2000 : 15000)) return Promise.resolve();
    const key = checkpointKey(adapter.world);
    if (!key) return Promise.resolve();
    checkpointTime = now;
    checkpointSoon = false;
    const epoch = checkpointEpoch;
    const view = adapter.view;
    const camera = view && {x:view.visibleGlobal.x + view.width / 2, y:view.visibleGlobal.y + view.height / 2};
    savingCheckpoint = adapter.checkpoint().then(bytes => {
      if (epoch !== checkpointEpoch) return;
      checkpointWork = checkpointWork.then(() => checkpoints.write(key, bytes, camera)).catch(() => {});
      return checkpointWork;
    }).catch(() => {}).finally(() => { savingCheckpoint = undefined; });
    return savingCheckpoint;
  }

  async function loadBattle(command, resume = false) {
    battleActive = false;
    loadingMission = true;
    outcomeShown = false;
    clearTimeout(tickTimer);
    tickTimer = undefined;
    controls.cancel();
    showHud(false);
    commandGroup = armed = aim = placement = placementTile = selectBox = notice = lastPortrait = null;
    selectionKey = infoKey = panelKey = '';
    savedCamera = undefined;
    ++checkpointEpoch;
    try {
      let mission = await adapter.run(command);
      let restored = false;
      if (resume && !directMode) {
        const saved = await checkpoints.read(checkpointKey(mission)).catch(() => null);
        if (saved) {
          try {
            mission = await adapter.run({op:'restoreCheckpoint', checkpoint:saved.bytes});
            savedCamera = saved.camera;
            restored = true;
          } catch {
            mission = await adapter.run(command);
          }
        }
      }
      const source = eraDirectory(mission);
      const nextRenderer = createMapRenderer(game, minimap, mission, scheduleFrame);
      art = await Promise.all([readJson(source + '/ui.json'), readImage(source + '/ui.webp')])
        .then(([meta, picture]) => artwork(meta, picture)).catch(() => defaultArt);
      for (const [field, element] of Object.entries(resourceValues)) {
        element.parentElement.firstChild.replaceWith(art.resource(field));
      }
      renderer = await nextRenderer;
      if (!restored && !mission.demo) {
        await adapter.run({op:'speed', speed:7});
        if (mission.mission.campaign !== 'quick' && !setting('fog', true))
          await adapter.run({op:'fog', enabled:false});
      }
      renderer.update(adapter.world);
      const race = mission.race === 1 || mission.mission.campaign === 'orc' || mission.mission.campaign === 'xorc'
        ? 'orc' : 'human';
      byId('battle').dataset.race = race;
      audio.race(race);
      if (!restored && !mission.demo) discardCheckpoint();
      return {world:adapter.world, restored};
    } finally { loadingMission = false; }
  }

  function playMission(showObjectivesAtStart = true) {
    battleActive = true;
    outcomeShown = false;
    showHud(!demoReturn);
    adapter.frame(performance.now());
    const world = adapter.world;
    const home = world.units.find(unit => unit.owner === world.player && [74,75].includes(unit.kind)) ??
      world.units.find(unit => unit.owner === world.player);
    if (demoReturn) centerDemo(world);
    else if (Number.isFinite(savedCamera?.x) && Number.isFinite(savedCamera?.y))
      adapter.centerOn(savedCamera.x, savedCamera.y);
    else if (home) adapter.centerOn(home.x + home.width / 2, home.y + home.height / 2);
    if (!demoReturn) updateHud(world);
    nextTick = 0;
    checkpointTime = performance.now();
    checkpointSoon = true;
    if (showObjectivesAtStart && setting('objectives', true)) showObjectives(closeModal);
    scheduleFrame();
    scheduleTick();
  }

  function toFront() {
    battleActive = false;
    audio.media(false);
    closeModal();
    showHud(false);
    front.home();
  }

  function onError(error) {
    notice = {message: error.message || String(error), until: performance.now() + 2200};
    if (battleActive) updateHud(adapter.world);
    audio.play('error');
  }

  function onWorld(world, command) {
    if (!battleActive || loadingMission || !renderer) return;
    const visual = renderer.update(world);
    const sounds = {
      acknowledge: 'ack', select: 'select', ready: 'ready', attack: 'sword',
      construction: 'construct', constructing: 'construct', chop: 'chop', workComplete: 'workComplete',
    };
    for (const {cue, kind, tile} of world.sounds ?? []) {
      if (tile && adapter.view) {
        const {visibleGlobal: origin, width, height} = adapter.view;
        const [x, y] = tile.map(value => value * world.tileSize);
        if (x < origin.x || y < origin.y || x > origin.x + width || y > origin.y + height) continue;
      }
      if (['acknowledge', 'select', 'ready'].includes(cue)) {
        audio.play(sounds[cue] + '-' + kind);
      } else if (cue === 'buildingSelect') {
        audio.play('buildingSelect-' + kind, [58,59].includes(kind) ? 'farm' : kind === 92 ? 'mine' : 'button');
      } else if (cue === 'workComplete' || cue === 'help' || cue === 'buildingHelp') {
        const race = byId('battle').dataset.race;
        audio.play((cue === 'workComplete' ? 'workComplete-' : 'under-attack-') + race, sounds[cue]);
      } else if (sounds[cue]) {
        audio.play(sounds[cue]);
      }
    }
    if (demoReturn) {
      if (world.demo?.finished) stopDemo();
      else if (visual) scheduleFrame();
      return;
    }
    updateHud(world);
    if (!outcomeShown && world.outcome && world.outcome !== 'running') {
      outcomeShown = true;
      discardCheckpoint();
      const score = world.score.missionScore ?? world.score.score;
      const total = front.scoreTotal(world.mission, score);
      if (!directMode) front.recordResult(world.outcome, world.mission, world.nextMission, score);
      showOutcome(world, total);
    }
    if (checkpointUpdates.has(command.op)) checkpointSoon = true;
    if (command.op === 'step' && performance.now() - checkpointTime >= (checkpointSoon ? 2000 : 15000))
      saveCheckpoint();
    if (visual || command.op !== 'step') scheduleFrame();
  }

  function showModal(title, content, actions) {
    controls.cancel();
    clearTimeout(tickTimer);
    tickTimer = undefined;
    byId('modal-title').textContent = t(title);
    byId('modal-content').replaceChildren(...content);
    byId('modal-actions').replaceChildren(...actions.map(([label, activate, tone, wide]) =>
      button(t(label), () => { audio.play('button'); activate(); }, (tone ?? '') + (wide ? ' wide' : ''))));
    if (!modal.open) modal.showModal();
  }

  function text(value) {
    const paragraph = document.createElement('p');
    paragraph.textContent = value;
    return paragraph;
  }

  function closeModal() {
    modal.close();
    nextTick = 0;
    scheduleFrame();
    scheduleTick();
  }

  function showMenu() {
    showModal('Game Menu', [], [
      ['Objectives', showObjectives, '', true],
      ['Settings', showBattleSettings, '', true],
      ['Restart', showRestart, '', true],
      ['Exit to Main Menu', showExit, '', true],
      ['Back', closeModal, 'negative', true],
    ]);
  }

  function checkControl(label, enabled, onChange) {
    const row = document.createElement('label');
    row.className = 'check-control';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = enabled;
    check.addEventListener('change', () => { audio.play('button'); onChange(check.checked); });
    row.append(check, t(label));
    return row;
  }

  function showObjectives(back = showMenu) {
    const goals = missionLabel(adapter.world.mission).objectives;
    const list = document.createElement('ul');
    for (const goal of goals ?? []) {
      const line = document.createElement('li');
      line.textContent = goal;
      list.append(line);
    }
    showModal('Mission Objectives', [list, checkControl('Show every time', setting('objectives', true),
      value => setSetting('objectives', value))], [['OK', back, 'positive']]);
  }

  function volumeControls() {
    return [['music', 'Music'], ['effects', 'Sound effects']].map(([key, name]) => {
      const label = document.createElement('label');
      label.className = 'sound-control';
      label.append(text(t(name)));
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0'; slider.max = '100';
      slider.value = String(Math.round(audio.volumes[key] * 100));
      slider.setAttribute('aria-label', t(name));
      slider.addEventListener('input', () => audio.change(key, Number(slider.value) / 100));
      label.append(slider);
      return label;
    });
  }

  function showSound(back) {
    showModal('Sound', volumeControls(), [['Back', back, 'negative']]);
  }

  function showBattleSettings() {
    const fog = checkControl('Fog of war', adapter.world.fog, enabled => {
      setSetting('fog', enabled);
      adapter.send({op:'fog', enabled});
    });
    const speed = document.createElement('div');
    speed.className = 'speed-controls';
    const choices = [['Slow', 4], ['Medium', 7], ['Fast', 8]];
    for (const [label, value] of choices) {
      const choice = button(t(label), () => {
        audio.play('button');
        adapter.send({op:'speed', speed:value});
        for (const other of speed.children) other.classList.toggle('active', other === choice);
      });
      choice.classList.toggle('active', adapter.world.speed === value);
      speed.append(choice);
    }
    showModal('Settings', [...volumeControls(), fog, text(t('Game speed')), speed],
      [['Back', showMenu, 'negative']]);
  }

  function showRestart() {
    const warning = text(t('Progress in this battle will be replaced.'));
    warning.className = 'warning';
    showModal('Restart the mission?', [warning], [
      ['OK', async () => {
        try {
          await loadBattle({op:'restart'});
          closeModal();
          playMission();
        } catch (error) {
          showModal('Unable to load the mission', [text(error.message)], [['Main Menu', toFront, 'positive']]);
        }
      }, 'positive'], ['Back', showMenu, 'negative'],
    ]);
  }

  function showExit() {
    showModal('Exit to the Main Menu?', [],
      [['OK', async () => { await saveCheckpoint(true); toFront(); }, 'positive'], ['Back', showMenu, 'negative']]);
  }

  async function showOutcome(world, totalScore) {
    const won = world.outcome === 'victory';
    const next = world.nextMission;
    const advance = won && Number.isInteger(next) ? () => { toFront(); front.next(next); } : undefined;
    try {
      const {showResults} = await import('./results-ui.js');
      await showResults({
        world:{...world, score:{...world.score, totalScore}}, won, language:currentLanguage(),
        onAdvance:advance, onMenu:toFront, musicVolume:audio.volumes.music,
        onClick:() => audio.play('button'), onSound:key => audio.play(key),
        onMediaChange:stage => audio.media(stage === 'statistics'),
      });
    } catch {
      audio.media(false);
      showModal(won ? 'Victory' : 'Defeat', [], [['Continue', advance ?? toFront, 'positive']]);
    }
  }

  function purchase(command) {
    const cancellation = command.op === 'cancel';
    const preview = document.createElement('div');
    preview.className = 'purchase-preview';
    preview.append(art.icon(commandIcon(command)), text(description(command) || commandLabel(command)));
    showModal(`${commandLabel(command)}?`, [preview], [
      [cancellation ? 'OK' : 'Buy', () => {
        const current = adapter.world.actions.find(entry => commandKey(entry) === commandKey(command));
        if (!current?.enabled) return;
        closeModal();
        adapter.send({op: command.op, kind: command.kind, action: command.action});
      }, 'positive'],
      ['Cancel', closeModal, 'negative'],
    ]);
  }

  function previewBuilding(point) {
    const pending = placement;
    if (!pending) return;
    placementTile = null;
    byId('place-button').disabled = true;
    scheduleFrame();
    adapter.run({op: 'checkBuild', kind: pending.kind, ...point}).then(world => {
      if (placement !== pending) return;
      placementTile = world.placement && {...world.placement, kind: pending.kind, point};
      byId('place-button').disabled = !placementTile?.valid;
      updateHud(world);
      scheduleFrame();
    }).catch(() => {});
  }

  function cancelPlacement() {
    placement = placementTile = null;
    updateHud(adapter.world);
    scheduleFrame();
  }

  function confirmPlacement() {
    if (!placement || !placementTile?.valid) return;
    audio.play('button');
    const {kind} = placement;
    const point = placementTile.point;
    byId('place-button').disabled = true;
    adapter.run({op: 'build', kind, ...point}).then(cancelPlacement).catch(() => {
      byId('place-button').disabled = false;
    });
  }

  function commandIcon(command) {
    if (Number.isInteger(command.icon)) return command.icon;
    if (command.op === 'cancel' || command.op === 'back') return cancelGlyph;
    if (command.op === 'buildMenu') return command.kind ? 88 : 87;
    if (command.op === 'stop') return 164;
    if (command.op === 'hold') return 180;
    return targetIcons[command.action] ?? art.portraitId(command.kind);
  }

  function activateCommand(command) {
    audio.play('button');
    if (command.op === 'back') {
      aim = commandGroup = armed = null;
    } else if (command.op === 'cancel') {
      purchase(command);
    } else if (armed !== commandKey(command) || command.enabled === false) {
      armed = commandKey(command);
    } else {
      armed = null;
      if (command.op === 'buildMenu') commandGroup = command.kind;
      else if (command.op === 'build') {
        placement = {...command, key: commandKey(command)};
        placementTile = null;
        byId('place-button').disabled = true;
      } else if (command.op === 'target') aim = command;
      else if (['train', 'upgrade', 'research'].includes(command.op)) purchase(command);
      else adapter.send({op: command.op, kind: command.kind, action: command.action});
    }
    updateHud(adapter.world);
  }

  function paintSelection(world) {
    const units = world.selection.map(id => world.units.find(unit => unit.id === id)).filter(Boolean);
    const key = units.map(unit => [unit.id, unit.kind, unit.hp, unit.progress, unit.construction,
      unit.production, unit.level, unit.resourcesAmount].join(':')).join(',');
    if (infoKey === key) return;
    infoKey = key;
    selection.replaceChildren();
    if (!units.length) return;
    const grid = document.createElement('div');
    grid.className = units.length === 1 ? 'one-selected' : 'portraits';
    for (const unit of units) {
      const portrait = document.createElement('button');
      portrait.type = 'button';
      portrait.className = 'portrait';
      portrait.setAttribute('aria-label', unitLabel(unit.kind, unit.name ?? unitNames[unit.kind] ?? 'Center on unit'));
      const meter = document.createElement('div');
      meter.className = 'health';
      const bar = document.createElement('span');
      bar.style.width = `${clamp(unit.hp / Math.max(1, unit.maxHp), 1) * 100}%`;
      meter.append(bar);
      portrait.append(art.portrait(unit.kind), meter);
      portrait.addEventListener('click', () => {
        const live = adapter.world.units.find(entry => entry.id === unit.id);
        if (!live) return;
        const now = performance.now();
        if (units.length > 1 && lastPortrait?.unit === unit.id && now - lastPortrait.time < 350) {
          adapter.send({op: 'selectIds', ids: [unit.id]});
        }
        lastPortrait = {unit: unit.id, time: now};
        adapter.centerOn(live.x + live.width / 2, live.y + live.height / 2);
      });
      grid.append(portrait);
    }
    if (units.length === 1) {
      const unit = units[0];
      const name = document.createElement('span');
      name.textContent = unitLabel(unit.kind, unit.name ?? unitNames[unit.kind] ?? (unit.building ? 'Building' : 'Unit'));
      grid.append(name);
      const stats = document.createElement('div');
      stats.className = 'stats';
      stats.textContent = `${unit.hp} / ${unit.maxHp}`;
      const rows = unit.kind === 92 ? [['Gold left', unit.resourcesAmount ?? unit.resources * 100]] : !unit.building ? [
        ['Armor', unit.armor], ['Damage', unit.damageRange?.join('–')], ['Range', unit.range],
        ['Sight', unit.sight], ['Speed', unit.displaySpeed],
      ] : [];
      for (const [label, value] of rows) {
        if (value == null) continue;
        const row = document.createElement('div');
        row.textContent = `${t(label)}: ${value}`;
        stats.append(row);
      }
      if (typeof unit.progress === 'number' && unit.progress >= 0) {
        const progress = unit.progress * 100 / 255;
        const bar = document.createElement('div');
        bar.className = 'progress-track';
        bar.style.setProperty('--progress', progress + '%');
        bar.textContent = Math.floor(progress) + '% ' + t('complete');
        stats.append(bar);
      }
      selection.append(grid, stats);
    } else selection.append(grid);
  }

  function shownActions(world) {
    if (placement) return [];
    if (aim) return [{op: 'back', label: 'Cancel', enabled: true}];
    const actions = world.actions ?? [];
    if (commandGroup != null) {
      const builds = actions.filter(command => command.op === 'build' &&
        Boolean(command.advanced) === Boolean(commandGroup));
      return [...builds.slice(0, 8), {op: 'back', label: 'Back', enabled: true}];
    }
    const basic = actions.some(command => command.op === 'build' && !command.advanced);
    const advanced = actions.some(command => command.op === 'build' && command.advanced);
    return [
      ...actions.filter(command => command.op !== 'build'),
      ...(basic ? [{op: 'buildMenu', kind: 0, label: 'Build Basic Structures', enabled: true, slot: 6}] : []),
      ...(advanced ? [{op: 'buildMenu', kind: 1, label: 'Build Advanced Structures', enabled: true, slot: 7}] : []),
    ];
  }

  function showCommands(world) {
    const actions = shownActions(world);
    const key = JSON.stringify([actions, armed, Boolean(placement)]);
    if (panelKey !== key) {
      panelKey = key;
      commands.replaceChildren();
      const used = new Set();
      actions.forEach((command, index) => {
        const el = document.createElement('button');
        el.type = 'button';
        const cancel = ['back', 'cancel'].includes(command.op);
        let slot = command.slot ?? targetSlots[command.action] ?? (command.op === 'stop' ? 1 : index);
        if (used.has(slot) || slot < 0 || slot > 8)
          slot = Array.from({length: 9}, (_, n) => n).find(n => !used.has(n));
        if (!cancel && slot == null) return;
        if (!cancel) used.add(slot);
        el.className = 'command' + (cancel ? ' cancel' : '') +
          (armed === commandKey(command) ? ' armed' : '') +
          (command.enabled === false ? ' unavailable' : '');
        el.title = priceLabel(command);
        el.setAttribute('aria-label', commandLabel(command));
        el.dataset.command = command.op;
        if (command.kind != null) el.dataset.kind = command.kind;
        if (command.action != null) el.dataset.action = command.action;
        if (!cancel) {
          el.style.gridColumn = slot % 3 + 1;
          el.style.gridRow = 3 - Math.floor(slot / 3);
        }
        el.append(art.icon(commandIcon(command)));
        el.addEventListener('click', () => activateCommand(command));
        commands.append(el);
      });
    }
    commands.hidden = Boolean(placement);
    byId('placement').hidden = !placement;
    byId('command-area').classList.toggle('placing', Boolean(placement));
    const armedCommand = actions.find(cmd => commandKey(cmd) === armed);
    const message = notice?.until > performance.now() ? notice.message : placement ?
      t(placementTile && !placementTile.valid ? 'Choose another site' : 'Choose a site, then tap Place') :
      aim ? commandLabel(aim) + ' — ' + t('Tap a target') : armedCommand ? priceLabel(armedCommand) : '';
    if (detail.textContent !== message) detail.textContent = message;
    detail.hidden = !message;
  }

  function updateHud(world) {
    const ids = world.selection.join(',');
    if (selectionKey !== ids) {
      selectionKey = ids;
      commandGroup = armed = aim = placement = placementTile = null;
    }
    const values = {...world.resources, food: world.resources.foodUsed + '/' + world.resources.foodSupply};
    for (const [key, element] of Object.entries(resourceValues)) {
      if (element.textContent !== String(values[key])) element.textContent = values[key];
    }
    paintSelection(world);
    showCommands(world);
  }

  function centerFromMinimap(event) {
    const rect = minimap.getBoundingClientRect();
    const world = adapter.world;
    const x = (event.clientX - rect.left) / rect.width * world.width * world.tileSize;
    const y = (event.clientY - rect.top) / rect.height * world.height * world.tileSize;
    adapter.centerOn(clamp(x, world.width * world.tileSize), clamp(y, world.height * world.tileSize));
  }

  minimap.addEventListener('pointerdown', event => {
    controls.cancel();
    minimap.setPointerCapture(event.pointerId);
    centerFromMinimap(event);
  });
  minimap.addEventListener('pointermove', event => {
    if (minimap.hasPointerCapture(event.pointerId)) centerFromMinimap(event);
  });
  byId('menu-button').addEventListener('click', () => { audio.play('button'); showMenu(); });
  byId('place-button').addEventListener('click', confirmPlacement);
  byId('cancel-placement').addEventListener('click', () => { audio.play('button'); cancelPlacement(); });
  modal.addEventListener('cancel', event => {
    event.preventDefault();
    if (!outcomeShown) closeModal();
  });
  function syncProjection() {
    const next = game.getBoundingClientRect();
    if (next.width !== canvasRect.width || next.height !== canvasRect.height ||
        next.left !== canvasRect.left || next.top !== canvasRect.top) {
      controls.cancel();
      canvasRect = next;
      adapter.frame(performance.now());
      if (battleActive && demoReturn) centerDemo(adapter.world);
      scheduleFrame();
    }
  }
  const resize = new ResizeObserver(syncProjection);
  resize.observe(game);
  window.addEventListener('resize', syncProjection);

  function draw(time) {
    frameRequested = false;
    if (!battleActive || stopped || document.hidden || !renderer) return;
    const view = adapter.frame(time);
    renderer.draw(view, canvasRect, placementTile, selectBox);
    if (adapter.cameraMoving) scheduleFrame();
  }

  function scheduleFrame() {
    if (battleActive && !frameRequested && !stopped && !document.hidden) {
      frameRequested = true;
      requestAnimationFrame(draw);
    }
  }

  function scheduleTick() {
    if (!battleActive || tickTimer !== undefined || stepPending || stopped || document.hidden || modal.open || outcomeShown) return;
    tickTimer = setTimeout(async () => {
      tickTimer = undefined;
      if (!battleActive || stopped || document.hidden || modal.open || outcomeShown) return;
      const time = performance.now();
      const duration = adapter.world.cycleMs || tickMs;
      const cycles = nextTick === 0 ? 1 : Math.min(3, 1 + Math.max(0, Math.floor((time - nextTick) / duration)));
      nextTick = nextTick === 0 ? time + duration : Math.max(time + 1, nextTick + cycles * duration);
      stepPending = true;
      try { await adapter.run({op: 'step', cycles}); } catch {}
      finally { stepPending = false; scheduleTick(); }
    }, nextTick ? Math.max(0, nextTick - performance.now()) : 0);
  }

  document.addEventListener('visibilitychange', () => {
    nextTick = 0;
    if (document.hidden) {
      saveCheckpoint(true);
      clearTimeout(tickTimer);
      tickTimer = undefined;
      controls.cancel();
    } else {
      scheduleFrame();
      scheduleTick();
    }
  });
  window.addEventListener('pagehide', event => {
    saveCheckpoint(true);
    if (event.persisted) { controls.cancel(); return; }
    stopped = true;
    clearTimeout(tickTimer);
    resize.disconnect();
    window.removeEventListener('resize', syncProjection);
    controls.destroy();
  });

  window.__tidewaterPilot = Object.freeze({
    world: () => structuredClone(adapter.world),
    state: () => ({
      screen:battleActive ? (demoReturn ? 'demo' : outcomeShown ? 'results' : 'battle') : byId('front').dataset.screen,
      progress:front.progress.exportProgress(),
    }),
    camera() {
      syncProjection();
      return structuredClone(adapter.view);
    },
    screenPoint(x, y) {
      syncProjection();
      const view = adapter.view;
      if (!view) return null;
      const scale = canvasRect.width / view.width;
      return {x: canvasRect.left + (x - view.visibleGlobal.x) * scale,
        y: canvasRect.top + (y - view.visibleGlobal.y) * scale};
    },
  });
  updateLanguage();
  if (directMode) {
    await loadMission(Number(direct));
    playMission(false);
  } else front.home();
  byId('loading').hidden = true;
  window.dispatchEvent(new Event('tidewater:ready'));
  scheduleFrame();
  scheduleTick();
}

start().catch(error => {
  byId('loading-text').textContent = error.message || String(error);
  byId('loading-progress').hidden = true;
  const retry = byId('retry');
  retry.hidden = false;
  retry.addEventListener('click', () => location.reload(), {once: true});
});
