// Builds src/jintori/japan.js: Japan cut into 10 km squares, each square belonging to one prefecture.
// Input: prefecture shapes as GeoJSON (Natural Earth 1:10m admin-1, public domain, filtered to Japan).
//   node tools/build-japan-grid.mjs <jp.geojson>
// Each feature needs properties.iso ("JP-01".."JP-47") and a Polygon / MultiPolygon geometry.
import { readFileSync, writeFileSync } from 'node:fs';

const KM = 10;            // square size
const SUB = 4;            // samples per side inside a square (2.5 km)
const MIN_SAMPLES = 3;    // a square is land when at least this many of its 16 samples are land
const LAT0 = 36;          // reference latitude of the flat projection
const KX = 111.32 * Math.cos(LAT0 * Math.PI / 180), KY = 110.57; // km per degree
const LON_MIN = 122, LAT_MAX = 46;

// prefecture names (ISO 3166-2 order) and the prefectural office used as the starting square
const PREFS = [
  ['北海道', 43.064, 141.347], ['青森県', 40.824, 140.740], ['岩手県', 39.704, 141.153], ['宮城県', 38.269, 140.872],
  ['秋田県', 39.719, 140.102], ['山形県', 38.240, 140.363], ['福島県', 37.750, 140.468], ['茨城県', 36.342, 140.447],
  ['栃木県', 36.566, 139.884], ['群馬県', 36.391, 139.061], ['埼玉県', 35.857, 139.649], ['千葉県', 35.605, 140.123],
  ['東京都', 35.690, 139.692], ['神奈川県', 35.448, 139.642], ['新潟県', 37.902, 139.023], ['富山県', 36.695, 137.211],
  ['石川県', 36.594, 136.626], ['福井県', 36.065, 136.222], ['山梨県', 35.664, 138.568], ['長野県', 36.651, 138.181],
  ['岐阜県', 35.391, 136.722], ['静岡県', 34.977, 138.383], ['愛知県', 35.180, 136.907], ['三重県', 34.730, 136.509],
  ['滋賀県', 35.005, 135.869], ['京都府', 35.021, 135.756], ['大阪府', 34.686, 135.520], ['兵庫県', 34.691, 135.183],
  ['奈良県', 34.685, 135.833], ['和歌山県', 34.226, 135.168], ['鳥取県', 35.504, 134.238], ['島根県', 35.472, 133.051],
  ['岡山県', 34.662, 133.935], ['広島県', 34.396, 132.459], ['山口県', 34.186, 131.471], ['徳島県', 34.066, 134.559],
  ['香川県', 34.340, 134.043], ['愛媛県', 33.842, 132.766], ['高知県', 33.560, 133.531], ['福岡県', 33.607, 130.418],
  ['佐賀県', 33.249, 130.299], ['長崎県', 32.745, 129.874], ['熊本県', 32.790, 130.742], ['大分県', 33.238, 131.613],
  ['宮崎県', 31.911, 131.424], ['鹿児島県', 31.560, 130.558], ['沖縄県', 26.212, 127.681],
];

const px = lon => (lon - LON_MIN) * KX;   // km east of LON_MIN
const py = lat => (LAT_MAX - lat) * KY;   // km south of LAT_MAX

const src = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const polys = []; // { pref, rings: [[[x,y],...]] } in km
for (const f of src.features) {
  const pref = parseInt(String(f.properties.iso).slice(3), 10);
  if (!(pref >= 1 && pref <= 47)) throw new Error('bad iso ' + f.properties.iso);
  const g = f.geometry;
  const list = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of list) polys.push({ pref, rings: p.map(r => r.map(([lon, lat]) => [px(lon), py(lat)])) });
}

let maxX = 0, maxY = 0;
for (const p of polys) for (const r of p.rings) for (const [x, y] of r) { maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
const COLS = Math.ceil(maxX / KM) + 1, ROWS = Math.ceil(maxY / KM) + 1;
const SW = COLS * SUB, SH = ROWS * SUB, STEP = KM / SUB;
const sample = new Uint8Array(SW * SH); // prefecture of each sample point (0 = sea)

// scanline fill, even-odd over all rings of a polygon (so holes stay empty)
for (const p of polys) {
  let y0 = Infinity, y1 = -Infinity;
  for (const r of p.rings) for (const [, y] of r) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  for (let sy = Math.max(0, Math.floor(y0 / STEP)); sy <= Math.min(SH - 1, Math.ceil(y1 / STEP)); sy++) {
    const y = (sy + 0.5) * STEP;
    const xs = [];
    for (const r of p.rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xa, ya] = r[i], [xb, yb] = r[j];
        if ((ya > y) !== (yb > y)) xs.push(xa + (y - ya) * (xb - xa) / (yb - ya));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] / STEP - 0.5)), b = Math.min(SW - 1, Math.floor(xs[k + 1] / STEP - 0.5));
      for (let sx = a; sx <= b; sx++) sample[sy * SW + sx] = p.pref;
    }
  }
}

