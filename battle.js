import {createTidewater} from './engine.js';
import {createMapRenderer, readImage, readJson, eraDirectory} from './map-renderer.js';
import {createCampaignUi} from './campaign-ui.js';
import {checkpointKey, createCheckpointStore} from './checkpoint-store.js';
import {commandLabel, commandReason, currentLanguage, missionLabel, setLanguage, translate as t, unitLabel} from './localization.js';
import {commandDescription} from './command-descriptions.js';
import {createMusicLoop} from './music-loop.js';
import {createMusicFade} from './music-fade.js';

const byId = id => document.getElementById(id);
const game = byId('game');
const minimap = byId('minimap');
const selection = byId('selection');
const commands = byId('commands');
const detail = byId('command-detail');
const modal = byId('modal');
const cancelGlyph = 91;
const tickMs = 40;
const maxPartySize = 9;
const checkpointUpdates = new Set([
  'smart','move','target','build','train','upgrade','research','cancel','returnGoods','cast','unload','unloadOne','fog','speed',
]);
const unitNames = {0: 'Footman', 1: 'Grunt', 2: 'Peasant', 3: 'Peon', 58: 'Farm', 59: 'Pig Farm',
  60: 'Barracks', 61: 'Barracks', 74: 'Town Hall', 75: 'Great Hall', 92: 'Gold Mine'};
const targetIcons = {move: 83, attack: 116, repair: 85, harvest: 86, patrol: 184};
const targetSlots = {move: 0, attack: 2, repair: 3, harvest: 4, patrol: 3};
const orderCommands = {
  idle:'stop', holding:'hold', returning:'returnGoods', unload:'unload',
  moving:'target:move', attacking:'target:attack', attackGround:'target:attackGround',
  demolish:'target:demolish', patrolling:'target:patrol', repairing:'target:repair', harvesting:'target:harvest',
};
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
  return commandCosts(command).map(([, label, amount]) => amount + ' ' + t(label)).join(' · ');
}

