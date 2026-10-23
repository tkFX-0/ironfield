// The big world: one world cut into 47 plots, one per prefecture (docs/陣取り設計.md, chapter 9).
// Every plot is the same size and they sit on a tile map shaped like Japan (north-east at the top right).
// Each plot runs on its own as an open room (net/session.js plotRoom), so plots never share buildings.

import { MAP_W } from './data.js';

// [prefecture 1..47, column, row]
const LAYOUT = [
  [1, 13, 0],
  [2, 12, 1],
  [5, 11, 2], [3, 12, 2],
  [6, 11, 3], [4, 12, 3],
  [17, 8, 4], [16, 9, 4], [15, 10, 4], [7, 11, 4],
  [32, 3, 5], [31, 4, 5], [28, 5, 5], [26, 6, 5], [25, 7, 5], [18, 8, 5], [21, 9, 5], [20, 10, 5], [10, 11, 5], [9, 12, 5],
  [40, 1, 6], [35, 2, 6], [34, 3, 6], [33, 4, 6], [27, 5, 6], [29, 6, 6], [24, 7, 6], [23, 8, 6], [22, 9, 6], [19, 10, 6], [11, 11, 6], [8, 12, 6],
  [42, 0, 7], [41, 1, 7], [38, 3, 7], [37, 4, 7], [30, 6, 7], [14, 10, 7], [13, 11, 7], [12, 12, 7],
  [43, 1, 8], [44, 2, 8], [39, 3, 8], [36, 4, 8],
  [46, 1, 9], [45, 2, 9],
  [47, 0, 10],
];
export const PLOT_COLS = 14, PLOT_ROWS = 11;
export const PLOT_AT = new Map(LAYOUT.map(([p, c, r]) => [p, { c, r }]));

// the plot's own seed: where its ores and oil lie
export const plotSeed = p => (20261023 + p * 7919) | 0;

// Plots are MAP_W tiles square and touch each other, so a tile of the big world is (column * MAP_W + x, row * MAP_W + y).
const S = MAP_W;
const AT = new Map(LAYOUT.map(([p, c, r]) => [r * PLOT_COLS + c, p]));
export const plotAtCell = (c, r) => (c >= 0 && r >= 0 && c < PLOT_COLS && r < PLOT_ROWS ? AT.get(r * PLOT_COLS + c) || 0 : 0);

// distance from a tile of the big world to the nearest open sea (a cell with no plot)
export function coastDist(gx, gy) {
  const c = Math.floor(gx / S), r = Math.floor(gy / S);
  let d = Infinity;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (plotAtCell(c + dc, r + dr)) continue;
    const x0 = (c + dc) * S, y0 = (r + dr) * S;
    d = Math.min(d, Math.hypot(Math.max(x0 - gx, 0, gx - (x0 + S - 1)), Math.max(y0 - gy, 0, gy - (y0 + S - 1))));
  }
  return d;
}

// Each prefecture's climate: how snowy (0..1) and how southern (0..1, wide beaches, palms, turquoise sea).
// Prefectures not listed are temperate (0, 0).
const CLIMATE = {
  1: [1, 0], 2: [0.85, 0], 5: [0.75, 0], 3: [0.6, 0], 6: [0.65, 0], 15: [0.6, 0], 16: [0.5, 0], 20: [0.5, 0],
  17: [0.4, 0], 18: [0.35, 0], 7: [0.35, 0], 4: [0.25, 0], 21: [0.25, 0], 10: [0.2, 0],
  47: [0, 1], 46: [0, 0.5], 45: [0, 0.4], 39: [0, 0.3], 43: [0, 0.15],
};
const CLIM_BLEND = 96; // tiles over which two plots' climates run into each other at their border
const NO_CLIMATE = [0, 0];

// [snow, warm] at a tile of the big world. Every plot within CLIM_BLEND tiles counts, more the closer it is,
// so the climate changes smoothly across plot borders (and the open sea takes the climate of the land near it).
export function climateAt(gx, gy) {
  const c = Math.floor(gx / S), r = Math.floor(gy / S);
  let wsum = 0, snow = 0, warm = 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    const p = plotAtCell(c + dc, r + dr);
    if (!p) continue;
    const x0 = (c + dc) * S, y0 = (r + dr) * S;
    const kx = 1 - Math.max(x0 - gx, 0, gx - (x0 + S - 1)) / CLIM_BLEND, ky = 1 - Math.max(y0 - gy, 0, gy - (y0 + S - 1)) / CLIM_BLEND;
    if (kx <= 0 || ky <= 0) continue;
    const w = kx * ky, cl = CLIMATE[p] || NO_CLIMATE;
    wsum += w; snow += w * cl[0]; warm += w * cl[1];
  }
  return wsum ? [snow / wsum, warm / wsum] : NO_CLIMATE;
}

// where plot p sits, for generateWorld
export function plotPlace(p) {
  const { c, r } = PLOT_AT.get(p);
  return { gx: c * S, gy: r * S, coast: coastDist, climate: climateAt };
}