// squares: majority prefecture among their land samples
const cellPref = new Uint8Array(COLS * ROWS);
for (let cy = 0; cy < ROWS; cy++) for (let cx = 0; cx < COLS; cx++) {
  const cnt = new Map();
  let land = 0;
  for (let j = 0; j < SUB; j++) for (let i = 0; i < SUB; i++) {
    const v = sample[(cy * SUB + j) * SW + cx * SUB + i];
    if (v) { land++; cnt.set(v, (cnt.get(v) || 0) + 1); }
  }
  if (land >= MIN_SAMPLES) cellPref[cy * COLS + cx] = [...cnt.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}
// small islands that got no square of their own get the square under their middle
for (const p of polys) {
  const r = p.rings[0];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  let has = false;
  for (let cy = Math.floor(y0 / KM); cy <= Math.floor(y1 / KM) && !has; cy++) for (let cx = Math.floor(x0 / KM); cx <= Math.floor(x1 / KM); cx++) {
    if (cellPref[cy * COLS + cx] === p.pref) { has = true; break; }
  }
  if (has) continue;
  const c = Math.floor((y0 + y1) / 2 / KM) * COLS + Math.floor((x0 + x1) / 2 / KM);
  if (!cellPref[c]) cellPref[c] = p.pref;
}

// every prefecture's office square must belong to it
const cells = [];
const at = new Int32Array(COLS * ROWS).fill(-1);
for (let i = 0; i < COLS * ROWS; i++) if (cellPref[i]) { at[i] = cells.length; cells.push([i % COLS, Math.floor(i / COLS), cellPref[i]]); }
const capitals = PREFS.map(([, lat, lon], k) => {
  const pref = k + 1, x = px(lon) / KM, y = py(lat) / KM;
  let best = -1, bd = Infinity;
  cells.forEach(([cx, cy, p], i) => {
    if (p !== pref) return;
    const d = (cx + 0.5 - x) ** 2 + (cy + 0.5 - y) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  if (best < 0) throw new Error('no square for ' + PREFS[k][0]);
  return best;
});

// islands: link every group of touching squares to the rest by the shortest sea crossing (a spanning tree)
const comp = new Int32Array(cells.length).fill(-1);
let nComp = 0;
for (let s = 0; s < cells.length; s++) {
  if (comp[s] >= 0) continue;
  const stack = [s]; comp[s] = nComp;
  while (stack.length) {
    const c = stack.pop(), [cx, cy] = cells[c];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
      const n = at[y * COLS + x];
      if (n >= 0 && comp[n] < 0) { comp[n] = nComp; stack.push(n); }
    }
  }
  nComp++;
}
const pairBest = new Map(); // "a,b" -> [d, i, j]
for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
  const a = comp[i], b = comp[j];
  if (a === b) continue;
  const d = (cells[i][0] - cells[j][0]) ** 2 + (cells[i][1] - cells[j][1]) ** 2;
  const k = a < b ? a + ',' + b : b + ',' + a;
  const cur = pairBest.get(k);
  if (!cur || d < cur[0]) pairBest.set(k, [d, i, j]);
}
const parent = Array.from({ length: nComp }, (_, i) => i);
const find = x => (parent[x] === x ? x : (parent[x] = find(parent[x])));
const bridges = [];
for (const [d, i, j] of [...pairBest.values()].sort((a, b) => a[0] - b[0])) {
  const a = find(comp[i]), b = find(comp[j]);
  if (a === b) continue;
  parent[a] = b;
  bridges.push([i, j, Math.round(Math.sqrt(d) * KM)]);
}

// 47 colours that stay apart: golden-angle hues, three lightness bands
const colors = PREFS.map((_, k) => {
  const h = (k * 137.508) % 360, l = [52, 62, 44][k % 3], s = [62, 55, 58][k % 3];
  return `hsl(${h.toFixed(0)},${s}%,${l}%)`;
});

const prefs = PREFS.map(([name], k) => ({ name, short: name === '北海道' ? name : name.slice(0, -1), color: colors[k], capital: capitals[k] }));
const count = new Array(48).fill(0);
for (const c of cells) count[c[2]]++;
const out = `// Generated by tools/build-japan-grid.mjs from Natural Earth 1:10m admin-1 (public domain). Do not edit by hand.
// Japan cut into ${KM} km squares on a flat projection (reference latitude ${LAT0}°). ${cells.length} squares.
export const GRID = { km: ${KM}, cols: ${COLS}, rows: ${ROWS}, lonMin: ${LON_MIN}, latMax: ${LAT_MAX}, kx: ${KX.toFixed(4)}, ky: ${KY} };
// prefecture 1..47 (index 0 unused): name, short name, colour, starting square
export const PREFS = [null,
${prefs.map(p => '  ' + JSON.stringify(p)).join(',\n')},
];
// squares: flat [col, row, prefecture] triples
export const CELLS = ${JSON.stringify(cells.flat())};
// sea crossings that join islands to the rest: [square, square, km]
export const BRIDGES = ${JSON.stringify(bridges)};
`;
writeFileSync(new URL('../src/jintori/japan.js', import.meta.url), out);
console.log(`grid ${COLS}x${ROWS}, ${cells.length} squares, ${nComp} island groups, ${bridges.length} crossings`);
console.log('squares per prefecture:', prefs.map((p, k) => `${p.short}${count[k + 1]}`).join(' '));