function commandCosts(command) {
  if (command?.manaCost) return [['mana', 'Mana', command.manaCost]];
  return (command?.cost ?? []).flatMap((amount, index) =>
    amount && resourceFields[index] ? [[...resourceFields[index], amount]] : []);
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
  let manualVerticalPan = false;
  let queued = Promise.resolve();
  let remembered = [];
  let demoSelection;
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
    manualVerticalPan = false;
    pressed.clear();
    remembered = [];
    demoSelection = undefined;
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
      if (world.demo) {
        const retained = world.units.some(unit => unit.id === demoSelection && selectable(unit));
        world.selection = retained ? [demoSelection] : [];
      }
      onWorld(world, command);
      return world;
    });
    queued = operation.catch(onError);
    return operation;
  }

  const extendsBelowMap = projection =>
    projection.visibleGlobal.y + projection.height > geometry.world.bottom + .01;
  const bottomCenter = projection => geometry.world.bottom - projection.height / 2;

  function frame(time) {
    const {width, height} = getRect();
    if (width <= 0 || height <= 0) return view;
    const previous = view;
    view = camera.frame(geometry, width, height, time, null, mapEdgeRoom);
    const resized = previous && view && (previous.width !== view.width || previous.height !== view.height);
    if (resized && extendsBelowMap(view) &&
        (!extendsBelowMap(previous) || (height > width && !manualVerticalPan))) {
      const x = view.visibleGlobal.x + view.width / 2;
      camera.centerOn(x, bottomCenter(view), {useEdgeRoom:true});
      view = camera.frame(geometry, width, height, time, null, mapEdgeRoom);
    }
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

  const touchRadius = () => Math.min(12, Math.ceil(7 * view.width / getRect().width));
  const selectable = unit => unit.hp > 0 && !unit.dying;
  const groupSelectable = unit => unit.owner === world.player && unit.rectSelectable;
  const overlaps = (unit, left, top, right, bottom) => unit.x < right && unit.x + unit.width > left &&
    unit.y < bottom && unit.y + unit.height > top;

  function touchTapSubject({x, y}) {
    if (!view) return undefined;
    let found;
    let nearest = touchRadius();
    let nearestCentre = Infinity;
    for (const unit of world.units) {
      if (!selectable(unit)) continue;
      const dx = x - Math.max(unit.x, Math.min(unit.x + unit.width, x));
      const dy = y - Math.max(unit.y, Math.min(unit.y + unit.height, y));
      const distance = Math.hypot(dx, dy);
      const centre = Math.hypot(x - unit.x - unit.width / 2, y - unit.y - unit.height / 2);
      if (distance > nearest || (distance === nearest && centre >= nearestCentre)) continue;
      found = unit;
      nearest = distance;
      nearestCentre = centre;
    }
    return found?.id;
  }

  function inspectDemo(x, y) {
    demoSelection = touchTapSubject({x, y});
    world = {...world, selection:demoSelection == null ? [] : [demoSelection], sounds:[]};
    onWorld(world, {op:'inspectDemo'});
  }

  function handleSameUnitDoubleTap(id, point, restoreSelection) {
    if (world.demo) {
      inspectDemo(point.x, point.y);
      return true;
    }
    if (id == null || touchTapSubject(point) !== id) return false;
    const leader = world.units.find(unit => unit.id === id);
    if (!leader) return false;
    const priorSelection = restoreSelection ? remembered : world.selection;
    if (leader.transport && world.units.some(unit =>
      priorSelection.includes(unit.id) && unit.canBoardTransport && selectable(unit))) {
      // Use the transport's footprint even if the tap landed in its touch margin.
      const x = leader.x + leader.width / 2, y = leader.y + leader.height / 2;
      if (restoreSelection) orderWithTouchSelection(x, y);
      else send({op:'smart', x, y});
      return true;
    }
    if (leader.kind === 0x39) {
      // A second tap on the same critter is a selection click. A smart order
      // would reset the original game's click count via acknowledgement.
      send({op:'selectIds', ids:[id]});
      return true;
    }
    if (!groupSelectable(leader)) return false;
    if (!priorSelection.includes(id)) {
      const party = priorSelection.filter(selectedId => world.units.some(unit =>
        unit.id === selectedId && selectable(unit) && groupSelectable(unit)));
      if (party.length < maxPartySize) party.push(id);
      send({op:'selectIds', ids:party, silent:restoreSelection});
      return true;
    }
    const {x, y} = view.visibleGlobal;
    const radius = Math.max(14, Math.ceil(view.width / world.tileSize)) - 1;
    const neighbors = world.units.filter(unit => unit.id !== id && unit.kind === leader.kind &&
      selectable(unit) && groupSelectable(unit) &&
      overlaps(unit, x, y, x + view.width, y + view.height)).map(unit => {
      const dx = unit.tileX - leader.tileX, dy = unit.tileY - leader.tileY;
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      // Original BNE scans each square ring east, south, west, then north.
      const step = dy === -ring ? dx + ring : dx === ring ? 3 * ring + dy :
        dy === ring ? 5 * ring - dx : 7 * ring - dy;
      return {id:unit.id, ring, step};
    }).filter(unit => unit.ring <= radius)
      .sort((a, b) => a.ring - b.ring || a.step - b.step);
    send({op:'selectIds', ids:[id, ...neighbors.slice(0, maxPartySize - 1).map(unit => unit.id)],
      silent:restoreSelection});
    return true;
  }

  function orderWithTouchSelection(x, y) {
    send({op:'selectIds', ids: remembered, silent: true});
    send({op:'smart', x, y});
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
    if (world.demo) {
      if (id === 0 && Math.hypot(start.x - x, start.y - y) <= 5) inspectDemo(x, y);
      return;
    }
    if (id === 1) {
      if (action.placement()) action.cancelPlacement();
      else send({op: 'smart', x, y});
    } else if (action.target()) {
      action.finishTarget(x, y);
    } else if (Math.hypot(start.x - x, start.y - y) <= 5) {
      send({op: 'select', x, y, radius: touchRadius()});
    } else {
      const left = Math.min(start.x, x), right = Math.max(start.x, x);
      const top = Math.min(start.y, y), bottom = Math.max(start.y, y);
      const candidates = world.units.filter(unit => selectable(unit) && overlaps(unit, left, top, right, bottom));
      const group = candidates.filter(groupSelectable).slice(0, maxPartySize);
      if (group.length || candidates.length) {
        const ids = (group.length ? group : [candidates.at(-1)]).map(unit => unit.id);
        send({op: 'selectIds', ids});
      }
    }
  }

  function panPixels(dx, dy, time) {
    if (dy) manualVerticalPan = true;
    camera.move(dx, dy, time);
    onFrame();
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
    touchTapSubject,
    handleSameUnitDoubleTap,
    panTiles(dx, dy) { panPixels(dx * 32, dy * 32, performance.now()); },
    beginPan: (...args) => camera.begin(...args),
    panPixels,
    endPan(...args) { camera.end(...args); onFrame(); },
    stopPan() { camera.stop(); onFrame(); },
    clearSelection: () => send({op: 'selectIds', ids: []}),
    retainsTouchSelection: () => true,
    rememberTouchSelection() { remembered = [...world.selection]; },
    orderWithTouchSelection,
    buildingWorldPoint: (x, y) => ({x, y}),
    getBuildingContext: () => action.placement()?.key,
    previewBuilding: point => action.preview(point),
    confirmBuilding: () => false,
    requestActionCancellation: () => { action.cancelPlacement(); return true; },
    cancelPendingInput() { pressed.clear(); onBox(null); },
  };
  return {
    frame, run, input, send, checkpoint,
    centerOn(x, y, {useEdgeRoom = true, clampBottom = false} = {}) {
      manualVerticalPan = false;
      if (view && (clampBottom || view.height > view.width)) {
        y = Math.min(y, bottomCenter(view));
      }
      camera.centerOn(x, y, {useEdgeRoom});
      onFrame();
    },
    get world() { return world; },
    get view() { return view; },
    get cameraMoving() { return camera.active; },
  };
}

function localPlayerColour(world) {
  return world.playerColour ?? world.units.find(unit => unit.owner === world.player)?.colour ?? world.player;
}

