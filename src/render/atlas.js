// Packs procedurally drawn sprites into 2048x2048 layers (shelf packing).
const SIZE = 2048, PAD = 3;

export function buildAtlas(registerSprites) {
  const list = [];
  registerSprites((key, w, h, draw, opts = {}) => {
    list.push({ key, w: Math.ceil(w), h: Math.ceil(h), draw, ax: opts.ax || 0, ay: opts.ay || 0, rot: !!opts.rot });
  });
  const order = list.map((s, i) => i).sort((a, b) => list[b].h - list[a].h || list[b].w - list[a].w);
  const layers = [];
  let layer = -1, x = SIZE, y = 0, rowH = 0;
  const newLayer = () => {
    const c = document.createElement('canvas');
    c.width = SIZE; c.height = SIZE;
    layers.push(c); layer++; x = 0; y = 0; rowH = 0;
  };
  const map = new Map();
  for (const i of order) {
    const s = list[i];
    const w = s.w + PAD * 2, h = s.h + PAD * 2;
    if (x + w > SIZE) { x = 0; y += rowH; rowH = 0; }
    if (layer < 0 || y + h > SIZE) newLayer();
    s.layer = layer; s.px = x + PAD; s.py = y + PAD;
    x += w; rowH = Math.max(rowH, h);
  }
  const ctxs = layers.map(c => c.getContext('2d'));
  for (const s of list) {
    const ctx = ctxs[s.layer];
    ctx.save();
    ctx.beginPath(); ctx.rect(s.px, s.py, s.w, s.h); ctx.clip();
    ctx.translate(s.px, s.py);
    try { s.draw(ctx, s.w, s.h); } catch (e) { console.warn('sprite failed', s.key, e); }
    ctx.restore();
    map.set(s.key, {
      layer: s.layer, w: s.w, h: s.h, ax: s.ax, ay: s.ay, rot: s.rot,
      u0: s.px / SIZE, v0: s.py / SIZE, u1: (s.px + s.w) / SIZE, v1: (s.py + s.h) / SIZE,
    });
  }
  return { layers, map, count: list.length };
}
