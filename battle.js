import {createTidewater} from './engine.js';
import {createMapRenderer, readImage, readJson} from './map-renderer.js';

const byId = id => document.getElementById(id);
const game = byId('game');
const minimap = byId('minimap');
const selection = byId('selection');
const commands = byId('commands');
const detail = byId('command-detail');
const modal = byId('modal');
const cancelGlyph = 91;
const tickMs = 40;
const costNames = ['Gold', 'Lumber', 'Oil'];
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
  return (command.cost ?? []).flatMap((cost, index) => cost ? [`${cost} ${costNames[index]}`] : []).join(' · ');
}

function priceLabel(command) {
  const price = description(command);
  return price ? `${command.label} — ${price}` : command.label;
}

function commandKey(command) {
  return [command.op, command.action, command.kind].join(':');
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
  const geometry = {
    ...viewport, active: true, cameraX: 0, cameraY: 0, maxX: 0, maxY: 0,
    mapWidth: world.width, mapHeight: world.height,
    world: {left: 0, top: 0, right: world.width * world.tileSize, bottom: world.height * world.tileSize},
  };

  function run(command) {
    const operation = queued.then(async () => {
      const next = await request(command);
      world = {
        ...next,
        visible: next.visible ?? world.visible,
        explored: next.explored ?? world.explored,
        mission: next.mission ?? world.mission,
      };
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
      inGame: true, modal: modal.open, inputAllowed: active(),
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
    frame, run, input, send,
    centerOn(x, y) { camera.centerOn(x, y, {useEdgeRoom: true}); onFrame(); },
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
  let music;
  let audioContext;
  let unlocked = false;
  const cache = new Map();
  readJson('./art/audio.json').then(source => { files = source; }).catch(() => {});
  const musicSource = () => files.music?.[0];
  const audioPath = path => './art/' + path;
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
      music = new Audio(audioPath(musicSource()));
      music.loop = true;
      music.preload = 'auto';
    }
    music.volume = volumes.music;
    if (document.hidden || !volumes.music) music.pause();
    else music.play().catch(() => {});
  }
  function activate() {
    const Context = window.AudioContext || window.webkitAudioContext;
    unlocked = true;
    if (!audioContext && Context) audioContext = new Context();
    audioContext?.resume().catch(() => {});
    sync();
  }
  async function play(key) {
    const paths = files[key];
    if (!unlocked || !audioContext || !paths?.length || !volumes.effects || document.hidden) return;
    const file = paths[Math.floor(Math.random() * paths.length)];
    try {
      if (!cache.has(file))
        cache.set(file, fetch(audioPath(file)).then(response => response.arrayBuffer())
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
  window.addEventListener('pointerdown', activate, {passive: true, capture: true});
  window.addEventListener('pointerup', activate, {passive: true, capture: true});
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audioContext?.suspend().catch(() => {});
    else if (unlocked) audioContext?.resume().catch(() => {});
    sync();
  });
  return {play, change, volumes};
}

async function start() {
  const audio = makeAudio();
  byId('loading-text').textContent = 'Loading the game files…';
  const [data, patch, uiMeta, uiAtlas] = await Promise.all([
    bytes('./game/War2Dat.mpq'), bytes('./game/War2Patch.mpq'),
    readJson('./art/ui.json'), readImage('./art/ui.webp'),
  ]);
  const request = await createTidewater(data, patch, {wasmUrl: new URL('./tidewater_web.wasm', import.meta.url)});
  await request({op: 'speed', speed: 7});
  const initialWorld = await request({op: 'snapshot'});
  const renderer = await createMapRenderer(game, minimap, initialWorld);
  const art = artwork(uiMeta, uiAtlas);
  document.documentElement.style.setProperty('--button-art', 'url(./art/button.webp)');
  document.documentElement.style.setProperty('--panel-art', 'url(./art/panel.webp)');
  let canvasRect = game.getBoundingClientRect();
  let frameRequested = false;
  let nextTick = 0;
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
  let infoKey = '';
  let panelKey = '';

  const resourceValues = Object.fromEntries(resourceFields.map(([key, label]) => {
    const item = document.createElement('span');
    const value = document.createElement('span');
    item.className = 'resource';
    item.title = label;
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
    active: () => !stopped && !document.hidden && !outcomeShown,
    action: {
      target: () => aim,
      placement: () => placement,
      cancelPlacement,
      preview: previewBuilding,
      finishTarget(x, y) {
        if (!aim) return;
        const action = aim.action;
        aim = null;
        adapter.send({op: 'target', action, x, y});
        updateHud(adapter.world);
      },
    },
  });
  const controls = createWarcraftDuneControls({...adapter.input, canvasElement: game}, () => canvasRect).enable();

  function onError(error) {
    detail.textContent = error.message || String(error);
    detail.hidden = false;
    audio.play('error');
  }

  function onWorld(world, command) {
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
        audio.play(kind === 58 ? 'farm' : kind === 92 ? 'mine' : 'button');
      } else if (sounds[cue]) {
        audio.play(sounds[cue]);
      }
    }
    updateHud(world);
    if (!outcomeShown && world.outcome && world.outcome !== 'running') {
      outcomeShown = true;
      showOutcome(world.outcome);
    }
    if (visual || command.op !== 'step') scheduleFrame();
  }

  function showModal(title, content, actions) {
    controls.cancel();
    clearTimeout(tickTimer);
    tickTimer = undefined;
    byId('modal-title').textContent = title;
    byId('modal-content').replaceChildren(...content);
    byId('modal-actions').replaceChildren(...actions.map(([label, activate, tone, wide]) =>
      button(label, () => { audio.play('button'); activate(); }, (tone ?? '') + (wide ? ' wide' : ''))));
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
    audio.play('button');
    showModal('Game Menu', [], [
      ['Objectives', showObjectives, '', true],
      ['Sound', showSound, '', true],
      ['Restart', showRestart, '', true],
      ['Back', closeModal, '', true],
    ]);
  }

  function showObjectives() {
    const goals = adapter.world.mission?.objectives;
    const list = document.createElement('ul');
    for (const goal of Array.isArray(goals) ? goals : ['Build four Farms', 'Build a Barracks']) {
      const line = document.createElement('li');
      line.textContent = goal;
      list.append(line);
    }
    showModal('Mission Objectives', [list], [['Back', showMenu]]);
  }

  function showSound() {
    const controls = [['music', 'Music'], ['effects', 'Sound effects']].map(([key, name]) => {
      const label = document.createElement('label');
      label.className = 'sound-control';
      label.append(text(name));
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0'; slider.max = '100';
      slider.value = String(Math.round(audio.volumes[key] * 100));
      slider.addEventListener('input', () => audio.change(key, Number(slider.value) / 100));
      label.append(slider);
      return label;
    });
    showModal('Sound', controls, [['Back', showMenu]]);
  }

  function showRestart() {
    const warning = text('Progress in this battle will be replaced.');
    warning.className = 'warning';
    showModal('Restart the mission?', [warning], [
      ['Restart', () => location.reload(), 'positive'], ['Back', showMenu, 'negative'],
    ]);
  }

  function showOutcome(result) {
    const won = String(result).toLowerCase().includes('victory') || String(result).toLowerCase() === 'win';
    showModal(won ? 'Victory' : 'Defeat', [], [['Play again', () => location.reload(), 'positive']]);
  }

  function purchase(command) {
    const cancellation = command.op === 'cancel';
    const preview = document.createElement('div');
    preview.className = 'purchase-preview';
    preview.append(art.icon(commandIcon(command)), text(description(command) || command.label));
    showModal(cancellation ? command.label : `Buy ${command.label}?`, [preview], [
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
      if (placementTile?.message) {
        detail.textContent = placementTile.message;
        detail.hidden = false;
      }
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
      unit.production, unit.level].join(':')).join(',');
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
      portrait.setAttribute('aria-label', unit.name ?? 'Center on unit');
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
      name.textContent = unit.name ?? ['Footman', 'Grunt', 'Peasant'][unit.kind] ?? 'Building';
      grid.append(name);
      const stats = document.createElement('div');
      stats.className = 'stats';
      stats.textContent = `${unit.hp} / ${unit.maxHp}`;
      if (typeof unit.progress === 'number' && unit.progress >= 0) {
        const progress = unit.progress * 100 / 255;
        const bar = document.createElement('div');
        bar.className = 'progress-track';
        bar.style.setProperty('--progress', progress + '%');
        bar.textContent = Math.floor(progress) + '% complete';
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
        el.setAttribute('aria-label', command.label);
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
    const message = placement ? 'Choose a site, then tap Place' :
      aim ? aim.label + ' — Tap a target' : armedCommand ? priceLabel(armedCommand) : '';
    detail.textContent = message;
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
  byId('menu-button').addEventListener('click', showMenu);
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
      scheduleFrame();
    }
  }
  const resize = new ResizeObserver(syncProjection);
  resize.observe(game);
  window.addEventListener('resize', syncProjection);

  function draw(time) {
    frameRequested = false;
    if (stopped || document.hidden) return;
    const view = adapter.frame(time);
    renderer.draw(view, canvasRect, placementTile, selectBox);
    if (adapter.cameraMoving) scheduleFrame();
  }

  function scheduleFrame() {
    if (!frameRequested && !stopped && !document.hidden) {
      frameRequested = true;
      requestAnimationFrame(draw);
    }
  }

  function scheduleTick() {
    if (tickTimer !== undefined || stepPending || stopped || document.hidden || modal.open || outcomeShown) return;
    tickTimer = setTimeout(async () => {
      tickTimer = undefined;
      if (stopped || document.hidden || modal.open || outcomeShown) return;
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
      clearTimeout(tickTimer);
      tickTimer = undefined;
      controls.cancel();
    } else {
      scheduleFrame();
      scheduleTick();
    }
  });
  window.addEventListener('pagehide', event => {
    if (event.persisted) { controls.cancel(); return; }
    stopped = true;
    clearTimeout(tickTimer);
    resize.disconnect();
    window.removeEventListener('resize', syncProjection);
    controls.destroy();
  });

  for (const id of ['hud-top', 'selection', 'minimap', 'command-area']) byId(id).hidden = false;
  byId('loading').hidden = true;
  updateHud(initialWorld);
  adapter.frame(performance.now());
  const home = initialWorld.units.find(unit => unit.owner === initialWorld.player && unit.kind === 74) ??
    initialWorld.units.find(unit => unit.owner === initialWorld.player);
  if (home) adapter.centerOn(home.x + home.width / 2, home.y + home.height / 2);
  window.__tidewaterPilot = Object.freeze({
    world: () => structuredClone(adapter.world),
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
