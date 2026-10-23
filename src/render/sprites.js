// Ironfield procedural sprites. Plain ES module, no dependencies.
// Everything is painted with Canvas2D at load time; output is deterministic (seeded PRNG, no Math.random).
// Light comes from the top-left; entities bake a soft shadow toward the lower-right.

export const TILE = 64;
export const BELT_LOOP_TILES = 0.25; // belt ribs are 16 px apart; 16 frames move one rib
const T = TILE, TAU = Math.PI * 2, HP = Math.PI / 2;
const SHX = 26, SHY = 19; // baked shadow offset (0.4, 0.3 tile)
const OUT = 'rgba(17,14,11,0.92)';

// ------------------------------------------------------------------ prng / colour
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const rng = (k) => mulberry32(hashStr(String(k)));

function hex(s) { if (s[0] === 'r') { const m = s.match(/[\d.]+/g); return [+m[0], +m[1], +m[2]]; } s = s.replace('#', ''); if (s.length === 3) s = s.split('').map(x => x + x).join(''); const n = parseInt(s, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const C = (c) => (typeof c === 'string' ? hex(c) : c);
function css(c, a = 1) { c = C(c); return a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`; }
function mix(a, b, t) { a = C(a); b = C(b); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
const lt = (c, t, a = 1) => css(mix(c, [255, 248, 232], t), a);
const dk = (c, t, a = 1) => css(mix(c, [8, 7, 6], t), a);

// ------------------------------------------------------------------ canvas helpers
function mk(w, h) {
  w = Math.max(1, Math.ceil(w)); h = Math.max(1, Math.ceil(h));
  if (typeof document !== 'undefined' && document.createElement) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}
function rrect(x, y, w, h, r = 0) {
  const p = new Path2D(); r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!r) { p.rect(x, y, w, h); return p; }
  p.moveTo(x + r, y); p.arcTo(x + w, y, x + w, y + h, r); p.arcTo(x + w, y + h, x, y + h, r);
  p.arcTo(x, y + h, x, y, r); p.arcTo(x, y, x + w, y, r); p.closePath(); return p;
}
function poly(pts) { const p = new Path2D(); pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); return p; }
function circ(x, y, r) { const p = new Path2D(); p.arc(x, y, Math.max(r, 0.1), 0, TAU); return p; }
function ell(x, y, rx, ry) { const p = new Path2D(); p.ellipse(x, y, Math.max(rx, 0.1), Math.max(ry, 0.1), 0, 0, TAU); return p; }
function chamf(x, y, w, h, c) { return poly([[x + c, y], [x + w - c, y], [x + w, y + c], [x + w, y + h - c], [x + w - c, y + h], [x + c, y + h], [x, y + h - c], [x, y + c]]); }
function smoothPath(pts) {
  const p = new Path2D(), n = pts.length, mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let m = mid(pts[n - 1], pts[0]); p.moveTo(m[0], m[1]);
  for (let i = 0; i < n; i++) { const q = pts[i], m2 = mid(q, pts[(i + 1) % n]); p.quadraticCurveTo(q[0], q[1], m2[0], m2[1]); }
  p.closePath(); return p;
}
function blobPts(cx, cy, rx, ry, n, jit, R) { const pts = []; for (let i = 0; i < n; i++) { const a = (i / n) * TAU, k = 1 + (R() * 2 - 1) * jit; pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]); } return pts; }

function lg(ctx, x0, y0, x1, y1, ...st) { const g = ctx.createLinearGradient(x0, y0, x1, y1); for (let i = 0; i < st.length; i += 2) g.addColorStop(st[i], st[i + 1]); return g; }
function rg(ctx, x0, y0, r0, x1, y1, r1, ...st) { const g = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1); for (let i = 0; i < st.length; i += 2) g.addColorStop(st[i], st[i + 1]); return g; }
function fill(ctx, path, style) { ctx.fillStyle = style; ctx.fill(path); }
function stroke(ctx, path, style = OUT, w = 1.5) { ctx.strokeStyle = style; ctx.lineWidth = w; ctx.stroke(path); }
function seg(ctx, x0, y0, x1, y1, style, w = 1) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.strokeStyle = style; ctx.lineWidth = w; ctx.stroke(); }
function pline(ctx, pts, style, w = 1) { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.strokeStyle = style; ctx.lineWidth = w; ctx.stroke(); }
function dot(ctx, x, y, r, style) { ctx.fillStyle = style; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }

// shared noise textures (built once, reused as CanvasPatterns)
let TEX = null;
function textures() {
  if (TEX) return TEX;
  const N = 128, r = mulberry32(9157);
  const fine = mk(N, N), fg = fine.getContext('2d'), id = fg.createImageData(N, N), d = id.data;
  for (let i = 0; i < N * N; i++) {
    const v = r(), o = i * 4;
    if (v < 0.5) { d[o] = d[o + 1] = d[o + 2] = 0; d[o + 3] = (0.5 - v) * 170; }
    else { d[o] = 255; d[o + 1] = 246; d[o + 2] = 228; d[o + 3] = (v - 0.5) * 110; }
  }
  fg.putImageData(id, 0, 0);
  const blot = mk(N, N), bg = blot.getContext('2d');
  for (let i = 0; i < 80; i++) {
    const x = r() * N, y = r() * N, rad = 4 + r() * 18, dark = r() < 0.72;
    const rgb = dark ? '28,20,12' : '255,244,222', a = dark ? 0.22 + r() * 0.35 : 0.12 + r() * 0.18;
    for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) {
      const cx = x + ox, cy = y + oy;
      if (cx + rad < 0 || cx - rad > N || cy + rad < 0 || cy - rad > N) continue;
      bg.fillStyle = rg(bg, cx, cy, 0, cx, cy, rad, 0, `rgba(${rgb},${a})`, 1, `rgba(${rgb},0)`);
      bg.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    }
  }
  TEX = { fine, blot };
  return TEX;
}
const PATS = new WeakMap();
function pats(ctx) {
  let p = PATS.get(ctx);
  if (!p) { const t = textures(); p = { fine: ctx.createPattern(t.fine, 'repeat'), blot: ctx.createPattern(t.blot, 'repeat') }; PATS.set(ctx, p); }
  return p;
}
// filling the path with the pattern already confines it; no clip needed (clips are slow on GPU canvases)
function grain(ctx, path, a = 0.4, b = 0.28) {
  const p = pats(ctx), ga = ctx.globalAlpha;
  if (a) { ctx.globalAlpha = ga * a; ctx.fillStyle = p.fine; ctx.fill(path); }
  if (b) { ctx.globalAlpha = ga * b; ctx.fillStyle = p.blot; ctx.fill(path); }
  ctx.globalAlpha = ga;
}
// inner bevel: light along top-left inner edge, dark along bottom-right
function bevel(ctx, path, hi = 0.32, lo = 0.42, w = 1.5) {
  ctx.save(); ctx.clip(path); ctx.lineWidth = w * 2;
  ctx.translate(w * 0.8, w * 0.8); ctx.strokeStyle = `rgba(255,250,236,${hi})`; ctx.stroke(path);
  ctx.translate(-w * 1.6, -w * 1.6); ctx.strokeStyle = `rgba(0,0,0,${lo})`; ctx.stroke(path);
  ctx.restore();
}
function panel(ctx, path, base, x, y, w, h, o = {}) {
  ctx.fillStyle = lg(ctx, x, y, x + w * 0.4, y + h, 0, lt(base, o.l ?? 0.16), 1, dk(base, o.d ?? 0.3)); ctx.fill(path);
  if (o.grain !== 0) grain(ctx, path, o.grain ?? 0.4, o.grime ?? 0.28);
  if (o.bevel !== false) bevel(ctx, path, o.hi ?? 0.3, o.lo ?? 0.4, o.bw ?? 1.5);
  if (o.outline !== false) stroke(ctx, path, OUT, o.ow ?? 1.5);
}
// box seen in 3/4 view: top face plus a darker front face of depth d
function block(ctx, x, y, w, h, d, base, o = {}) {
  const r = o.r ?? 3, whole = rrect(x, y, w, h, r);
  fill(ctx, whole, lg(ctx, 0, y + h - d, 0, y + h, 0, dk(base, 0.38), 1, dk(base, 0.62)));
  grain(ctx, whole, 0.35, 0.3);
  const top = rrect(x, y, w, h - d, r);
  panel(ctx, top, base, x, y, w, h - d, { ...o, outline: false });
  seg(ctx, x + 1, y + h - d + 0.5, x + w - 1, y + h - d + 0.5, 'rgba(255,245,225,.18)', 1);
  stroke(ctx, whole, OUT, o.ow ?? 1.5);
  return top;
}
function rivet(ctx, x, y, r = 1.6) {
  dot(ctx, x + 0.6, y + 0.7, r + 0.5, 'rgba(0,0,0,.5)');
  dot(ctx, x, y, r, 'rgba(196,192,180,.95)');
  dot(ctx, x - r * 0.35, y - r * 0.35, r * 0.45, 'rgba(255,255,248,.85)');
}
function seam(ctx, x0, y0, x1, y1, a = 0.5) { seg(ctx, x0, y0, x1, y1, `rgba(0,0,0,${a})`, 1); seg(ctx, x0 + 1, y0 + 1, x1 + 1, y1 + 1, `rgba(255,248,230,${a * 0.45})`, 1); }
function vents(ctx, x, y, w, h, n, vertical = false) {
  for (let i = 0; i < n; i++) {
    if (vertical) { const xx = x + (i + 0.5) * (w / n); fill(ctx, rrect(xx - 1.2, y, 2.4, h, 1), 'rgba(0,0,0,.6)'); seg(ctx, xx + 1.6, y + 1, xx + 1.6, y + h, 'rgba(255,248,230,.18)', 1); }
    else { const yy = y + (i + 0.5) * (h / n); fill(ctx, rrect(x, yy - 1.2, w, 2.4, 1), 'rgba(0,0,0,.6)'); seg(ctx, x + 1, yy + 1.8, x + w, yy + 1.8, 'rgba(255,248,230,.18)', 1); }
  }
}
function hazard(ctx, path, x, y, w, h, s = 6) {
  ctx.save(); ctx.clip(path); fill(ctx, path, '#d9a62c');
  ctx.fillStyle = '#25221d';
  for (let k = -h; k < w + h; k += s * 2) { ctx.beginPath(); ctx.moveTo(x + k, y + h); ctx.lineTo(x + k + s, y + h); ctx.lineTo(x + k + s + h, y); ctx.lineTo(x + k + h, y); ctx.closePath(); ctx.fill(); }
  ctx.restore(); grain(ctx, path, 0.35, 0.35); stroke(ctx, path, OUT, 1);
}
// vertical cylinder (axis up): body + top cap ellipse
function cylV(ctx, x, y, w, h, base, o = {}) {
  const ry = o.ry ?? w * 0.3, cx = x + w / 2;
  const body = new Path2D(); body.moveTo(x, y + ry); body.lineTo(x, y + h - ry); body.ellipse(cx, y + h - ry, w / 2, ry, 0, Math.PI, 0, true); body.lineTo(x + w, y + ry); body.closePath();
  fill(ctx, body, lg(ctx, x, 0, x + w, 0, 0, dk(base, 0.2), 0.2, lt(base, 0.35), 0.42, base, 0.8, dk(base, 0.42), 1, dk(base, 0.62)));
  if (o.grain !== 0) grain(ctx, body, 0.35, o.grime ?? 0.25);
  stroke(ctx, body, OUT, o.ow ?? 1.5);
  const top = ell(cx, y + ry, w / 2, ry);
  fill(ctx, top, o.capStyle || lg(ctx, x, y, x + w, y + 2 * ry, 0, lt(base, 0.38), 1, dk(base, 0.12)));
  stroke(ctx, top, OUT, Math.min(o.ow ?? 1.5, 1.3));
  return { body, top, cx, cy: y + ry, ry };
}
// horizontal cylinder lying along x
function cylH(ctx, x, y, w, h, base, o = {}) {
  const p = rrect(x, y, w, h, o.r ?? Math.min(9, h / 3));
  fill(ctx, p, lg(ctx, 0, y, 0, y + h, 0, dk(base, 0.1), 0.18, lt(base, 0.4), 0.38, lt(base, 0.08), 0.75, dk(base, 0.38), 1, dk(base, 0.62)));
  if (o.grain !== 0) grain(ctx, p, 0.35, o.grime ?? 0.28);
  stroke(ctx, p, OUT, 1.5);
  return p;
}
// cylinder lying along y (seen from above-south): rounded far end, visible near end disc
function cylY(ctx, x, y, w, h, base, o = {}) {
  const rx = w / 2, ry = w * 0.3, cx = x + rx;
  const body = new Path2D(); body.moveTo(x, y + ry); body.ellipse(cx, y + ry, rx, ry, 0, Math.PI, 0); body.lineTo(x + w, y + h - ry); body.lineTo(x, y + h - ry); body.closePath();
  fill(ctx, body, lg(ctx, x, 0, x + w, 0, 0, dk(base, 0.2), 0.2, lt(base, 0.38), 0.42, base, 0.8, dk(base, 0.42), 1, dk(base, 0.62)));
  if (o.grain !== 0) grain(ctx, body, 0.35, o.grime ?? 0.28);
  stroke(ctx, body, OUT, 1.5);
  const end = ell(cx, y + h - ry, rx, ry);
  fill(ctx, end, rg(ctx, cx - rx * 0.3, y + h - ry * 1.5, 1, cx, y + h - ry, rx, 0, lt(base, 0.05), 1, dk(base, 0.5)));
  stroke(ctx, end, OUT, 1.3);
  return { body, end };
}
function gearPath(cx, cy, r, teeth, ang, th = r * 0.2, hole = r * 0.32) {
  const p = new Path2D(), st = TAU / teeth, ri = r - th;
  for (let t = 0; t < teeth; t++) {
    const a = ang + t * st;
    const pts = [[ri, a], [r, a + st * 0.12], [r, a + st * 0.42], [ri, a + st * 0.56]];
    pts.forEach(([rr, aa], i) => { const x = cx + Math.cos(aa) * rr, y = cy + Math.sin(aa) * rr; (t === 0 && i === 0) ? p.moveTo(x, y) : p.lineTo(x, y); });
  }
  p.closePath();
  if (hole) { p.moveTo(cx + hole, cy); p.arc(cx, cy, hole, 0, TAU, true); }
  return p;
}
function gear(ctx, cx, cy, r, teeth, ang, base, o = {}) {
  const p = gearPath(cx, cy, r, teeth, ang, o.th, o.hole ?? r * 0.3);
  if (o.shadow !== false) { ctx.save(); ctx.translate(2, 2.5); fill(ctx, p, 'rgba(0,0,0,.45)'); ctx.restore(); }
  ctx.fillStyle = lg(ctx, cx - r, cy - r, cx + r, cy + r, 0, lt(base, 0.35), 1, dk(base, 0.45)); ctx.fill(p, 'evenodd');
  ctx.strokeStyle = OUT; ctx.lineWidth = o.ow ?? 1.2; ctx.stroke(p);
  const inner = circ(cx, cy, r * 0.62);
  stroke(ctx, inner, 'rgba(0,0,0,.35)', 1);
  ctx.save(); ctx.translate(0.8, 0.8); stroke(ctx, inner, 'rgba(255,248,230,.18)', 1); ctx.restore();
}

// soft blurred shadow: silhouette drawn at 1/s scale, then up-scaled with smoothing (no ctx.filter)
let SHC = null;
function softShadow(ctx, bx, by, bw, bh, fn, alpha = 0.36, s = 4) {
  const tw = Math.ceil(bw / s) + 4, th = Math.ceil(bh / s) + 4;
  if (!SHC || SHC.width < tw + 2 || SHC.height < th + 2) SHC = mk(Math.max(tw + 2, SHC ? SHC.width : 0, 64), Math.max(th + 2, SHC ? SHC.height : 0, 64));
  const g = SHC.getContext('2d');
  // clear a 2 px margin too: smoothing samples just outside the source rect
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, tw + 2, th + 2);
  g.setTransform(1 / s, 0, 0, 1 / s, 2 - bx / s, 2 - by / s);
  g.fillStyle = '#000'; g.strokeStyle = '#000'; g.lineCap = 'round'; g.lineJoin = 'round';
  fn(g);
  g.setTransform(1, 0, 0, 1, 0, 0);
  ctx.save(); ctx.globalAlpha *= alpha; ctx.imageSmoothingEnabled = true;
  ctx.drawImage(SHC, 0, 0, tw, th, bx - 2 * s, by - 2 * s, tw * s, th * s);
  ctx.restore();
}
// shadow of a box with height k (in units of the standard 0.4/0.3 tile offset)
function boxShadow(ctx, x, y, w, h, k = 1, a = 0.36, i = 3) {
  const dx = SHX * k, dy = SHY * k;
  softShadow(ctx, x - 8, y - 8, w + dx + 16, h + dy + 16, (g) => {
    g.beginPath(); g.moveTo(x + i, y + i); g.lineTo(x + w - i, y + i); g.lineTo(x + w - i + dx, y + i + dy);
    g.lineTo(x + w - i + dx, y + h - i + dy); g.lineTo(x + i + dx, y + h - i + dy); g.lineTo(x + i, y + h - i); g.closePath(); g.fill();
  }, a, 4);
}
// tall-object shadow: fn draws in (u, v) space, u = right of base, v = height above ground
const TALL_KX = 0.62, TALL_KY = 0.27;
function tallShadow(ctx, bx, by, box, fn, a = 0.34, s = 4, kx = TALL_KX, ky = TALL_KY) {
  softShadow(ctx, box[0], box[1], box[2], box[3], (g) => { g.transform(1, 0, kx, ky, bx, by); fn(g); }, a, s);
}

// small LRU of pre-rendered static layers (machine bodies reused across animation frames)
const LAYERS = new Map();
function layer(id, w, h, ox, oy, fn) {
  let c = LAYERS.get(id);
  if (c) { LAYERS.delete(id); LAYERS.set(id, c); return c; }
  c = mk(w, h); const g = c.getContext('2d'); g.translate(ox, oy); fn(g);
  LAYERS.set(id, c);
  if (LAYERS.size > 10) LAYERS.delete(LAYERS.keys().next().value);
  return c;
}

// ------------------------------------------------------------------ registry
const DEFS = [], DEFMAP = new Map();
function def(key, w, h, draw, opts = {}) { const d = { key, w: Math.ceil(w), h: Math.ceil(h), draw, opts }; DEFS.push(d); DEFMAP.set(key, d); }
// entity sprite: paint(ctx, o) draws in footprint coordinates (0,0 = footprint top-left)
// snowy: the same sprite with snow settled on top (snowOn)
function ent(key, fw, fh, pad, paint, snowy = false) {
  const p = { l: 0, t: 0, r: SHX + 10, b: SHY + 9, ...pad };
  const w = fw + p.l + p.r, h = fh + p.t + p.b;
  const draw = (ctx) => { ctx.translate(p.l, p.t); paint(ctx, { shadow: true, pad: p, w, h }); };
  def(key, w, h, snowy ? (ctx) => snowOn(ctx, w, h, key, draw) : draw, { ax: p.l, ay: p.t });
}
// Snow settles on whatever faces up: opaque pixels just below the sprite's top silhouette (or below any gap
// of open air, like the shoulders of a fir's tiers) turn white, a little deeper in some columns than others.
function snowOn(ctx, w, h, key, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g);
  const img = g.getImageData(0, 0, w, h), a = img.data, R = rng('snow' + key);
  const ph = R() * 6;
  for (let x = 0; x < w; x++) {
    const depth = 5 + Math.sin(x * 0.42 + ph) * 1.8 + R() * 2.2;
    let run = 0; // opaque pixels since the last open air above
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      if (a[i + 3] < 90) { run = 0; continue; } // open air (soft shadows count as air)
      run++;
      if (run > depth + 1.5 || a[i + 3] < 220) continue;
      const k = run === 1 ? 0.55 : run > depth ? 0.5 : 0.95;
      const tone = run === 1 ? [160, 172, 192] : [240 - run * 2.5, 244 - run * 1.8, 252];
      for (let ch = 0; ch < 3; ch++) a[i + ch] += (tone[ch] - a[i + ch]) * k;
    }
  }
  g.putImageData(img, 0, 0);
  ctx.drawImage(c, 0, 0);
}
// rotate a point given in north-layout footprint pixels (fw x fh) into the footprint for dir
function rotPt(dir, fw, fh, x, y) {
  if (dir === 1) return [fh - y, x];
  if (dir === 2) return [fw - x, fh - y];
  if (dir === 3) return [y, fw - x];
  return [x, y];
}
const DXY = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// ------------------------------------------------------------------ terrain decoration
const TREE_PAL = [
  ['#273f1c', '#46672a', '#82a04a', 'd'],
  ['#21361a', '#3a5826', '#6c8c42', 'd'],
  ['#1a3122', '#2c5236', '#5a8858', 'c'],
  ['#5a2f14', '#9a521f', '#dc9542', 'd'],
  ['#353f1d', '#5e6a2e', '#9ca457', 'd'],
  ['#142a1b', '#22422a', '#477050', 'c'],
  ['#57491a', '#977f27', '#d8c25c', 'd'],
  ['#1f3a37', '#345c54', '#6c9688', 'c'],
];
const TREE_PAD = { l: 50, t: 134, r: 88, b: 46 };
export const SNOW_TREES = [2, 5, 7]; // the firs: in the snow every tree is drawn as one of these
export const PALMS = 4;
export const WARM_TREES = [0, 1, 4]; // the green leafy ones: in the south no firs or autumn colours
function drawTree(ctx, i, o) {
  const R = rng('tree' + i), [cd, cm, cl, type] = TREE_PAL[i];
  const conifer = type === 'c', bx = 32, by = 56;
  const H = conifer ? 168 + R() * 18 : 140 + R() * 20;
  const cw = conifer ? 44 + R() * 8 : 52 + R() * 12;
  const cy = by - H * 0.6;
  if (o.shadow) tallShadow(ctx, bx, by, [-40, -20, 260, 180], (g) => {
    g.fillRect(-5, 0, 10, H * 0.5);
    if (conifer) { g.beginPath(); g.moveTo(-cw, H * 0.1); g.lineTo(cw, H * 0.1); g.lineTo(0, H); g.closePath(); g.fill(); }
    else { g.beginPath(); g.ellipse(0, H * 0.62, cw * 0.95, H * 0.36, 0, 0, TAU); g.fill(); }
  }, 0.34, 5, 0.45, 0.24);
  // trunk
  fill(ctx, ell(bx + 3, by + 1, 15, 5.5), 'rgba(0,0,0,.3)');
  const top = conifer ? by - H * 0.4 : cy + 16, tw = conifer ? 5 : 7 + R() * 2;
  const trunk = poly([[bx - tw - 5, by + 1], [bx - tw, by - 7], [bx - tw * 0.6, top], [bx + tw * 0.6, top], [bx + tw, by - 7], [bx + tw + 5, by + 1]]);
  fill(ctx, trunk, lg(ctx, bx - tw, 0, bx + tw, 0, 0, '#86663f', 0.35, '#5c4127', 1, '#2a1c0f'));
  grain(ctx, trunk, 0.5, 0.3);
  for (let k = 0; k < 4; k++) { const xx = bx - tw * 0.5 + R() * tw; seg(ctx, xx, by - 4 - R() * 6, xx + (R() - 0.5) * 2, top + 10 + R() * 20, 'rgba(20,12,6,.45)', 1); }
  stroke(ctx, trunk, OUT, 1.2);
  if (!conifer) {
    for (const s of [-1, 1]) pline(ctx, [[bx + s * 2, top + 18], [bx + s * 14, top - 6], [bx + s * 20, top - 16]], '#4a3420', 3);
  }
  if (conifer) drawConifer(ctx, R, bx, by, H, cw, cd, cm, cl, o.snow);
  else drawCanopy(ctx, R, bx, cy, H, cw, cd, cm, cl);
}
function drawCanopy(ctx, R, bx, cy, H, cw, cd, cm, cl) {
  const ry = H * 0.3, lumps = [], small = [];
  const nl = 8 + ((R() * 3) | 0);
  for (let k = 0; k < nl; k++) { const a = (k / nl) * TAU + R() * 0.5, d = 0.55 + R() * 0.2; lumps.push({ x: bx + Math.cos(a) * cw * d, y: cy + Math.sin(a) * ry * d, r: cw * (0.34 + R() * 0.12) }); }
  lumps.push({ x: bx - cw * 0.1, y: cy - ry * 0.25, r: cw * 0.5 }, { x: bx + cw * 0.15, y: cy + ry * 0.2, r: cw * 0.45 });
  for (let k = 0; k < 34; k++) { const a = R() * TAU, d = Math.sqrt(R()); small.push({ x: bx + Math.cos(a) * d * cw * 0.9, y: cy + Math.sin(a) * d * ry * 1.0, r: 7 + R() * 7 }); }
  const mass = new Path2D();
  for (const c of lumps) { mass.moveTo(c.x + c.r, c.y); mass.arc(c.x, c.y, c.r, 0, TAU); }
  stroke(ctx, mass, OUT, 3);
  fill(ctx, mass, cd);
  // global top-left light across the canopy
  const gl = (x, y) => Math.max(0, Math.min(1, 0.5 - ((x - bx) / cw) * 0.38 - ((y - cy) / ry) * 0.42));
  ctx.save(); ctx.clip(mass);
  const all = lumps.concat(small).sort((a, b) => a.y - b.y);
  for (const c of all) {
    const g = gl(c.x, c.y), base = mix(cd, cm, 0.25 + g * 0.75), hiC = mix(cm, cl, g);
    if (c.r > 16) fill(ctx, circ(c.x + c.r * 0.12, c.y + c.r * 0.18, c.r), css(mix(cd, [0, 0, 0], 0.25), 0.5));
    fill(ctx, circ(c.x, c.y, c.r), rg(ctx, c.x - c.r * 0.35, c.y - c.r * 0.45, 0.5, c.x, c.y, c.r, 0, css(hiC), 0.6, css(base), 1, c.r > 16 ? css(mix(cd, base, 0.5)) : css(base, 0)));
  }
  // leaf dabs, batched into one path per tone
  const tones = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  for (let k = 0; k < 420; k++) {
    const a = R() * TAU, d = Math.sqrt(R()), x = bx + Math.cos(a) * d * cw * 1.05, y = cy + Math.sin(a) * d * ry * 1.15;
    const g = gl(x, y) + (R() - 0.5) * 0.3, t = g > 0.8 ? 3 : g > 0.55 ? 2 : g > 0.3 ? 1 : 0;
    const rx = 1.6 + R() * 2, ryy = 1 + R() * 0.9, rot = R() * Math.PI;
    tones[t].moveTo(x + Math.cos(rot) * rx, y + Math.sin(rot) * rx); tones[t].ellipse(x, y, rx, ryy, rot, 0, TAU);
  }
  [cd, cm, cl, mix(cl, '#fff8d8', 0.12)].forEach((c, i) => fill(ctx, tones[i], css(c, i ? 0.75 : 0.5)));
  fill(ctx, mass, lg(ctx, 0, cy - ry, 0, cy + ry * 1.3, 0, 'rgba(0,0,0,0)', 0.6, 'rgba(0,0,0,0.05)', 1, 'rgba(10,20,5,.45)'));
  ctx.restore();
}
function drawConifer(ctx, R, bx, by, H, cw, cd, cm, cl, snow = false) {
  const tiers = 5;
  for (let t = 0; t < tiers; t++) {
    const f = t / tiers, tb = by - 16 - f * (H - 34) * 0.95, tt = tb - (H - 34) / tiers * 1.75;
    const hw = cw * (1 - f * 0.78), pts = [[bx, tt]];
    const teeth = 7 - t;
    pts.push([bx + hw * 0.55, tt + (tb - tt) * 0.55]);
    for (let k = 0; k <= teeth; k++) {
      const u = 1 - (2 * k) / teeth, x = bx + u * hw, dy = (k % 2 ? -5 : 2) + R() * 3;
      pts.push([x, tb + dy - Math.abs(u) * 6]);
    }
    pts.push([bx - hw * 0.55, tt + (tb - tt) * 0.55]);
    const p = poly(pts);
    stroke(ctx, p, OUT, 2.6);
    fill(ctx, p, lg(ctx, bx - hw, tt, bx + hw, tb, 0, cl, 0.38, cm, 0.62, cd, 1, css(mix(cd, [0, 0, 0], 0.3))));
    ctx.save(); ctx.clip(p);
    const nd = [new Path2D(), new Path2D(), new Path2D()];
    for (let k = 0; k < 46; k++) {
      const x = bx + (R() * 2 - 1) * hw, y = tt + 6 + R() * (tb - tt - 4), side = x < bx ? -1 : 1;
      const t = x < bx - hw * 0.25 ? 2 : x > bx + hw * 0.2 ? 0 : 1;
      nd[t].moveTo(x, y); nd[t].lineTo(x + side * (3 + R() * 4), y + 3 + R() * 3);
    }
    [mix(cd, '#000000', 0.25), cm, mix(cl, '#fff8d8', 0.15)].forEach((c, i) => stroke(ctx, nd[i], css(c, 0.8), 1.5));
    if (snow) {
      // a layer of snow over the top of the tier, with a wavy lower edge
      const sy = tt + (tb - tt) * (0.42 + R() * 0.08), pts2 = [[bx, tt - 2], [bx + hw * 0.62, tt + (tb - tt) * 0.6]];
      for (let k = 1; k < 6; k++) { const u = 1 - (2 * k) / 6; pts2.push([bx + u * hw * 0.6, sy + (k % 2 ? 4 : -1) + R() * 3 - Math.abs(u) * 2]); }
      pts2.push([bx - hw * 0.62, tt + (tb - tt) * 0.6]);
      const sn = poly(pts2);
      fill(ctx, sn, lg(ctx, bx - hw, tt, bx + hw, tb, 0, '#f6f9fd', 0.5, '#e2e9f3', 1, '#b4c2d6'));
      stroke(ctx, sn, 'rgba(110,128,156,.55)', 1);
    }
    fill(ctx, rrect(bx - hw, tb - 9, hw * 2, 14, 0), 'rgba(0,0,0,.22)');
    ctx.restore();
    pline(ctx, [[bx, tt + 2], [bx - hw * 0.5, tt + (tb - tt) * 0.55]], css(cl, 0.55), 1.3);
  }
}
// a coconut palm for the southern prefectures: a leaning ringed trunk under a crown of drooping fronds
const PALM_PAD = { l: 70, t: 170, r: 100, b: 46 };
function drawPalm(ctx, i, o) {
  const R = rng('palm' + i), bx = 32, by = 56;
  const H = 118 + R() * 34, lean = (i & 1 ? -1 : 1) * (8 + R() * 20);
  const tx = bx + lean, ty = by - H;
  const at = t => { const u = 1 - t; return [u * u * bx + 2 * u * t * (bx + lean * 0.1) + t * t * tx, u * u * by + 2 * u * t * (by - H * 0.55) + t * t * ty]; };
  if (o.shadow) tallShadow(ctx, bx, by, [-60, -20, 300, 220], (g) => {
    g.fillRect(-4, 0, 8, H * 0.95);
    g.beginPath(); g.ellipse(lean * 0.4, H, 54, 24, 0, 0, TAU); g.fill();
  }, 0.3, 5, 0.45, 0.24);
  fill(ctx, ell(bx + 3, by + 1, 12, 4.5), 'rgba(0,0,0,.3)');
  // fronds: [angle, length, droop]; the ones pointing away are drawn behind the trunk top
  const fronds = [];
  const nf = 8 + (i % 2);
  for (let k = 0; k < nf; k++) fronds.push([(k / nf) * TAU + R() * 0.4, 42 + R() * 18, 14 + R() * 16]);
  const frond = ([a, L, droop]) => {
    const ex = tx + Math.cos(a) * L, ey = ty + Math.sin(a) * L * 0.42 + droop;
    const cx = tx + Math.cos(a) * L * 0.5, cy = ty + Math.sin(a) * L * 0.2 - 12;
    const q = t => { const u = 1 - t; return [u * u * tx + 2 * u * t * cx + t * t * ex, u * u * ty + 2 * u * t * cy + t * t * ey]; };
    const left = [], right = [];
    for (let k = 0; k <= 12; k++) {
      const t = k / 12, [x, y] = q(t), [x2, y2] = q(Math.min(1, t + 0.02));
      const dx = x2 - x, dy = y2 - y, l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
      const wd = 8 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 1;
      left.push([x + nx * wd, y + ny * wd]); right.unshift([x - nx * wd, y - ny * wd]);
    }
    const leaf = poly(left.concat(right));
    const lit = 0.5 - Math.cos(a) * 0.25 - Math.sin(a) * 0.2;
    stroke(ctx, leaf, OUT, 2.2);
    fill(ctx, leaf, lg(ctx, tx, ty, ex, ey, 0, css(mix('#3f7a26', '#9fd055', lit)), 1, css(mix('#24461a', '#5f9a32', lit))));
    // leaflets: the notched edge of a palm frond
    const cuts = new Path2D(), ribs = new Path2D();
    for (let k = 1; k < 12; k++) {
      const [x, y] = q(k / 12), [lx, ly] = left[k], [rx, ry] = right[12 - k];
      cuts.moveTo(x, y); cuts.lineTo(lx + (lx - x) * 0.2, ly + (ly - y) * 0.2);
      cuts.moveTo(x, y); cuts.lineTo(rx + (rx - x) * 0.2, ry + (ry - y) * 0.2);
    }
    for (let k = 0; k <= 12; k++) { const [x, y] = q(k / 12); k ? ribs.lineTo(x, y) : ribs.moveTo(x, y); }
    stroke(ctx, cuts, 'rgba(20,40,12,.55)', 1.1);
    stroke(ctx, ribs, css(mix('#c8d88a', '#6f8a3a', 1 - lit), 0.85), 1.4);
  };
  for (const f of fronds) if (Math.sin(f[0]) < 0) frond(f);
  // trunk: segments that narrow toward the top, each with a ring
  ctx.lineCap = 'round';
  const N = 14, pts = [];
  for (let k = 0; k <= N; k++) pts.push(at(k / N));
  for (let k = 0; k < N; k++) seg(ctx, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], OUT, 9.5 - k * 0.25 + 2.4);
  for (let k = 0; k < N; k++) seg(ctx, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], k & 1 ? '#86663f' : '#7a5b37', 9.5 - k * 0.25);
  for (let k = 0; k < N; k++) seg(ctx, pts[k][0] - 2, pts[k][1], pts[k + 1][0] - 2, pts[k + 1][1], 'rgba(230,205,160,.35)', 2);
  for (let k = 1; k < N; k++) { const [x, y] = pts[k], w = (9.5 - k * 0.25) / 2; seg(ctx, x - w, y + 1, x + w, y - 1, 'rgba(40,26,14,.6)', 1.2); }
  ctx.lineCap = 'butt';
  // coconuts under the crown
  for (const [dx, dy] of [[-5, 6], [4, 7], [0, 10]]) {
    fill(ctx, circ(tx + dx, ty + dy, 4.6), OUT);
    fill(ctx, circ(tx + dx, ty + dy, 3.8), rg(ctx, tx + dx - 1.5, ty + dy - 1.5, 0.5, tx + dx, ty + dy, 4, 0, '#8a6a3a', 1, '#3e2a14'));
  }
  for (const f of fronds) if (Math.sin(f[0]) >= 0) frond(f);
}
function drawDeadTree(ctx, i, o) {
  const R = rng('dead' + i), bx = 32, by = 56, segs = [];
  const br = (x, y, a, len, w, d) => {
    const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len; segs.push([x, y, x2, y2, w]);
    if (d > 0) { const n = d > 2 ? 2 : 1 + (R() < 0.6 ? 1 : 0); for (let k = 0; k < n; k++) br(x2, y2, a + (k ? 1 : -1) * (0.35 + R() * 0.45) + (R() - 0.5) * 0.3, len * (0.62 + R() * 0.12), w * 0.62, d - 1); }
  };
  br(bx, by, -HP + (R() - 0.5) * 0.15, 46 + i * 8, 9, 4);
  br(bx, by - 30, -HP - 0.9, 26, 4, 2);
  if (o.shadow) tallShadow(ctx, bx, by, [-40, -20, 240, 160], (g) => {
    for (const [x0, y0, x1, y1, w] of segs) { g.lineWidth = w + 1; g.beginPath(); g.moveTo(x0 - bx, by - y0); g.lineTo(x1 - bx, by - y1); g.stroke(); }
  }, 0.3, 3, 0.5, 0.24);
  fill(ctx, ell(bx + 3, by + 1, 12, 4.5), 'rgba(0,0,0,.3)');
  ctx.lineCap = 'round';
  for (const [x0, y0, x1, y1, w] of segs) seg(ctx, x0, y0, x1, y1, OUT, w + 2.4);
  for (const [x0, y0, x1, y1, w] of segs) seg(ctx, x0, y0, x1, y1, '#6e6152', w);
  for (const [x0, y0, x1, y1, w] of segs) if (w > 2) seg(ctx, x0 - w * 0.25, y0, x1 - w * 0.25, y1, 'rgba(210,198,176,.45)', w * 0.3);
  ctx.lineCap = 'butt';
}
const ROCK_PAD = { l: 22, t: 28, r: 34, b: 24 };
function drawRock(ctx, i, o) {
  const R = rng('rock' + i);
  const parts = i === 0 ? [[30, 36, 36, 27], [62, 50, 13, 9]] : i === 1 ? [[33, 34, 44, 32]] : [[22, 40, 22, 17], [46, 28, 19, 15], [52, 52, 14, 10]];
  if (o.shadow) softShadow(ctx, -24, -24, 140, 120, (g) => { for (const [x, y, rx, ry] of parts) { g.beginPath(); g.ellipse(x + rx * 0.35, y + ry * 0.45, rx * 1.02, ry * 0.92, 0, 0, TAU); g.fill(); } }, 0.36, 4);
  const sorted = parts.slice().sort((a, b) => a[1] - b[1]);
  for (const [cx, cy, rx, ry] of sorted) {
    const n = 9, pts = [];
    for (let k = 0; k < n; k++) { const a = (k / n) * TAU + R() * 0.3, d = 0.82 + R() * 0.22; pts.push([cx + Math.cos(a) * rx * d, Math.min(cy + Math.sin(a) * ry * d, cy + ry * 0.78)]); }
    fill(ctx, ell(cx + 2, cy + ry * 0.7, rx * 0.95, ry * 0.35), 'rgba(0,0,0,.35)');
    const p = poly(pts);
    fill(ctx, p, lg(ctx, cx - rx, cy - ry, cx + rx * 0.6, cy + ry, 0, '#a09682', 0.45, '#776e5e', 1, '#38322a'));
    const top = poly(pts.map(([x, y]) => [cx - rx * 0.14 + (x - cx) * 0.66, cy - ry * 0.32 + (y - cy) * 0.52]));
    fill(ctx, top, lg(ctx, cx - rx, cy - ry, cx + rx * 0.5, cy, 0, 'rgba(226,218,196,.7)', 1, 'rgba(170,160,140,.35)'));
    ctx.save(); ctx.clip(p); stroke(ctx, top, 'rgba(40,34,26,.35)', 1.2); ctx.restore();
    ctx.save(); ctx.clip(p); fill(ctx, poly([[cx + rx * 0.15, cy + ry * 0.05], [cx + rx, cy - ry * 0.1], [cx + rx, cy + ry], [cx, cy + ry]]), 'rgba(20,16,10,.22)'); ctx.restore();
    ctx.save(); ctx.clip(p);
    for (let k = 0; k < 3; k++) { const a = R() * TAU; pline(ctx, [[cx + Math.cos(a) * rx * 0.2, cy + Math.sin(a) * ry * 0.2], [cx + Math.cos(a) * rx * 1.1, cy + Math.sin(a) * ry * 1.1]], 'rgba(30,26,20,.45)', 1); }
    for (let k = 0; k < 4; k++) fill(ctx, ell(cx - rx * 0.3 + R() * rx * 0.6, cy - ry * 0.55 + R() * ry * 0.3, 3 + R() * 5, 2 + R() * 2), 'rgba(92,110,52,.35)');
    ctx.restore();
    grain(ctx, p, 0.55, 0.35);
    bevel(ctx, p, 0.28, 0.4, 1.5);
    stroke(ctx, p, OUT, 1.5);
  }
}
function drawDecal(ctx, i) {
  const R = rng('decal' + i);
  const blades = (n, col, h) => { for (let k = 0; k < n; k++) { const x = 9 + R() * 14, y = 24 + R() * 3, a = -HP + (R() - 0.5) * 1.1; pline(ctx, [[x, y], [x + Math.cos(a) * h * 0.5, y + Math.sin(a) * h * 0.5 - 1], [x + Math.cos(a) * h, y + Math.sin(a) * h]], css(mix(col, R() < 0.5 ? '#ffffff' : '#000000', R() * 0.25), 0.75), 1.2); } };
  const pebble = (x, y, r) => { fill(ctx, ell(x + 1, y + 1, r + 0.5, r * 0.7), 'rgba(0,0,0,.3)'); fill(ctx, ell(x, y, r, r * 0.72), lg(ctx, x - r, y - r, x + r, y + r, 0, '#a59d8c', 1, '#55504a')); dot(ctx, x - r * 0.35, y - r * 0.3, r * 0.3, 'rgba(255,250,235,.4)'); };
  switch (i) {
    case 0: blades(9, '#6f8c3c', 10); break;
    case 1: pebble(12, 16, 3.2); pebble(19, 19, 2.2); pebble(15, 22, 1.8); pebble(22, 13, 1.5); break;
    case 2: blades(6, '#5f7f38', 8); for (let k = 0; k < 4; k++) { const x = 10 + R() * 12, y = 12 + R() * 8; dot(ctx, x, y, 1.6, k % 2 ? 'rgba(240,236,220,.9)' : 'rgba(232,200,70,.9)'); dot(ctx, x, y, 0.6, 'rgba(200,120,40,.9)'); } break;
    case 3: for (let k = 0; k < 14; k++) dot(ctx, 6 + R() * 20, 6 + R() * 20, 0.6 + R() * 1.4, `rgba(${60 + R() * 30},${42 + R() * 20},${24},${0.3 + R() * 0.3})`); break;
    case 4: blades(10, '#a29a52', 9); break;
    case 5: pebble(16, 17, 4.5); fill(ctx, ell(14, 14.5, 3, 1.5), 'rgba(96,120,52,.6)'); blades(3, '#6f8c3c', 6); break;
    case 6: for (let k = 0; k < 5; k++) { const x = 9 + R() * 14, y = 10 + R() * 12; for (let j = 0; j < 3; j++) { const a = (j / 3) * TAU + R(); fill(ctx, ell(x + Math.cos(a) * 1.8, y + Math.sin(a) * 1.8, 1.8, 1.8), 'rgba(78,112,48,.7)'); } } break;
    default: for (let k = 0; k < 3; k++) { const x = 8 + R() * 14, y = 10 + R() * 12, a = R() * Math.PI; pline(ctx, [[x, y], [x + Math.cos(a) * 9, y + Math.sin(a) * 9]], 'rgba(86,64,40,.7)', 1.3); } break;
  }
}
const ORE_COL = {
  'iron-ore': ['#5d7388', '#adc0cf', '#253140'],
  'copper-ore': ['#a65a33', '#ec9c62', '#47210f'],
  coal: ['#29292d', '#7a7a84', '#0a0a0c'],
  stone: ['#a28c64', '#dccaa2', '#54442d'],
};
function oreChunk(ctx, R, x, y, r, res) {
  const [base, light, darkc] = ORE_COL[res];
  fill(ctx, ell(x + r * 0.35, y + r * 0.55, r * 1.25, r * 0.75), 'rgba(0,0,0,.16)');
  fill(ctx, ell(x + r * 0.2, y + r * 0.45, r * 1.02, r * 0.58), 'rgba(0,0,0,.26)');
  const n = 6 + ((R() * 2) | 0), pts = [];
  for (let k = 0; k < n; k++) { const a = (k / n) * TAU + R() * 0.5, d = r * (0.75 + R() * 0.35); pts.push([x + Math.cos(a) * d, y + Math.sin(a) * d * 0.84]); }
  const p = poly(pts);
  fill(ctx, p, lg(ctx, x - r, y - r, x + r * 0.6, y + r, 0, light, 0.42, base, 1, darkc));
  const fp = poly(pts.map(([px, py]) => [x - r * 0.18 + (px - x) * 0.55, y - r * 0.26 + (py - y) * 0.5]));
  fill(ctx, fp, css(mix(light, base, 0.35), 0.5));
  if (res === 'copper-ore' && R() < 0.7) for (let k = 0; k < 2; k++) dot(ctx, x + (R() - 0.5) * r, y + (R() - 0.5) * r * 0.8, Math.max(0.7, r * 0.18), 'rgba(80,160,118,.85)');
  if (res === 'coal') { seg(ctx, x - r * 0.45, y - r * 0.3, x - r * 0.05, y - r * 0.5, 'rgba(255,255,255,.55)', 1); }
  if (res === 'iron-ore') dot(ctx, x - r * 0.3, y - r * 0.32, Math.max(0.6, r * 0.16), 'rgba(220,235,250,.6)');
  if (res === 'stone') for (let k = 0; k < 2; k++) dot(ctx, x + (R() - 0.5) * r, y + (R() - 0.5) * r * 0.7, 0.7, 'rgba(60,46,30,.6)');
  stroke(ctx, p, css(mix(darkc, [0, 0, 0], 0.45), 0.9), r > 5 ? 1.2 : 1);
}
function drawOre(ctx, res, v, dens) {
  const R = rng(`ore:${res}:${v}:${dens}`);
  // jittered grid keeps coverage even, so neighbouring tiles read as one continuous field
  const grid = [2, 3, 4, 5][dens], keep = [0.85, 0.85, 0.9, 0.95][dens], rmin = [2.6, 3.2, 3.8, 4.4], rmax = [4.4, 5.4, 6.6, 7.8];
  const cell = 64 / grid, placed = [];
  for (let gy = 0; gy < grid; gy++) for (let gx = 0; gx < grid; gx++) {
    if (R() > keep) continue;
    const r = rmin[dens] + R() * (rmax[dens] - rmin[dens]), m = r * 0.85 + 1.5;
    const x = Math.max(m, Math.min(64 - m, (gx + 0.5 + (R() - 0.5) * 0.8) * cell));
    const y = Math.max(m, Math.min(64 - m - 1, (gy + 0.5 + (R() - 0.5) * 0.8) * cell));
    placed.push({ x, y, r });
  }
  if (dens === 0) placed.push({ x: 12 + R() * 40, y: 12 + R() * 40, r: 2.2 });
  placed.sort((a, b) => a.y - b.y);
  const [, , darkc] = ORE_COL[res];
  for (const c of placed) fill(ctx, ell(c.x + 1, c.y + 2, c.r * 1.9, c.r * 1.4), rg(ctx, c.x + 1, c.y + 2, 0, c.x + 1, c.y + 2, c.r * 1.9, 0, css(darkc, 0.22), 1, css(darkc, 0)));
  const gs = new Path2D(), gv = new Path2D();
  for (let k = 0; k < 6 + dens * 5; k++) { const x = 4 + R() * 56, y = 4 + R() * 56, r = 0.6 + R() * 0.8; gs.moveTo(x + 1.7, y + 0.6); gs.arc(x + 0.5, y + 0.6, 1.2, 0, TAU); gv.moveTo(x + r, y); gv.arc(x, y, r, 0, TAU); }
  fill(ctx, gs, 'rgba(0,0,0,.3)'); fill(ctx, gv, css(mix(ORE_COL[res][0], ORE_COL[res][1], 0.4), 0.9));
  for (const c of placed) oreChunk(ctx, R, c.x, c.y, c.r, res);
}
function drawOil(ctx, v) {
  const R = rng('oil' + v), cx = 64, cy = 64;
  const soil = smoothPath(blobPts(cx, cy, 50, 42, 12, 0.18, R));
  fill(ctx, soil, rg(ctx, cx, cy, 10, cx, cy, 54, 0, 'rgba(24,16,12,.6)', 0.75, 'rgba(36,26,18,.35)', 1, 'rgba(36,26,18,0)'));
  const pud = smoothPath(blobPts(cx, cy, 34, 27, 11, 0.22, R));
  fill(ctx, pud, rg(ctx, cx - 8, cy - 8, 2, cx, cy, 38, 0, '#2a1f30', 0.7, '#120c14', 1, '#07050a'));
  ctx.save(); ctx.clip(pud);
  const sheen = [['rgba(140,70,190,.35)', -10, -6, 16], ['rgba(40,170,160,.28)', 8, 4, 14], ['rgba(210,170,60,.22)', -2, 10, 12], ['rgba(70,90,210,.25)', 12, -10, 10]];
  for (const [col, ox, oy, r] of sheen) { const x = cx + ox + (R() - 0.5) * 8, y = cy + oy + (R() - 0.5) * 6; fill(ctx, ell(x, y, r * 1.4, r), rg(ctx, x, y, 0, x, y, r * 1.4, 0, col, 1, 'rgba(0,0,0,0)')); }
  fill(ctx, ell(cx - 10, cy - 10, 14, 5), 'rgba(255,255,255,.12)');
  for (let k = 0; k < 6; k++) { const x = cx + (R() - 0.5) * 40, y = cy + (R() - 0.5) * 30, r = 1 + R() * 2; stroke(ctx, circ(x, y, r), 'rgba(200,190,220,.35)', 0.8); }
  ctx.restore();
  stroke(ctx, pud, 'rgba(0,0,0,.6)', 1.5);
  ctx.save(); ctx.translate(0.8, 1); ctx.clip(pud); stroke(ctx, pud, 'rgba(255,255,255,.12)', 1.5); ctx.restore();
}

function defTerrain() {
  for (let i = 0; i < 8; i++) ent('tree:' + i, 64, 64, TREE_PAD, (ctx, o) => drawTree(ctx, i, o));
  for (let i = 0; i < 2; i++) ent('deadtree:' + i, 64, 64, { l: 30, t: 100, r: 96, b: 50 }, (ctx, o) => drawDeadTree(ctx, i, o));
  for (let i = 0; i < 3; i++) ent('rock:' + i, 64, 64, ROCK_PAD, (ctx, o) => drawRock(ctx, i, o));
  // the snowy north and the warm south (renderer._drawDecor picks these by the climate, plots.js climateAt)
  for (const i of SNOW_TREES) ent('tree-snow:' + i, 64, 64, TREE_PAD, (ctx, o) => drawTree(ctx, i, { ...o, snow: true }), true);
  for (let i = 0; i < 2; i++) ent('deadtree-snow:' + i, 64, 64, { l: 30, t: 100, r: 96, b: 50 }, (ctx, o) => drawDeadTree(ctx, i, o), true);
  for (let i = 0; i < 3; i++) ent('rock-snow:' + i, 64, 64, ROCK_PAD, (ctx, o) => drawRock(ctx, i, o), true);
  for (let i = 0; i < PALMS; i++) ent('palm:' + i, 64, 64, PALM_PAD, (ctx, o) => drawPalm(ctx, i, o));
  for (let i = 0; i < 8; i++) def('decal:' + i, 32, 32, (ctx) => drawDecal(ctx, i));
  for (const res of ['iron-ore', 'copper-ore', 'coal', 'stone'])
    for (let v = 0; v < 6; v++) for (let d = 0; d < 4; d++) def(`ore:${res}:${v}:${d}`, 64, 64, (ctx) => drawOre(ctx, res, v, d));
  for (let v = 0; v < 2; v++) def('oil:' + v, 128, 128, (ctx) => drawOil(ctx, v), { ax: 32, ay: 32 });
}

// ------------------------------------------------------------------ belts
const BELT = ['#d8a42a', '#c9412e', '#3a8fd4'];
// (u, s) -> pixel: u = lateral offset (+ = right of travel), s = distance travelled from the entry edge
function beltMap(shape) {
  if (shape === 's') return (u, s) => [32 + u, 64 - s];
  if (shape === 'cl') return (u, s) => { const r = 32 + u, a = HP * (1 - s / 64); return [r * Math.cos(a), r * Math.sin(a)]; };
  return (u, s) => { const r = 32 - u, a = HP * (1 + s / 64); return [64 + r * Math.cos(a), r * Math.sin(a)]; };
}
function band(m, u0, u1, s0, s1, n) {
  const p = new Path2D();
  for (let i = 0; i <= n; i++) { const [x, y] = m(u0, s0 + ((s1 - s0) * i) / n); i ? p.lineTo(x, y) : p.moveTo(x, y); }
  for (let i = n; i >= 0; i--) { const [x, y] = m(u1, s0 + ((s1 - s0) * i) / n); p.lineTo(x, y); }
  p.closePath(); return p;
}
// frame-0 plates, masked to the tread band; frames translate (straight) or rotate about the curve centre
function beltPlates(g, tier, shape) {
  const m = beltMap(shape), col = BELT[tier], plate = css(mix('#46433d', col, 0.1)), us = [-25, -17, -9, 0, 9, 17, 25];
  g.save();
  if (shape === 's') { g.beginPath(); g.rect(7.5, -40, 49, 160); g.clip(); }
  else { const cx = shape === 'cl' ? 0 : 64, p = new Path2D(); p.moveTo(cx + 56.5, 0); p.arc(cx, 0, 56.5, 0, TAU); p.moveTo(cx + 7.5, 0); p.arc(cx, 0, 7.5, 0, TAU, true); g.clip(p); }
  const plates = new Path2D(), fronts = [], backs = [];
  for (let k = -2; k <= 6; k++) {
    const s0 = 16 * k, front = [], back = [];
    for (const u of us) { const c = 4 * (1 - Math.abs(u) / 25); front.push(m(u, s0 + c + 4.6)); back.push(m(u, s0 + c - 4.6)); }
    const all = front.concat(back.slice().reverse());
    all.forEach(([x, y], i) => (i ? plates.lineTo(x, y) : plates.moveTo(x, y))); plates.closePath();
    fronts.push(front); backs.push(back);
  }
  fill(g, plates, plate);
  grain(g, plates, 0.35, 0.15);
  for (const f of fronts) pline(g, f, 'rgba(255,240,210,.26)', 1.4);
  for (const b of backs) pline(g, b, 'rgba(0,0,0,.6)', 1.6);
  g.restore();
}
function beltOver(g, tier, shape) {
  const m = beltMap(shape), col = BELT[tier], n = shape === 's' ? 1 : 14;
  fill(g, band(m, -1.1, 1.1, 0, 64, n), 'rgba(0,0,0,.42)');
  fill(g, band(m, -24.5, -20, 0, 64, n), 'rgba(0,0,0,.38)');
  fill(g, band(m, 20, 24.5, 0, 64, n), 'rgba(0,0,0,.3)');
  for (const sd of [-1, 1]) {
    fill(g, band(m, sd * 23.5, sd * 32, 0, 64, n), '#2b2823');
    const strip = band(m, sd * 25, sd * 31, 0, 64, n);
    fill(g, strip, col);
    fill(g, band(m, sd * 25, sd * 26.6, 0, 64, n), lt(col, 0.42, 0.9));
    fill(g, band(m, sd * 29.4, sd * 31, 0, 64, n), dk(col, 0.45, 0.9));
    grain(g, strip, 0.3, 0.2);
    const inner = (shape === 'cl' && sd < 0) || (shape === 'cr' && sd > 0);
    if (!inner) for (let s = 8; s < 64; s += 16) { const [x, y] = m(sd * 28, s); rivet(g, x, y, 1.3); }
  }
  for (const u of [-32, -23.5, 23.5, 32]) { const pts = []; for (let i = 0; i <= n; i++) pts.push(m(u, (64 * i) / n)); pline(g, pts, 'rgba(10,8,6,.75)', 1); }
}
function drawBelt(ctx, tier, shape, f) {
  const m = beltMap(shape), n = shape === 's' ? 1 : 14;
  fill(ctx, band(m, -24.5, 24.5, 0, 64, n), '#191714');
  const pl = layer(`bp${tier}${shape}`, 112, 112, 24, 24, (g) => beltPlates(g, tier, shape));
  ctx.save();
  if (shape === 's') ctx.translate(0, -f);
  else { const cx = shape === 'cl' ? 0 : 64; ctx.translate(cx, 0); ctx.rotate(((shape === 'cl' ? -1 : 1) * HP * f) / 64); ctx.translate(-cx, 0); }
  ctx.drawImage(pl, -24, -24);
  ctx.restore();
  ctx.drawImage(layer(`bo${tier}${shape}`, 64, 64, 0, 0, (g) => beltOver(g, tier, shape)), 0, 0);
}
function drawUB(ctx, tier, out) {
  const col = BELT[tier];
  ctx.save();
  if (out) { ctx.translate(0, 64); ctx.scale(1, -1); } // exit hood is the entrance mirrored
  fill(ctx, rrect(8, 14, 48, 40, 0), lg(ctx, 0, 18, 0, 56, 0, 'rgba(0,0,0,.97)', 0.45, 'rgba(0,0,0,.62)', 1, 'rgba(0,0,0,0)'));
  for (const [x, s] of [[0, 1], [54, -1]]) {
    const p = s > 0 ? poly([[x, 0], [x + 10, 0], [x + 10, 52], [x, 46]]) : poly([[x, 0], [x + 10, 0], [x + 10, 46], [x, 52]]);
    panel(ctx, p, '#47443e', x, 0, 10, 52, { grime: 0.2 });
    const st = rrect(x + 2.5, 2, 5, 40, 2); fill(ctx, st, col); bevel(ctx, st, 0.35, 0.4, 1);
    rivet(ctx, x + 5, 46, 1.2);
  }
  const roof = rrect(3, 0, 58, 26, 3);
  panel(ctx, roof, col, 3, 0, 58, 26);
  for (const y of [6, 12, 18]) seam(ctx, 6, y, 58, y, 0.4);
  const lip = rrect(4, 21, 56, 9, 2);
  panel(ctx, lip, '#4b4740', 4, 21, 56, 9, { grime: 0.15 });
  for (const x of [11, 23, 41, 53]) rivet(ctx, x, 25.5, 1.3);
  fill(ctx, rrect(8, 30, 48, 3, 0), 'rgba(0,0,0,.45)');
  ctx.restore();
  const c = out ? 52 : 11; // travel arrow always points north
  const ar = poly([[32, c - 7], [41, c + 1], [36.5, c + 1], [36.5, c + 6], [27.5, c + 6], [27.5, c + 1], [23, c + 1]]);
  fill(ctx, ar, 'rgba(20,16,12,.6)');
}
function drawSplitter(ctx, tier) {
  const col = BELT[tier];
  fill(ctx, rrect(4, 17, 122, 34, 6), 'rgba(0,0,0,.32)');
  for (const x of [0, 114]) { const p = rrect(x, 11, 14, 42, 3); panel(ctx, p, '#47443e', x, 11, 14, 42); fill(ctx, rrect(x + 4, 15, 6, 34, 2), col); rivet(ctx, x + 7, 47, 1.3); }
  const beam = rrect(9, 17, 110, 30, 4);
  panel(ctx, beam, '#57534c', 9, 17, 110, 30);
  for (const x of [14, 72]) {
    const p = rrect(x, 20, 42, 20, 3); panel(ctx, p, col, x, 20, 42, 20);
    vents(ctx, x + 6, 24, 30, 12, 4, true);
  }
  fill(ctx, rrect(10, 41, 108, 6, 2), 'rgba(0,0,0,.35)');
  const dv = rrect(57, 12, 14, 40, 3); panel(ctx, dv, '#3e3b36', 57, 12, 14, 40);
  fill(ctx, rrect(60, 16, 8, 8, 2), col);
  rivet(ctx, 64, 31, 1.4); rivet(ctx, 64, 44, 1.4);
}
function defBelts() {
  for (let t = 0; t < 3; t++) {
    for (const sh of ['s', 'cl', 'cr']) for (let f = 0; f < 16; f++) def(`belt:${t}:${sh}:${f}`, 64, 64, (ctx) => drawBelt(ctx, t, sh, f), { rot: true });
    def(`ub:${t}:in`, 64, 64, (ctx) => drawUB(ctx, t, false), { rot: true });
    def(`ub:${t}:out`, 64, 64, (ctx) => drawUB(ctx, t, true), { rot: true });
    def(`splitter:${t}`, 128, 64, (ctx) => drawSplitter(ctx, t), { rot: true });
  }
}

// ------------------------------------------------------------------ inserters
const INS = {
  'burner-inserter': { arm: '#5f5a53', hub: '#8a5a32' },
  inserter: { arm: '#d8a42e', hub: '#d8a42e' },
  'long-handed-inserter': { arm: '#c43c2c', hub: '#c43c2c' },
  'fast-inserter': { arm: '#3a86c8', hub: '#3a86c8' },
};
function insBase(ctx, name) {
  const c = INS[name];
  softShadow(ctx, 10, 12, 52, 50, (g) => g.fill(rrect(16, 18, 40, 38, 7)), 0.38, 3);
  const plate = rrect(13, 14, 38, 37, 7);
  panel(ctx, plate, '#5c5a55', 13, 14, 38, 37);
  for (const [x, y] of [[18.5, 19.5], [45.5, 19.5], [18.5, 45.5], [45.5, 45.5]]) rivet(ctx, x, y, 1.6);
  if (name === 'burner-inserter') { const fb = rrect(22, 41, 20, 8, 2); panel(ctx, fb, '#3d3a35', 22, 41, 20, 8); vents(ctx, 25, 43, 14, 4, 4, true); }
  fill(ctx, circ(33, 34, 14), 'rgba(0,0,0,.4)');
  const ring = circ(32, 32, 13);
  fill(ctx, ring, lg(ctx, 20, 20, 44, 44, 0, lt(c.hub, 0.35), 0.5, c.hub, 1, dk(c.hub, 0.5)));
  grain(ctx, ring, 0.3, 0.2); stroke(ctx, ring, OUT, 1.5);
  const hub = circ(32, 32, 7);
  fill(ctx, hub, rg(ctx, 29, 29, 1, 32, 32, 7, 0, '#9c9a94', 1, '#3a3935')); stroke(ctx, hub, OUT, 1.2);
  dot(ctx, 32, 32, 2.2, '#1d1c1a');
}
function insArm(ctx, name) {
  const c = INS[name].arm, long = name === 'long-handed-inserter', w = long ? 5 : 7;
  const bar = rrect(8 - w / 2, 7, w, 50, w / 2);
  fill(ctx, bar, lg(ctx, 8 - w / 2, 0, 8 + w / 2, 0, 0, lt(c, 0.45), 0.45, c, 1, dk(c, 0.5)));
  if (long) for (let y = 14; y < 52; y += 7) fill(ctx, rrect(7, y, 2, 3.5, 1), 'rgba(0,0,0,.55)');
  else seg(ctx, 8, 12, 8, 52, 'rgba(0,0,0,.25)', 1);
  stroke(ctx, bar, OUT, 1.3);
  const j0 = circ(8, 56, 5.5); fill(ctx, j0, rg(ctx, 6, 54, 0.5, 8, 56, 5.5, 0, '#a4a29b', 1, '#3b3a36')); stroke(ctx, j0, OUT, 1.2); dot(ctx, 8, 56, 1.6, '#1b1a18');
  const j1 = circ(8, 8, 4.2); fill(ctx, j1, rg(ctx, 6.5, 6.5, 0.5, 8, 8, 4.2, 0, '#a4a29b', 1, '#3b3a36')); stroke(ctx, j1, OUT, 1.1);
}
function insHand(ctx, name, closed) {
  const c = INS[name].hub, steel = '#7d7b75';
  const finger = (s) => {
    const pts = closed
      ? [[16 + s * 2.5, 21], [16 + s * 4.5, 12], [16 + s * 3, 4], [16 + s * 0.8, 5.5], [16 + s * 1.8, 12], [16 + s * 0.8, 20]]
      : [[16 + s * 3, 21], [16 + s * 10, 10], [16 + s * 9, 3], [16 + s * 6.5, 4], [16 + s * 7, 10], [16 + s * 1, 20]];
    const p = poly(pts); fill(ctx, p, lg(ctx, 6, 0, 26, 0, 0, lt(steel, 0.35), 1, dk(steel, 0.45))); stroke(ctx, p, OUT, 1.2);
  };
  finger(-1); finger(1);
  const wr = rrect(10, 19, 12, 10, 3);
  fill(ctx, wr, lg(ctx, 10, 19, 22, 29, 0, lt(c, 0.3), 1, dk(c, 0.45))); stroke(ctx, wr, OUT, 1.2);
  dot(ctx, 16, 24, 1.8, '#2a2825');
}
function defInserters() {
  for (const n of Object.keys(INS)) {
    def(`ins:${n}:base`, 64, 64, (ctx) => insBase(ctx, n));
    def(`ins:${n}:arm`, 16, 64, (ctx) => insArm(ctx, n), { rot: true });
    def(`ins:${n}:hand`, 32, 32, (ctx) => insHand(ctx, n, false), { rot: true });
    def(`ins:${n}:handc`, 32, 32, (ctx) => insHand(ctx, n, true), { rot: true });
  }
}

// ------------------------------------------------------------------ poles / lamp
const POLE = {
  'small-electric-pole': { bx: 32, by: 46, top: 152, pad: { t: 118, r: 102, b: 40 } },
  'medium-electric-pole': { bx: 32, by: 46, top: 190, pad: { t: 158, r: 128, b: 50 } },
  'big-electric-pole': { bx: 64, by: 96, top: 306, pad: { t: 222, r: 214, b: 66 } },
};
function drawSmallPole(ctx, o) {
  const { bx, by } = POLE['small-electric-pole'];
  if (o.shadow) tallShadow(ctx, bx, by, [0, 20, 170, 100], (g) => {
    g.beginPath(); g.moveTo(-7, 0); g.lineTo(-5, 146); g.lineTo(5, 146); g.lineTo(7, 0); g.fill();
    g.fillRect(-26, 125, 52, 9); g.fillRect(-3, 146, 6, 10);
    g.fillRect(-24, 133, 6, 9); g.fillRect(18, 133, 6, 9);
  });
  fill(ctx, ell(bx + 2, by + 1, 13, 5), 'rgba(0,0,0,.38)');
  const pole = poly([[bx - 7, by + 1], [bx - 5, by - 146], [bx + 5, by - 146], [bx + 7, by + 1]]);
  fill(ctx, pole, lg(ctx, bx - 7, 0, bx + 7, 0, 0, '#a88352', 0.35, '#77563a', 1, '#33220f'));
  grain(ctx, pole, 0.55, 0.35);
  for (let k = 0; k < 4; k++) seg(ctx, bx - 3.5 + k * 2.3, by - 6, bx - 3 + k * 1.9, by - 140, 'rgba(30,18,8,.3)', 0.8);
  fill(ctx, rrect(bx - 7.5, by - 16, 15, 4, 1), 'rgba(40,36,30,.7)');
  stroke(ctx, pole, OUT, 1.4);
  for (const s of [-1, 1]) { pline(ctx, [[bx + s * 3, by - 100], [bx + s * 20, by - 127]], OUT, 5); pline(ctx, [[bx + s * 3, by - 100], [bx + s * 20, by - 127]], '#6a4b2c', 3); }
  const bar = rrect(bx - 26, by - 134, 52, 9, 2);
  fill(ctx, bar, lg(ctx, 0, by - 134, 0, by - 125, 0, '#b08a56', 0.5, '#7c5a36', 1, '#3e2a16')); grain(ctx, bar, 0.4, 0.2); stroke(ctx, bar, OUT, 1.3);
  for (const ux of [-20.5, 0, 20.5]) {
    const top = ux === 0 ? by - 157 : by - 143, x = bx + ux;
    const ins = rrect(x - 3.4, top, 6.8, 10, 2);
    fill(ctx, ins, lg(ctx, x - 3.4, 0, x + 3.4, 0, 0, '#dcefe4', 0.45, '#8fb6a2', 1, '#3b5c4e')); stroke(ctx, ins, OUT, 1.1);
    seg(ctx, x - 3.4, top + 3.5, x + 3.4, top + 3.5, 'rgba(0,0,0,.35)', 1); seg(ctx, x - 3.4, top + 6.5, x + 3.4, top + 6.5, 'rgba(0,0,0,.3)', 1);
  }
}
function drawMediumPole(ctx, o) {
  const { bx, by } = POLE['medium-electric-pole'];
  if (o.shadow) tallShadow(ctx, bx, by, [0, 20, 200, 120], (g) => {
    g.beginPath(); g.moveTo(-10, 0); g.lineTo(-6, 178); g.lineTo(6, 178); g.lineTo(10, 0); g.fill();
    g.fillRect(-21, 171, 42, 7); g.fillRect(-4, 178, 8, 14);
  });
  fill(ctx, ell(bx + 2, by + 3, 18, 6), 'rgba(0,0,0,.38)');
  const foot = rrect(bx - 15, by - 7, 30, 13, 2); panel(ctx, foot, '#8b877c', bx - 15, by - 7, 30, 13);
  const rust = '#8c4a32';
  const legs = poly([[bx - 9, by - 2], [bx - 5, by - 178], [bx + 5, by - 178], [bx + 9, by - 2]]);
  fill(ctx, legs, 'rgba(24,14,10,.62)');
  ctx.lineCap = 'round';
  for (let y = by - 8, k = 0; y > by - 172; y -= 14, k++) {
    const w0 = 9 - ((by - y) / 178) * 4, w1 = 9 - ((by - y + 14) / 178) * 4, s = k % 2 ? 1 : -1;
    seg(ctx, bx - s * w0, y, bx + s * w1, y - 14, OUT, 3.2); seg(ctx, bx - s * w0, y, bx + s * w1, y - 14, dk(rust, 0.1), 1.8);
  }
  for (const s of [-1, 1]) { seg(ctx, bx + s * 9, by - 2, bx + s * 5, by - 178, OUT, 6); seg(ctx, bx + s * 9, by - 2, bx + s * 5, by - 178, s < 0 ? lt(rust, 0.32) : dk(rust, 0.18), 3.8); }
  ctx.lineCap = 'butt';
  const arm = rrect(bx - 21, by - 178, 42, 8, 2); panel(ctx, arm, rust, bx - 21, by - 178, 42, 8, { grain: 0.2 });
  for (const ux of [-16, 0, 16]) {
    const x = bx + ux, top = ux === 0 ? by - 196 : by - 188;
    const ins = rrect(x - 3.4, top, 6.8, 12, 2);
    fill(ctx, ins, lg(ctx, x - 3.4, 0, x + 3.4, 0, 0, '#e2eae8', 0.45, '#a3b0b2', 1, '#4b5658')); stroke(ctx, ins, OUT, 1.1);
    for (const d of [3.5, 6.5, 9.5]) seg(ctx, x - 3.4, top + d, x + 3.4, top + d, 'rgba(0,0,0,.32)', 1);
  }
}
function drawBigPole(ctx, o) {
  const { bx, by } = POLE['big-electric-pole'];
  const H = 286, steel = '#73777b';
  const legs = [[-46, 0, -9], [46, 0, 9], [-36, -22, -7], [36, -22, 7]]; // [u at ground, screen y offset (back legs higher), u at top]
  const lvl = [0, 60, 116, 166, 210, 250, H];
  const ux = (L, v) => L[0] + ((L[2] - L[0]) * v) / H;
  if (o.shadow) tallShadow(ctx, bx, by, [0, 40, 360, 200], (g) => {
    g.lineWidth = 5;
    for (const L of legs.slice(0, 2)) { g.beginPath(); g.moveTo(L[0], 0); g.lineTo(L[2], H); g.stroke(); }
    g.lineWidth = 2.5;
    for (let i = 0; i < lvl.length - 1; i++) { const a = lvl[i], b = lvl[i + 1]; g.beginPath(); g.moveTo(ux(legs[0], a), a); g.lineTo(ux(legs[1], b), b); g.moveTo(ux(legs[1], a), a); g.lineTo(ux(legs[0], b), b); g.stroke(); }
    g.fillRect(-50, H - 4, 100, 9); g.fillRect(-6, H, 12, 18);
  }, 0.34, 3);
  for (const L of legs) { const x = bx + L[0], y = by + L[1]; fill(ctx, ell(x + 2, y + 2, 11, 5), 'rgba(0,0,0,.35)'); panel(ctx, rrect(x - 8, y - 5, 16, 9, 2), '#8e8a80', x - 8, y - 5, 16, 9); }
  const P = (L, v) => [bx + ux(L, v), by + L[1] * (1 - v / H) - v];
  const beam = (a, b, w, col) => { ctx.lineCap = 'round'; seg(ctx, a[0], a[1], b[0], b[1], OUT, w + 2); seg(ctx, a[0], a[1], b[0], b[1], col, w); };
  // back face first, then sides, then front
  for (const L of [legs[2], legs[3]]) beam(P(L, 0), P(L, H), 4.5, dk(steel, 0.25));
  for (let i = 0; i < lvl.length - 1; i++) { const a = lvl[i], b = lvl[i + 1]; beam(P(legs[2], a), P(legs[3], b), 1.4, dk(steel, 0.35)); beam(P(legs[3], a), P(legs[2], b), 1.4, dk(steel, 0.35)); }
  for (let i = 1; i < lvl.length; i++) { const v = lvl[i]; beam(P(legs[0], v), P(legs[2], v), 1.6, dk(steel, 0.15)); beam(P(legs[1], v), P(legs[3], v), 1.6, dk(steel, 0.3)); }
  for (let i = 0; i < lvl.length - 1; i++) { const a = lvl[i], b = lvl[i + 1]; beam(P(legs[0], a), P(legs[1], b), 2.4, steel); beam(P(legs[1], a), P(legs[0], b), 2.4, dk(steel, 0.1)); if (i) beam(P(legs[0], a), P(legs[1], a), 2.6, lt(steel, 0.1)); }
  beam(P(legs[0], 0), P(legs[0], H), 5.5, lt(steel, 0.25)); beam(P(legs[1], 0), P(legs[1], H), 5.5, dk(steel, 0.2));
  ctx.lineCap = 'butt';
  const ty = by - H;
  const arm = rrect(bx - 50, ty - 8, 100, 9, 2); panel(ctx, arm, steel, bx - 50, ty - 8, 100, 9, { grain: 0.25 });
  const cap = rrect(bx - 10, ty - 18, 20, 12, 2); panel(ctx, cap, steel, bx - 10, ty - 18, 20, 12, { grain: 0.25 });
  for (const ux2 of [-40, 0, 40]) {
    const x = bx + ux2, top = ux2 === 0 ? ty - 30 : ty - 2;
    const ins = rrect(x - 3.2, top, 6.4, 13, 2);
    fill(ctx, ins, lg(ctx, x - 3, 0, x + 3, 0, 0, '#e8eee9', 0.5, '#a6b6ac', 1, '#4a5a52')); stroke(ctx, ins, OUT, 1);
    for (let k = 1; k < 4; k++) seg(ctx, x - 3.2, top + k * 3.2, x + 3.2, top + k * 3.2, 'rgba(0,0,0,.35)', 1);
  }
}
function drawLamp(ctx, o, on) {
  if (o.shadow) boxShadow(ctx, 17, 22, 30, 28, 0.5, 0.36);
  const base = rrect(16, 22, 32, 28, 5);
  block(ctx, 16, 22, 32, 28, 7, '#6a6863', { r: 5 });
  for (const [x, y] of [[20, 26], [44, 26], [20, 39], [44, 39]]) rivet(ctx, x, y, 1.3);
  void base;
  const lens = circ(32, 32, 9.5);
  fill(ctx, circ(32.5, 33.5, 11), 'rgba(0,0,0,.45)');
  if (on) {
    fill(ctx, circ(32, 32, 22), rg(ctx, 32, 32, 4, 32, 32, 22, 0, 'rgba(255,240,180,.6)', 1, 'rgba(255,220,140,0)'));
    fill(ctx, lens, rg(ctx, 30, 30, 1, 32, 32, 10, 0, '#ffffff', 0.4, '#fff3be', 1, '#e8b850'));
  } else fill(ctx, lens, rg(ctx, 29, 29, 1, 32, 32, 10, 0, '#e8e2c8', 0.35, '#a59f80', 1, '#4f4b3a'));
  stroke(ctx, lens, OUT, 1.4);
  fill(ctx, ell(29, 28.5, 3.5, 2.2), 'rgba(255,255,255,.65)');
  for (let a = 0; a < 4; a++) { const an = a * HP + Math.PI / 4; seg(ctx, 32 + Math.cos(an) * 4, 32 + Math.sin(an) * 4, 32 + Math.cos(an) * 9, 32 + Math.sin(an) * 9, 'rgba(60,50,30,.35)', 1); }
}
function defPoles() {
  ent('ent:small-electric-pole', 64, 64, POLE['small-electric-pole'].pad, drawSmallPole);
  ent('ent:medium-electric-pole', 64, 64, POLE['medium-electric-pole'].pad, drawMediumPole);
  ent('ent:big-electric-pole', 128, 128, POLE['big-electric-pole'].pad, drawBigPole);
  ent('ent:small-lamp', 64, 64, { r: 18, b: 14 }, (c, o) => drawLamp(c, o, false));
  ent('ent:small-lamp:on', 64, 64, { r: 18, b: 14 }, (c, o) => drawLamp(c, o, true));
}

// ------------------------------------------------------------------ pipes
const PIPE = '#8d8b85';
function pipeV(ctx, x, y0, y1, hw = 12, base = PIPE) {
  const p = rrect(x - hw, y0, hw * 2, y1 - y0, 0);
  fill(ctx, p, lg(ctx, x - hw, 0, x + hw, 0, 0, dk(base, 0.25), 0.16, lt(base, 0.42), 0.38, lt(base, 0.1), 0.78, dk(base, 0.35), 1, dk(base, 0.62)));
  grain(ctx, p, 0.35, 0.32);
  seg(ctx, x - hw, y0, x - hw, y1, OUT, 1.4); seg(ctx, x + hw, y0, x + hw, y1, OUT, 1.4);
}
function pipeH(ctx, x0, x1, y, hw = 12, base = PIPE) {
  const p = rrect(x0, y - hw, x1 - x0, hw * 2, 0);
  fill(ctx, p, lg(ctx, 0, y - hw, 0, y + hw, 0, dk(base, 0.15), 0.14, lt(base, 0.45), 0.36, lt(base, 0.1), 0.78, dk(base, 0.38), 1, dk(base, 0.64)));
  grain(ctx, p, 0.35, 0.32);
  seg(ctx, x0, y - hw, x1, y - hw, OUT, 1.4); seg(ctx, x0, y + hw, x1, y + hw, OUT, 1.4);
}
function flange(ctx, x, y, vertical, hw = 12, base = PIPE) {
  const r = vertical ? rrect(x - hw - 3, y - 3.5, hw * 2 + 6, 7, 2) : rrect(x - 3.5, y - hw - 3, 7, hw * 2 + 6, 2);
  const b = vertical ? [x - hw - 3, y - 3.5, hw * 2 + 6, 7] : [x - 3.5, y - hw - 3, 7, hw * 2 + 6];
  panel(ctx, r, lt(base, 0.06), b[0], b[1], b[2], b[3], { grain: 0.3, bw: 1, ow: 1.1, l: 0.25, d: 0.35 });
  if (vertical) { rivet(ctx, x - hw + 1, y, 1.1); rivet(ctx, x + hw - 1, y, 1.1); }
  else { rivet(ctx, x, y - hw + 1, 1.1); rivet(ctx, x, y + hw - 1, 1.1); }
}
function pipeHub(ctx, x, y, r = 15, base = PIPE) {
  const p = rrect(x - r, y - r, r * 2, r * 2, 9);
  fill(ctx, p, rg(ctx, x - r * 0.4, y - r * 0.45, 1, x, y, r * 1.4, 0, lt(base, 0.45), 0.5, base, 1, dk(base, 0.6)));
  grain(ctx, p, 0.35, 0.3); stroke(ctx, p, OUT, 1.4);
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) rivet(ctx, x + dx * (r - 4.5), y + dy * (r - 4.5), 1.3);
}
function pipeShadow(ctx, mask) {
  softShadow(ctx, 0, 0, 80, 80, (g) => {
    const d = 6;
    g.fillRect(20 + d, 20 + d, 24, 24);
    if (mask & 1) g.fillRect(20 + d, 0 + d, 24, 32);
    if (mask & 4) g.fillRect(20 + d, 32 + d, 24, 32);
    if (mask & 2) g.fillRect(32 + d, 20 + d, 32, 24);
    if (mask & 8) g.fillRect(0 + d, 20 + d, 32, 24);
  }, 0.3, 3);
}
function drawPipe(ctx, mask, o) {
  if (o.shadow) pipeShadow(ctx, mask || 5);
  const N = mask & 1, E = mask & 2, S = mask & 4, W = mask & 8;
  if (!mask) {
    pipeV(ctx, 32, 14, 50); flange(ctx, 32, 16, true); flange(ctx, 32, 48, true); pipeHub(ctx, 32, 32, 13); return;
  }
  if (N) pipeV(ctx, 32, 0, 33); if (S) pipeV(ctx, 32, 31, 64);
  if (W) pipeH(ctx, 0, 33, 32); if (E) pipeH(ctx, 31, 64, 32);
  const straight = mask === 5 || mask === 10;
  if (straight) {
    if (mask === 5) seam(ctx, 21, 32, 43, 32, 0.4); else seam(ctx, 32, 21, 32, 43, 0.4);
  } else pipeHub(ctx, 32, 32);
  if (N) flange(ctx, 32, 5, true); if (S) flange(ctx, 32, 59, true);
  if (W) flange(ctx, 5, 32, false); if (E) flange(ctx, 59, 32, false);
}
function drawPipeToGround(ctx, dir, o) {
  const [dx, dy] = DXY[dir];
  if (o.shadow) pipeShadow(ctx, 1 << dir);
  // mound where the pipe dives underground (opposite side)
  const mx = 32 - dx * 13, my = 32 - dy * 13 + 2;
  fill(ctx, ell(mx, my, 22, 15), rg(ctx, mx, my, 2, mx, my, 22, 0, 'rgba(40,30,20,.75)', 0.7, 'rgba(60,46,30,.45)', 1, 'rgba(60,46,30,0)'));
  if (dir === 0) pipeV(ctx, 32, 0, 34); else if (dir === 2) pipeV(ctx, 32, 30, 64); else if (dir === 1) pipeH(ctx, 30, 64, 32); else pipeH(ctx, 0, 34, 32);
  // hood: squat housing with dark opening toward the ground side
  const hx = 32 - dx * 6, hy = 32 - dy * 6;
  const hood = rrect(hx - 17, hy - 15, 34, 30, 7);
  panel(ctx, hood, '#7d7b75', hx - 17, hy - 15, 34, 30);
  const ox = 32 - dx * 14, oy = 32 - dy * 14;
  const hole = dir % 2 === 0 ? ell(ox, oy, 12, 5) : ell(ox, oy, 5, 12);
  fill(ctx, hole, '#141210'); stroke(ctx, hole, 'rgba(0,0,0,.8)', 1);
  for (const [a, b] of [[-11, -9], [11, -9], [-11, 9], [11, 9]]) rivet(ctx, hx + a, hy + b, 1.3);
  if (dir === 0) flange(ctx, 32, 5, true); else if (dir === 2) flange(ctx, 32, 59, true); else if (dir === 1) flange(ctx, 59, 32, false); else flange(ctx, 5, 32, false);
}
function drawPipePort(ctx, dir) {
  const [dx, dy] = DXY[dir];
  const L = 28;
  const shp = dir === 0 ? [20, 0, 24, L + 6] : dir === 2 ? [20, 64 - L - 6, 24, L + 6] : dir === 1 ? [64 - L - 6, 20, L + 6, 24] : [0, 20, L + 6, 24];
  fill(ctx, rrect(shp[0] + 4, shp[1] + 4, shp[2], shp[3], 2), 'rgba(0,0,0,.3)');
  if (dir === 0) pipeV(ctx, 32, 0, L + 2); else if (dir === 2) pipeV(ctx, 32, 62 - L, 64); else if (dir === 1) pipeH(ctx, 62 - L, 64, 32); else pipeH(ctx, 0, L + 2, 32);
  const ex = 32 + dx * 27, ey = 32 + dy * 27, bxp = 32 + dx * (32 - L), byp = 32 + dy * (32 - L);
  flange(ctx, ex, ey, dir % 2 === 0);
  const pl = dir % 2 === 0 ? rrect(bxp - 17, byp - 4, 34, 8, 2) : rrect(bxp - 4, byp - 17, 8, 34, 2);
  const bb = dir % 2 === 0 ? [bxp - 17, byp - 4, 34, 8] : [bxp - 4, byp - 17, 8, 34];
  panel(ctx, pl, '#6a6862', bb[0], bb[1], bb[2], bb[3], { grain: 0.3, bw: 1 });
}
function defPipes() {
  for (let m = 0; m < 16; m++) ent('pipe:' + m, 64, 64, { r: 8, b: 8 }, (c, o) => drawPipe(c, m, o));
  for (let d = 0; d < 4; d++) ent('ent:pipe-to-ground:' + d, 64, 64, { r: 8, b: 8 }, (c, o) => drawPipeToGround(c, d, o));
  for (let d = 0; d < 4; d++) def('pipe-port:' + d, 64, 64, (c) => drawPipePort(c, d));
}

// ------------------------------------------------------------------ chests / tank
function drawChest(ctx, kind, o) {
  const x = 10, y = 11, w = 44, h = 45, d = 11;
  if (o.shadow) boxShadow(ctx, x, y, w, h, 0.75);
  if (kind === 'wooden-chest') {
    const top = block(ctx, x, y, w, h, d, '#8c5d33', { r: 2, grain: 0.5, grime: 0.35 });
    ctx.save(); ctx.clip(top);
    for (const py of [y + 11, y + 22]) seam(ctx, x, py, x + w, py, 0.6);
    const R = rng('wood-chest'); for (let k = 0; k < 12; k++) { const yy = y + 2 + R() * 30, xx = x + R() * w; seg(ctx, xx, yy, xx + 6 + R() * 10, yy + (R() - 0.5), 'rgba(50,28,12,.35)', 1); }
    ctx.restore();
    seam(ctx, x, y + h - d + 5, x + w, y + h - d + 5, 0.5);
    for (const [cx, cy] of [[x, y], [x + w - 8, y], [x, y + h - d - 8], [x + w - 8, y + h - d - 8]]) { const b = rrect(cx, cy, 8, 8, 1); panel(ctx, b, '#57534d', cx, cy, 8, 8, { grain: 0.2, bw: 1, ow: 1 }); rivet(ctx, cx + 4, cy + 4, 1.1); }
    const latch = rrect(x + w / 2 - 4, y + h - d - 3, 8, 9, 1.5); panel(ctx, latch, '#6a665f', x + w / 2 - 4, y + h - d - 3, 8, 9, { bw: 1, ow: 1 });
  } else if (kind === 'iron-chest') {
    block(ctx, x, y, w, h, d, '#8b8c88', { r: 3 });
    const inner = rrect(x + 6, y + 6, w - 12, h - d - 12, 2);
    panel(ctx, inner, '#7a7b77', x + 6, y + 6, w - 12, h - d - 12, { hi: 0.15, lo: 0.3, bw: 1, ow: 1 });
    seam(ctx, x + w / 2, y + 7, x + w / 2, y + h - d - 7, 0.4);
    for (const [cx, cy] of [[x + 3.5, y + 3.5], [x + w - 3.5, y + 3.5], [x + 3.5, y + h - d - 3.5], [x + w - 3.5, y + h - d - 3.5], [x + w / 2, y + 3.5], [x + w / 2, y + h - d - 3.5]]) rivet(ctx, cx, cy, 1.3);
    const latch = rrect(x + w / 2 - 5, y + h - d - 2, 10, 8, 1.5); panel(ctx, latch, '#55534e', x + w / 2 - 5, y + h - d - 2, 10, 8, { bw: 1, ow: 1 });
  } else {
    block(ctx, x, y, w, h, d, '#5e6874', { r: 3 });
    const fr = rrect(x + 4, y + 4, w - 8, h - d - 8, 2);
    ctx.save(); ctx.clip(fr);
    seg(ctx, x + 4, y + 4, x + w - 4, y + h - d - 4, '#3b424b', 5); seg(ctx, x + w - 4, y + 4, x + 4, y + h - d - 4, '#3b424b', 5);
    seg(ctx, x + 3, y + 3, x + w - 5, y + h - d - 5, 'rgba(255,255,255,.18)', 1);
    ctx.restore();
    stroke(ctx, fr, 'rgba(0,0,0,.45)', 1.5);
    for (const [cx, cy] of [[x + 4, y + 4], [x + w - 4, y + 4], [x + 4, y + h - d - 4], [x + w - 4, y + h - d - 4], [x + w / 2, y + (h - d) / 2]]) rivet(ctx, cx, cy, 1.5);
    fill(ctx, rrect(x + 3, y + h - d + 3, w - 6, 3, 1), 'rgba(214,170,64,.75)');
  }
}
function drawTank(ctx, o) {
  const cx = 96, cy = 88, R = 72;
  if (o.shadow) softShadow(ctx, 0, 0, 240, 230, (g) => { g.fillRect(12, 14, 170, 170); g.beginPath(); g.ellipse(cx + 30, cy + 34, R, R * 0.9, 0, 0, TAU); g.fill(); }, 0.36, 5);
  const frame = chamf(8, 10, 176, 174, 18);
  fill(ctx, frame, lg(ctx, 0, 150, 0, 184, 0, '#3e3d39', 1, '#25241f'));
  panel(ctx, chamf(8, 10, 176, 164, 18), '#5d5c56', 8, 10, 176, 164);
  stroke(ctx, frame, OUT, 1.6);
  for (const [x, y] of [[20, 22], [172, 22], [20, 160], [172, 160]]) rivet(ctx, x, y, 2);
  pipeV(ctx, 96, 0, 30); pipeV(ctx, 96, 160, 192); pipeH(ctx, 0, 30, 96); pipeH(ctx, 162, 192, 96);
  flange(ctx, 96, 5, true); flange(ctx, 96, 187, true); flange(ctx, 5, 96, false); flange(ctx, 187, 96, false);
  // cylinder wall + roof
  const wall = new Path2D(); wall.ellipse(cx, cy + 16, R, R * 0.86, 0, 0, Math.PI); wall.lineTo(cx - R, cy); wall.ellipse(cx, cy, R, R * 0.86, 0, Math.PI, 0, true); wall.closePath();
  fill(ctx, ell(cx + 4, cy + 20, R + 3, R * 0.88), 'rgba(0,0,0,.35)');
  fill(ctx, wall, lg(ctx, cx - R, 0, cx + R, 0, 0, '#6e6d66', 0.25, '#b7b5ab', 0.5, '#8c8a82', 1, '#3a3934'));
  grain(ctx, wall, 0.35, 0.3); stroke(ctx, wall, OUT, 1.5);
  const roof = ell(cx, cy, R, R * 0.86);
  fill(ctx, roof, rg(ctx, cx - 28, cy - 30, 4, cx, cy, R * 1.1, 0, '#d3d0c5', 0.5, '#a19f96', 1, '#64625b'));
  grain(ctx, roof, 0.35, 0.3);
  for (const k of [0.72, 0.45]) { stroke(ctx, ell(cx, cy, R * k, R * 0.86 * k), 'rgba(0,0,0,.28)', 1); stroke(ctx, ell(cx + 0.8, cy + 0.8, R * k, R * 0.86 * k), 'rgba(255,255,255,.18)', 1); }
  stroke(ctx, roof, OUT, 1.6);
  for (let k = 0; k < 20; k++) { const a = (k / 20) * TAU; rivet(ctx, cx + Math.cos(a) * (R - 5), cy + Math.sin(a) * (R - 5) * 0.86, 1.2); }
  // walkway
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.6);
  const wk = rrect(0, -7, R - 4, 14, 2); panel(ctx, wk, '#55534d', 0, -7, R - 4, 14, { grain: 0.2 });
  for (let x = 4; x < R - 6; x += 5) seg(ctx, x, -6, x, 6, 'rgba(0,0,0,.45)', 1);
  seg(ctx, 0, -7, R - 4, -7, '#c9a43a', 1.5); seg(ctx, 0, 7, R - 4, 7, '#c9a43a', 1.5);
  ctx.restore();
  const hatch = circ(cx, cy, 13); panel(ctx, hatch, '#76746d', cx - 13, cy - 13, 26, 26); dot(ctx, cx, cy, 4, '#3a3934');
}
function defStorage() {
  for (const k of ['wooden-chest', 'iron-chest', 'steel-chest']) ent('ent:' + k, 64, 64, { r: 30, b: 22 }, (c, o) => drawChest(c, k, o));
  ent('ent:storage-tank', 192, 192, { r: 40, b: 30 }, drawTank);
}

// ------------------------------------------------------------------ shared machine bits
function glow(ctx, x, y, r, col, a = 1) {
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha *= a;
  fill(ctx, circ(x, y, r), rg(ctx, x, y, 0, x, y, r, 0, col, 1, 'rgba(0,0,0,0)'));
  ctx.restore();
}
function fireWindow(ctx, path, x, y, w, h, on, bars = 4) {
  if (on) {
    fill(ctx, path, lg(ctx, 0, y, 0, y + h, 0, '#ffe08a', 0.45, '#ff9a2a', 1, '#b33a0c'));
    ctx.save(); ctx.clip(path); const R = rng('fire' + x + y);
    for (let k = 0; k < 6; k++) fill(ctx, ell(x + R() * w, y + h * (0.55 + R() * 0.4), 2 + R() * 4, 3 + R() * 5), 'rgba(255,250,210,.55)');
    ctx.restore();
  } else fill(ctx, path, lg(ctx, 0, y, 0, y + h, 0, '#0d0b0a', 1, '#2a1a12'));
  for (let i = 1; i < bars; i++) { const xx = x + (w * i) / bars; seg(ctx, xx, y, xx, y + h, on ? 'rgba(60,20,5,.85)' : 'rgba(80,76,70,.8)', 1.6); }
  stroke(ctx, path, OUT, 1.4);
}
function chuteAt(ctx, x, y, dir, len = 16, wd = 24) {
  const hw = wd / 2, [dx, dy] = DXY[dir];
  const r = dir === 0 ? [x - hw, y - len, wd, len + 14] : dir === 2 ? [x - hw, y - 14, wd, len + 14] : dir === 1 ? [x - 14, y - hw, len + 14, wd] : [x - len, y - hw, len + 14, wd];
  const p = rrect(r[0], r[1], r[2], r[3], 3);
  panel(ctx, p, '#6e706a', r[0], r[1], r[2], r[3]);
  const ch = dir % 2 === 0 ? rrect(r[0] + 5, r[1] + 3, r[2] - 10, r[3] - 6, 2) : rrect(r[0] + 3, r[1] + 5, r[2] - 6, r[3] - 10, 2);
  // channel: dark inside the machine, lighter toward the open end
  const ex = x + dx * len, ey = y + dy * len, ix = x - dx * 14, iy = y - dy * 14;
  fill(ctx, ch, lg(ctx, ix, iy, ex, ey, 0, '#0f0e0d', 0.6, '#2c2a26', 1, '#4a4741'));
  stroke(ctx, ch, 'rgba(0,0,0,.65)', 1);
  const lip = dir % 2 === 0 ? rrect(x - hw, ey - (dir === 0 ? 0 : 4), wd, 4, 1) : rrect(ex - (dir === 3 ? 0 : 4), y - hw, 4, wd, 1);
  fill(ctx, lip, '#d6a42c'); stroke(ctx, lip, OUT, 1);
  for (let k = 0; k < 3; k++) dot(ctx, x + dx * (len - 8 - k * 5) + (k - 1) * 2.5 * (dir % 2 ? 0 : 1), y + dy * (len - 8 - k * 5) + (k - 1) * 2.5 * (dir % 2), 1.7, 'rgba(160,150,128,.7)');
}
function nozzle(ctx, x, y, dir, kind = 'in') {
  const vert = dir % 2 === 0, [dx, dy] = DXY[dir];
  const L = 22, x0 = x - dx * 4, y0 = y - dy * 4;
  if (vert) pipeV(ctx, x, Math.min(y0, y0 + dy * L), Math.max(y0, y0 + dy * L), 9); else pipeH(ctx, Math.min(x0, x0 + dx * L), Math.max(x0, x0 + dx * L), y, 9);
  flange(ctx, x0 + dx * (L - 4), y0 + dy * (L - 4), vert, 9);
  const c = kind === 'in' ? '#b8432f' : '#3a7cc0';
  const vx = x0 + dx * 6, vy = y0 + dy * 6;
  fill(ctx, circ(vx, vy, 6), c); stroke(ctx, circ(vx, vy, 6), OUT, 1.2); dot(ctx, vx - 1.5, vy - 1.5, 1.8, 'rgba(255,255,255,.45)');
}
function bricks(ctx, path, x, y, w, h, base, R, bh = 9, bw = 16) {
  ctx.save(); ctx.clip(path);
  for (let row = 0, yy = y; yy < y + h; row++, yy += bh) {
    for (let xx = x - (row % 2) * bw * 0.5; xx < x + w; xx += bw) {
      const b = rrect(xx + 0.5, yy + 0.5, bw - 1, bh - 1, 2), c = mix(base, R() < 0.5 ? '#000000' : '#ffffff', R() * 0.16);
      fill(ctx, b, lg(ctx, xx, yy, xx + bw * 0.3, yy + bh, 0, lt(c, 0.12), 1, dk(c, 0.25)));
      bevel(ctx, b, 0.25, 0.35, 1);
    }
  }
  grain(ctx, path, 0.35, 0.3);
  ctx.restore();
}

// ------------------------------------------------------------------ mining drills
const BD_PAD = { l: 16, t: 20, r: 40, b: 32 };
const BD_CHIM = [[104, 34], [26, 34], [104, 34], [104, 34]]; // chimney base (footprint px); top is 40 px higher
function bdStatic(ctx, dir, o) {
  if (o.shadow) boxShadow(ctx, 6, 14, 116, 110, 1.1);
  const [ox, oy] = rotPt(dir, 128, 128, 32, 0);
  if (dir === 0) chuteAt(ctx, ox, oy, 0);
  const top = block(ctx, 6, 16, 116, 106, 16, '#6b6861');
  ctx.save(); ctx.clip(top); for (const x of [36, 92]) seam(ctx, x, 16, x, 106, 0.35); ctx.restore();
  for (const [x, y] of [[12, 22], [116, 22], [12, 100], [116, 100]]) rivet(ctx, x, y, 1.6);
  const fb = rrect(30, 70, 68, 52, 4);
  bricks(ctx, fb, 30, 70, 68, 52, '#8d806d', rng('bd' + dir));
  stroke(ctx, fb, OUT, 1.5);
  const door = rrect(46, 98, 36, 18, 3); fireWindow(ctx, door, 46, 98, 36, 18, false);
  glow(ctx, 64, 110, 14, 'rgba(255,120,40,.35)');
  const cx = 64, cy = 46;
  fill(ctx, circ(cx + 1, cy + 2, 27), 'rgba(0,0,0,.4)');
  const rim = circ(cx, cy, 25); panel(ctx, rim, '#55534d', cx - 25, cy - 25, 50, 50);
  fill(ctx, circ(cx, cy, 19), '#191816');
  cylV(ctx, 14, 40, 16, 34, '#7c7a73');
  const [chx, chy] = BD_CHIM[dir];
  cylV(ctx, chx - 7, chy - 40, 14, 44, '#5c5a55', { ry: 4 });
  fill(ctx, ell(chx, chy - 36, 5, 2.6), '#0e0d0c');
  if (dir !== 0) chuteAt(ctx, ox, oy, dir);
}
function drawBurnerDrill(ctx, dir, f, o) {
  const pd = o.pad;
  ctx.drawImage(layer('bd' + dir + (o.shadow ? 's' : ''), o.w, o.h, pd.l, pd.t, (g) => bdStatic(g, dir, o)), -pd.l, -pd.t);
  const cx = 64, cy = 46;
  ctx.save(); ctx.clip(circ(cx, cy, 19));
  gear(ctx, cx, cy, 16, 8, (f * TAU) / 32, '#8f8b80', { hole: 0 });
  fill(ctx, circ(cx, cy, 6), rg(ctx, cx - 2, cy - 2, 0, cx, cy, 6, 0, '#e2c25a', 1, '#6e5418')); stroke(ctx, circ(cx, cy, 6), OUT, 1);
  fill(ctx, circ(cx, cy, 19), rg(ctx, cx, cy, 8, cx, cy, 19, 0, 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,.6)'));
  ctx.restore();
  stroke(ctx, circ(cx, cy, 19), OUT, 1.4);
  const py = 34 + Math.round(Math.sin((f * TAU) / 4) * 4);
  fill(ctx, rrect(20, py, 4, 14, 1), '#c9c6bd'); stroke(ctx, rrect(20, py, 4, 14, 1), OUT, 1);
  const cap = rrect(15, py - 5, 14, 6, 2); panel(ctx, cap, '#5d5b55', 15, py - 5, 14, 6, { grain: 0, bw: 1, ow: 1 });
}
const ED_PAD = [{ t: 18 }, {}, {}, { l: 18 }].map((p) => ({ l: 0, t: 0, r: 30, b: 24, ...p }));
function eDrillBody(ctx, sh, dir) {
  const [ox, oy] = rotPt(dir, 192, 192, 96, 0);
  if (sh) boxShadow(ctx, 6, 10, 180, 178, 1.15);
  if (dir === 0) chuteAt(ctx, ox, oy, 0, 18, 30);
  const base = '#7b7d6d';
  const outer = chamf(6, 10, 180, 178, 24);
  fill(ctx, outer, lg(ctx, 0, 150, 0, 188, 0, dk(base, 0.4), 1, dk(base, 0.66))); grain(ctx, outer, 0.35, 0.3);
  const top = chamf(6, 10, 180, 162, 24);
  panel(ctx, top, base, 6, 10, 180, 162, { outline: false });
  stroke(ctx, outer, OUT, 2);
  vents(ctx, 40, 176, 112, 8, 10, true);
  // corner plates
  for (const [x, y, sx, sy] of [[6, 10, 1, 1], [186, 10, -1, 1], [6, 172, 1, -1], [186, 172, -1, -1]]) {
    const p = poly([[x + sx * 24, y], [x + sx * 44, y], [x, y + sy * 44], [x, y + sy * 24]]);
    fill(ctx, p, 'rgba(0,0,0,.18)');
    rivet(ctx, x + sx * 16, y + sy * 16, 2);
  }
  // side motors
  for (const sx of [12, 148]) { block(ctx, sx, 62, 32, 66, 8, '#5d6058'); vents(ctx, sx + 5, 68, 22, 44, 6); }
  hazard(ctx, rrect(70, 156, 52, 8, 1), 70, 156, 52, 8, 5);
  // drill housing
  const cx = 96, cy = 84;
  fill(ctx, circ(cx + 3, cy + 6, 62), 'rgba(0,0,0,.38)');
  const rim = circ(cx, cy, 60);
  fill(ctx, rim, lg(ctx, cx - 60, cy - 60, cx + 60, cy + 60, 0, '#a5a69a', 0.5, '#6f7068', 1, '#383934'));
  grain(ctx, rim, 0.35, 0.3); stroke(ctx, rim, OUT, 1.8);
  const well = circ(cx, cy, 50);
  fill(ctx, well, '#1c1b19'); stroke(ctx, well, OUT, 1.5);
  ctx.save(); ctx.translate(-1, -1); stroke(ctx, circ(cx, cy, 51.5), 'rgba(0,0,0,.6)', 1.5); ctx.restore();
  for (let k = 0; k < 16; k++) { const a = (k / 16) * TAU; rivet(ctx, cx + Math.cos(a) * 55.5, cy + Math.sin(a) * 55.5, 1.5); }
  if (dir !== 0) chuteAt(ctx, ox, oy, dir, 18, 30);
}
function eDrillRotor(ctx, f) {
  const cx = 96, cy = 84, a0 = ((f / 8) * TAU) / 3;
  ctx.save(); ctx.clip(circ(cx, cy, 49.5));
  gear(ctx, cx, cy, 47, 24, a0, '#55564f', { hole: 0, th: 5, shadow: false });
  for (let k = 0; k < 3; k++) {
    const a = a0 + (k * TAU) / 3, ca = Math.cos(a), sa = Math.sin(a);
    const pts = [[-9, 8], [9, 8], [7, 42], [-7, 42]].map(([u, v]) => [cx + ca * v - sa * u, cy + sa * v + ca * u]);
    const sh = poly(pts.map(([x, y]) => [x + 3, y + 4]));
    fill(ctx, sh, 'rgba(0,0,0,.5)');
    const p = poly(pts);
    fill(ctx, p, lg(ctx, cx - 40, cy - 40, cx + 40, cy + 40, 0, '#bdbcb0', 1, '#56564e')); stroke(ctx, p, OUT, 1.3);
    const tip = [cx + ca * 38, cy + sa * 38]; dot(ctx, tip[0], tip[1], 3.2, '#d4a42e'); stroke(ctx, circ(tip[0], tip[1], 3.2), OUT, 1);
  }
  const hub = circ(cx, cy, 15);
  hazard(ctx, hub, cx - 15, cy - 15, 30, 30, 5);
  fill(ctx, circ(cx, cy, 6), rg(ctx, cx - 2, cy - 2, 0, cx, cy, 6, 0, '#c8c6bd', 1, '#4a4944')); stroke(ctx, circ(cx, cy, 6), OUT, 1);
  fill(ctx, circ(cx, cy, 50), rg(ctx, cx - 10, cy - 12, 20, cx, cy, 50, 0, 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,.55)'));
  ctx.restore();
}
function drawEDrill(ctx, dir, f, o) {
  const p = o.pad, c = layer('edrill' + dir + (o.shadow ? 's' : ''), o.w, o.h, p.l, p.t, (g) => eDrillBody(g, o.shadow, dir));
  ctx.drawImage(c, -p.l, -p.t);
  eDrillRotor(ctx, f);
}

// ------------------------------------------------------------------ offshore pump
function offPad(dir) { const p = { l: 0, t: 0, r: 32, b: 26 }; if (dir === 0) p.b = 64 + 18; if (dir === 2) p.t = 64; if (dir === 1) p.l = 64; if (dir === 3) p.r = 64 + 20; return p; }
function drawOffshore(ctx, dir, o) {
  const [dx, dy] = DXY[dir], wx = 32 - dx * 62, wy = 32 - dy * 62;
  if (o.shadow) softShadow(ctx, Math.min(0, wx - 32), Math.min(0, wy - 32), 140, 140, (g) => { g.fillRect(16 + 10, 18 + 8, 36, 34); g.fillRect(Math.min(32, wx) - 8 + 8, Math.min(32, wy) - 8 + 6, Math.abs(wx - 32) + 16, Math.abs(wy - 32) + 16); }, 0.32, 4);
  fill(ctx, ell(wx, wy + 3, 28, 20), rg(ctx, wx, wy + 3, 4, wx, wy + 3, 28, 0, 'rgba(6,24,32,.5)', 1, 'rgba(6,24,32,0)'));
  for (const [r, a] of [[16, 0.3], [22, 0.18]]) stroke(ctx, ell(wx, wy + 4, r, r * 0.55), `rgba(220,240,255,${a})`, 1.2);
  if (dir % 2 === 0) pipeV(ctx, 32, Math.min(32, wy), Math.max(32, wy), 9); else pipeH(ctx, Math.min(32, wx), Math.max(32, wx), 32, 9);
  const head = rrect(wx - 14, wy - 12, 28, 24, 5);
  panel(ctx, head, '#56645e', wx - 14, wy - 12, 28, 24);
  vents(ctx, wx - 9, wy - 7, 18, 14, 4, true);
  fill(ctx, rrect(wx - 15, wy + 2, 30, 11, 4), 'rgba(20,60,80,.45)');
  // body
  const top = block(ctx, 14, 12, 36, 40, 10, '#7b7d79', { r: 4 });
  hazard(ctx, rrect(16, 14, 32, 7, 2), 16, 14, 32, 7, 4);
  ctx.save(); ctx.clip(top); vents(ctx, 20, 26, 24, 10, 3); ctx.restore();
  cylV(ctx, 24, 30, 16, 14, '#9a978d', { ry: 4 });
  for (const [x, y] of [[18, 40], [46, 40]]) rivet(ctx, x, y, 1.4);
  const ex = 32 + dx * 27, ey = 32 + dy * 27;
  if (dir === 0) pipeV(ctx, 32, 0, 14, 10); else if (dir === 2) pipeV(ctx, 32, 50, 64, 10); else if (dir === 1) pipeH(ctx, 50, 64, 32, 10); else pipeH(ctx, 0, 14, 32, 10);
  flange(ctx, ex, ey, dir % 2 === 0, 10);
}

// ------------------------------------------------------------------ boiler / steam engine
const BOILER_PAD = { t: 34, r: 38, b: 28 };
const BOILER_SMOKE = { 0: [[150, -30]], 1: [[98, -24]], 2: [[42, -30]], 3: [[30, -24]] };
function firebox(ctx, x, y, w, h, d, on) {
  const top = block(ctx, x, y, w, h, d, '#5d4c42');
  bricks(ctx, top, x, y, w, h - d, '#7a4a36', rng('fb' + x + y), 8, 14);
  stroke(ctx, top, OUT, 1.2);
  const dw = w - 18, dh = Math.min(18, h - d - 12), door = rrect(x + 9, y + h - d - dh - 5, dw, dh, 3);
  fill(ctx, rrect(x + 7, y + h - d - dh - 7, dw + 4, dh + 4, 4), '#34302c');
  fireWindow(ctx, door, x + 9, y + h - d - dh - 5, dw, dh, on, 5);
  if (on) { glow(ctx, x + w / 2, y + h - d - dh / 2 - 5, w * 0.7, 'rgba(255,130,40,.55)'); glow(ctx, x + w / 2, y + h, w * 0.5, 'rgba(255,110,30,.3)'); }
}
function chimney(ctx, x, top, bottom, w = 16) {
  cylV(ctx, x - w / 2, top, w, bottom - top, '#5c5a55', { ry: w * 0.28 });
  fill(ctx, ell(x, top + w * 0.28, w * 0.36, w * 0.18), '#0e0d0c');
  fill(ctx, rrect(x - w / 2 - 1, top + 10, w + 2, 4, 1), 'rgba(0,0,0,.35)');
}
function drawBoiler(ctx, dir, on, o) {
  const drum = '#8b877e';
  if (dir === 0 || dir === 2) {
    const s = dir === 0, dyD = s ? 52 : 18, wy = s ? 96 : 32;
    if (o.shadow) boxShadow(ctx, 8, s ? 46 : 14, 176, s ? 80 : 110, 1.2);
    chimney(ctx, BOILER_SMOKE[dir][0][0], -30, dyD + 24);
    if (s) pipeV(ctx, 96, 0, dyD, 11);
    pipeH(ctx, 0, 26, wy, 10); pipeH(ctx, 166, 192, wy, 10); flange(ctx, 5, wy, false, 10); flange(ctx, 187, wy, false, 10);
    cylH(ctx, 16, dyD, 160, 56, drum);
    for (const x of [44, 74, 118, 148]) seam(ctx, x, dyD + 2, x, dyD + 54, 0.4);
    for (let x = 24; x < 172; x += 10) rivet(ctx, x, dyD + 9, 1.1);
    if (s) { cylV(ctx, 84, dyD - 12, 24, 26, '#7e7b73'); flange(ctx, 96, 5, true, 11); firebox(ctx, 62, 82, 68, 44, 12, on); }
    else {
      firebox(ctx, 22, 74, 62, 48, 12, on);
      pipeV(ctx, 96, dyD + 44, 128, 11); flange(ctx, 96, 123, true, 11);
      cylV(ctx, 84, dyD + 34, 24, 22, '#7e7b73');
      block(ctx, 126, 82, 44, 36, 10, '#66645e'); vents(ctx, 132, 88, 32, 14, 3);
    }
    const gx = s ? 150 : 52, gy = s ? 100 : 66; fill(ctx, circ(gx, gy, 6), '#e8e4d8'); stroke(ctx, circ(gx, gy, 6), OUT, 1.2); seg(ctx, gx, gy, gx + 3, gy - 3, '#b02020', 1.2);
  } else {
    const e = dir === 1, dx0 = e ? 6 : 68, wx = dx0 + 27;
    if (o.shadow) boxShadow(ctx, 6, 10, 116, 172, 1.2);
    chimney(ctx, BOILER_SMOKE[dir][0][0], -24, 60);
    pipeV(ctx, wx, 0, 24, 10); pipeV(ctx, wx, 168, 192, 10); flange(ctx, wx, 5, true, 10); flange(ctx, wx, 187, true, 10);
    if (e) pipeH(ctx, dx0 + 40, 128, 96, 11); else pipeH(ctx, 0, dx0 + 14, 96, 11);
    flange(ctx, e ? 123 : 5, 96, false, 11);
    cylY(ctx, dx0, 12, 54, 172, drum);
    for (const y of [40, 70, 118, 146]) seam(ctx, dx0 + 2, y, dx0 + 52, y, 0.4);
    for (let y = 22; y < 160; y += 10) rivet(ctx, dx0 + 12, y, 1.1);
    const dome = cylV(ctx, e ? dx0 + 36 : dx0 - 6, 82, 24, 26, '#7e7b73'); void dome;
    firebox(ctx, e ? 66 : 6, 118, 56, 60, 12, on);
    const gx = e ? 94 : 34, gy = 96; fill(ctx, circ(gx, gy - 14, 6), '#e8e4d8'); stroke(ctx, circ(gx, gy - 14, 6), OUT, 1.2);
  }
}
// steam engine: animated crank, piston, flywheel
// cylinder lying along y, drawn as a rounded body with end flanges
function cylLong(ctx, x, y, w, h, base) {
  const p = rrect(x, y, w, h, Math.min(16, w / 4));
  fill(ctx, p, lg(ctx, x, 0, x + w, 0, 0, dk(base, 0.15), 0.2, lt(base, 0.4), 0.42, lt(base, 0.05), 0.8, dk(base, 0.4), 1, dk(base, 0.62)));
  grain(ctx, p, 0.35, 0.28); stroke(ctx, p, OUT, 1.5);
  for (const yy of [y + 8, y + h - 14]) {
    const b = rrect(x - 3, yy, w + 6, 6, 2);
    fill(ctx, b, lg(ctx, x, 0, x + w, 0, 0, dk(base, 0.3), 0.25, lt(base, 0.2), 1, dk(base, 0.7))); stroke(ctx, b, OUT, 1.1);
    for (let k = 1; k < 5; k++) dot(ctx, x - 3 + ((w + 6) * k) / 5, yy + 3, 1.1, 'rgba(230,226,214,.8)');
  }
}
function engineV(ctx, flip, f, o, pad) {
  const Y = (y) => (flip ? 320 - y : y), RY = (y, h) => (flip ? 320 - y - h : y);
  const cy = Y(232), wx = 150, wrx = 17, wry = 64;
  const body = layer('engV' + flip + (o.shadow ? 's' : ''), o.w, o.h, pad.l, pad.t, (g) => {
    if (o.shadow) { boxShadow(g, 28, 8, 140, 306, 1.1); softShadow(g, wx - 30, cy - 80, 120, 180, (s) => { s.beginPath(); s.ellipse(wx + 16, cy + 14, wrx + 4, wry, 0, 0, TAU); s.fill(); }, 0.3, 4); }
    pipeV(g, 96, 0, 30, 11); pipeV(g, 96, 290, 320, 11); flange(g, 96, 5, true, 11); flange(g, 96, 315, true, 11);
    const top = block(g, 30, 10, 132, 300, 12, '#55534d');
    g.save(); g.clip(top); for (let y = 40; y < 300; y += 44) seam(g, 32, y, 160, y, 0.3); g.restore();
    for (let y = 18; y < 300; y += 24) { rivet(g, 36, y, 1.3); rivet(g, 156, y, 1.3); }
    cylLong(g, 50, RY(26, 112), 92, 112, '#8e8b82');
    block(g, 72, RY(46, 40), 48, 40, 8, '#6e6b64'); cylV(g, 88, RY(52, 22) - 6, 16, 20, '#a29f96', { ry: 4 });
    for (const x of [83, 104]) { const r = rrect(x, Math.min(Y(138), Y(200)), 5, 62, 1); panel(g, r, '#6a6862', x, Math.min(Y(138), Y(200)), 5, 62, { grain: 0, bw: 1, ow: 1 }); }
    const gy = RY(194, 80);
    block(g, 36, gy, 48, 80, 10, '#4f5d50');
    g.save(); g.clip(rrect(40, gy + 6, 40, 58, 2)); for (let y = gy + 8; y < gy + 64; y += 5) seg(g, 40, y, 80, y, '#a8642e', 2.4); g.restore();
    stroke(g, rrect(40, gy + 6, 40, 58, 2), OUT, 1.2);
    const axle = rrect(80, cy - 6, 66, 12, 3); panel(g, axle, '#8c8a83', 80, cy - 6, 66, 12, { grain: 0 });
    fill(g, ell(wx, cy, wrx + 4, wry), '#2c2b28'); stroke(g, ell(wx, cy, wrx + 4, wry), OUT, 1.4);
  });
  ctx.drawImage(body, -pad.l, -pad.t);
  const phi = (f / 8) * TAU, sg = flip ? -1 : 1;
  // flywheel seen at a steep angle: thin ellipse with rotating spokes
  for (let k = 0; k < 6; k++) {
    const a = phi * sg + (k * TAU) / 6, ex = wx + Math.cos(a) * (wrx - 3), ey = cy + Math.sin(a) * (wry - 7);
    seg(ctx, wx, cy, ex, ey, OUT, 5); seg(ctx, wx, cy, ex, ey, '#8f8c84', 3);
  }
  const rimO = ell(wx, cy, wrx, wry), rimI = ell(wx, cy, wrx - 5, wry - 8);
  const ring = new Path2D(); ring.addPath(rimO); ring.addPath(rimI);
  ctx.fillStyle = lg(ctx, wx - wrx, cy - wry, wx + wrx, cy + wry, 0, '#cfccc1', 0.45, '#85837b', 1, '#383733'); ctx.fill(ring, 'evenodd');
  stroke(ctx, rimO, OUT, 1.5); stroke(ctx, rimI, OUT, 1);
  dot(ctx, wx, cy, 5, '#4a4944'); dot(ctx, wx - 1.5, cy - 1.5, 1.8, '#cfccc2');
  const pinY = cy - sg * 16 * Math.cos(phi) - 10 * Math.sin(phi), pinX = 96;
  const xh = cy - sg * (16 * Math.cos(phi) + 58);
  seg(ctx, 96, Y(138), 96, xh, OUT, 6); seg(ctx, 96, Y(138), 96, xh, '#d6d3c8', 3.5);
  const cr = rrect(84, xh - 7, 24, 14, 3); panel(ctx, cr, '#77756e', 84, xh - 7, 24, 14, { grain: 0, bw: 1 });
  const disc = circ(96, cy, 20); fill(ctx, disc, rg(ctx, 90, cy - 6, 2, 96, cy, 20, 0, '#a19e95', 1, '#3d3c37')); stroke(ctx, disc, OUT, 1.4);
  ctx.lineCap = 'round'; seg(ctx, 96, xh, pinX, pinY, OUT, 8); seg(ctx, 96, xh, pinX, pinY, '#9b988f', 5); seg(ctx, 95, xh, pinX - 1, pinY, 'rgba(255,255,255,.35)', 1.5); ctx.lineCap = 'butt';
  dot(ctx, pinX, pinY, 4, '#2a2926'); dot(ctx, 96, xh, 3.5, '#2a2926');
}
function engineH(ctx, flip, f, o, pad) {
  const X = (x) => (flip ? 320 - x : x), RX = (x, w) => (flip ? 320 - x - w : x);
  const wcx = X(232), wcy = 116, Rw = 50;
  const body = layer('engH' + flip + (o.shadow ? 's' : ''), o.w, o.h, pad.l, pad.t, (g) => {
    if (o.shadow) boxShadow(g, 8, 20, 306, 156, 1.1);
    pipeH(g, 0, 30, 96, 11); pipeH(g, 290, 320, 96, 11); flange(g, 5, 96, false, 11); flange(g, 315, 96, false, 11);
    const top = block(g, 10, 22, 300, 152, 12, '#55534d');
    g.save(); g.clip(top); for (let x = 40; x < 300; x += 44) seam(g, x, 24, x, 160, 0.3); g.restore();
    for (let x = 18; x < 304; x += 24) { rivet(g, x, 28, 1.3); rivet(g, x, 156, 1.3); }
    block(g, RX(212, 44), 30, 44, 52, 10, '#4f5d50');
    g.save(); g.clip(rrect(RX(216, 36), 36, 36, 30, 2)); for (let x = RX(216, 36); x < RX(216, 36) + 36; x += 5) seg(g, x, 36, x, 66, '#a8642e', 2.4); g.restore();
    const ax = rrect(wcx - 6, 74, 12, wcy - 74, 3); panel(g, ax, '#8c8a83', wcx - 6, 74, 12, wcy - 74, { grain: 0 });
    cylH(g, RX(28, 104), 54, 104, 62, '#8e8b82');
    for (const x of [RX(48, 4), RX(108, 4)]) fill(g, rrect(x, 55, 4, 60, 1), 'rgba(0,0,0,.3)');
    block(g, RX(52, 50), 40, 50, 26, 8, '#6e6b64');
    const gx0 = Math.min(X(134), X(196));
    for (const y of [76, 92]) { const r = rrect(gx0, y, 62, 5, 1); panel(g, r, '#6a6862', gx0, y, 62, 5, { grain: 0, bw: 1, ow: 1 }); }
    fill(g, ell(wcx + 4, wcy + 6, Rw + 3, Rw * 0.72 + 2), 'rgba(0,0,0,.4)');
    const back = ell(wcx, wcy - 6, Rw, Rw * 0.72); fill(g, back, '#3a3935'); stroke(g, back, OUT, 1.4);
  });
  ctx.drawImage(body, -pad.l, -pad.t);
  const phi = (f / 8) * TAU, sg = flip ? -1 : 1;
  const rimO = ell(wcx, wcy, Rw, Rw * 0.72), rimI = ell(wcx, wcy, Rw - 8, (Rw - 8) * 0.72);
  const ring = new Path2D(); ring.addPath(rimO); ring.addPath(rimI);
  fill(ctx, rimI, 'rgba(20,19,17,.85)');
  for (let k = 0; k < 6; k++) {
    const a = phi + (k * TAU) / 6, ex = wcx + sg * Math.cos(a) * (Rw - 6), ey = wcy - Math.sin(a) * (Rw - 6) * 0.72;
    seg(ctx, wcx, wcy, ex, ey, OUT, 6); seg(ctx, wcx, wcy, ex, ey, '#8f8c84', 3.5);
  }
  ctx.fillStyle = lg(ctx, wcx - Rw, wcy - Rw, wcx + Rw, wcy + Rw, 0, '#c4c1b6', 0.5, '#7f7d75', 1, '#3a3935'); ctx.fill(ring, 'evenodd');
  stroke(ctx, rimO, OUT, 1.6); stroke(ctx, rimI, OUT, 1.2);
  const hub = circ(wcx, wcy, 9); fill(ctx, hub, rg(ctx, wcx - 3, wcy - 3, 1, wcx, wcy, 9, 0, '#cfccc2', 1, '#4a4944')); stroke(ctx, hub, OUT, 1.2);
  const pinX = wcx + sg * 22 * Math.cos(phi), pinY = wcy - 22 * 0.72 * Math.sin(phi);
  const xh = X(176) + sg * 14 * Math.cos(phi);
  seg(ctx, X(132), 85, xh, 85, OUT, 6); seg(ctx, X(132), 85, xh, 85, '#d6d3c8', 3.5);
  const cr = rrect(xh - 8, 77, 16, 16, 3); panel(ctx, cr, '#77756e', xh - 8, 77, 16, 16, { grain: 0, bw: 1 });
  ctx.lineCap = 'round'; seg(ctx, xh, 85, pinX, pinY, OUT, 8); seg(ctx, xh, 85, pinX, pinY, '#9b988f', 5); seg(ctx, xh, 84, pinX, pinY - 1, 'rgba(255,255,255,.35)', 1.5); ctx.lineCap = 'butt';
  dot(ctx, pinX, pinY, 4, '#2a2926'); dot(ctx, xh, 85, 3.5, '#2a2926');
}

// ------------------------------------------------------------------ power
function drawSolar(ctx, o) {
  if (o.shadow) boxShadow(ctx, 4, 4, 184, 184, 0.55, 0.34);
  const fr = rrect(4, 4, 184, 184, 4);
  block(ctx, 4, 4, 184, 184, 7, '#5d6066', { r: 4 });
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const x = 9 + i * 59.3, y = 9 + j * 57.3, w = 56, h = 54, p = rrect(x, y, w, h, 2);
    fill(ctx, p, lg(ctx, x, y, x + w, y + h, 0, '#2d4f86', 0.5, '#1c335c', 1, '#101d38'));
    ctx.save(); ctx.clip(p);
    for (let k = 1; k < 4; k++) { seg(ctx, x + (w * k) / 4, y, x + (w * k) / 4, y + h, 'rgba(160,190,230,.35)', 1); seg(ctx, x, y + (h * k) / 4, x + w, y + (h * k) / 4, 'rgba(160,190,230,.35)', 1); }
    for (let k = 0; k < 8; k++) seg(ctx, x + 3 + k * 7, y, x + 3 + k * 7, y + h, 'rgba(0,0,0,.18)', 0.6);
    ctx.globalCompositeOperation = 'lighter';
    fill(ctx, poly([[x - 10, y + h], [x + w * 0.3, y - 4], [x + w * 0.55, y - 4], [x + 5, y + h]]), 'rgba(120,150,200,.16)');
    fill(ctx, poly([[x + w * 0.5, y + h], [x + w * 0.85, y - 4], [x + w * 0.92, y - 4], [x + w * 0.6, y + h]]), 'rgba(120,150,200,.1)');
    ctx.restore();
    stroke(ctx, p, 'rgba(10,12,16,.9)', 1.2);
    bevel(ctx, p, 0.25, 0.3, 1);
  }
  void fr;
  for (const [x, y] of [[8, 8], [184, 8], [8, 184], [184, 184], [96, 8], [96, 184]]) rivet(ctx, x, Math.min(y, 181), 1.4);
}
function drawAccumulator(ctx, o, on) {
  if (o.shadow) boxShadow(ctx, 6, 8, 116, 116, 0.9);
  block(ctx, 6, 10, 116, 114, 10, '#4c4e52');
  const conn = rrect(54, 54, 20, 28, 3); panel(ctx, conn, '#6a6c70', 54, 54, 20, 28);
  for (const [cx, by] of [[36, 64], [92, 64], [36, 112], [92, 112]]) {
    const x = cx - 21, top = by - 50;
    const cyl = cylV(ctx, x, top, 42, 50, '#7d8590', { ry: 11 });
    for (const k of [0.38, 0.62]) { const yy = top + 11 + (50 - 22) * k; fill(ctx, rrect(x, yy, 42, 4, 0), on ? 'rgba(90,210,255,.9)' : 'rgba(0,0,0,.35)'); }
    fill(ctx, ell(cx, top + 11, 13, 5), '#2c2f34');
    dot(ctx, cx - 6, top + 10, 2.4, '#c47a3c'); dot(ctx, cx + 6, top + 10, 2.4, '#8a8f96');
    if (on) glow(ctx, cx, top + 30, 26, 'rgba(80,190,255,.45)');
    void cyl;
  }
}

// ------------------------------------------------------------------ furnaces
function drawStoneFurnace(ctx, o, on) {
  const R = rng('stonefurnace');
  const rows = [[8, 124, 112, 30], [15, 98, 98, 29], [24, 73, 80, 28], [36, 49, 56, 27]]; // [x, bottom, width, height]
  if (o.shadow) softShadow(ctx, 0, 10, 170, 150, (g) => {
    g.beginPath(); g.moveTo(12, 122); g.lineTo(36, 28); g.lineTo(92, 28); g.lineTo(92 + SHX * 1.2, 28 + SHY * 1.2); g.lineTo(116 + SHX * 0.8, 122 + SHY * 0.6); g.lineTo(12 + SHX * 0.8, 122 + SHY * 0.6); g.closePath(); g.fill();
  }, 0.36, 4);
  for (const [x, by, w, h] of rows) {
    const n = Math.max(2, Math.round(w / 21)), widths = [];
    let tot = 0; for (let i = 0; i < n; i++) { const v = 0.8 + R() * 0.4; widths.push(v); tot += v; }
    let xx = x;
    for (const v of widths) {
      const bw = (v / tot) * w, c = mix('#928473', R() < 0.5 ? '#000000' : '#ffffff', R() * 0.14);
      const b = rrect(xx + 0.5, by - h + R() * 3, bw - 1, h, 7);
      fill(ctx, b, lg(ctx, xx, by - h, xx + bw * 0.4, by, 0, lt(c, 0.22), 0.5, css(c), 1, dk(c, 0.45)));
      grain(ctx, b, 0.45, 0.35); bevel(ctx, b, 0.3, 0.42, 1.5); stroke(ctx, b, OUT, 1.3);
      xx += bw;
    }
  }
  const mouth = new Path2D(); mouth.moveTo(45, 124); mouth.lineTo(45, 106); mouth.arc(64, 106, 19, Math.PI, 0); mouth.lineTo(83, 124); mouth.closePath();
  fill(ctx, rrect(41, 84, 46, 41, 18), 'rgba(0,0,0,.35)');
  fireWindow(ctx, mouth, 45, 87, 38, 37, on, 1);
  const hole = ell(64, 31, 17, 7.5);
  fill(ctx, hole, on ? rg(ctx, 64, 31, 1, 64, 31, 17, 0, '#ffe7a0', 0.5, '#ff8a20', 1, '#7a2a08') : '#141210'); stroke(ctx, hole, OUT, 1.4);
  if (on) { glow(ctx, 64, 110, 36, 'rgba(255,130,40,.6)'); glow(ctx, 64, 28, 26, 'rgba(255,150,60,.5)'); }
}
function drawSteelFurnace(ctx, o, on) {
  if (o.shadow) boxShadow(ctx, 8, 10, 112, 114, 1.2);
  chimney(ctx, 104, -16, 30, 14);
  const top = block(ctx, 8, 14, 112, 108, 18, '#6c6f72');
  const inner = rrect(20, 24, 88, 50, 4);
  bricks(ctx, inner, 20, 24, 88, 50, '#7e4a37', rng('steelfurnace'), 8, 14); stroke(ctx, inner, OUT, 1.3);
  const vent = rrect(40, 34, 48, 28, 4);
  fill(ctx, vent, on ? rg(ctx, 64, 48, 2, 64, 48, 30, 0, '#ffe39a', 0.5, '#ff8a22', 1, '#6a2008') : '#161412'); stroke(ctx, vent, OUT, 1.4);
  for (let x = 46; x < 88; x += 7) seg(ctx, x, 34, x, 62, on ? 'rgba(80,30,10,.8)' : 'rgba(90,88,84,.9)', 2);
  void top;
  const door = rrect(30, 82, 68, 26, 3); panel(ctx, door, '#55585b', 30, 82, 68, 26);
  for (let k = 0; k < 4; k++) { const sl = rrect(36 + k * 15, 88, 10, 14, 2); fireWindow(ctx, sl, 36 + k * 15, 88, 10, 14, on, 1); }
  for (const [x, y] of [[14, 20], [114, 20], [14, 98], [114, 98]]) rivet(ctx, x, y, 1.7);
  if (on) { glow(ctx, 64, 96, 40, 'rgba(255,130,40,.5)'); glow(ctx, 64, 48, 34, 'rgba(255,150,60,.45)'); }
}
function drawElectricFurnace(ctx, o, on) {
  if (o.shadow) boxShadow(ctx, 6, 8, 180, 180, 1.2);
  const base = '#7d6c5c';
  const outer = chamf(6, 10, 180, 178, 20);
  fill(ctx, outer, lg(ctx, 0, 150, 0, 188, 0, dk(base, 0.4), 1, dk(base, 0.65))); grain(ctx, outer, 0.35, 0.3);
  panel(ctx, chamf(6, 10, 180, 160, 20), base, 6, 10, 180, 160, { outline: false });
  stroke(ctx, outer, OUT, 2);
  for (const [x, y] of [[14, 50], [150, 50]]) { block(ctx, x, y, 28, 90, 8, '#5f5650'); vents(ctx, x + 5, y + 6, 18, 70, 8); }
  for (const [x, y] of [[30, 22], [162, 22], [30, 156], [162, 156]]) rivet(ctx, x, y, 2);
  const win = chamf(50, 30, 92, 92, 14);
  fill(ctx, chamf(48, 28, 96, 96, 15), '#3a3430'); stroke(ctx, chamf(48, 28, 96, 96, 15), OUT, 1.5);
  fill(ctx, win, on ? rg(ctx, 96, 76, 4, 96, 76, 62, 0, '#fff0b0', 0.35, '#ffa632', 0.8, '#b84410', 1, '#5a1c06') : rg(ctx, 96, 76, 4, 96, 76, 62, 0, '#3a2c26', 1, '#171210'));
  ctx.save(); ctx.clip(win);
  for (let y = 40; y < 122; y += 12) pline(ctx, Array.from({ length: 12 }, (_, i) => [50 + i * 8.4, y + (i % 2 ? 3 : -3)]), on ? 'rgba(120,30,0,.75)' : 'rgba(120,110,100,.6)', 2);
  ctx.restore();
  stroke(ctx, win, OUT, 1.4);
  hazard(ctx, rrect(60, 140, 72, 8, 1), 60, 140, 72, 8, 5);
  if (on) glow(ctx, 96, 76, 80, 'rgba(255,130,40,.45)');
}

// ------------------------------------------------------------------ assemblers / lab
const AM_COL = { 1: { body: '#8f948a', acc: '#7f9a5e' }, 2: { body: '#8a929c', acc: '#3e7cc2' }, 3: { body: '#9a9384', acc: '#d6aa38' } };
function amBody(ctx, tier, sh) {
  const { body, acc } = AM_COL[tier];
  if (sh) boxShadow(ctx, 4, 6, 184, 184, 1.25);
  const outer = chamf(4, 8, 184, 180, 18);
  fill(ctx, outer, lg(ctx, 0, 160, 0, 188, 0, dk('#5c5e5a', 0.35), 1, dk('#5c5e5a', 0.65))); grain(ctx, outer, 0.35, 0.3);
  panel(ctx, chamf(4, 8, 184, 166, 18), '#5f615c', 4, 8, 184, 166, { outline: false });
  stroke(ctx, outer, OUT, 2);
  for (const [x, y] of [[8, 12], [144, 12], [8, 128], [144, 128]]) {
    block(ctx, x, y, 40, 42, 8, body);
    const pl = rrect(x + 7, y + 6, 26, 20, 2); panel(ctx, pl, acc, x + 7, y + 6, 26, 20, { bw: 1 });
    rivet(ctx, x + 5, y + 4, 1.3); rivet(ctx, x + 35, y + 4, 1.3);
  }
  for (const y of [70, 108]) { pipeH(ctx, 46, 60, y, 5, '#6d6f6a'); pipeH(ctx, 132, 146, y, 5, '#6d6f6a'); }
  block(ctx, 26, 20, 140, 146, 14, body, { r: 10 });
  hazard(ctx, rrect(40, 140, 112, 8, 1), 40, 140, 112, 8, 5);
  fill(ctx, rrect(40, 140, 112, 8, 1), css(acc, 0.45));
  vents(ctx, 34, 118, 26, 16, 4); vents(ctx, 132, 118, 26, 16, 4);
  const cx = 96, cy = 74;
  fill(ctx, circ(cx + 2, cy + 4, 48), 'rgba(0,0,0,.35)');
  const rim = circ(cx, cy, 46);
  fill(ctx, rim, lg(ctx, cx - 46, cy - 46, cx + 46, cy + 46, 0, lt(body, 0.35), 0.5, body, 1, dk(body, 0.5))); grain(ctx, rim, 0.3, 0.2); stroke(ctx, rim, OUT, 1.6);
  fill(ctx, circ(cx, cy, 39), '#1b1a18');
  for (let k = 0; k < 12; k++) { const a = (k / 12) * TAU; rivet(ctx, cx + Math.cos(a) * 42.5, cy + Math.sin(a) * 42.5, 1.3); }
  dot(ctx, 150, 34, 3, css(acc)); stroke(ctx, circ(150, 34, 3), OUT, 1);
}
function amMech(ctx, tier, f) {
  const cx = 96, cy = 74, { acc } = AM_COL[tier], a = (f / 8) * (TAU / 12);
  ctx.save(); ctx.clip(circ(cx, cy, 39));
  fill(ctx, circ(cx, cy, 39), rg(ctx, cx, cy, 4, cx, cy, 39, 0, '#34322e', 1, '#141311'));
  gear(ctx, cx - 9, cy + 6, 25, 12, a, '#8e8b82');
  gear(ctx, cx + 22, cy - 15, 13, 8, -a * 1.5 + 0.2, css(mix(acc, '#888888', 0.4)));
  gear(ctx, cx + 20, cy + 22, 10, 8, -a * 1.5 + 0.4, '#77746c');
  fill(ctx, circ(cx - 9, cy + 6, 7), rg(ctx, cx - 11, cy + 4, 0, cx - 9, cy + 6, 7, 0, lt(acc, 0.3), 1, dk(acc, 0.4))); stroke(ctx, circ(cx - 9, cy + 6, 7), OUT, 1);
  const py = Math.sin((f / 8) * TAU) * 6;
  const arm = rrect(cx - 26, cy - 30 + py, 30, 8, 3); panel(ctx, arm, '#9c998f', cx - 26, cy - 30 + py, 30, 8, { grain: 0, bw: 1, ow: 1 });
  fill(ctx, rrect(cx - 4, cy - 34 + py, 8, 16, 2), css(acc)); stroke(ctx, rrect(cx - 4, cy - 34 + py, 8, 16, 2), OUT, 1);
  fill(ctx, circ(cx, cy, 39), rg(ctx, cx - 8, cy - 10, 14, cx, cy, 40, 0, 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,.6)'));
  ctx.restore();
  stroke(ctx, circ(cx, cy, 39), OUT, 1.4);
}
function drawAssembler(ctx, tier, f, o) {
  const p = o.pad, c = layer('am' + tier + (o.shadow ? 's' : ''), o.w, o.h, p.l, p.t, (g) => amBody(g, tier, o.shadow));
  ctx.drawImage(c, -p.l, -p.t);
  amMech(ctx, tier, f);
}
function labBody(ctx, sh) {
  if (sh) boxShadow(ctx, 6, 8, 180, 180, 1.15);
  const base = '#6f7378';
  const outer = chamf(6, 10, 180, 178, 46);
  fill(ctx, outer, lg(ctx, 0, 160, 0, 188, 0, dk(base, 0.4), 1, dk(base, 0.66))); grain(ctx, outer, 0.35, 0.3);
  panel(ctx, chamf(6, 10, 180, 164, 46), base, 6, 10, 180, 164, { outline: false });
  stroke(ctx, outer, OUT, 2);
  for (const [x, y] of [[20, 30], [148, 30], [20, 130], [148, 130]]) { block(ctx, x, y, 24, 26, 6, '#5a5d61', { r: 4 }); dot(ctx, x + 12, y + 9, 3, '#3a86c8'); }
  const cx = 96, cy = 84;
  fill(ctx, circ(cx + 3, cy + 6, 62), 'rgba(0,0,0,.35)');
  const ring = circ(cx, cy, 60);
  fill(ctx, ring, lg(ctx, cx - 60, cy - 60, cx + 60, cy + 60, 0, '#b6b9bc', 0.5, '#7c8085', 1, '#3b3e42')); grain(ctx, ring, 0.3, 0.2); stroke(ctx, ring, OUT, 1.8);
  fill(ctx, circ(cx, cy, 47), '#14181e'); stroke(ctx, circ(cx, cy, 47), OUT, 1.4);
  for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU + 0.39; rivet(ctx, cx + Math.cos(a) * 54, cy + Math.sin(a) * 54, 1.6); }
  vents(ctx, 70, 152, 52, 10, 8, true);
}
function labCore(ctx, f) {
  const cx = 96, cy = 84, ph = (f / 8) * TAU, pulse = 0.5 + 0.5 * Math.sin(ph);
  ctx.save(); ctx.clip(circ(cx, cy, 46.5));
  fill(ctx, circ(cx, cy, 46), rg(ctx, cx, cy, 2, cx, cy, 46, 0, `rgba(120,200,255,${0.55 + pulse * 0.35})`, 0.45, 'rgba(30,90,170,.55)', 1, 'rgba(8,20,40,.9)'));
  const a0 = ph / 4;
  for (let k = 0; k < 4; k++) {
    const a = a0 + (k * TAU) / 4, x = cx + Math.cos(a) * 32, y = cy + Math.sin(a) * 32;
    seg(ctx, cx + Math.cos(a) * 14, cy + Math.sin(a) * 14, x, y, '#2b3138', 5);
    fill(ctx, circ(x, y, 6), rg(ctx, x - 2, y - 2, 0, x, y, 6, 0, '#d0d6dc', 1, '#4a5058')); stroke(ctx, circ(x, y, 6), OUT, 1);
  }
  ctx.restore();
  const core = circ(cx, cy, 15);
  fill(ctx, core, rg(ctx, cx - 4, cy - 5, 1, cx, cy, 15, 0, '#ffffff', 0.35, '#9fe0ff', 1, '#2a78c8')); stroke(ctx, core, OUT, 1.3);
  glow(ctx, cx, cy, 34 + pulse * 10, `rgba(110,190,255,${0.35 + pulse * 0.3})`);
  fill(ctx, ell(cx - 18, cy - 22, 14, 6), 'rgba(255,255,255,.18)');
}
function drawLab(ctx, f, o) {
  const p = o.pad, c = layer('lab' + (o.shadow ? 's' : ''), o.w, o.h, p.l, p.t, (g) => labBody(g, o.shadow));
  ctx.drawImage(c, -p.l, -p.t);
  labCore(ctx, f);
}

// ------------------------------------------------------------------ oil
const REF_PAD = { t: 120, r: 40, b: 30 };
const REF_FLARE = [292, -78];
const REF_CONN = [[[1, 4, 2, 'in'], [3, 4, 2, 'in'], [4, 0, 0, 'out'], [2, 0, 0, 'out']]];
function rotConn(list, dir, W, H) {
  return list.map(([x, y, d, k]) => {
    let nx = x, ny = y;
    for (let i = 0; i < dir; i++) { const t = nx; nx = (i % 2 === 0 ? H : W) - 1 - ny; ny = t; }
    return [nx, ny, (d + dir) % 4, k];
  });
}
function connNozzles(ctx, conns) {
  for (const [x, y, d, k] of conns) {
    const [dx, dy] = DXY[d], px = x * 64 + 32 + dx * 32, py = y * 64 + 32 + dy * 32;
    nozzle(ctx, px - dx * 22, py - dy * 22, d, k);
  }
}
function tower(ctx, x, top, w, bottom, base) {
  const c = cylV(ctx, x, top, w, bottom - top, base, { ry: w * 0.28 });
  for (let y = top + 40; y < bottom - 30; y += 46) {
    fill(ctx, rrect(x - 3, y, w + 6, 6, 2), lg(ctx, x, 0, x + w, 0, 0, '#5a5650', 0.3, '#a8a398', 1, '#34312c')); stroke(ctx, rrect(x - 3, y, w + 6, 6, 2), OUT, 1);
    seg(ctx, x - 3, y - 6, x + w + 3, y - 6, 'rgba(210,170,60,.8)', 1.2);
  }
  const lx = x + w * 0.22; seg(ctx, lx, top + 12, lx, bottom - 10, 'rgba(30,26,22,.8)', 1.2); seg(ctx, lx + 5, top + 12, lx + 5, bottom - 10, 'rgba(30,26,22,.8)', 1.2);
  for (let y = top + 16; y < bottom - 12; y += 5) seg(ctx, lx, y, lx + 5, y, 'rgba(30,26,22,.6)', 1);
  fill(ctx, ell(c.cx, c.cy, w * 0.18, w * 0.08), '#2a2622');
}
function drawRefinery(ctx, dir, on, o) {
  if (o.shadow) boxShadow(ctx, 6, 10, 308, 304, 1.15);
  const conns = rotConn(REF_CONN[0], dir, 5, 5);
  block(ctx, 6, 12, 308, 302, 14, '#6d6961', { r: 6 });
  ctx.save(); ctx.clip(rrect(8, 14, 304, 284, 4)); for (let x = 70; x < 300; x += 64) seam(ctx, x, 14, x, 296, 0.25); for (let y = 76; y < 296; y += 64) seam(ctx, 8, y, 312, y, 0.25); ctx.restore();
  for (const [x, y] of [[14, 20], [306, 20], [14, 290], [306, 290]]) rivet(ctx, x, y, 2);
  connNozzles(ctx, conns);
  // pipe rack
  pipeH(ctx, 30, 290, 196, 6, '#86847d'); pipeH(ctx, 30, 290, 212, 6, '#7c7a73');
  // tower shadows fall on the deck
  softShadow(ctx, 30, 40, 290, 230, (g) => {
    for (const [x, w, h, b] of [[40, 54, 230, 176], [114, 68, 290, 190], [204, 46, 180, 160], [286, 12, 258, 180]]) { g.save(); g.transform(1, 0, 0.62, 0.27, x + w / 2, b); g.fillRect(-w / 2, 0, w, h); g.restore(); }
  }, 0.3, 4);
  // front equipment
  const hb = block(ctx, 26, 228, 124, 70, 14, '#6d4f3e');
  for (let k = 0; k < 4; k++) fireWindow(ctx, rrect(36 + k * 28, 246, 20, 18, 3), 36 + k * 28, 246, 20, 18, on, 2);
  void hb;
  block(ctx, 176, 226, 118, 70, 12, '#5f625e'); vents(ctx, 184, 236, 60, 34, 6, true);
  cylV(ctx, 254, 232, 30, 34, '#8a8780');
  // towers and flare
  tower(ctx, 40, -54, 54, 176, '#9a968c');
  tower(ctx, 114, -100, 68, 190, '#8e8a80');
  tower(ctx, 204, -20, 46, 160, '#a29e93');
  pipeV(ctx, 160, 186, 230, 6, '#86847d'); pipeV(ctx, 66, 172, 230, 6, '#86847d');
  const fx = REF_FLARE[0];
  fill(ctx, rrect(fx - 10, 176, 20, 10, 2), '#3c3a35');
  cylV(ctx, fx - 6, REF_FLARE[1] + 6, 12, 184 - REF_FLARE[1], '#8d8a83', { ry: 3 });
  for (let y = REF_FLARE[1] + 24; y < 170; y += 30) { seg(ctx, fx - 9, y, fx + 9, y + 20, 'rgba(40,36,30,.7)', 1.2); seg(ctx, fx + 9, y, fx - 9, y + 20, 'rgba(40,36,30,.7)', 1.2); }
  const ft = REF_FLARE[1];
  fill(ctx, rrect(fx - 8, ft, 16, 8, 2), '#3f3c37'); stroke(ctx, rrect(fx - 8, ft, 16, 8, 2), OUT, 1);
  if (on) {
    glow(ctx, fx, ft - 16, 34, 'rgba(255,140,40,.7)');
    const fl = new Path2D(); fl.moveTo(fx - 8, ft); fl.bezierCurveTo(fx - 14, ft - 14, fx - 6, ft - 26, fx + 2, ft - 38); fl.bezierCurveTo(fx + 4, ft - 26, fx + 14, ft - 16, fx + 8, ft); fl.closePath();
    fill(ctx, fl, lg(ctx, 0, ft - 38, 0, ft, 0, 'rgba(255,190,70,.25)', 0.35, '#ff9a28', 0.75, '#ffd060', 1, '#fff8d0'));
    const fc = new Path2D(); fc.moveTo(fx - 4, ft); fc.quadraticCurveTo(fx - 5, ft - 12, fx + 1, ft - 20); fc.quadraticCurveTo(fx + 5, ft - 10, fx + 4, ft); fc.closePath(); fill(ctx, fc, 'rgba(255,255,235,.9)');
    glow(ctx, 88, 256, 70, 'rgba(255,120,40,.45)');
  }
}
const CHEM_CONN = [[0, 2, 2, 'in'], [2, 2, 2, 'in'], [0, 0, 0, 'out'], [2, 0, 0, 'out']];
const CHEM_LIQ = '#3fb39a';
function chemBody(ctx, dir, sh) {
  if (sh) boxShadow(ctx, 4, 8, 184, 180, 1.2);
  block(ctx, 4, 10, 184, 178, 14, '#6c6e6a', { r: 10 });
  for (const [x, y] of [[12, 18], [180, 18], [12, 166], [180, 166]]) rivet(ctx, x, y, 1.8);
  connNozzles(ctx, rotConn(CHEM_CONN, dir, 3, 3));
  const horiz = dir % 2 === 0;
  pipeH(ctx, 40, 152, 150, 5, '#7d7b74');
  block(ctx, 70, 128, 52, 40, 10, '#5d605c'); vents(ctx, 76, 134, 40, 14, 3);
  const domes = horiz ? [[56, 84], [136, 84]] : [[96, 52], [96, 112]];
  for (const [x, y] of domes) { fill(ctx, ell(x + 3, y + 26, 36, 14), 'rgba(0,0,0,.4)'); cylV(ctx, x - 34, y + 4, 68, 30, '#77797a', { ry: 14 }); }
  if (horiz) { cylV(ctx, 86, 26, 20, 64, '#8a8780'); fill(ctx, rrect(80, 22, 32, 14, 3), '#4c4e4c'); stroke(ctx, rrect(80, 22, 32, 14, 3), OUT, 1.2); }
  else { cylV(ctx, 150, 60, 20, 60, '#8a8780'); fill(ctx, rrect(144, 56, 32, 14, 3), '#4c4e4c'); stroke(ctx, rrect(144, 56, 32, 14, 3), OUT, 1.2); }
}
function chemDomes(ctx, dir, f) {
  const horiz = dir % 2 === 0, domes = horiz ? [[56, 84], [136, 84]] : [[96, 52], [96, 112]];
  domes.forEach(([x, y], i) => {
    const r = 30, cy = y - 2, dome = circ(x, cy, r), ph = (f / 4) * TAU + i * 1.7;
    fill(ctx, dome, 'rgba(30,50,46,.55)');
    ctx.save(); ctx.clip(dome);
    const lvl = cy + 2, sl = new Path2D(); sl.moveTo(x - r, cy + r);
    for (let k = 0; k <= 12; k++) { const xx = x - r + (k / 12) * 2 * r; sl.lineTo(xx, lvl + Math.sin(k * 0.55 + ph) * 3.5 + Math.sin(ph) * (xx - x) * 0.08); }
    sl.lineTo(x + r, cy + r); sl.closePath();
    fill(ctx, sl, lg(ctx, 0, lvl - 4, 0, cy + r, 0, lt(CHEM_LIQ, 0.35), 0.4, CHEM_LIQ, 1, dk(CHEM_LIQ, 0.5)));
    for (let k = 0; k < 3; k++) { const bx = x - 14 + ((k * 13 + f * 7) % 28), by = cy + 20 - ((f * 4.5 + k * 9) % 18); stroke(ctx, circ(bx, by, 1.6), 'rgba(220,255,240,.6)', 1); }
    ctx.restore();
    fill(ctx, dome, rg(ctx, x - 10, cy - 12, 2, x, cy, r, 0, 'rgba(255,255,255,.35)', 0.5, 'rgba(200,230,230,.08)', 1, 'rgba(10,20,20,.35)'));
    ctx.beginPath(); ctx.arc(x, cy, r - 5, Math.PI * 1.1, Math.PI * 1.45); ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 2.5; ctx.stroke();
    stroke(ctx, dome, OUT, 1.6);
    fill(ctx, rrect(x - 6, cy - r - 4, 12, 8, 2), '#5d5f5c'); stroke(ctx, rrect(x - 6, cy - r - 4, 12, 8, 2), OUT, 1);
  });
}
function drawChem(ctx, dir, f, o) {
  const p = o.pad, c = layer('chem' + dir + (o.shadow ? 's' : ''), o.w, o.h, p.l, p.t, (g) => chemBody(g, dir, o.shadow));
  ctx.drawImage(c, -p.l, -p.t);
  chemDomes(ctx, dir, f);
}
function drawPumpjack(ctx, dir, f, o) {
  const mir = dir >= 2, X = (x) => (mir ? 192 - x : x);
  const th = Math.sin((f / 8) * TAU) * 0.2, phi = (f / 8) * TAU;
  const piv = [X(106), 40], Lh = 70, Lt = 52;
  const ca = Math.cos(th), sa = Math.sin(th), sg = mir ? -1 : 1;
  const head = [piv[0] - sg * Lh * ca, piv[1] + Lh * sa], tail = [piv[0] + sg * Lt * ca, piv[1] - Lt * sa];
  const well = [X(44), 132], crank = [X(158), 132];
  const pd = o.pad, body = layer('pj' + dir + (o.shadow ? 's' : ''), o.w, o.h, pd.l, pd.t, (ctx) => {
    if (o.shadow) boxShadow(ctx, 8, 12, 176, 172, 0.6);
    block(ctx, 8, 14, 176, 170, 10, '#8b867a', { r: 6 });
    ctx.save(); ctx.clip(rrect(10, 16, 172, 156, 4)); for (let x = 50; x < 180; x += 44) seam(ctx, x, 16, x, 170, 0.25); ctx.restore();
    // output pipe from the wellhead
    const [ox, oy] = rotPt(dir, 192, 192, 96, 0), [dx, dy] = DXY[dir];
    const ex = ox - dx * 10, ey = oy - dy * 10;
    if (dir % 2 === 0) { pipeH(ctx, Math.min(well[0], ex), Math.max(well[0], ex), well[1] + 4, 6, '#7f7d76'); pipeV(ctx, ex, Math.min(ey, well[1]), Math.max(ey, well[1] + 4), 6, '#7f7d76'); }
    else { pipeH(ctx, Math.min(well[0], ex), Math.max(well[0], ex), ey, 6, '#7f7d76'); if (Math.abs(ey - well[1]) > 2) pipeV(ctx, well[0], Math.min(ey, well[1]), Math.max(ey, well[1]), 6, '#7f7d76'); }
    nozzle(ctx, ox - dx * 22, oy - dy * 22, dir, 'out');
    fill(ctx, ell(well[0], well[1] + 4, 16, 8), 'rgba(0,0,0,.4)');
    cylV(ctx, well[0] - 10, well[1] - 18, 20, 26, '#6b6f73', { ry: 5 });
    // motor + gearbox
    block(ctx, X(158) - 22, 140, 44, 34, 8, '#5b5e5a'); vents(ctx, X(158) - 16, 146, 32, 10, 3);
  });
  ctx.drawImage(body, -pd.l, -pd.t);
  // beam and A-frame shadow falls on the concrete pad
  softShadow(ctx, 8, 14, 176, 160, (g) => { g.save(); g.beginPath(); g.rect(10, 16, 172, 154); g.clip(); g.lineWidth = 10; g.beginPath(); g.moveTo(head[0] + 34, head[1] + 62); g.lineTo(tail[0] + 34, tail[1] + 62); g.stroke(); g.lineWidth = 6; g.beginPath(); g.moveTo(piv[0] - 24, 160); g.lineTo(piv[0] + 34, piv[1] + 62); g.lineTo(piv[0] + 24, 160); g.stroke(); g.restore(); }, 0.28, 3);
  // samson post (A frame)
  ctx.lineCap = 'round';
  for (const [bx2, col] of [[piv[0] - 24, '#a4553a'], [piv[0] + 24, '#7e3f2a']]) { seg(ctx, bx2, 160, piv[0], piv[1] + 4, OUT, 10); seg(ctx, bx2, 160, piv[0], piv[1] + 4, col, 6.5); }
  for (const yy of [112, 80]) { const w = 16 * (yy - piv[1]) / (160 - piv[1]) + 4; seg(ctx, piv[0] - w, yy, piv[0] + w, yy, OUT, 5); seg(ctx, piv[0] - w, yy, piv[0] + w, yy, '#8e4a32', 3); }
  for (const s2 of [-1, 1]) { fill(ctx, rrect(piv[0] + s2 * 24 - 7, 156, 14, 8, 2), '#5b5d5a'); stroke(ctx, rrect(piv[0] + s2 * 24 - 7, 156, 14, 8, 2), OUT, 1); }
  // crank with counterweights (rotating in the x-z plane)
  const cp = [crank[0] + sg * Math.cos(phi) * 18, crank[1] - Math.sin(phi) * 18 * 0.75];
  const cw = [crank[0] - sg * Math.cos(phi) * 14, crank[1] + Math.sin(phi) * 14 * 0.75];
  seg(ctx, cp[0], cp[1], cw[0], cw[1], OUT, 9); seg(ctx, cp[0], cp[1], cw[0], cw[1], '#6b6d70', 6);
  const wt = circ(cw[0], cw[1], 11); fill(ctx, wt, rg(ctx, cw[0] - 3, cw[1] - 3, 1, cw[0], cw[1], 11, 0, '#9a9ca0', 1, '#3a3b3e')); stroke(ctx, wt, OUT, 1.3);
  dot(ctx, crank[0], crank[1], 4, '#2c2b28');
  // pitman arm
  seg(ctx, cp[0], cp[1], tail[0], tail[1] + 2, OUT, 6); seg(ctx, cp[0], cp[1], tail[0], tail[1] + 2, '#8d8b84', 3.5);
  // walking beam + horse head
  seg(ctx, head[0], head[1], tail[0], tail[1], OUT, 14); seg(ctx, head[0], head[1], tail[0], tail[1], '#b05a3c', 10.5); seg(ctx, head[0], head[1] - 3, tail[0], tail[1] - 3, 'rgba(255,220,190,.4)', 2.5); seg(ctx, head[0], head[1] + 3, tail[0], tail[1] + 3, 'rgba(40,10,0,.35)', 2);
  ctx.lineCap = 'butt';
  ctx.save(); ctx.translate(head[0], head[1]); ctx.rotate(mir ? -th : th); ctx.scale(1.45, 1.45);
  const hh = new Path2D(); hh.moveTo(sg * 6, -10); hh.quadraticCurveTo(-sg * 22, -8, -sg * 18, 22); hh.lineTo(-sg * 8, 22); hh.quadraticCurveTo(-sg * 8, 2, sg * 8, 6); hh.closePath();
  fill(ctx, hh, lg(ctx, -20, -10, 10, 22, 0, '#d0744e', 1, '#6e2e1a')); stroke(ctx, hh, OUT, 1.4);
  ctx.restore();
  const hb = [head[0] - sg * 20 * ca, head[1] + 28];
  seg(ctx, hb[0], hb[1], well[0], well[1] - 16, 'rgba(30,28,24,.9)', 1.6);
  dot(ctx, piv[0], piv[1], 4.5, '#2c2b28'); dot(ctx, piv[0] - 1, piv[1] - 1, 1.6, '#9c9a94');
  dot(ctx, tail[0], tail[1], 3.5, '#2c2b28');
}

// ------------------------------------------------------------------ rocket silo / rocket
function drawSilo(ctx, o) {
  if (o.shadow) boxShadow(ctx, 6, 8, 564, 564, 0.7);
  const conc = '#9c978b';
  const outer = chamf(6, 8, 564, 564, 60);
  fill(ctx, outer, lg(ctx, 0, 540, 0, 572, 0, dk(conc, 0.35), 1, dk(conc, 0.6))); grain(ctx, outer, 0.4, 0.4);
  const top = chamf(6, 8, 564, 544, 60);
  panel(ctx, top, conc, 6, 8, 564, 544, { outline: false, grime: 0.45 });
  ctx.save(); ctx.clip(top); for (let k = 1; k < 9; k++) { seam(ctx, 6 + k * 63, 8, 6 + k * 63, 552, 0.18); seam(ctx, 6, 8 + k * 61, 570, 8 + k * 61, 0.18); } ctx.restore();
  stroke(ctx, outer, OUT, 2.4);
  // corner structures
  for (const [x, y] of [[60, 50], [446, 50], [60, 420], [446, 420]]) {
    block(ctx, x, y, 70, 82, 14, '#6d7074');
    vents(ctx, x + 10, y + 10, 50, 22, 4);
    dot(ctx, x + 60, y + 56, 4, '#d23a2a'); glow(ctx, x + 60, y + 56, 10, 'rgba(255,60,40,.6)');
    pipeH(ctx, x < 288 ? x + 70 : 196, x < 288 ? 196 : x, y + 40, 7, '#7e7c76');
  }
  // hazard ring and hatch
  const hz = chamf(150, 140, 276, 276, 34), inner = chamf(170, 160, 236, 236, 26);
  const ring = new Path2D(); ring.addPath(hz); ring.addPath(inner);
  ctx.save(); ctx.clip(hz);
  fill(ctx, hz, '#d6a42c');
  ctx.fillStyle = '#26231e';
  for (let k = -300; k < 300; k += 28) { ctx.beginPath(); ctx.moveTo(150 + k, 416); ctx.lineTo(150 + k + 14, 416); ctx.lineTo(150 + k + 290, 140); ctx.lineTo(150 + k + 276, 140); ctx.closePath(); ctx.fill(); }
  ctx.restore();
  grain(ctx, hz, 0.35, 0.4); stroke(ctx, hz, OUT, 2);
  fill(ctx, chamf(166, 156, 244, 244, 28), '#2a2a29');
  const half = (x) => { const p = chamf(x, 168, 112, 220, 0); panel(ctx, p, '#5c6066', x, 168, 112, 220); for (let y = 190; y < 380; y += 26) seam(ctx, x + 6, y, x + 106, y, 0.35); for (let y = 182; y < 384; y += 30) { rivet(ctx, x + 8, y, 1.8); rivet(ctx, x + 104, y, 1.8); } };
  half(174); half(290);
  fill(ctx, rrect(284, 168, 8, 220, 1), '#141414');
  for (const [x, s] of [[230, -1], [346, 1]]) { fill(ctx, poly([[x - s * 16, 278], [x + s * 6, 262], [x + s * 6, 294]]), 'rgba(214,164,44,.85)'); stroke(ctx, poly([[x - s * 16, 278], [x + s * 6, 262], [x + s * 6, 294]]), OUT, 1.2); }
  for (let k = 0; k < 12; k++) { const a = (k / 12) * TAU; dot(ctx, 288 + Math.cos(a) * 150, 278 + Math.sin(a) * 150, 2.5, 'rgba(255,220,120,.9)'); }
}
function drawRocket(ctx) {
  const cx = 48;
  const fin = (s) => { const p = poly([[cx + s * 18, 290], [cx + s * 44, 340], [cx + s * 44, 366], [cx + s * 18, 350]]); fill(ctx, p, lg(ctx, cx + s * 18, 0, cx + s * 44, 0, 0, '#5a5c60', 1, '#2a2b2e')); stroke(ctx, p, OUT, 1.5); };
  fin(-1); fin(1);
  const body = rrect(cx - 20, 70, 40, 296, 4);
  fill(ctx, body, lg(ctx, cx - 20, 0, cx + 20, 0, 0, '#9fa2a6', 0.25, '#f2f2ee', 0.55, '#d6d6d2', 1, '#6e7074')); grain(ctx, body, 0.25, 0.15); stroke(ctx, body, OUT, 1.6);
  for (const [y, c] of [[120, '#2c2d30'], [128, '#b8382a'], [250, '#2c2d30'], [330, '#2c2d30']]) fill(ctx, rrect(cx - 20, y, 40, 5, 0), c);
  for (let y = 150; y < 320; y += 24) seg(ctx, cx - 19, y, cx + 19, y, 'rgba(0,0,0,.2)', 1);
  const nose = new Path2D(); nose.moveTo(cx - 20, 72); nose.quadraticCurveTo(cx - 18, 24, cx, 4); nose.quadraticCurveTo(cx + 18, 24, cx + 20, 72); nose.closePath();
  fill(ctx, nose, lg(ctx, cx - 20, 0, cx + 20, 0, 0, '#3a3b3f', 0.3, '#6a6c70', 1, '#16171a')); stroke(ctx, nose, OUT, 1.6);
  fill(ctx, rrect(cx - 3, 140, 6, 100, 2), 'rgba(0,0,0,.12)');
  const noz = poly([[cx - 14, 366], [cx + 14, 366], [cx + 20, 384], [cx - 20, 384]]);
  fill(ctx, noz, lg(ctx, cx - 20, 0, cx + 20, 0, 0, '#4a4b4f', 0.4, '#8a8c90', 1, '#1e1f22')); stroke(ctx, noz, OUT, 1.4);
}
function drawRocketFlame(ctx) {
  const cx = 48;
  const outer = new Path2D(); outer.moveTo(cx - 20, 0); outer.bezierCurveTo(cx - 46, 60, cx - 30, 150, cx, 192); outer.bezierCurveTo(cx + 30, 150, cx + 46, 60, cx + 20, 0); outer.closePath();
  fill(ctx, outer, lg(ctx, 0, 0, 0, 192, 0, 'rgba(255,170,60,.95)', 0.5, 'rgba(230,80,20,.6)', 1, 'rgba(120,20,0,0)'));
  const mid = new Path2D(); mid.moveTo(cx - 14, 0); mid.bezierCurveTo(cx - 26, 50, cx - 14, 110, cx, 140); mid.bezierCurveTo(cx + 14, 110, cx + 26, 50, cx + 14, 0); mid.closePath();
  fill(ctx, mid, lg(ctx, 0, 0, 0, 140, 0, 'rgba(255,240,170,1)', 0.6, 'rgba(255,170,50,.7)', 1, 'rgba(255,120,30,0)'));
  const core = new Path2D(); core.moveTo(cx - 8, 0); core.quadraticCurveTo(cx - 10, 40, cx, 70); core.quadraticCurveTo(cx + 10, 40, cx + 8, 0); core.closePath();
  fill(ctx, core, lg(ctx, 0, 0, 0, 70, 0, '#ffffff', 1, 'rgba(255,250,220,0)'));
}

function defMachines() {
  for (let d = 0; d < 4; d++) {
    for (let f = 0; f < 4; f++) ent(`ent:burner-mining-drill:${d}:f${f}`, 128, 128, BD_PAD, (c, o) => drawBurnerDrill(c, d, f, o));
    for (let f = 0; f < 8; f++) ent(`ent:electric-mining-drill:${d}:f${f}`, 192, 192, ED_PAD[d], (c, o) => drawEDrill(c, d, f, o));
    ent(`ent:offshore-pump:${d}`, 64, 64, offPad(d), (c, o) => drawOffshore(c, d, o));
    const bw = d % 2 ? 128 : 192, bh = d % 2 ? 192 : 128;
    ent(`ent:boiler:${d}`, bw, bh, BOILER_PAD, (c, o) => drawBoiler(c, d, false, o));
    ent(`ent:boiler:${d}:on`, bw, bh, BOILER_PAD, (c, o) => drawBoiler(c, d, true, o));
    const ew = d % 2 ? 320 : 192, eh = d % 2 ? 192 : 320;
    for (let f = 0; f < 8; f++) ent(`ent:steam-engine:${d}:f${f}`, ew, eh, d % 2 ? { t: 4, r: 32, b: 14 } : { t: 4, r: 20, b: 22 }, (c, o) => (d % 2 ? engineH(c, d === 3, f, o, o.pad) : engineV(c, d === 2, f, o, o.pad)));
    ent(`ent:oil-refinery:${d}`, 320, 320, REF_PAD, (c, o) => drawRefinery(c, d, false, o));
    ent(`ent:oil-refinery:${d}:on`, 320, 320, REF_PAD, (c, o) => drawRefinery(c, d, true, o));
    for (let f = 0; f < 4; f++) ent(`ent:chemical-plant:${d}:f${f}`, 192, 192, { t: 6, r: 32, b: 24 }, (c, o) => drawChem(c, d, f, o));
    for (let f = 0; f < 8; f++) ent(`ent:pumpjack:${d}:f${f}`, 192, 192, { t: 4, r: 18, b: 14 }, (c, o) => drawPumpjack(c, d, f, o));
  }
  ent('ent:solar-panel', 192, 192, { r: 30, b: 22 }, drawSolar);
  ent('ent:accumulator', 128, 128, { t: 2, r: 36, b: 28 }, (c, o) => drawAccumulator(c, o, false));
  ent('ent:accumulator:on', 128, 128, { t: 2, r: 36, b: 28 }, (c, o) => drawAccumulator(c, o, true));
  ent('ent:stone-furnace', 128, 128, {}, (c, o) => drawStoneFurnace(c, o, false));
  ent('ent:stone-furnace:on', 128, 128, {}, (c, o) => drawStoneFurnace(c, o, true));
  ent('ent:steel-furnace', 128, 128, { t: 18 }, (c, o) => drawSteelFurnace(c, o, false));
  ent('ent:steel-furnace:on', 128, 128, { t: 18 }, (c, o) => drawSteelFurnace(c, o, true));
  ent('ent:electric-furnace', 192, 192, { r: 40, b: 30 }, (c, o) => drawElectricFurnace(c, o, false));
  ent('ent:electric-furnace:on', 192, 192, { r: 40, b: 30 }, (c, o) => drawElectricFurnace(c, o, true));
  for (const t of [1, 2, 3]) for (let f = 0; f < 8; f++) ent(`ent:assembling-machine-${t}:f${f}`, 192, 192, { r: 34, b: 27 }, (c, o) => drawAssembler(c, t, f, o));
  for (let f = 0; f < 8; f++) ent(`ent:lab:f${f}`, 192, 192, { r: 32, b: 25 }, (c, o) => drawLab(c, f, o));
  ent('ent:rocket-silo', 576, 576, { r: 26, b: 20 }, drawSilo);
  def('fx:rocket', 96, 384, drawRocket);
  def('fx:rocket-flame', 96, 192, drawRocketFlame);
}

// ------------------------------------------------------------------ item icons
// entity-based icons: render the entity (no shadow) once, then step-downscale into a 128 px canvas
const ICON_SRC = {
  'wooden-chest': [64, 64, 0, (c, o) => drawChest(c, 'wooden-chest', o)],
  'iron-chest': [64, 64, 0, (c, o) => drawChest(c, 'iron-chest', o)],
  'steel-chest': [64, 64, 0, (c, o) => drawChest(c, 'steel-chest', o)],
  'small-electric-pole': [64, 30, 118, drawSmallPole], // cropped above the base so the head reads at icon size
  'medium-electric-pole': [64, 30, 158, drawMediumPole],
  'big-electric-pole': [128, 100, 234, drawBigPole],
  'pipe-to-ground': [64, 64, 0, (c, o) => drawPipeToGround(c, 1, o)],
  'storage-tank': [192, 192, 0, drawTank],
  'small-lamp': [64, 64, 0, (c, o) => drawLamp(c, o, false)],
  'burner-mining-drill': [128, 128, 20, (c, o) => drawBurnerDrill(c, 0, 0, o)],
  'electric-mining-drill': [192, 192, 18, (c) => { eDrillBody(c, false, 0); eDrillRotor(c, 0); }],
  'offshore-pump': [64, 128, 0, (c, o) => drawOffshore(c, 0, o)],
  boiler: [192, 128, 32, (c, o) => drawBoiler(c, 0, false, o)],
  'steam-engine': [320, 192, 0, (c, o) => engineH(c, false, 0, o, { l: 0, t: 0 })],
  'solar-panel': [192, 192, 0, drawSolar],
  accumulator: [128, 128, 0, (c, o) => drawAccumulator(c, o, false)],
  'stone-furnace': [128, 128, 0, (c, o) => drawStoneFurnace(c, o, false)],
  'steel-furnace': [128, 128, 18, (c, o) => drawSteelFurnace(c, o, false)],
  'electric-furnace': [192, 192, 0, (c, o) => drawElectricFurnace(c, o, false)],
  'assembling-machine-1': [192, 192, 0, (c) => { amBody(c, 1, false); amMech(c, 1, 0); }],
  'assembling-machine-2': [192, 192, 0, (c) => { amBody(c, 2, false); amMech(c, 2, 0); }],
  'assembling-machine-3': [192, 192, 0, (c) => { amBody(c, 3, false); amMech(c, 3, 0); }],
  'oil-refinery': [320, 320, 104, (c, o) => drawRefinery(c, 0, false, o)],
  'chemical-plant': [192, 192, 4, (c) => { chemBody(c, 0, false); chemDomes(c, 0, 0); }],
  pumpjack: [192, 192, 0, (c, o) => drawPumpjack(c, 0, 0, o)],
  lab: [192, 192, 0, (c) => { labBody(c, false); labCore(c, 0); }],
  'rocket-silo': [576, 576, 0, drawSilo],
};
const ICON_CACHE = new Map();
function downscaleInto(src, box, size = 128) {
  let cur = src, w = src.width, h = src.height;
  const sc = Math.min(box / w, box / h), tw = Math.max(1, Math.round(w * sc)), th = Math.max(1, Math.round(h * sc));
  while (w * 0.5 >= tw && h * 0.5 >= th) {
    const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2), n = mk(nw, nh), g = n.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(cur, 0, 0, w, h, 0, 0, nw, nh);
    cur = n; w = nw; h = nh;
  }
  const out = mk(size, size), og = out.getContext('2d');
  og.imageSmoothingEnabled = true; og.imageSmoothingQuality = 'high';
  og.drawImage(cur, 0, 0, w, h, (size - tw) / 2, (size - th) / 2, tw, th);
  return out;
}
function entIcon(name) {
  let c = ICON_CACHE.get(name);
  if (c) return c;
  const [fw, fh, top, paint] = ICON_SRC[name];
  const k = Math.min(1, 256 / Math.max(fw, fh + top)); // big entities are painted smaller; still >= 2x the 120 px target
  const big = mk(fw * k, (fh + top) * k), g = big.getContext('2d');
  g.scale(k, k); g.translate(0, top);
  paint(g, { shadow: false, pad: { l: 0, t: top, r: 0, b: 0 }, w: fw, h: fh + top });
  c = downscaleInto(big, 120);
  ICON_CACHE.set(name, c);
  return c;
}
function slab(ctx, pts, t, base, o = {}) {
  const [A, B, Cc, D] = pts, dn = (p) => [p[0], p[1] + t];
  fill(ctx, poly([A, D, dn(D), dn(A)]), dk(base, 0.3)); fill(ctx, poly([D, Cc, dn(Cc), dn(D)]), dk(base, 0.5));
  const top = poly(pts);
  fill(ctx, top, lg(ctx, A[0], B[1], Cc[0], D[1], 0, lt(base, o.l ?? 0.3), 0.5, css(base), 1, dk(base, 0.2)));
  if (o.grain !== 0) grain(ctx, top, 0.3, 0.2);
  pline(ctx, [A, B, Cc], 'rgba(255,250,235,.45)', 1);
  stroke(ctx, poly([A, B, Cc, dn(Cc), dn(D), dn(A)]), OUT, 1.6);
  seg(ctx, A[0], A[1], D[0], D[1], 'rgba(0,0,0,.35)', 1); seg(ctx, D[0], D[1], Cc[0], Cc[1], 'rgba(0,0,0,.35)', 1); seg(ctx, D[0], D[1], D[0], D[1] + t, 'rgba(0,0,0,.35)', 1);
  return top;
}
function itemOre(ctx, res) {
  const R = rng('item' + res);
  const ch = [[32, 22, 11], [46, 30, 10], [18, 30, 10], [28, 42, 13], [46, 46, 10]];
  for (const [x, y, r] of ch) oreChunk(ctx, R, x, y, r, res);
}
function itemWood(ctx) {
  for (const [y, l] of [[38, 46], [24, 42]]) {
    ctx.save(); ctx.translate(32, y); ctx.rotate(-0.3);
    const body = rrect(-l / 2, -9, l, 18, 8);
    fill(ctx, body, lg(ctx, 0, -9, 0, 9, 0, '#a07a4c', 0.4, '#6e4c2c', 1, '#3a2614')); grain(ctx, body, 0.5, 0.3);
    for (let k = 0; k < 3; k++) seg(ctx, -l / 2 + 6, -4 + k * 4, l / 2 - 10, -4 + k * 4 + (k - 1), 'rgba(30,18,8,.35)', 1);
    stroke(ctx, body, OUT, 1.6);
    const end = ell(l / 2 - 4, 0, 6, 9);
    fill(ctx, end, rg(ctx, l / 2 - 4, 0, 0, l / 2 - 4, 0, 9, 0, '#e2c08a', 0.6, '#c09460', 1, '#8a6232'));
    for (const r of [2.5, 5]) stroke(ctx, ell(l / 2 - 4, 0, r * 0.66, r), 'rgba(110,70,30,.6)', 0.9);
    stroke(ctx, end, OUT, 1.3);
    ctx.restore();
  }
}
function itemPlates(ctx, base, n = 3, bar = false) {
  for (let k = n - 1; k >= 0; k--) {
    const y = 20 + k * 9, w = bar ? 0.75 : 1;
    slab(ctx, [[8, y + 10 * w], [32 - 6 * (1 - w), y], [56, y + 10 * w], [32 + 6 * (1 - w), y + 20 * w]], 5, base);
  }
}
function itemBricks(ctx) {
  slab(ctx, [[6, 38], [26, 30], [46, 40], [26, 48]], 8, '#b39a74');
  slab(ctx, [[18, 26], [38, 18], [58, 28], [38, 36]], 8, '#a88d66');
  slab(ctx, [[14, 20], [32, 12], [50, 21], [32, 29]], 7, '#bea47c');
}
function itemCable(ctx) {
  for (let k = 0; k < 5; k++) {
    const y = 40 - k * 4, e = ell(30, y, 19, 9);
    ctx.lineWidth = 4.5; ctx.strokeStyle = OUT; ctx.stroke(e);
    ctx.lineWidth = 3; ctx.strokeStyle = lg(ctx, 11, 0, 49, 0, 0, '#f0a868', 0.5, '#c46a32', 1, '#7a3814'); ctx.stroke(e);
  }
  pline(ctx, [[48, 22], [54, 14], [58, 10]], OUT, 4.5); pline(ctx, [[48, 22], [54, 14], [58, 10]], '#d8884a', 2.6);
}
function itemBoard(ctx, board, chips) {
  const b = rrect(6, 14, 52, 38, 4);
  fill(ctx, rrect(8, 17, 52, 38, 4), 'rgba(0,0,0,.35)');
  fill(ctx, b, lg(ctx, 6, 14, 58, 52, 0, lt(board, 0.25), 1, dk(board, 0.35))); stroke(ctx, b, OUT, 1.6);
  for (const y of [20, 46]) seg(ctx, 10, y, 54, y, 'rgba(230,190,90,.8)', 1.4);
  for (const x of [12, 52]) seg(ctx, x, 20, x, 46, 'rgba(230,190,90,.8)', 1.4);
  for (const [x, y, w, h, col] of chips) {
    for (let k = 0; k < Math.floor(w / 4); k++) { seg(ctx, x + 2 + k * 4, y - 3, x + 2 + k * 4, y + h + 3, '#c9c4b0', 1.2); }
    const c = rrect(x, y, w, h, 1.5); fill(ctx, c, lg(ctx, x, y, x, y + h, 0, lt(col, 0.2), 1, dk(col, 0.3))); stroke(ctx, c, OUT, 1.2);
    seg(ctx, x + 1, y + 1.5, x + w - 1, y + 1.5, 'rgba(255,255,255,.25)', 1);
  }
}
function itemEngine(ctx) {
  block(ctx, 10, 24, 40, 28, 8, '#7d7f84');
  for (let k = 0; k < 3; k++) { const c = cylV(ctx, 14 + k * 12, 14, 10, 18, '#9a9ca0', { ry: 3 }); void c; }
  gear(ctx, 50, 40, 10, 8, 0.2, '#8e8b82');
  pipeH(ctx, 4, 14, 44, 4); flange(ctx, 6, 44, false, 4);
}
function itemFlask(ctx, liq) {
  const p = new Path2D(); p.moveTo(26, 8); p.lineTo(38, 8); p.lineTo(38, 24); p.lineTo(52, 50); p.quadraticCurveTo(54, 58, 46, 58); p.lineTo(18, 58); p.quadraticCurveTo(10, 58, 12, 50); p.lineTo(26, 24); p.closePath();
  fill(ctx, p, 'rgba(200,225,235,.35)');
  ctx.save(); ctx.clip(p); fill(ctx, rrect(0, 34, 64, 30, 0), lg(ctx, 12, 0, 52, 0, 0, lt(liq, 0.35), 0.5, liq, 1, dk(liq, 0.45))); seg(ctx, 0, 34, 64, 34, lt(liq, 0.5), 2); ctx.restore();
  pline(ctx, [[30, 26], [18, 50]], 'rgba(255,255,255,.65)', 2.5);
  stroke(ctx, p, OUT, 2);
  const cork = rrect(24, 4, 16, 8, 2); fill(ctx, cork, lg(ctx, 0, 4, 0, 12, 0, '#a07a4c', 1, '#5c3e20')); stroke(ctx, cork, OUT, 1.3);
}
function itemFlag(ctx) {
  fill(ctx, rrect(17, 50, 18, 7, 2), '#6e6a64'); stroke(ctx, rrect(17, 50, 18, 7, 2), OUT, 1.5);
  seg(ctx, 26, 52, 26, 7, OUT, 6); seg(ctx, 26, 52, 26, 7, '#c9ccd0', 3);
  const f = new Path2D(); f.moveTo(28, 9); f.bezierCurveTo(38, 5, 46, 14, 58, 10); f.lineTo(58, 32); f.bezierCurveTo(46, 36, 38, 27, 28, 31); f.closePath();
  fill(ctx, f, lg(ctx, 28, 0, 58, 0, 0, '#ff6a52', 1, '#c8331f')); stroke(ctx, f, OUT, 2);
  fill(ctx, circ(43, 20, 5.5), '#fff2e0');
  fill(ctx, circ(26, 7, 3.2), '#f0c24a'); stroke(ctx, circ(26, 7, 3.2), OUT, 1.2);
}
function itemBattery(ctx) {
  cylV(ctx, 18, 12, 28, 46, '#6d7884', { ry: 7 });
  fill(ctx, rrect(18, 30, 28, 9, 0), '#d68a2c'); stroke(ctx, rrect(18, 30, 28, 9, 0), 'rgba(0,0,0,.5)', 1);
  cylV(ctx, 27, 8, 10, 10, '#c47a3c', { ry: 3 });
}
function itemSulfur(ctx) {
  const R = rng('sulfur');
  for (const [x, y, r] of [[22, 40, 14], [40, 40, 14], [31, 28, 13], [46, 48, 9], [16, 50, 8]]) {
    const p = smoothPath(blobPts(x, y, r, r * 0.8, 9, 0.15, R));
    fill(ctx, p, rg(ctx, x - r * 0.4, y - r * 0.5, 1, x, y, r * 1.1, 0, '#fff1a0', 0.5, '#e0c632', 1, '#8a7410')); stroke(ctx, p, OUT, 1.3);
  }
}
function itemLDS(ctx) {
  const top = slab(ctx, [[6, 30], [32, 16], [58, 30], [32, 44]], 7, '#c88a52');
  ctx.save(); ctx.clip(top);
  for (let j = 0; j < 8; j++) for (let i = 0; i < 10; i++) { const x = 4 + i * 6 + (j % 2) * 3, y = 14 + j * 4.5; stroke(ctx, poly([[x, y - 2.5], [x + 2.6, y - 1.2], [x + 2.6, y + 1.2], [x, y + 2.5], [x - 2.6, y + 1.2], [x - 2.6, y - 1.2]]), 'rgba(80,40,10,.55)', 0.8); }
  ctx.restore();
}
function itemBelt(ctx, tier, ub) {
  ctx.save(); ctx.translate(32, 32); ctx.rotate(Math.PI / 4); ctx.scale(0.68, 0.68); ctx.translate(-32, -32);
  fill(ctx, rrect(3, 3, 64, 64, 0), 'rgba(0,0,0,.35)');
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, 64, 64); ctx.clip(); drawBelt(ctx, tier, 's', 0); if (ub) drawUB(ctx, tier, false); ctx.restore();
  ctx.strokeStyle = OUT; ctx.lineWidth = 2.5; ctx.strokeRect(0, 0, 64, 64);
  ctx.restore();
}
function itemSplitter(ctx, tier) {
  ctx.save(); ctx.translate(32, 32); ctx.rotate(-0.5); ctx.scale(0.46, 0.46); ctx.translate(-64, -32);
  for (const x of [0, 64]) { ctx.save(); ctx.beginPath(); ctx.rect(x, 0, 64, 64); ctx.clip(); ctx.translate(x, 0); drawBelt(ctx, tier, 's', 0); ctx.restore(); }
  drawSplitter(ctx, tier);
  ctx.strokeStyle = OUT; ctx.lineWidth = 3; ctx.strokeRect(0, 0, 128, 64);
  ctx.restore();
}
function itemInserter(ctx, n) {
  ctx.save(); ctx.translate(-6, 12); insBase(ctx, n); ctx.restore();
  const a = 0.8, len = 24, px = 26, py = 44;
  ctx.save(); ctx.translate(px, py); ctx.rotate(a); ctx.scale(1.6, len / 48); ctx.translate(-8, -56); insArm(ctx, n); ctx.restore();
  ctx.save(); ctx.translate(px + Math.sin(a) * len, py - Math.cos(a) * len); ctx.rotate(a); ctx.scale(1.15, 1.15); ctx.translate(-16, -22); insHand(ctx, n, false); ctx.restore();
}
function itemPipe(ctx) { ctx.save(); ctx.translate(32, 32); ctx.rotate(-0.45); ctx.translate(-32, -32); drawPipe(ctx, 10, { shadow: false }); ctx.restore(); }
function itemFuel(ctx, rocket) {
  if (rocket) {
    cylV(ctx, 16, 12, 32, 46, '#c23b2b', { ry: 8 });
    fill(ctx, rrect(16, 32, 32, 8, 0), '#e8e0c8'); stroke(ctx, rrect(16, 32, 32, 8, 0), 'rgba(0,0,0,.5)', 1);
    cylV(ctx, 26, 6, 12, 12, '#5a5c60', { ry: 3 });
  } else {
    block(ctx, 12, 16, 40, 38, 12, '#5a4c40', { r: 5, grime: 0.5 });
    const R = rng('solidfuel'); for (let k = 0; k < 10; k++) dot(ctx, 16 + R() * 32, 20 + R() * 18, 1 + R(), 'rgba(230,150,60,.7)');
  }
}

const ITEM_NAMES = ['wood', 'coal', 'stone', 'iron-ore', 'copper-ore', 'iron-plate', 'copper-plate', 'steel-plate', 'stone-brick', 'iron-gear-wheel', 'copper-cable',
  'electronic-circuit', 'advanced-circuit', 'processing-unit', 'engine-unit', 'plastic-bar', 'sulfur', 'battery', 'solid-fuel', 'rocket-fuel', 'low-density-structure',
  'automation-science-pack', 'logistic-science-pack', 'chemical-science-pack', 'wooden-chest', 'iron-chest', 'steel-chest', 'transport-belt', 'fast-transport-belt',
  'express-transport-belt', 'underground-belt', 'fast-underground-belt', 'express-underground-belt', 'splitter', 'fast-splitter', 'express-splitter', 'burner-inserter',
  'inserter', 'long-handed-inserter', 'fast-inserter', 'small-electric-pole', 'medium-electric-pole', 'big-electric-pole', 'pipe', 'pipe-to-ground', 'storage-tank',
  'small-lamp', 'burner-mining-drill', 'electric-mining-drill', 'offshore-pump', 'boiler', 'steam-engine', 'solar-panel', 'accumulator', 'stone-furnace', 'steel-furnace',
  'electric-furnace', 'assembling-machine-1', 'assembling-machine-2', 'assembling-machine-3', 'oil-refinery', 'chemical-plant', 'pumpjack', 'lab', 'rocket-silo', 'flag'];
const ITEM_PAINT = {
  wood: itemWood,
  coal: (c) => itemOre(c, 'coal'), stone: (c) => itemOre(c, 'stone'), 'iron-ore': (c) => itemOre(c, 'iron-ore'), 'copper-ore': (c) => itemOre(c, 'copper-ore'),
  'iron-plate': (c) => itemPlates(c, '#8d969e'), 'copper-plate': (c) => itemPlates(c, '#c97a44'), 'steel-plate': (c) => itemPlates(c, '#b8c0c8', 3, true),
  'stone-brick': itemBricks,
  'iron-gear-wheel': (c) => gear(c, 32, 33, 26, 10, 0.15, '#9097a0', { hole: 8, th: 6, ow: 1.8 }),
  'copper-cable': itemCable,
  'electronic-circuit': (c) => itemBoard(c, '#2e7d34', [[22, 25, 20, 15, '#26262a']]),
  'advanced-circuit': (c) => itemBoard(c, '#b2342b', [[14, 24, 14, 16, '#26262a'], [36, 24, 14, 16, '#26262a']]),
  'processing-unit': (c) => { itemBoard(c, '#2f5fb4', [[18, 21, 28, 24, '#26262a']]); fill(c, rrect(26, 27, 12, 12, 1), '#d6b04a'); },
  'engine-unit': itemEngine,
  'plastic-bar': (c) => itemPlates(c, '#e6e4dc', 2, true),
  sulfur: itemSulfur, battery: itemBattery,
  'solid-fuel': (c) => itemFuel(c, false), 'rocket-fuel': (c) => itemFuel(c, true),
  'low-density-structure': itemLDS,
  'automation-science-pack': (c) => itemFlask(c, '#d63a2c'), 'logistic-science-pack': (c) => itemFlask(c, '#3fae3a'), 'chemical-science-pack': (c) => itemFlask(c, '#3d8fe2'),
  'transport-belt': (c) => itemBelt(c, 0), 'fast-transport-belt': (c) => itemBelt(c, 1), 'express-transport-belt': (c) => itemBelt(c, 2),
  'underground-belt': (c) => itemBelt(c, 0, true), 'fast-underground-belt': (c) => itemBelt(c, 1, true), 'express-underground-belt': (c) => itemBelt(c, 2, true),
  splitter: (c) => itemSplitter(c, 0), 'fast-splitter': (c) => itemSplitter(c, 1), 'express-splitter': (c) => itemSplitter(c, 2),
  'burner-inserter': (c) => itemInserter(c, 'burner-inserter'), inserter: (c) => itemInserter(c, 'inserter'),
  'long-handed-inserter': (c) => itemInserter(c, 'long-handed-inserter'), 'fast-inserter': (c) => itemInserter(c, 'fast-inserter'),
  pipe: itemPipe,
  flag: itemFlag,
};
const FLUID_COL = { water: '#2c6fd6', steam: '#d8d8d8', 'crude-oil': '#3a2140', 'petroleum-gas': '#7a4a9c', 'sulfuric-acid': '#d6c43a' };
function drawFluid(ctx, name) {
  const col = FLUID_COL[name];
  if (name === 'steam' || name === 'petroleum-gas') {
    const p = new Path2D();
    for (const [x, y, r] of [[22, 38, 14], [36, 30, 16], [46, 40, 12], [32, 44, 13]]) { p.moveTo(x + r, y); p.arc(x, y, r, 0, TAU); }
    stroke(ctx, p, OUT, 3.5); fill(ctx, p, rg(ctx, 26, 22, 2, 34, 38, 30, 0, lt(col, 0.6), 0.6, css(col), 1, dk(col, 0.35)));
    fill(ctx, ell(28, 26, 8, 4), 'rgba(255,255,255,.4)');
    return;
  }
  const p = new Path2D(); p.moveTo(32, 5); p.bezierCurveTo(38, 16, 52, 28, 52, 40); p.bezierCurveTo(52, 52, 43, 60, 32, 60); p.bezierCurveTo(21, 60, 12, 52, 12, 40); p.bezierCurveTo(12, 28, 26, 16, 32, 5); p.closePath();
  fill(ctx, p, rg(ctx, 25, 34, 2, 32, 40, 26, 0, lt(col, 0.45), 0.55, css(col), 1, dk(col, 0.45)));
  stroke(ctx, p, OUT, 2.2);
  fill(ctx, ell(24, 38, 3.5, 8), 'rgba(255,255,255,.55)');
}
function drawUiIcon(ctx, k) {
  const ring = (fillA = 0.6) => { const c = circ(32, 32, 27); fill(ctx, c, `rgba(40,6,4,${fillA})`); stroke(ctx, c, OUT, 7); stroke(ctx, c, '#e0402e', 4.5); };
  if (k === 'no-power') {
    ring();
    const b = poly([[36, 8], [18, 36], [30, 36], [26, 56], [46, 26], [34, 26], [40, 8]]);
    fill(ctx, b, lg(ctx, 0, 8, 0, 56, 0, '#fff27a', 0.5, '#ffbe2a', 1, '#e8572a')); stroke(ctx, b, OUT, 2);
  } else if (k === 'no-fuel') {
    ring();
    const f = new Path2D(); f.moveTo(32, 10); f.bezierCurveTo(44, 22, 48, 32, 46, 42); f.bezierCurveTo(44, 52, 38, 56, 32, 56); f.bezierCurveTo(24, 56, 18, 50, 18, 42); f.bezierCurveTo(18, 34, 24, 30, 26, 22); f.bezierCurveTo(30, 28, 30, 32, 32, 34); f.bezierCurveTo(34, 26, 34, 18, 32, 10); f.closePath();
    fill(ctx, f, lg(ctx, 0, 10, 0, 56, 0, '#ffe07a', 0.5, '#ff9a2a', 1, '#d8401a')); stroke(ctx, f, OUT, 2);
    const inner = ell(32, 46, 6, 8); fill(ctx, inner, '#fff4c0');
  } else if (k === 'output-full' || k === 'no-input') {
    const full = k === 'output-full';
    const box = block(ctx, 10, 26, 44, 32, 10, '#9a7a4e', { r: 3 });
    if (!full) { fill(ctx, rrect(16, 30, 32, 12, 2), 'rgba(0,0,0,.55)'); }
    else { for (let i = 0; i < 3; i++) { const p = rrect(15 + i * 12, 28, 10, 8, 2); fill(ctx, p, '#8d969e'); stroke(ctx, p, OUT, 1); } }
    void box;
    if (full) { const a = poly([[32, 2], [46, 16], [38, 16], [38, 26], [26, 26], [26, 16], [18, 16]]); fill(ctx, a, '#e8b23a'); stroke(ctx, a, OUT, 2); }
    else { const c = circ(48, 16, 11); fill(ctx, c, '#e0402e'); stroke(ctx, c, OUT, 2); seg(ctx, 42, 16, 54, 16, '#fff', 3); }
  } else if (k === 'no-recipe') {
    gear(ctx, 32, 32, 26, 10, 0.1, '#8d9196', { hole: 0, th: 6, ow: 1.8 });
    fill(ctx, circ(32, 32, 15), '#2a2b2e');
    ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(32, 27, 6, Math.PI * 1.05, Math.PI * 2.35); ctx.lineTo(32, 36); ctx.strokeStyle = '#f2d24a'; ctx.lineWidth = 3.4; ctx.stroke(); ctx.lineCap = 'butt';
    dot(ctx, 32, 41.5, 2.2, '#f2d24a');
  } else {
    const t = poly([[32, 5], [60, 56], [4, 56]]);
    fill(ctx, t, lg(ctx, 0, 5, 0, 56, 0, '#ffe066', 1, '#e0a42a')); stroke(ctx, t, OUT, 3);
    fill(ctx, rrect(29, 20, 6, 22, 3), '#26221c'); dot(ctx, 32, 48, 3.4, '#26221c');
  }
}

// ------------------------------------------------------------------ fx
function puff(ctx, rgb, a, R) {
  for (const [x, y, r, al] of [[32, 34, 26, 1], [22, 30, 15, 0.8], [42, 28, 16, 0.8], [30, 22, 14, 0.7], [40, 40, 14, 0.6]]) {
    const xx = x + (R() - 0.5) * 3, yy = y + (R() - 0.5) * 3;
    fill(ctx, circ(xx, yy, r), rg(ctx, xx - r * 0.3, yy - r * 0.3, 0, xx, yy, r, 0, `rgba(${rgb},${a * al})`, 0.6, `rgba(${rgb},${a * al * 0.5})`, 1, `rgba(${rgb},0)`));
  }
}
function defFx() {
  def('fx:smoke', 64, 64, (c) => puff(c, '120,116,108', 0.55, rng('smoke')));
  def('fx:steam', 64, 64, (c) => puff(c, '250,250,248', 0.7, rng('steam')));
  def('fx:arrow', 64, 64, (c) => {
    const a = poly([[32, 4], [58, 32], [42, 32], [42, 60], [22, 60], [22, 32], [6, 32]]);
    c.lineJoin = 'round'; stroke(c, a, 'rgba(10,10,10,.9)', 5); fill(c, a, '#ffffff'); c.lineJoin = 'miter';
  });
  def('fx:spark', 16, 16, (c) => {
    fill(c, circ(8, 8, 8), rg(c, 8, 8, 0, 8, 8, 8, 0, 'rgba(255,255,230,1)', 0.3, 'rgba(255,210,90,.8)', 1, 'rgba(255,140,30,0)'));
    seg(c, 1, 8, 15, 8, 'rgba(255,255,220,.8)', 1); seg(c, 8, 1, 8, 15, 'rgba(255,255,220,.8)', 1);
  });
  def('fx:light', 256, 256, (c) => fill(c, circ(128, 128, 128), rg(c, 128, 128, 0, 128, 128, 128, 0, 'rgba(255,255,255,1)', 0.25, 'rgba(255,255,255,.7)', 0.55, 'rgba(255,255,255,.3)', 0.8, 'rgba(255,255,255,.08)', 1, 'rgba(255,255,255,0)')));
}
function defItems() {
  for (const n of ITEM_NAMES) {
    const p = ITEM_PAINT[n];
    if (p) def('item:' + n, 64, 64, p);
    else if (ICON_SRC[n]) def('item:' + n, 64, 64, (ctx) => ctx.drawImage(entIcon(n), 0, 0, 128, 128, 0, 0, 64, 64));
  }
  for (const n of Object.keys(FLUID_COL)) def('fluid:' + n, 64, 64, (c) => drawFluid(c, n));
  for (const k of ['no-power', 'no-fuel', 'output-full', 'no-recipe', 'no-input', 'warning']) def('icon:' + k, 64, 64, (c) => drawUiIcon(c, k));
}

// ------------------------------------------------------------------ public API
let BUILT = false;
function build() {
  if (BUILT) return;
  BUILT = true;
  defTerrain(); defBelts(); defInserters(); defPoles(); defPipes(); defStorage(); defMachines(); defItems(); defFx();
}
function safeDraw(d) {
  return (ctx) => { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, d.w, d.h); ctx.clip(); d.draw(ctx, d.w, d.h); ctx.restore(); };
}
export function registerSprites(add) {
  build();
  for (const d of DEFS) add(d.key, d.w, d.h, safeDraw(d), d.opts);
}
export function drawIcon(ctx, key, size) {
  build();
  const d = DEFMAP.get(key);
  if (!d) return;
  ctx.save(); ctx.scale(size / d.w, size / d.h);
  ctx.beginPath(); ctx.rect(0, 0, d.w, d.h); ctx.clip();
  d.draw(ctx, d.w, d.h);
  ctx.restore();
}

export const WIRE_ANCHORS = {
  'small-electric-pole': [32, POLE['small-electric-pole'].by - 157],
  'medium-electric-pole': [32, POLE['medium-electric-pole'].by - 196],
  'big-electric-pole': [64, POLE['big-electric-pole'].by - 286 - 30],
};
export const SMOKE_POINTS = {
  'stone-furnace': [[64, 28]],
  'steel-furnace': [[104, -14]],
  boiler: BOILER_SMOKE,
  'burner-mining-drill': Object.fromEntries(BD_CHIM.map(([x, y], d) => [d, [[x, y - 38]]])),
  'oil-refinery': { 0: [[REF_FLARE[0], REF_FLARE[1] - 14]], 1: [[REF_FLARE[0], REF_FLARE[1] - 14]], 2: [[REF_FLARE[0], REF_FLARE[1] - 14]], 3: [[REF_FLARE[0], REF_FLARE[1] - 14]] },
};
export const SPRITE_FRAMES = { belt: 16, 'electric-mining-drill': 8, 'burner-mining-drill': 4, 'steam-engine': 8, 'assembling-machine-1': 8, 'assembling-machine-2': 8, 'assembling-machine-3': 8, 'chemical-plant': 4, pumpjack: 8, lab: 8 };
