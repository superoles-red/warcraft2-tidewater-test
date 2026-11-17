export async function readJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Can't load ${path}`);
  return response.json();
}

export async function readImage(path) {
  const image = new Image();
  image.src = path;
  await image.decode();
  return image;
}

function surface(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  return {canvas, ctx};
}

function placementStamp(size, color) {
  const {canvas, ctx} = surface(size, size);
  const checker = surface(2, 2);
  checker.ctx.fillStyle = color;
  checker.ctx.fillRect(1, 0, 1, 1);
  checker.ctx.fillRect(0, 1, 1, 1);
  ctx.fillStyle = ctx.createPattern(checker.canvas, 'repeat');
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

export function eraDirectory(world) {
  const era = String(world.mission?.era || world.era || 'winter').toLowerCase();
  return './art/eras/' + (era === 'summer' ? 'forest' : era);
}

function sameUnits(previous, next) {
  if (previous === next) return true;
  return previous.length === next.length && next.every((unit, index) => {
    const old = previous[index];
    return old.id === unit.id && old.x === unit.x && old.y === unit.y &&
      old.frame === unit.frame && old.picture === unit.picture &&
      old.colour === unit.colour && old.owner === unit.owner && old.allied === unit.allied &&
      old.width === unit.width && old.height === unit.height &&
      old.boxWidth === unit.boxWidth && old.boxHeight === unit.boxHeight &&
      old.mirrored === unit.mirrored && old.carry === unit.carry && old.dying === unit.dying;
  });
}

const noBuildings = [];

export async function createMapRenderer(game, minimap, initialWorld, invalidate = () => {}) {
  const root = eraDirectory(initialWorld);
  const catalog = await readJson(root + '/sprites.json').then(atlas => ({atlas, source:root}))
    .catch(async error => {
      if (initialWorld.width !== 32 || root.split('/').at(-1) !== 'winter') throw error;
      return {atlas: await readJson('./art/sprites.json'), source:'./art'};
    });
  const {atlas, source} = catalog;
  const [tiles, fogShapes, fogCodes, previewTerrain, effectAtlas, effectImage] = await Promise.all([
    readImage(source + '/tiles.webp'),
    readImage(source + '/fog-shapes.png'),
    readJson('./art/fog-codes.json'),
    initialWorld.terrain ? null : readImage('./art/terrain.webp'),
    readJson('./art/effects.json'),
    readImage('./art/effects.webp'),
  ]);
  const tile = initialWorld.tileSize;
  const minimapSize = 128;
  const mapWidth = initialWorld.width, mapHeight = initialWorld.height;
  const width = mapWidth * tile, height = mapHeight * tile;
  const tileColumns = tiles.width / tile;
  const cells = initialWorld.terrain ? Uint16Array.from(initialWorld.terrain) : null;
  if (cells && cells.length !== mapWidth * mapHeight) throw new Error('Invalid terrain for this mission.');
  const shapeSheet = surface(tile, tile * fogCodes.length);
  shapeSheet.ctx.drawImage(fogShapes, 0, 0);
  const shapes = shapeSheet.ctx.getImageData(0, 0, tile, tile * fogCodes.length).data;
  const miniTerrain = surface(minimapSize, minimapSize);
  const ctx = game.getContext('2d', {alpha: false});
  const miniContext = minimap.getContext('2d');
  const fogStamps = new Map();
  const fogShown = new Int16Array(mapWidth * mapHeight).fill(-1);
  const chunkTiles = 8;
  const chunkSize = chunkTiles * tile;
  const chunkColumns = Math.ceil(mapWidth / chunkTiles);
  const chunkRows = Math.ceil(mapHeight / chunkTiles);
  const chunks = new Map();
  const mapColour = key => 'rgb(' + atlas.mapColours[key].join(',') + ')';
  const ownSelection = mapColour('ownSelection');
  const otherSelection = mapColour('otherSelection');
  const alliedSelection = atlas.mapColours.alliedSelection ? mapColour('alliedSelection') : otherSelection;
  const placingBuilding = mapColour('placingBuilding');
  const buildableTile = placementStamp(tile, mapColour('buildableTile'));
  const blockedTile = placementStamp(tile, mapColour('blockedTile'));
  const spritePages = new Map();
  const teamFrames = new Map();
  const pageNames = atlas.pages || [atlas.image || 'sprites.webp'];
  let world = initialWorld;
  let unitOrder;
  let rememberedBuildings = initialWorld.rememberedBuildings ?? noBuildings;
  let painted;
  let miniPainted;
  let paintRevision = 0;
  let miniRevision = 0;
  let miniUnits = '';
  let fogArrays = [];
  let mapEffects = [];
  let effectKey = '';

  function loadPage(id) {
    if (!spritePages.has(id)) {
      const path = pageNames[id];
      const entry = {image:null};
      if (!path) return Promise.resolve(null);
      entry.loading = readImage(source + '/' + path).then(image => {
        entry.image = image;
        ++paintRevision;
        invalidate();
        return image;
      }).catch(() => null);
      spritePages.set(id, entry);
    }
    return spritePages.get(id).loading;
  }

  function spriteFrame(unit) {
    const carried = unit.carry && atlas.carriedSprites?.[`${unit.kind}:${unit.carry}`];
    const meta = carried || atlas.sprites[unit.picture];
    if (!meta) return null;
    const frames = meta.frames ?? meta.colours?.[unit.colour] ?? Object.values(meta.colours || {})[0];
    const frame = frames?.[unit.frame];
    const rectangle = frame?.[2] > 0 && frame?.[3] > 0 ? frame : frames?.[0];
    if (!rectangle || rectangle[2] <= 0 || rectangle[3] <= 0) return null;
    return {rectangle, size: meta.size, page: rectangle[6] ?? 0,
      keyed: meta.frames != null && rectangle[7] !== 0};
  }

  await Promise.all([...new Set([...initialWorld.units, ...rememberedBuildings]
    .map(unit => spriteFrame(unit)?.page).filter(Number.isInteger))]
    .map(loadPage));

  function fogStamp(visible, explored) {
    const key = visible * 17 + explored;
    if (fogStamps.has(key)) return fogStamps.get(key);
    const stamp = new ImageData(tile, tile);
    const pixels = stamp.data;
    function lookup(code, pixel) {
      if (code < 1 || code > 15) return -1;
      const index = 4 * (code * tile * tile + pixel);
      return shapes[index + 3] === 0 ? -1 : index;
    }
    for (let pixel = 0; pixel < tile * tile; ++pixel) {
      const even = (pixel % tile + Math.floor(pixel / tile)) % 2 === 0;
      const offset = 4 * pixel;
      if (visible === 16 && (explored === 16 || even)) pixels[offset + 3] = 255;
      else {
        const grey = lookup(explored, pixel);
        const source = grey >= 0 ? grey : even ? lookup(visible, pixel) : -1;
        if (source >= 0) pixels.set(shapes.subarray(source, source + 4), offset);
      }
    }
    const stampSurface = surface(tile, tile);
    stampSurface.ctx.putImageData(stamp, 0, 0);
    fogStamps.set(key, stampSurface.canvas);
    return stampSurface.canvas;
  }

  function fogForTile(index) {
    const key = fogShown[index];
    return key < 17 ? null : fogStamp(Math.floor(key / 17), key % 17);
  }

  function paintTerrain(context, i, dx, dy, dw = tile, dh = tile) {
    if (cells) {
      const id = cells[i];
      context.drawImage(tiles, id % tileColumns * tile, Math.floor(id / tileColumns) * tile,
        tile, tile, dx, dy, dw, dh);
    } else {
      context.drawImage(previewTerrain, i % mapWidth * tile, Math.floor(i / mapWidth) * tile,
        tile, tile, dx, dy, dw, dh);
    }
  }

  function paintTile(chunk, i, localX, localY, terrain, vision) {
    if (terrain) paintTerrain(chunk.terrain.ctx, i, localX, localY);
    if (vision) {
      const fog = fogForTile(i);
      chunk.fog.ctx.clearRect(localX, localY, tile, tile);
      if (fog) chunk.fog.ctx.drawImage(fog, localX, localY);
    }
  }

  function paintMiniTile(index) {
    const x = index % mapWidth, y = Math.floor(index / mapWidth);
    const left = Math.floor(x * minimapSize / mapWidth), top = Math.floor(y * minimapSize / mapHeight);
    const w = Math.floor((x + 1) * minimapSize / mapWidth) - left;
    const h = Math.floor((y + 1) * minimapSize / mapHeight) - top;
    if (!w || !h) return;
    const context = miniTerrain.ctx;
    context.clearRect(left, top, w, h);
    if (fogShown[index] === 16 * 17 + 16) {
      context.fillStyle = '#000b';
      context.fillRect(left, top, w, h);
    } else {
      paintTerrain(context, index, left, top, w, h);
      const fog = fogForTile(index);
      if (fog) context.drawImage(fog, left, top, w, h);
    }
  }

  function refreshTile(index, terrain, vision) {
    const x = index % mapWidth, y = Math.floor(index / mapWidth);
    const c = chunks.get(Math.floor(y / chunkTiles) * chunkColumns + Math.floor(x / chunkTiles));
    if (c) paintTile(c, index, x % chunkTiles * tile, y % chunkTiles * tile, terrain, vision);
    paintMiniTile(index);
  }

  function chunk(cx, cy) {
    const key = cy * chunkColumns + cx;
    let result = chunks.get(key);
    if (result) chunks.delete(key);
    else {
      const w = Math.min(chunkTiles, mapWidth - cx * chunkTiles);
      const h = Math.min(chunkTiles, mapHeight - cy * chunkTiles);
      result = {terrain: surface(w * tile, h * tile), fog: surface(w * tile, h * tile)};
      for (let j = 0; j < h; ++j) {
        for (let i = 0; i < w; ++i) {
          const index = (cy * chunkTiles + j) * mapWidth + cx * chunkTiles + i;
          paintTile(result, index, i * tile, j * tile, true, true);
        }
      }
    }
    chunks.set(key, result);
    while (chunks.size > 27) chunks.delete(chunks.keys().next().value);
    return result;
  }

  function updateFog(state) {
    if (state.demo || !state.visible || !state.explored ||
        (fogArrays[0] === state.visible && fogArrays[1] === state.explored)) return false;
    fogArrays = [state.visible, state.explored];
    let dirty = false;
    for (let index = 0; index < fogShown.length; ++index) {
      const key = fogCodes[state.visible[index]] * 17 + fogCodes[state.explored[index]];
      if (!Number.isFinite(key) || key === fogShown[index]) continue;
      dirty = true;
      fogShown[index] = key;
      refreshTile(index, false, true);
    }
    return dirty;
  }

  function applyTerrain(state) {
    let updated = false;
    for (const [x, y, id] of state.terrainChanges ?? []) {
      const index = y * mapWidth + x;
      if (cells) {
        if (cells[index] === id) continue;
        cells[index] = id;
      }
      refreshTile(index, true, false);
      updated = true;
    }
    return updated;
  }

  function updateMapEffects(state) {
    mapEffects = state.effects ?? [];
    const key = mapEffects.map(effect => [effect.kind, effect.x, effect.y, effect.frame].join(':')).join(';');
    if (key === effectKey) return;
    effectKey = key;
    ++paintRevision;
  }

  function drawMapEffects(view, groundMarkers) {
    const {x: left, y: top} = view.visibleGlobal;
    for (const effect of mapEffects) {
      if ((effect.kind === 0x1c) !== groundMarkers) continue;
      const sheet = effectAtlas[effect.kind], frame = sheet?.frames[effect.frame];
      if (!frame) continue;
      const [sx, sy, w, h, ox, oy] = frame;
      if (!w || !h) continue;
      const x = effect.x + ox - Math.floor(sheet.size[0] / 2);
      const y = effect.y + oy - Math.floor(sheet.size[1] / 2);
      if (x + w <= left || y + h <= top || x >= left + view.width || y >= top + view.height) continue;
      ctx.drawImage(effectImage, sx, sy, w, h, x, y, w, h);
    }
  }

  function update(state) {
    const previousRevision = paintRevision;
    const previousMini = miniRevision;
    updateMapEffects(state);
    const terrainChanged = applyTerrain(state);
    const visionChanged = updateFog(state);
    const remembered = state.rememberedBuildings ?? noBuildings;
    if (!sameUnits(rememberedBuildings, remembered)) ++paintRevision;
    rememberedBuildings = remembered;
    if (!unitOrder || !sameUnits(world.units, state.units) ||
        world.selection.join(',') !== state.selection.join(',') || terrainChanged || visionChanged) {
      ++paintRevision;
      unitOrder = [...state.units].sort((a, b) => Number(b.building) - Number(a.building) || a.y - b.y);
    }
    world = state;
    const points = state.units.filter(unit => unit.minimap !== false)
      .map(unit => [unit.tileX, unit.tileY, unit.width, unit.height, unit.owner]).join(';') + '/' +
      rememberedBuildings.filter(unit => unit.minimap !== false)
        .map(unit => [unit.x, unit.y, unit.width, unit.height, unit.owner]).join(';');
    if (points !== miniUnits || terrainChanged || visionChanged) {
      miniUnits = points;
      ++miniRevision;
    }
    return paintRevision !== previousRevision || miniRevision !== previousMini;
  }

  function tileColours(image, frame, unit) {
    const [x, y, w, h] = frame.rectangle;
    const colours = atlas.teamColours?.[unit.colour];
    if (!frame.keyed || !colours) return [image, x, y];
    const key = `${frame.page}:${x}:${y}:${unit.colour}`;
    if (!teamFrames.has(key)) {
      const tinted = surface(w, h);
      tinted.ctx.drawImage(image, x, y, w, h, 0, 0, w, h);
      const pixels = tinted.ctx.getImageData(0, 0, w, h);
      let changed = false;
      for (let i = 0; i < pixels.data.length; i += 4) {
        const blue = pixels.data[i + 2];
        if (pixels.data[i] !== 1 || pixels.data[i + 1] !== 255 || blue > 3 || !pixels.data[i + 3]) continue;
        pixels.data.set(colours[blue], i);
        changed = true;
      }
      if (changed) tinted.ctx.putImageData(pixels, 0, 0);
      teamFrames.set(key, changed ? tinted.canvas : null);
      if (teamFrames.size > 320) teamFrames.delete(teamFrames.keys().next().value);
    }
    const colored = teamFrames.get(key);
    return colored ? [colored, 0, 0] : [image, x, y];
  }

  function drawUnit(unit) {
    const frame = spriteFrame(unit);
    if (!frame) return;
    const image = spritePages.get(frame.page)?.image;
    if (!image) { loadPage(frame.page); return; }
    const [picture, sx, sy] = tileColours(image, frame, unit);
    const [, , w, h, offsetX, offsetY] = frame.rectangle;
    const x = unit.x + unit.width / 2;
    const y = Math.round(unit.y + (unit.height - frame.size[1]) / 2 + offsetY);
    if (unit.mirrored) {
      ctx.save();
      ctx.translate(Math.round(x + frame.size[0] / 2 - offsetX), y);
      ctx.scale(-1, 1);
      ctx.drawImage(picture, sx, sy, w, h, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(picture, sx, sy, w, h, Math.round(x - frame.size[0] / 2 + offsetX), y, w, h);
    }
  }

  function drawMinimap(view) {
    const mapScale = minimapSize;
    const id = [miniRevision, view.visibleGlobal.x.toFixed(2), view.visibleGlobal.y.toFixed(2),
      view.width, view.height].join(':');
    if (id === miniPainted) return;
    miniPainted = id;
    if (minimap.width !== mapScale || minimap.height !== mapScale) minimap.width = minimap.height = mapScale;
    miniContext.imageSmoothingEnabled = false;
    miniContext.clearRect(0, 0, mapScale, mapScale);
    miniContext.drawImage(miniTerrain.canvas, 0, 0);
    for (const layer of [rememberedBuildings, world.units]) {
      for (const unit of layer) {
        if (unit.minimap === false) continue;
        miniContext.fillStyle = unit.owner === world.player ? '#2aff05' : unit.owner === 15 ? '#d4c66e' : '#ef3324';
        miniContext.fillRect(
          Math.floor((unit.tileX ?? unit.x / tile) * mapScale / mapWidth),
          Math.floor((unit.tileY ?? unit.y / tile) * mapScale / mapHeight),
          Math.max(1, Math.round(unit.width * mapScale / width)),
          Math.max(1, Math.round(unit.height * mapScale / height)),
        );
      }
    }
    const x = view.visibleGlobal.x * mapScale / width;
    const y = view.visibleGlobal.y * mapScale / height;
    miniContext.strokeStyle = '#fff7df';
    miniContext.strokeRect(Math.round(x) + .5, Math.round(y) + .5,
      Math.round(view.width * mapScale / width) - 1, Math.round(view.height * mapScale / height) - 1);
  }

  function draw(view, rect, placement, selectBox, placing) {
    if (!view || rect.width < 1 || rect.height < 1) return;
    const ratio = Math.min(1.5, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(rect.width * ratio), pixelHeight = Math.round(rect.height * ratio);
    const left = view.visibleGlobal.x, top = view.visibleGlobal.y;
    const right = left + view.width, bottom = top + view.height;
    const key = [paintRevision, left, top, right, bottom, pixelWidth, pixelHeight, placing,
      placement?.x, placement?.y, placement?.valid, placement?.kind, placement?.width, placement?.height,
      placement?.blocked, selectBox?.x1, selectBox?.y1, selectBox?.x2, selectBox?.y2].join(':');
    if (painted !== key) {
      painted = key;
      if (game.width !== pixelWidth || game.height !== pixelHeight) {
        game.width = pixelWidth;
        game.height = pixelHeight;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, game.width, game.height);
      ctx.imageSmoothingEnabled = false;
      const scale = pixelWidth / view.width;
      ctx.setTransform(scale, 0, 0, scale, -left * scale, -top * scale);
      const x = Math.max(0, left), y = Math.max(0, top);
      const w = Math.min(width, right) - x, h = Math.min(height, bottom) - y;
      if (w > 0 && h > 0) {
        const deviceX = value => Math.round((value - left) * scale);
        const deviceY = value => Math.round((value - top) * scale);
        const chunkAt = (image, x0, y0) => {
          const dx = deviceX(x0), dy = deviceY(y0);
          ctx.drawImage(image, dx, dy, deviceX(x0 + image.width) - dx, deviceY(y0 + image.height) - dy);
        };
        const visibleChunks = [];
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        for (let cy = Math.floor(y / chunkSize); cy < Math.min(chunkRows, Math.ceil(bottom / chunkSize)); ++cy) {
          for (let cx = Math.floor(x / chunkSize); cx < Math.min(chunkColumns, Math.ceil(right / chunkSize)); ++cx) {
            const c = chunk(cx, cy), px = cx * chunkSize, py = cy * chunkSize;
            chunkAt(c.terrain.canvas, px, py);
            visibleChunks.push([c.fog.canvas, px, py]);
          }
        }
        ctx.setTransform(scale, 0, 0, scale, -left * scale, -top * scale);
        const selected = new Set(world.selection);
        const onScreen = unit => unit.x + unit.width >= left - 64 && unit.x <= right + 64 &&
          unit.y + unit.height >= top - 64 && unit.y <= bottom + 64;
        function drawSelection(unit, colour) {
          const w = unit.boxWidth ?? unit.width, h = unit.boxHeight ?? unit.height;
          const x = unit.x + unit.width / 2 - Math.floor(w / 2) - 1;
          const y = unit.y + unit.height / 2 - Math.floor(h / 2) - 1;
          const l = deviceX(x), t = deviceY(y);
          const r = deviceX(x + w + 1), b = deviceY(y + h + 1);
          const upper = Math.max(1, deviceY(y + 1) - t);
          const lower = Math.max(1, b - deviceY(y + h));
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = colour;
          ctx.fillRect(l, t, r - l, upper);
          ctx.fillRect(l, b - lower, r - l, lower);
          ctx.fillRect(l, t, Math.max(1, deviceX(x + 1) - l), b - t);
          const edge = Math.max(1, r - deviceX(x + w));
          ctx.fillRect(r - edge, t, edge, b - t);
          ctx.setTransform(scale, 0, 0, scale, -left * scale, -top * scale);
        }
        for (const unit of rememberedBuildings) {
          if (onScreen(unit)) drawUnit(unit);
        }
        for (const unit of unitOrder) {
          if (!onScreen(unit)) continue;
          const owned = unit.owner === world.player;
          if (selected.has(unit.id)) {
            drawSelection(unit, owned ? ownSelection : unit.allied ? alliedSelection : otherSelection);
          } else if (placing && owned && unit.building && unit.hp > 0 && !unit.dying) {
            drawSelection(unit, placingBuilding);
          }
          drawUnit(unit);
        }
        drawMapEffects(view, false);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        for (const [fog, px, py] of visibleChunks) chunkAt(fog, px, py);
        const line = Math.max(1, Math.round(ratio));
        const x0 = deviceX(x), y0 = deviceY(y);
        const x1 = deviceX(x + w), y1 = deviceY(y + h);
        ctx.fillStyle = '#fff';
        if (left <= .001) ctx.fillRect(x0, y0, line, y1 - y0);
        if (top <= .001) ctx.fillRect(x0, y0, x1 - x0, line);
        if (right >= width - .001) ctx.fillRect(x1 - line, y0, line, y1 - y0);
        if (bottom >= height - .001) ctx.fillRect(x0, y1 - line, x1 - x0, line);
        ctx.setTransform(scale, 0, 0, scale, -left * scale, -top * scale);
      }
      if (placement) {
        const actorColour = world.playerColour ?? unitOrder.find(unit => unit.owner === world.player)?.colour ?? world.player;
        const x = placement.x * tile, y = placement.y * tile;
        const width = placement.width * tile, height = placement.height * tile;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, width, height);
        ctx.clip();
        drawUnit({
          picture: placement.kind, frame: 0, colour: actorColour,
          x, y, width, height,
        });
        ctx.restore();
        for (let j = 0; j < placement.height; ++j) {
          for (let i = 0; i < placement.width; ++i) {
            const blocked = placement.blocked?.[j * placement.width + i] ?? !placement.valid;
            const cx = (placement.x + i) * tile, cy = (placement.y + j) * tile;
            ctx.drawImage(blocked ? blockedTile : buildableTile, cx, cy);
          }
        }
      }
      drawMapEffects(view, true);
      if (selectBox) {
        ctx.strokeStyle = ownSelection;
        ctx.lineWidth = 1 / scale;
        ctx.strokeRect(selectBox.x1, selectBox.y1, selectBox.x2 - selectBox.x1, selectBox.y2 - selectBox.y1);
      }
    }
    drawMinimap(view);
  }

  update(initialWorld);
  return {update, draw};
}
