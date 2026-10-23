// Prefecture territory battle: the rules, with no storage or screen code so they can be tested in node.
// Design: docs/陣取り設計.md. All numbers are first drafts meant to be tuned by playing.
import { GRID, PREFS, CELLS, BRIDGES } from './japan.js';

export const DAILY_FLAGS = 3;          // flags you may use per day
export const CARRY_DAYS = 2;           // unused flags carry over for this many days
export const MAX_ALLOW = DAILY_FLAGS * (1 + CARRY_DAYS);
export const MAX_DEF = 5;              // defence a square can be raised to
export const RESET_HOUR_JST = 5;       // the day turns over at 05:00 Japan time
export const N = CELLS.length / 3;

const DAY_MS = 86400000;
const SHIFT_MS = (9 - RESET_HOUR_JST) * 3600000; // JST is UTC+9; the game day starts 5 hours into it

// ------------------------------------------------------------------ calendar
export function dayIndex(now) { return Math.floor((now + SHIFT_MS) / DAY_MS); }
// the month (season) a game day belongs to, e.g. "2026-10"
export function seasonOf(day) { return new Date(day * DAY_MS).toISOString().slice(0, 7); }
export function seasonStartDay(day) {
  const d = new Date(day * DAY_MS);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / DAY_MS);
}
export function nextResetAt(now) { return (dayIndex(now) + 1) * DAY_MS - SHIFT_MS; }

// ------------------------------------------------------------------ the squares
export const cellX = i => CELLS[i * 3];
export const cellY = i => CELLS[i * 3 + 1];
export const cellHome = i => CELLS[i * 3 + 2]; // prefecture the square lies in
const CAPITAL = new Map(PREFS.slice(1).map((p, k) => [p.capital, k + 1]));
export const capitalOf = i => CAPITAL.get(i) || 0; // prefecture whose office is on this square

// neighbours: the 8 touching squares, plus sea crossings to islands
export const NEIGH = (() => {
  const at = new Map();
  for (let i = 0; i < N; i++) at.set(cellY(i) * GRID.cols + cellX(i), i);
  const nb = Array.from({ length: N }, () => []);
  for (let i = 0; i < N; i++) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const j = at.get((cellY(i) + dy) * GRID.cols + cellX(i) + dx);
      if (j !== undefined && cellX(j) - cellX(i) === dx) nb[i].push(j);
    }
  }
  for (const [a, b] of BRIDGES) { nb[a].push(b); nb[b].push(a); }
  return nb;
})();

// ------------------------------------------------------------------ your flags for the day
// allow = flags you may still use. Each new day adds DAILY_FLAGS, up to MAX_ALLOW.
export function newWallet(day) { return { day, allow: DAILY_FLAGS, used: 0, streak: 0, lastDay: -1 }; }
export function refillWallet(w, day) {
  if (day > w.day) {
    w.allow = Math.min(MAX_ALLOW, w.allow + DAILY_FLAGS * (day - w.day));
    w.day = day;
  }
  return w;
}
// called once a flag has been used: counts it and keeps the "days in a row" record
export function spendWallet(w, day) {
  w.allow--; w.used++;
  if (w.lastDay !== day) { w.streak = w.lastDay === day - 1 ? w.streak + 1 : 1; w.lastDay = day; }
}

// ------------------------------------------------------------------ the map of one season
// a fresh map for the season that `day` belongs to; m.day = last day already played out
export function newMap(day) {
  const m = { season: seasonOf(day), day: seasonStartDay(day) - 1, owner: new Uint8Array(N), def: new Uint8Array(N) };
  for (let p = 1; p <= 47; p++) { m.owner[PREFS[p].capital] = p; m.def[PREFS[p].capital] = MAX_DEF; }
  return m;
}

