// Slot inventories: arrays whose entries are null or [itemName, count].
import { ITEMS } from '../data.js';

export const stackOf = item => (ITEMS[item] ? ITEMS[item].stack : 50);

export function invCount(inv, item) {
  let n = 0;
  for (const s of inv) if (s && s[0] === item) n += s[1];
  return n;
}

export function invSpace(inv, item) {
  const st = stackOf(item);
  let n = 0;
  for (const s of inv) {
    if (!s) n += st;
    else if (s[0] === item) n += st - s[1];
  }
  return n;
}

// returns number actually added
export function invAdd(inv, item, n) {
  if (n <= 0) return 0;
  const st = stackOf(item);
  let left = n;
  for (const s of inv) {
    if (left <= 0) break;
    if (s && s[0] === item && s[1] < st) {
      const k = Math.min(st - s[1], left);
      s[1] += k; left -= k;
    }
  }
  for (let i = 0; i < inv.length && left > 0; i++) {
    if (!inv[i]) {
      const k = Math.min(st, left);
      inv[i] = [item, k]; left -= k;
    }
  }
  return n - left;
}

// removes from the last slots first; returns number removed
export function invRemove(inv, item, n) {
  let left = n;
  for (let i = inv.length - 1; i >= 0 && left > 0; i--) {
    const s = inv[i];
    if (s && s[0] === item) {
      const k = Math.min(s[1], left);
      s[1] -= k; left -= k;
      if (s[1] === 0) inv[i] = null;
    }
  }
  return n - left;
}

// can all [item, n] pairs be added (counting stacking between them)?
export function invCanFit(inv, pairs) {
  const copy = inv.map(s => (s ? [s[0], s[1]] : null));
  for (const [item, n] of pairs) if (invAdd(copy, item, n) < n) return false;
  return true;
}

export function invSort(inv) {
  const totals = new Map();
  for (const s of inv) if (s) totals.set(s[0], (totals.get(s[0]) || 0) + s[1]);
  const names = [...totals.keys()].sort((a, b) => (ITEMS[a]?.order ?? 999) - (ITEMS[b]?.order ?? 999));
  inv.fill(null);
  for (const nm of names) invAdd(inv, nm, totals.get(nm));
}

export function newInv(n) { return new Array(n).fill(null); }

// map-style counters {item: n}
export function mapAdd(m, item, n) { m[item] = (m[item] || 0) + n; }
export function mapTake(m, item, n) {
  const k = Math.min(m[item] || 0, n);
  if (k) { m[item] -= k; if (m[item] === 0) delete m[item]; }
  return k;
}
