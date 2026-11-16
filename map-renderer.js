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

function sameUnits(previous, next) {
  return previous?.length === next.length && next.every((unit, index) => {
    const old = previous[index];
    return old.id === unit.id && old.x === unit.x && old.y === unit.y &&
      old.frame === unit.frame && old.picture === unit.picture &&
      old.colour === unit.colour && old.mirrored === unit.mirrored;
  });
}

export async function createMapRenderer(game, minimap, initialWorld) {
  const atlas = await readJson('./art/sprites.json');
  const [terrainImage, tiles, fogShapes, sprites, fogCodes] = await Promise.all([
    readImage('./art/terrain.webp'),
    readImage('./art/tiles.webp'),
    readImage('./art/fog-shapes.png'),
    readImage('./art/' + (atlas.image ?? 'sprites.webp')),
    readJson('./art/fog-codes.json'),
  ]);
  const tile = initialWorld.tileSize;
  const width = initialWorld.width * tile;
  const height = initialWorld.height * tile;
  const terrain = surface(width, height);
  terrain.ctx.drawImage(terrainImage, 0, 0);
  const fog = surface(width, height);
  const shapesSurface = surface(tile, tile * fogCodes.length);
  shapesSurface.ctx.drawImage(fogShapes, 0, 0);
  const shapes = shapesSurface.ctx.getImageData(0, 0, tile, tile * fogCodes.length).data;
  const miniTerrain = surface(128, 128);
  const ctx = game.getContext('2d', {alpha: false});
  const miniContext = minimap.getContext('2d');
  const fogStamps = new Map();
  const fogShown = new Int16Array(initialWorld.width * initialWorld.height).fill(-1);
  let world = initialWorld;
  let unitOrder;
  let painted;
  let miniPainted;
  let paintRevision = 0;
  let miniRevision = 0;
  let miniUnits = '';
  let fogArrays = [];

  function fogStamp(visible, explored) {
    const key = visible * 17 + explored;
    if (fogStamps.has(key)) return fogStamps.get(key);
    const stamp = new ImageData(tile, tile);
    const pixels = stamp.data;
    const lookup = (code, pixel) => {
      if (code < 1 || code > 15) return -1;
      const index = 4 * (code * tile * tile + pixel);
      return shapes[index + 3] === 0 ? -1 : index;
    };
    for (let pixel = 0; pixel < tile * tile; ++pixel) {
      const even = (pixel % tile + Math.floor(pixel / tile)) % 2 === 0;
      const offset = 4 * pixel;
      if (visible === 16 && (explored === 16 || even)) {
        pixels[offset + 3] = 255;
      } else {
        const grey = lookup(explored, pixel);
        const source = grey >= 0 ? grey : even ? lookup(visible, pixel) : -1;
        if (source >= 0) pixels.set(shapes.subarray(source, source + 4), offset);
      }
    }
    fogStamps.set(key, stamp);
    return stamp;
  }

  function updateFog(state) {
    if (state.visible == null || state.explored == null) return false;
    if (fogArrays[0] === state.visible && fogArrays[1] === state.explored) return false;
    fogArrays = [state.visible, state.explored];
    let dirty = false;
    for (let index = 0; index < fogShown.length; ++index) {
      const visible = fogCodes[state.visible[index]];
      const explored = fogCodes[state.explored[index]];
      const key = visible * 17 + explored;
      if (key === fogShown[index]) continue;
      dirty = true;
      fogShown[index] = key;
      const x = index % state.width * tile;
      const y = Math.floor(index / state.width) * tile;
      if (visible === 0) fog.ctx.clearRect(x, y, tile, tile);
      else fog.ctx.putImageData(fogStamp(visible, explored), x, y);
    }
    return dirty;
  }

  function applyTerrain(state) {
    for (const [x, y, id] of state.terrainChanges ?? []) {
      terrain.ctx.drawImage(tiles, id % 64 * tile, Math.floor(id / 64) * tile, tile, tile,
        x * tile, y * tile, tile, tile);
    }
    return Boolean(state.terrainChanges?.length);
  }

  function updateMiniBase() {
    const {ctx: context, canvas} = miniTerrain;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(terrain.canvas, 0, 0, canvas.width, canvas.height);
    context.drawImage(fog.canvas, 0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = 'destination-out';
    context.fillStyle = '#0005';
    for (let index = 0; index < fogShown.length; ++index) {
      if (fogShown[index] !== 16 * 17 + 16) continue;
      const w = canvas.width / world.width;
      const h = canvas.height / world.height;
      context.fillRect(index % world.width * w, Math.floor(index / world.width) * h, w, h);
    }
    context.globalCompositeOperation = 'source-over';
  }

  function update(state) {
    const previousRevision = paintRevision;
    const previousMini = miniRevision;
    const terrainChanged = applyTerrain(state);
    const visionChanged = updateFog(state);
    if (!unitOrder || !sameUnits(world.units, state.units) ||
        world.selection.join(',') !== state.selection.join(',') || terrainChanged || visionChanged) {
      ++paintRevision;
      unitOrder = [...state.units].sort((a, b) => Number(b.building) - Number(a.building) || a.y - b.y);
    }
    world = state;
    if (terrainChanged || visionChanged) {
      updateMiniBase();
      ++miniRevision;
    }
    const points = state.units.filter(unit => unit.minimap !== false)
      .map(unit => [unit.id, unit.tileX, unit.tileY, unit.owner]).join(';');
    if (points !== miniUnits) {
      miniUnits = points;
      ++miniRevision;
    }
    return paintRevision !== previousRevision || miniRevision !== previousMini;
  }

  function drawUnit(unit) {
    const meta = atlas.sprites[unit.picture];
    if (!meta) return;
    const animation = meta.colours[unit.colour] ?? Object.values(meta.colours)[0];
    const expected = animation?.[unit.frame];
    const frame = expected?.[2] > 0 && expected?.[3] > 0 ? expected : animation?.[0];
    if (!frame || frame[2] < 1 || frame[3] < 1) return;
    const [sx, sy, w, h, offsetX, offsetY] = frame;
    const x = unit.x + unit.width / 2;
    const y = Math.round(unit.y + (unit.height - meta.size[1]) / 2 + offsetY);
    if (unit.mirrored) {
      ctx.save();
      ctx.translate(Math.round(x + meta.size[0] / 2 - offsetX), y);
      ctx.scale(-1, 1);
      ctx.drawImage(sprites, sx, sy, w, h, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(sprites, sx, sy, w, h,
        Math.round(x - meta.size[0] / 2 + offsetX), y, w, h);
    }
  }

  function drawMinimap(view) {
    const mapScale = 128;
    const id = [miniRevision, view.visibleGlobal.x.toFixed(2), view.visibleGlobal.y.toFixed(2),
      view.width, view.height].join(':');
    if (id === miniPainted) return;
    miniPainted = id;
    if (minimap.width !== mapScale || minimap.height !== mapScale) minimap.width = minimap.height = mapScale;
    miniContext.imageSmoothingEnabled = false;
    miniContext.clearRect(0, 0, mapScale, mapScale);
    miniContext.drawImage(miniTerrain.canvas, 0, 0);
    for (const unit of world.units) {
      if (unit.minimap === false) continue;
      miniContext.fillStyle = unit.owner === world.player ? '#2aff05' : unit.owner === 15 ? '#d4c66e' : '#ef3324';
      miniContext.fillRect(
        Math.floor(unit.x * mapScale / width), Math.floor(unit.y * mapScale / height),
        Math.max(2, Math.round(unit.width * mapScale / width)),
        Math.max(2, Math.round(unit.height * mapScale / height)),
      );
    }
    const x = view.visibleGlobal.x * mapScale / width;
    const y = view.visibleGlobal.y * mapScale / height;
    miniContext.strokeStyle = '#fffae1';
    miniContext.strokeRect(Math.round(x) + .5, Math.round(y) + .5,
      Math.round(view.width * mapScale / width) - 1, Math.round(view.height * mapScale / height) - 1);
  }

  function draw(view, rect, placement, selectBox) {
    if (!view || rect.width < 1 || rect.height < 1) return;
    const ratio = Math.min(1.5, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(rect.width * ratio);
    const pixelHeight = Math.round(rect.height * ratio);
    const left = view.visibleGlobal.x;
    const top = view.visibleGlobal.y;
    const right = left + view.width;
    const bottom = top + view.height;
    const key = [paintRevision, left, top, right, bottom, pixelWidth, pixelHeight,
      placement?.x, placement?.y, placement?.valid, placement?.kind, placement?.width, placement?.height, placement?.blocked,
      selectBox?.x1, selectBox?.y1, selectBox?.x2, selectBox?.y2].join(':');
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
        ctx.drawImage(terrain.canvas, x, y, w, h, x, y, w, h);
        const selected = new Set(world.selection);
        for (const unit of unitOrder) {
          if (unit.x + unit.width < left - 64 || unit.x > right + 64 ||
              unit.y + unit.height < top - 64 || unit.y > bottom + 64) continue;
          drawUnit(unit);
          if (selected.has(unit.id)) {
            ctx.lineWidth = 1 / scale;
            ctx.strokeStyle = '#4dfc00';
            ctx.strokeRect(unit.x, unit.y, unit.width, unit.height);
          }
        }
        ctx.drawImage(fog.canvas, x, y, w, h, x, y, w, h);
      }
      if (placement) {
        ctx.save();
        ctx.globalAlpha = .6;
        drawUnit({
          picture: placement.kind, frame: 0, colour: unitOrder.find(unit => unit.owner === world.player)?.colour,
          x: placement.x * tile, y: placement.y * tile, width: placement.width * tile, height: placement.height * tile,
        });
        ctx.restore();
        ctx.lineWidth = 1 / scale;
        for (let j = 0; j < placement.height; ++j) {
          for (let i = 0; i < placement.width; ++i) {
            const green = !(placement.blocked?.[j * placement.width + i] ?? !placement.valid);
            const cx = (placement.x + i) * tile, cy = (placement.y + j) * tile;
            ctx.fillStyle = green ? '#35fc1170' : '#fa152a85';
            ctx.strokeStyle = green ? '#57ff29' : '#ff293e';
            ctx.fillRect(cx, cy, tile, tile);
            ctx.strokeRect(cx, cy, tile, tile);
          }
        }
      }
      if (selectBox) {
        ctx.strokeStyle = '#9afa3d';
        ctx.lineWidth = 1 / scale;
        ctx.strokeRect(selectBox.x1, selectBox.y1, selectBox.x2 - selectBox.x1, selectBox.y2 - selectBox.y1);
      }
    }
    drawMinimap(view);
  }

  update(initialWorld);
  return {update, draw};
}