// what one flag from prefecture `pref` would do on square `i`:
//   'take' (nobody's), 'attack' (another prefecture's), 'defend' (ours), or null with a reason
export function flagAction(m, pref, i) {
  if (!(pref >= 1 && pref <= 47) || !(i >= 0 && i < N)) return { kind: null, why: 'ここには使えません' };
  const o = m.owner[i];
  if (o === pref) {
    if (capitalOf(i)) return { kind: null, why: '県庁のマスは最初から一番かたい守りです' };
    if (m.def[i] >= MAX_DEF) return { kind: null, why: '守りはもう一番上です' };
    return { kind: 'defend' };
  }
  if (capitalOf(i)) return { kind: null, why: '県庁のマスは取られません' };
  if (!NEIGH[i].some(j => m.owner[j] === pref)) return { kind: null, why: '自分の県のマスのとなりだけ取れます' };
  return { kind: o ? 'attack' : 'take' };
}

// uses one flag. Attacking first wears the defence down by one; at zero the square changes hands.
export function useFlag(m, pref, i) {
  const a = flagAction(m, pref, i);
  if (!a.kind) return a;
  if (a.kind === 'defend') m.def[i]++;
  else if (a.kind === 'attack' && m.def[i] > 0) { m.def[i]--; return { kind: 'attack', captured: false, def: m.def[i] }; }
  else { m.owner[i] = pref; m.def[i] = 0; }
  return { kind: a.kind, captured: a.kind !== 'defend', def: m.def[i] };
}

export function counts(m) {
  const c = new Array(48).fill(0);
  for (let i = 0; i < N; i++) if (m.owner[i]) c[m.owner[i]]++;
  return c;
}
export function ranking(m) {
  const c = counts(m);
  return PREFS.slice(1).map((p, k) => ({ pref: k + 1, n: c[k + 1] })).sort((a, b) => b.n - a.n || a.pref - b.pref);
}

// ------------------------------------------------------------------ stand-in for everybody else
// Until the server exists, every prefecture's other players are imitated: each day each prefecture
// uses DAILY_FLAGS flags, mostly on empty squares next to it, sometimes attacking or defending.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function simulateDay(m, day) {
  const R = rng(day * 7919 + 17);
  const order = Array.from({ length: 47 }, (_, k) => k + 1);
  for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(R() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
  for (const p of order) {
    // where this prefecture could put a flag today (worked out once; good enough for three flags)
    const empty = [], home = [], enemy = [], mine = [];
    for (let i = 0; i < N; i++) {
      const o = m.owner[i];
      if (o === p) { if (!capitalOf(i) && m.def[i] < 2 && NEIGH[i].some(j => m.owner[j] && m.owner[j] !== p)) mine.push(i); continue; }
      if (capitalOf(i) || !NEIGH[i].some(j => m.owner[j] === p)) continue;
      // squares inside its own prefecture first, so the map grows into recognisable shapes
      if (o) enemy.push(i); else (cellHome(i) === p ? home : empty).push(i);
    }
    // nearest to its office first (with a little noise), so territories grow as compact blobs
    const c = PREFS[p].capital, near = new Map();
    for (const a of [empty, home, enemy, mine]) {
      for (const i of a) near.set(i, Math.hypot(cellX(i) - cellX(c), cellY(i) - cellY(c)) + R() * 3);
      a.sort((x, y) => near.get(x) - near.get(y));
    }
    const take = a => a.shift();
    for (let f = 0; f < DAILY_FLAGS; f++) {
      const r = R();
      let i;
      if (r < 0.75 && (home.length || empty.length)) i = take(home.length ? home : empty);
      else if (r < 0.9 && enemy.length) i = enemy[0];
      else if (mine.length) i = take(mine);
      else if (home.length || empty.length) i = take(home.length ? home : empty);
      else if (enemy.length) i = enemy[0];
      if (i !== undefined) useFlag(m, p, i);
    }
  }
  m.day = day;
}
// brings the imitated players up to `day` (they act at the start of each day)
export function catchUp(m, day) {
  const from = Math.max(m.day + 1, seasonStartDay(day));
  for (let d = from; d <= day; d++) simulateDay(m, d);
  m.day = Math.max(m.day, day);
}
