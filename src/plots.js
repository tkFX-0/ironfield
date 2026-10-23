// The big world: one world cut into 47 plots, one per prefecture (docs/陣取り設計.md, chapter 9).
// Every plot is the same size and they sit on a tile map shaped like Japan (north-east at the top right).
// Each plot runs on its own as an open room (net/session.js plotRoom), so plots never share buildings.

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

// the plot's own seed, so every prefecture gets a different landscape
export const plotSeed = p => (20261023 + p * 7919) | 0;
