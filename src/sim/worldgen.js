// Procedural world generation. Runs on the host only; clients receive the arrays in the snapshot,
// so floating point here does not affect lockstep determinism.
import { MAP_W, MAP_H, RES_INDEX } from '../data.js';
import { mulberry32, hash2 } from './util.js';

// terrain codes
export const T_GRASS = 0, T_DRYGRASS = 1, T_DIRT = 2, T_SAND = 3, T_WATER = 4, T_DEEP = 5;
// decor codes: 1..8 trees, 9..10 dead trees, 11..13 rocks
export const DECOR_TREE_MAX = 10;
export const isTree = d => d >= 1 && d <= 10;
export const isRock = d => d >= 11 && d <= 13;

function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, seed, oct = 4) {
  let s = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += valueNoise(x * f, y * f, seed + i * 1013) * amp;
    norm += amp; amp *= 0.5; f *= 2.03;
  }
  return s / norm;
}

export function generateWorld(seed) {
  const W = MAP_W, H = MAP_H, N = W * H;
  const terrain = new Uint8Array(N);
  const res = new Uint8Array(N);
  const amt = new Uint32Array(N);
  const decor = new Uint8Array(N);
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const sx = W >> 1, sy = H >> 1;

  // spawn lake: a guaranteed pond close to spawn
  const lakeAng = rnd() * Math.PI * 2;
  const lx = sx + Math.round(Math.cos(lakeAng) * 26), ly = sy + Math.round(Math.sin(lakeAng) * 26);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const dsp = Math.hypot(x - sx, y - sy);
      let e = fbm(x / 70, y / 70, seed, 5);
      // keep spawn dry
      if (dsp < 22) e = Math.max(e, 0.5 + (22 - dsp) * 0.01);
      // spawn lake blob
      const dl = Math.hypot(x - lx, y - ly) + (fbm(x / 6, y / 6, seed + 77, 2) - 0.5) * 7;
      if (dl < 7) e = Math.min(e, 0.2 - (7 - dl) * 0.02);
      // map edge falls off into water so the world feels bounded
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (edge < 12) e -= (12 - edge) * 0.05;
      const m = fbm(x / 45 + 100, y / 45 - 50, seed + 31, 4);
      let t;
      if (e < 0.24) t = T_DEEP;
      else if (e < 0.31) t = T_WATER;
      else if (e < 0.335) t = T_SAND;
      else if (m < 0.36) t = T_DIRT;
      else if (m < 0.47) t = T_DRYGRASS;
      else t = T_GRASS;
      terrain[i] = t;
    }
  }

  const land = i => terrain[i] < T_WATER;
  function patch(type, cx, cy, radius, richness, sseed) {
    const r = Math.ceil(radius * 1.4);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        const i = y * W + x;
        if (!land(i)) continue;
        const d = Math.hypot(x - cx, y - cy) / radius + (fbm(x / 5, y / 5, sseed, 3) - 0.5) * 0.9;
        if (d >= 1) continue;
        const k = (1 - d);
        const a = Math.floor(richness * (0.25 + 0.75 * k) * (0.75 + 0.5 * hash2(x, y, sseed)));
        if (a <= 0) continue;
        if (res[i] && res[i] !== type) continue;
        res[i] = type; amt[i] = Math.max(amt[i], a);
      }
    }
  }
  function oilField(cx, cy, count, sseed) {
    const r2 = mulberry32(sseed);
    let placed = 0, tries = 0;
    while (placed < count && tries++ < 200) {
      const x = cx + Math.round((r2() - 0.5) * 14), y = cy + Math.round((r2() - 0.5) * 14);
      if (x < 3 || y < 3 || x >= W - 3 || y >= H - 3) continue;
      let ok = true;
      for (let yy = y - 3; yy <= y + 3 && ok; yy++) for (let xx = x - 3; xx <= x + 3; xx++) {
        const j = yy * W + xx;
        if (res[j] === RES_INDEX['crude-oil'] || !land(j)) { ok = false; break; }
      }
      if (!ok) continue;
      const i = y * W + x;
      res[i] = RES_INDEX['crude-oil']; amt[i] = 60 + Math.floor(r2() * 25) * 10; // yield percent
      placed++;
    }
  }

  // starting patches around spawn, in four different directions
  const base = rnd() * Math.PI * 2;
  const starts = [['iron-ore', 11, 1100], ['copper-ore', 9, 1000], ['coal', 8, 900], ['stone', 6, 800]];
  starts.forEach(([name, rad, rich], k) => {
    const a = base + k * (Math.PI / 2) + (rnd() - 0.5) * 0.6;
    const dist = 17 + rnd() * 9;
    let cx = Math.round(sx + Math.cos(a) * dist), cy = Math.round(sy + Math.sin(a) * dist);
    // nudge off the spawn lake
    if (Math.hypot(cx - lx, cy - ly) < 14) { cx = Math.round(sx + Math.cos(a + 0.7) * dist); cy = Math.round(sy + Math.sin(a + 0.7) * dist); }
    patch(RES_INDEX[name], cx, cy, rad, rich, seed + 500 + k);
  });
  // first oil field at mid distance
  {
    const a = rnd() * Math.PI * 2;
    oilField(Math.round(sx + Math.cos(a) * 75), Math.round(sy + Math.sin(a) * 75), 7, seed + 900);
  }
  // scattered patches across the map, richer further out
  const kinds = ['iron-ore', 'iron-ore', 'copper-ore', 'copper-ore', 'coal', 'stone', 'crude-oil'];
  for (let n = 0; n < 70; n++) {
    const x = 14 + Math.floor(rnd() * (W - 28)), y = 14 + Math.floor(rnd() * (H - 28));
    const d = Math.hypot(x - sx, y - sy);
    if (d < 55) continue;
    const kind = kinds[Math.floor(rnd() * kinds.length)];
    if (kind === 'crude-oil') { oilField(x, y, 4 + Math.floor(rnd() * 5), seed + 1000 + n); continue; }
    const rich = Math.floor(1200 + d * 12 + rnd() * 1500);
    patch(RES_INDEX[kind], x, y, 7 + rnd() * 9, rich, seed + 2000 + n);
  }

  // trees and rocks
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const t = terrain[i];
      if (t >= T_SAND || res[i]) continue;
      if (Math.hypot(x - sx, y - sy) < 9) continue;
      const f = fbm(x / 28 + 300, y / 28 + 300, seed + 61, 4);
      const h = hash2(x, y, seed + 62);
      const dens = t === T_GRASS ? (f - 0.5) * 2.2 : t === T_DRYGRASS ? (f - 0.56) * 1.6 : (f - 0.62) * 1.2;
      if (dens > 0 && h < dens * 0.75) {
        decor[i] = t === T_DIRT && h < dens * 0.2 ? 9 + Math.floor(hash2(x, y, seed + 63) * 2) : 1 + Math.floor(hash2(x, y, seed + 64) * 8);
      } else if (h > 0.9975) {
        decor[i] = 11 + Math.floor(hash2(x, y, seed + 65) * 3);
      }
    }
  }
  return { terrain, res, amt, decor, spawn: { x: sx, y: sy } };
}
