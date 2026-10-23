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

// where plot p sits, for generateWorld
export function plotPlace(p) {
  const { c, r } = PLOT_AT.get(p);
  return { gx: c * S, gy: r * S, coast: coastDist };
}