function artwork(meta, atlas) {
  const colouredIcons = new Map();
  const make = (source, label, picture = atlas) => {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    if (!source) return canvas;
    const [x, y, w, h] = source;
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.drawImage(picture, x, y, w, h, 0, 0, w, h);
    if (label != null) canvas.dataset.art = label;
    return canvas;
  };
  function icon(id, colour, label = id) {
    const source = meta.icons[id];
    if (!source || !meta.teamIcons?.[id]) return make(source, label);
    const shades = meta.teamColours[colour] ?? meta.teamColours[0];
    const key = `${id}:${colour ?? 0}`;
    if (!colouredIcons.has(key)) {
      const raster = make(source);
      const context = raster.getContext('2d');
      const image = context.getImageData(0, 0, raster.width, raster.height);
      const rgba = image.data;
      for (let offset = 0; offset < rgba.length; offset += 4) {
        const shade = rgba[offset + 2];
        if (rgba[offset] === 1 && rgba[offset + 1] === 255 && shade < 4 && rgba[offset + 3])
          rgba.set(shades[shade], offset);
      }
      context.putImageData(image, 0, 0);
      colouredIcons.set(key, raster);
    }
    const raster = colouredIcons.get(key);
    return make([0, 0, raster.width, raster.height], label, raster);
  }
  return {
    resource(name) { return make(meta.resources[name], name); },
    icon,
    portrait(kind, colour) { return icon(meta.portraits[kind] ?? kind, colour, kind); },
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
  let music;
  let musicFade;
  let musicLoop;
  let musicKey = 'music-menu';
  let trackIndex = 0;
  let skipFirstTrack = false;
  let loopPoint = 0;
  let nextTrack;
  let narration;
  let releaseNarration;
  let audioContext;
  let channels;
  let unlocked = false;
  let mediaActive = false;
  let effectEpoch = 0;
  let constructionPlaying = false;
  const effects = new Set();
  const nativePlayers = {music: new Set(), effects: new Set()};
  const cache = new Map();
  readJson('./art/audio.json').then(source => { files = source; sync(); }).catch(() => {});
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

  function connectAudio(source, key, level = 1) {
    if (level === 1) {
      source.connect(channels[key]);
      return () => source.disconnect();
    }
    const gain = audioContext.createGain();
    gain.gain.value = level;
    source.connect(gain).connect(channels[key]);
    return () => { source.disconnect(); gain.disconnect(); };
  }

  function routeMedia(player, key, {signal, level = 1} = {}) {
    if (signal?.aborted) return;
    let source;
    try { source = audioContext?.createMediaElementSource(player); } catch {}
    let release;
    if (source) {
      release = connectAudio(source, key, level);
    } else {
      const update = () => {
        player.volume = volumes[key] * level;
        player.muted = volumes[key] * level === 0;
      };
      update();
      nativePlayers[key].add(update);
      release = () => nativePlayers[key].delete(update);
    }
    signal?.addEventListener('abort', release, {once:true});
    return release;
  }

  function clearMusic() {
    clearTimeout(nextTrack);
    nextTrack = undefined;
    musicLoop?.clear();
    if (!music?.hasAttribute('src')) return;
    music.pause();
    music.removeAttribute('src');
    music.load();
  }

  function setMusic(key, index = 0, {skipFirst = false, loopFrom = 0} = {}) {
    clearMusic();
    musicKey = key;
    skipFirstTrack = skipFirst;
    trackIndex = skipFirst && index === 0 ? 1 : index;
    loopPoint = loopFrom;
    sync();
  }

  function trackEnded() {
    if (!music.ended || nextTrack !== undefined) return;
    const tracks = files[musicKey];
    if (loopPoint) {
      music.currentTime = loopPoint;
      sync();
    } else if (tracks?.length > 1) {
      nextTrack = setTimeout(() => {
        nextTrack = undefined;
        trackIndex = (trackIndex + 1) % tracks.length || (skipFirstTrack ? 1 : 0);
        sync();
      }, 2000);
    }
  }

  function sync() {
    const tracks = files[musicKey];
    const path = tracks?.[trackIndex];
    if (!unlocked || !path || nextTrack !== undefined) return;
    const playing = volumes.music > 0 && !document.hidden && !mediaActive;
    const source = audioPath(path);
    if (tracks.length === 1 && audioContext) {
      musicLoop ??= createMusicLoop(audioContext, channels.music, sync);
      const loop = {loopStart:loopPoint, loopEnd:files.musicLoopEnds?.[path]};
      if (musicLoop.sync(source, loop, playing)) return;
    }
    if (!playing) {
      music?.pause();
      return;
    }
    if (!music) {
      music = new Audio();
      music.preload = 'auto';
      let input;
      try { input = audioContext?.createMediaElementSource(music); } catch {}
      const stage = input && audioContext.createGain();
      if (stage) input.connect(stage).connect(channels.music);
      musicFade = createMusicFade(music, stage, () => volumes.music);
      music.addEventListener('ended', trackEnded);
    }
    music.loop = tracks.length === 1 && !loopPoint;
    if (music.getAttribute('src') !== source) {
      music.src = source;
      musicFade.chain(tracks.length > 1);
    }
    if (music.paused && (tracks.length === 1 || !music.ended)) music.play().catch(() => {});
  }
  function activate() {
    const Context = window.AudioContext || window.webkitAudioContext;
    unlocked = true;
    if (!audioContext && Context) {
      try {
        const context = new Context();
        const music = context.createGain();
        const effects = context.createGain();
        music.gain.value = volumes.music;
        effects.gain.value = volumes.effects;
        music.connect(context.destination);
        effects.connect(context.destination);
        channels = {music, effects};
        audioContext = context;
      } catch {}
    }
    if (audioContext?.state !== 'running') audioContext?.resume().catch(() => {});
    sync();
  }
  function play(key) {
    const paths = clip(key);
    if (paths.length) return playFile(paths[Math.floor(Math.random() * paths.length)], 0.99, false);
  }

  function playBattleSound(file, level) {
    const localized = languageFiles.battleAudio?.[file];
    const english = files.battleAudio?.[file];
    const path = localized ? './art/lang/ru/' + localized : english && audioPath(english);
    if (path) return playFile(path, level, file === 'misc/constrct');
  }

  async function playFile(file, level, construction) {
    if (!unlocked || !volumes.effects || document.hidden) return;
    if (construction && constructionPlaying) return;
    if (construction) constructionPlaying = true;
    const epoch = effectEpoch;
    let stop;
    let release;
    function ended() {
      release?.();
      effects.delete(stop);
      if (construction && epoch === effectEpoch) constructionPlaying = false;
    }
    try {
      let data;
      if (audioContext) {
        if (!cache.has(file))
          cache.set(file, bytes(file).then(buffer => audioContext.decodeAudioData(buffer.buffer).catch(() => null)));
        data = await cache.get(file);
      }
      if (epoch !== effectEpoch || document.hidden || !volumes.effects ||
          (audioContext && audioContext.state !== 'running')) return;
      if (data) {
        const source = audioContext.createBufferSource();
        source.buffer = data;
        release = connectAudio(source, 'effects', level);
        source.addEventListener('ended', ended, {once: true});
        source.start();
        stop = () => { source.stop(); release(); };
        effects.add(stop);
      } else {
        // Some WebKit builds accept AAC as media but cannot decode it into an AudioBuffer.
        const media = new Audio(file);
        release = routeMedia(media, 'effects', {level});
        media.addEventListener('ended', ended, {once:true});
        stop = () => {
          media.pause();
          media.removeAttribute('src');
          media.load();
          release();
        };
        effects.add(stop);
        await media.play();
      }
    } catch {
      if (stop) stop();
      else { release?.(); cache.delete(file); }
      effects.delete(stop);
    } finally {
      if (construction && epoch === effectEpoch && !effects.has(stop)) constructionPlaying = false;
    }
  }

  function stopEffects() {
    ++effectEpoch;
    constructionPlaying = false;
    for (const stop of effects) stop();
    effects.clear();
  }

  function change(key, value) {
    const previous = volumes[key];
    volumes[key] = value;
    try { localStorage.setItem('tidewater-pilot-' + key, value); } catch {}
    if (channels) channels[key].gain.value = value;
    for (const update of nativePlayers[key]) update();
    if (key === 'music') {
      sync();
      musicFade?.update();
    }
    else if (previous && !value) stopEffects();
  }
  function stopBriefing() {
    narration?.pause();
    releaseNarration?.();
    narration = undefined;
    releaseNarration = undefined;
  }
  function briefing(id) {
    stopBriefing();
    const orc = id % 2 !== 0;
    setMusic(orc ? 'music-orc-briefing' : 'music-human-briefing', 0, {loopFrom: orc ? 0 : 3.020});
    const path = clip('briefing-' + id)[0];
    if (!path || !unlocked) return;
    narration = new Audio(path);
    releaseNarration = routeMedia(narration, 'effects');
    narration.play().catch(() => {});
  }
  window.addEventListener('pointerdown', activate, {passive: true, capture: true});
  window.addEventListener('pointerup', activate, {passive: true, capture: true});
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopEffects();
      audioContext?.suspend().catch(() => {});
    } else if (unlocked) audioContext?.resume().catch(() => {});
    sync();
    if (document.hidden) narration?.pause();
    else narration?.play().catch(() => {});
  });
  return {
    play, playBattleSound, change, volumes, routeMedia, briefing, stopBriefing,
    media(active) { mediaActive = active; sync(); },
    quiet() {
      stopBriefing();
      stopEffects();
      setMusic(null);
    },
    menu() {
      stopBriefing();
      stopEffects();
      mediaActive = false;
      setMusic('music-menu');
    },
    battle({mission}, race) {
      stopBriefing();
      stopEffects();
      mediaActive = false;
      const campaign = Number.isInteger(mission.id) && mission.campaign !== 'quick';
      // Track choice must never consume a draw from the simulation's generator.
      const first = campaign ? Math.floor(mission.id / 2) % 6 : Math.floor(Math.random() * 6);
      setMusic('music-' + race, first, {skipFirst: campaign && mission.id < 28});
    },
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
  let restoredBattle;
  let checkpointTime = 0;
  let checkpointSoon = false;
  let savedCamera;
  let renderer;
  const defaultArt = artwork(uiMeta, uiAtlas);
  let art = defaultArt;
  let canvasRect = game.getBoundingClientRect();
  let frameRequested = false;
  let nextTick = 0;
  let lastSoundSample = 0;
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
  let manaBar;
  let litOrder;
  let progressBar;
  let panelKey = '';
  let detailKey = '';
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
    active: () => battleActive && !loadingMission && !stopped && !document.hidden && !outcomeShown,
    action: {
      target: () => aim,
      placement: () => placement,
      cancelPlacement,
      preview: previewBuilding,
      finishTarget,
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
    stopBriefing: back => back ? audio.menu() : audio.stopBriefing(),
    async act(mission) {
      const {createActInterlude} = await import('./act-interlude.js');
      acts ??= createActInterlude();
      audio.media(true);
      try {
        await acts.play(mission.id, {
          language: currentLanguage(), volume: audio.volumes.effects, routeMedia: audio.routeMedia,
        });
      } finally { audio.media(false); }
    },
    async story(view) {
      try {
        const {createStoryUi} = await import('./story-ui.js');
        createStoryUi({
          ...view, onDemo: startDemo,
          gain: kind => audio.volumes[kind],
          routeMedia: audio.routeMedia,
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
      showModal('Update', [message], [['Back', closeModal, 'negative']], {layout:'update'});
      try {
        const result = await window.TidewaterOffline?.checkForUpdate();
        const statuses = {current:'You have the latest version.', updated:'The update is ready.',
          deferred:'The update will apply when all open game windows are at the main menu.',
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
    controls.cancel();
    clearTimeout(tickTimer);
    tickTimer = undefined;
    demoBack?.remove();
    demoBack = undefined;
    showHud(false);
    audio.menu();
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
    const camera = view && {
      x:view.visibleGlobal.x + view.width / 2,
      y:view.visibleGlobal.y + view.height / 2,
    };
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
    audio.quiet();
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
      restoredBattle = restored;
      return {world:adapter.world, restored};
    } catch (error) {
      audio.menu();
      throw error;
    } finally { loadingMission = false; }
  }

  function playMission(showObjectivesAtStart = true) {
    if (!restoredBattle && !demoReturn) discardCheckpoint();
    battleActive = true;
    outcomeShown = false;
    showHud(!demoReturn);
    syncProjection();
    adapter.frame(performance.now());
    const world = adapter.world;
    audio.battle(world, byId('battle').dataset.race);
    const home = world.units.find(unit => unit.owner === world.player && [74,75].includes(unit.kind)) ??
      world.units.find(unit => unit.owner === world.player);
    if (demoReturn) {
      centerDemo(world);
      selection.hidden = minimap.hidden = false;
      paintSelection(world);
    }
    else if (Number.isFinite(savedCamera?.x) && Number.isFinite(savedCamera?.y))
      adapter.centerOn(savedCamera.x, savedCamera.y);
    else if (home) adapter.centerOn(home.x + home.width / 2, home.y + home.height / 2, {useEdgeRoom:false});
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
    audio.menu();
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
    for (const {file, tile, offScreen} of world.sounds ?? []) {
      let level = 0.99;
      if (tile && adapter.view) {
        const {visibleGlobal: origin, width, height} = adapter.view;
        const [x, y] = tile;
        const size = world.tileSize;
        const left = Math.floor(origin.x / size);
        const top = Math.floor(origin.y / size);
        const offscreen = x < left || y < top ||
          x > left + Math.floor(width / size) || y > top + Math.floor(height / size);
        if (offscreen) {
          if (!offScreen) continue;
          level = 0.24;
        }
      }
      audio.playBattleSound(file, level);
    }
    if (demoReturn) {
      paintSelection(world);
      if (visual) scheduleFrame();
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

  function showModal(title, content, actions, {layout = ''} = {}) {
    controls.cancel();
    clearTimeout(tickTimer);
    tickTimer = undefined;
    modal.dataset.layout = layout;
    byId('modal-title').textContent = t(title);
    const modalContent = byId('modal-content');
    modalContent.replaceChildren(...content);
    const closeButtons = [];
    const buttons = actions.flatMap(([label, activate, tone, wide]) => {
      const caption = t(label);
      const control = button(caption, () => { audio.play('button'); activate(); }, tone);
      control.classList.toggle('wide', Boolean(wide));
      if (caption === t('Back') && layout !== 'battle-confirmation') {
        control.id = 'modal-close';
        control.setAttribute('aria-label', t('Close'));
        control.textContent = '×';
        closeButtons.push(control);
        return [];
      }
      control.classList.toggle('modal-back', caption === t('Back'));
      control.classList.toggle('modal-ok', caption === t('OK'));
      if (tone === 'current-choice') control.setAttribute('aria-current', 'true');
      return [control];
    });
    byId('modal-chrome').replaceChildren(...closeButtons);
    const actionRow = byId('modal-actions');
    if (layout === 'scenario-options') {
      modalContent.append(...buttons);
      actionRow.replaceChildren();
    } else {
      actionRow.replaceChildren(...buttons);
    }
    if (!modal.open) modal.showModal();
    if (layout === 'about' || layout === 'scenario-options') modalContent.scrollTop = 0;
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
      ['Restart', showRestart],
      ['Main Menu', showExit],
      ['Back', closeModal, 'negative', true],
    ], {layout:'game-menu'});
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
      value => setSetting('objectives', value))], [['Back', back, 'negative']]);
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
      let changed = false;
      slider.addEventListener('input', () => {
        audio.change(key, Number(slider.value) / 100);
        changed = true;
      });
      if (key === 'effects') {
        const preview = () => {
          if (!changed) return;
          changed = false;
          if (modal.open && slider.isConnected) audio.play('button');
        };
        const release = () => setTimeout(preview, 0);
        slider.addEventListener('change', preview);
        slider.addEventListener('pointerup', release);
        slider.addEventListener('touchend', release, {passive:true});
      }
      label.append(slider);
      return label;
    });
  }

  function showSound(back) {
    showModal('Sound', volumeControls(), [['Back', back, 'negative']]);
  }

  function showBattleSettings() {
    let gameSpeed = adapter.world.speed;
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
        if (value === gameSpeed) return;
        gameSpeed = value;
        adapter.send({op:'speed', speed:value});
        for (const other of speed.children) {
          other.classList.toggle('active', other === choice);
          other.setAttribute('aria-pressed', String(other === choice));
        }
      });
      choice.classList.toggle('active', adapter.world.speed === value);
      choice.setAttribute('aria-pressed', String(adapter.world.speed === value));
      speed.append(choice);
    }
    showModal('Settings', [...volumeControls(), fog, text(t('Game speed')), speed],
      [['Back', showMenu, 'negative']], {layout:'battle-settings'});
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
    ], {layout:'battle-confirmation'});
  }

  function showExit() {
    showModal('Exit to the Main Menu?', [],
      [['OK', async () => { await saveCheckpoint(true); toFront(); }, 'positive'], ['Back', showMenu, 'negative']],
      {layout:'battle-confirmation'});
  }

  async function finishCampaign(mission) {
    audio.media(true);
    try {
      const {playCampaignFinale} = await import('./finale-ui.js');
      await playCampaignFinale(mission, {
        language:currentLanguage(), ...audio.volumes, routeMedia:audio.routeMedia, onClick:() => audio.play('button'),
      });
    } finally {
      toFront();
      audio.media(false);
    }
  }

  async function showOutcome(world, totalScore) {
    const won = world.outcome === 'victory';
    const next = world.nextMission;
    let advance;
    if (won && Number.isInteger(next)) advance = () => { toFront(); front.next(next); };
    else if (won && [26, 27, 50, 51].includes(world.mission?.id)) {
      advance = () => finishCampaign(world.mission.id).catch(() => {});
    }
    try {
      const {showResults} = await import('./results-ui.js');
      await showResults({
        world:{...world, score:{...world.score, totalScore}}, won, language:currentLanguage(),
        onAdvance:advance, onMenu:toFront, musicVolume:audio.volumes.music,
        routeMedia:audio.routeMedia,
        onClick:() => audio.play('button'), onSound:key => audio.play(key),
        onMediaChange:stage => audio.media(stage === 'statistics'),
      });
    } catch {
      audio.media(false);
      showModal(won ? 'Victory' : 'Defeat', [], [['Continue', advance ?? toFront, 'positive']]);
    }
  }

  function costTokens(command) {
    const items = commandCosts(command);
    if (!items.length) return null;
    const costs = document.createElement('span');
    costs.className = 'resource-costs';
    for (const [name, label, amount] of items) {
      const entry = document.createElement('span');
      entry.className = 'resource-cost';
      entry.setAttribute('role', 'img');
      entry.setAttribute('aria-label', `${amount} ${t(label)}`);
      entry.append(art.resource(name), String(amount));
      costs.append(entry);
    }
    return costs;
  }

  function workSubjectKey(subject) {
    return subject ? [subject.unit, subject.op, subject.kind, subject.icon, subject.colour].join(':') : '';
  }

  function workSubjectLabel(subject) {
    if (subject.op !== 'research') return unitLabel(subject.kind, subject.label);
    const name = commandLabel(subject);
    if (!subject.level) return name;
    const title = name.replace(/\s+\(?[\p{L}]+\s+\+\d+\)?$/u, '');
    return `${title} ${subject.level === 1 ? 'I' : 'II'}`;
  }

  function workSubjectIcon(subject) {
    return art.icon(subject.icon ?? art.portraitId(subject.kind), subject.colour);
  }

  function purchase(command) {
    const cancellation = command.op === 'cancel';
    const subject = command.subject;
    const preview = document.createElement('div');
    preview.className = 'purchase-preview';
    if (cancellation) {
      if (subject) preview.append(workSubjectIcon(subject), text(workSubjectLabel(subject)));
    } else {
      preview.append(art.icon(commandIcon(command), localPlayerColour(adapter.world)),
        costTokens(command) ?? text(commandLabel(command)));
    }
    const title = cancellation ? ({
      build: 'Cancel construction?', train: 'Cancel training?',
      research: 'Cancel research?', upgrade: 'Cancel upgrade?',
    }[subject?.op] ?? 'Cancel?') : `${commandLabel(command)}?`;
    const content = preview.childElementCount ? [preview] : [];
    const summary = !cancellation && commandDescription(command, currentLanguage());
    if (summary) {
      const description = text(summary);
      description.className = 'purchase-description';
      content.push(description);
    }
    showModal(title, content, [
      [cancellation ? 'OK' : 'Buy', () => {
        const current = adapter.world.actions.find(entry => commandKey(entry) === commandKey(command));
        if (!current?.enabled || (cancellation && workSubjectKey(current.subject) !== workSubjectKey(subject))) {
          if (cancellation) closeModal();
          return;
        }
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
    const {kind} = placement;
    const point = placementTile.point;
    byId('place-button').disabled = true;
    adapter.run({op: 'build', kind, ...point}).then(world => {
      if (world.placement?.valid) {
        audio.play('thunk');
        cancelPlacement();
      } else {
        audio.play('error');
        previewBuilding(point);
      }
    }).catch(() => {
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

  function finishTarget(x, y, minimap = false) {
    if (!aim) return;
    const {action, spell} = aim;
    aim = null;
    adapter.send({op: 'target', action, spell, x, y, minimap});
    updateHud(adapter.world);
  }

  function updateProgress(value) {
    if (!progressBar || value == null) return;
    const progress = Math.floor(value * 100 / 255);
    if (progressBar.getAttribute('aria-valuenow') === String(progress)) return;
    progressBar.style.setProperty('--progress', progress + '%');
    progressBar.setAttribute('aria-valuenow', progress);
    progressBar.textContent = progress + '% ' + t('complete');
  }

  function updateMana(value) {
    if (!manaBar || manaBar.textContent === String(value)) return;
    manaBar.style.setProperty('--mana', value / 255 * 100 + '%');
    manaBar.setAttribute('aria-valuenow', value);
    manaBar.textContent = value;
  }

  function unitPortrait(unit, label, onClick) {
    const portrait = document.createElement('button');
    portrait.type = 'button';
    portrait.className = 'portrait';
    portrait.setAttribute('aria-label', label);
    const meter = document.createElement('div');
    meter.className = 'health';
    const bar = document.createElement('span');
    bar.style.width = `${clamp(unit.hp / Math.max(1, unit.maxHp), 1) * 100}%`;
    meter.append(bar);
    portrait.append(art.portrait(unit.kind, unit.colour), meter);
    portrait.addEventListener('click', onClick);
    return portrait;
  }

  function passengerPortraits(ship, passengers) {
    const grid = document.createElement('div');
    grid.className = 'portraits passenger-portraits';
    passengers.forEach((passenger, slot) => {
      if (!passenger) return;
      const name = unitLabel(passenger.kind, passenger.name ?? unitNames[passenger.kind] ?? 'Unit');
      const label = t('Unload {unit}').replace('{unit}', name);
      const portrait = unitPortrait(passenger, label, () => {
        adapter.send({op: 'unloadOne', transport: ship.id, slot, passenger: passenger.id});
      });
      portrait.title = label;
      portrait.style.gridColumnStart = slot % 3 + 1;
      portrait.style.gridRowStart = Math.floor(slot / 3) + 1;
      grid.append(portrait);
    });
    return grid;
  }

  function paintSelection(world) {
    const units = world.selection.map(id => world.units.find(unit => unit.id === id)).filter(Boolean);
    const selected = units.length === 1 ? units[0] : null;
    const subject = selected && world.actions.find(action => action.op === 'cancel' && action.subject?.unit === selected.id)?.subject;
    const passengers = selected && world.passengers;
    const cargoKey = passengers?.map(unit => unit && `${unit.id}:${unit.hp}`).join(',') ?? '';
    const key = units.map(unit => [unit.id, unit.kind, unit.colour, unit.hp, unit.progress != null, unit.construction,
      unit.level, unit.mana != null, unit.resourcesAmount].join(':')).join(',') + ':' + workSubjectKey(subject) + ':' + cargoKey;
    if (infoKey === key) {
      updateProgress(selected?.progress);
      updateMana(selected?.mana);
      return;
    }
    infoKey = key;
    progressBar = null;
    manaBar = null;
    selection.replaceChildren();
    if (!units.length) return;
    const grid = document.createElement('div');
    grid.className = units.length === 1 ? 'one-selected' : 'portraits';
    for (const unit of units) {
      const label = unitLabel(unit.kind, unit.name ?? unitNames[unit.kind] ?? 'Center on unit');
      const portrait = unitPortrait(unit, label, () => {
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
      const name = document.createElement('div');
      name.className = 'unit-name';
      name.textContent = unitLabel(unit.kind, unit.name ?? unitNames[unit.kind] ?? (unit.building ? 'Building' : 'Unit'));
      if (unit.level != null) {
        const level = document.createElement('span');
        level.className = 'unit-level';
        level.textContent = `${t('Level')} ${unit.level}`;
        name.append(level);
      }
      grid.append(name);
      if (passengers) {
        selection.append(grid, passengerPortraits(unit, passengers));
        return;
      }
      const stats = document.createElement('div');
      stats.className = 'stats';
      const own = unit.owner === world.player;
      if (own && unit.hp <= 9999 && unit.maxHp <= 9999) stats.textContent = `${unit.hp} / ${unit.maxHp}`;
      const rows = unit.kind === 92 ? [['Gold left', unit.resourcesAmount]] :
        [86, 87, 93].includes(unit.kind) && !unit.construction ? [['Oil left', unit.resourcesAmount]] :
        own && !unit.building ? [
        ['Armor', unit.armor], ['Damage', unit.damageRange?.join('–')], ['Range', unit.range],
        ['Sight', unit.sight], ['Speed', unit.displaySpeed],
      ] : [];
      for (const [label, value] of rows) {
        if (value == null) continue;
        const row = document.createElement('div');
        row.textContent = `${t(label)}: ${value}`;
        stats.append(row);
      }
      if (own && unit.mana != null) {
        const row = document.createElement('div');
        row.className = 'mana-row';
        manaBar = document.createElement('span');
        manaBar.className = 'mana-value';
        manaBar.setAttribute('role', 'meter');
        manaBar.setAttribute('aria-label', t('Mana'));
        manaBar.setAttribute('aria-valuemin', '0');
        manaBar.setAttribute('aria-valuemax', '255');
        row.append(t('Mana'), manaBar);
        stats.append(row);
        updateMana(unit.mana);
      }
      if (typeof unit.progress === 'number' && unit.progress >= 0) {
        const row = document.createElement('div');
        row.className = 'production-progress';
        if (subject && !unit.construction) row.append(workSubjectIcon(subject));
        progressBar = document.createElement('div');
        progressBar.className = 'progress-track';
        progressBar.setAttribute('role', 'progressbar');
        progressBar.setAttribute('aria-label', subject ? workSubjectLabel(subject) : t('Progress'));
        row.append(progressBar);
        stats.append(row);
        updateProgress(unit.progress);
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
    const colour = localPlayerColour(world);
    const key = JSON.stringify([actions, armed, Boolean(placement), colour]);
    if (panelKey !== key) {
      panelKey = key;
      litOrder = undefined;
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
        el.dataset.order = command.action ? command.op + ':' + command.action : command.op;
        if (!cancel) {
          el.style.gridColumn = slot % 3 + 1;
          el.style.gridRow = 3 - Math.floor(slot / 3);
        }
        el.append(art.icon(commandIcon(command), colour));
        el.addEventListener('click', () => activateCommand(command));
        commands.append(el);
      });
    }
    const primary = world.units.find(unit => unit.id === world.selection[0] && unit.owner === world.player);
    const activeOrder = orderCommands[primary?.order] ?? '';
    if (litOrder !== activeOrder) {
      litOrder = activeOrder;
      for (const command of commands.children)
        command.classList.toggle('current-order', command.dataset.order === activeOrder);
    }
    commands.hidden = Boolean(placement);
    byId('placement').hidden = !placement;
    byId('command-area').classList.toggle('placing', Boolean(placement));
    const armedCommand = actions.find(cmd => commandKey(cmd) === armed);
    const hint = notice?.until > performance.now() ? notice.message : placement ?
      (placementTile && !placementTile.valid ? commandReason(placementTile) || t('Choose another site') :
        t('Choose a site, then tap Place')) :
      aim ? commandLabel(aim) + ' — ' + t('Tap a target') : '';
    const message = hint || (armedCommand ? commandLabel(armedCommand) : '');
    const price = hint ? null : armedCommand;
    const summary = commandDescription(price, currentLanguage());
    const reason = price?.enabled === false ? commandReason(price) : '';
    const nextDetailKey = JSON.stringify([message, price?.cost, price?.manaCost, summary, reason]);
    if (detailKey !== nextDetailKey) {
      detailKey = nextDetailKey;
      detail.replaceChildren(message);
      const costs = costTokens(price);
      if (costs) detail.append(costs);
      for (const [caption, className] of [[summary, 'command-description'], [reason, 'warning command-reason']]) {
        if (!caption) continue;
        const line = document.createElement('span');
        line.className = className;
        line.textContent = caption;
        detail.append(line);
      }
    }
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

  function minimapPoint(event) {
    const rect = minimap.getBoundingClientRect();
    const world = adapter.world;
    const width = world.width * world.tileSize;
    const height = world.height * world.tileSize;
    return {
      x: clamp((event.clientX - rect.left - minimap.clientLeft) / minimap.clientWidth * width, width - 1),
      y: clamp((event.clientY - rect.top - minimap.clientTop) / minimap.clientHeight * height, height - 1),
    };
  }

  let minimapPan;
  minimap.addEventListener('pointerdown', event => {
    if (!event.isPrimary || ![0, 2].includes(event.button) || !adapter.input.state().inputAllowed || modal.open) return;
    if (demoReturn && event.button === 2) return;
    controls.cancel();
    const {x, y} = minimapPoint(event);
    if (event.button === 0 && aim) return finishTarget(x, y, true);
    if (event.button === 2 && !aim && !placement) return adapter.send({op: 'smart', x, y, minimap: true});
    if (event.button === 0) {
      minimapPan = event.pointerId;
      minimap.setPointerCapture(event.pointerId);
    }
    adapter.centerOn(x, y, {clampBottom:true});
  });
  minimap.addEventListener('pointermove', event => {
    if (minimapPan !== event.pointerId || !minimap.hasPointerCapture(event.pointerId)) return;
    const {x, y} = minimapPoint(event);
    adapter.centerOn(x, y, {clampBottom:true});
  });
  minimap.addEventListener('lostpointercapture', event => {
    if (minimapPan === event.pointerId) minimapPan = undefined;
  });
  minimap.addEventListener('contextmenu', event => event.preventDefault());
  byId('menu-button').addEventListener('click', () => { audio.play('button'); showMenu(); });
  byId('place-button').addEventListener('click', confirmPlacement);
  byId('cancel-placement').addEventListener('click', () => { audio.play('button'); cancelPlacement(); });
  modal.addEventListener('cancel', event => {
    event.preventDefault();
    if (!outcomeShown) closeModal();
  });
  function syncProjection() {
    const viewport = window.visualViewport;
    // Use the visible bottom if it extends beyond CSS bounds. A stale
    // viewport or innerHeight on portrait launch must never shorten the map.
    const visibleBottom = viewport?.scale === 1 ? viewport.height + viewport.offsetTop : 0;
    const extent = visibleBottom > 0 ? `${visibleBottom}px` : '';
    const root = document.documentElement.style;
    if (root.getPropertyValue('--battle-visible-bottom') !== extent) {
      root.setProperty('--battle-visible-bottom', extent);
    }
    const next = game.getBoundingClientRect();
    if (next.width !== canvasRect.width || next.height !== canvasRect.height ||
        next.left !== canvasRect.left || next.top !== canvasRect.top) {
      controls.cancel();
      canvasRect = next;
      adapter.frame(performance.now());
      scheduleFrame();
    }
  }
  const resize = new ResizeObserver(syncProjection);
  resize.observe(game);
  window.addEventListener('resize', syncProjection);
  window.addEventListener('pageshow', syncProjection);
  window.visualViewport?.addEventListener('resize', syncProjection);
  syncProjection();

  function draw(time) {
    frameRequested = false;
    if (!battleActive || stopped || document.hidden || !renderer) return;
    const view = adapter.frame(time);
    renderer.draw(view, canvasRect, placementTile, selectBox, Boolean(placement));
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
      const soundSample = Math.round(time);
      const soundElapsedMs = nextTick === 0 ? 0 : soundSample - lastSoundSample;
      lastSoundSample = soundSample;
      nextTick = nextTick === 0 ? time + duration : Math.max(time + 1, nextTick + cycles * duration);
      stepPending = true;
      try { await adapter.run({op: 'step', cycles, soundElapsedMs}); } catch {}
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
      syncProjection();
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
    window.removeEventListener('pageshow', syncProjection);
    window.visualViewport?.removeEventListener('resize', syncProjection);
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
