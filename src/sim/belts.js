// Transport belts: per-tile lanes, items keep integer positions 0..len along the lane.
// "pieces" are belts, underground belts, and the two halves of each splitter.
// Lane 0 = left of travel direction, lane 1 = right. Updated downstream-first so lines stay compressed.
import { DX, DY } from '../data.js';

export const LANE = 256;
export const SP = 64;          // minimum spacing between items on a lane (4 per lane per tile)
const END = LANE - SP / 2;      // where items stop at a dead end

// tiles of a splitter's halves: [left, right] relative to travel direction
export function splitterTiles(e) {
  const { x, y, dir } = e;
  switch (dir) {
    case 0: return [[x, y], [x + 1, y]];
    case 1: return [[x, y], [x, y + 1]];
    case 2: return [[x + 1, y], [x, y]];
    default: return [[x, y + 1], [x, y]];
  }
}

export function pieceAt(g, x, y) {
  const e = g.entAt(x, y);
  if (!e) return null;
  if (e._kind === 'belt' || e._kind === 'underground') return e;
  if (e._kind === 'splitter') {
    const t = splitterTiles(e);
    return (t[0][0] === x && t[0][1] === y) ? e.halves[0] : e.halves[1];
  }
  return null;
}

// does piece p output above ground into tile (x,y)?
function feeds(p, x, y) {
  if (!p) return false;
  const e = p._ent || p;
  if (e._kind === 'underground' && e.ut === 'in') return false;
  return p.x + DX[e.dir] === x && p.y + DY[e.dir] === y;
}

function resolveNext(g, p, dir) {
  const tx = p.x + DX[dir], ty = p.y + DY[dir];
  const t = g.entAt(tx, ty);
  if (!t) return null;
  if (t._kind === 'belt') {
    if (t.dir === dir) return { p: t, side: -1 };
    if (t.dir === (dir + 2) % 4) return null;
    const fromLeft = (dir + 2) % 4 === (t.dir + 3) % 4; // p sits on t's left side
    if ((fromLeft && t._shape === 1) || (!fromLeft && t._shape === 2)) return { p: t, side: -1 };
    return { p: t, side: fromLeft ? 0 : 1 };
  }
  if (t._kind === 'underground') {
    if (t.dir === dir) return t.ut === 'in' ? { p: t, side: -1 } : null;
    if (t.dir === (dir + 2) % 4) return null;
    const fromLeft = (dir + 2) % 4 === (t.dir + 3) % 4;
    return { p: t, side: fromLeft ? 0 : 1 };
  }
  if (t._kind === 'splitter' && t.dir === dir) {
    const tiles = splitterTiles(t);
    return { p: (tiles[0][0] === tx && tiles[0][1] === ty) ? t.halves[0] : t.halves[1], side: -1 };
  }
  return null;
}

export function rebuildBelts(g) {
  const belts = g.lists.belt, ugs = g.lists.underground, sps = g.lists.splitter;
  // splitter halves need positions and back references
  for (const e of sps) {
    const t = splitterTiles(e);
    for (let k = 0; k < 2; k++) {
      const h = e.halves[k];
      h.x = t[k][0]; h.y = t[k][1]; h._ent = e; h._len = LANE; h.speed = e._proto.speed;
    }
  }
  // underground pairing
  for (const e of ugs) { e._partner = null; e._len = LANE; e.speed = e._proto.speed; }
  for (const e of ugs) {
    if (e.ut !== 'in') continue;
    const reach = e._proto.reach;
    for (let k = 1; k <= reach; k++) {
      const o = g.entAt(e.x + DX[e.dir] * k, e.y + DY[e.dir] * k);
      if (!o || o._kind !== 'underground' || o.name !== e.name || o.dir !== e.dir) continue;
      if (o.ut === 'in') break;
      if (o._partner) break;
      e._partner = o; o._partner = e;
      e._len = LANE * k;
      break;
    }
  }
  // belt shapes: 0 straight, 1 curve fed from the left, 2 curve fed from the right
  for (const e of belts) {
    e._len = LANE; e.speed = e._proto.speed;
    const d = e.dir;
    const behind = pieceAt(g, e.x - DX[d], e.y - DY[d]);
    let shape = 0;
    if (!feeds(behind, e.x, e.y)) {
      const ld = (d + 3) % 4, rd = (d + 1) % 4;
      const L = feeds(pieceAt(g, e.x + DX[ld], e.y + DY[ld]), e.x, e.y);
      const R = feeds(pieceAt(g, e.x + DX[rd], e.y + DY[rd]), e.x, e.y);
      if (L && !R) shape = 1; else if (R && !L) shape = 2;
    }
    e._shape = shape;
  }
  // next links
  const pieces = [];
  for (const e of belts) { e._next = resolveNext(g, e, e.dir); pieces.push(e); }
  for (const e of ugs) {
    if (e.ut === 'in') e._next = e._partner ? { p: e._partner, side: -1 } : null;
    else e._next = resolveNext(g, e, e.dir);
    pieces.push(e);
  }
  for (const e of sps) {
    const outs = [resolveNext(g, e.halves[0], e.dir), resolveNext(g, e.halves[1], e.dir)];
    for (const o of outs) if (o && o.side !== -1) outs[outs.indexOf(o)] = null; // splitters only output straight
    for (const h of e.halves) { h._outs = outs; h._next = null; pieces.push(h); }
  }
  // downstream-first order (post-order DFS); entity id order keeps it deterministic
  pieces.sort((a, b) => ((a._ent || a).id - (b._ent || b).id) || ((a._ent ? a._ent.halves.indexOf(a) : 0) - (b._ent ? b._ent.halves.indexOf(b) : 0)));
  const seen = new Set();
  const order = [];
  const stack = [];
  for (const root of pieces) {
    if (seen.has(root)) continue;
    stack.push([root, 0]); seen.add(root);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const p = top[0];
      const outs = p._outs ? p._outs : (p._next ? [p._next] : []);
      if (top[1] < outs.length) {
        const o = outs[top[1]++];
        if (o && !seen.has(o.p)) { seen.add(o.p); stack.push([o.p, 0]); }
      } else {
        order.push(p);
        stack.pop();
      }
    }
  }
  g._beltOrder = order;
}

// insert an item into a lane at pos if the gap allows
export function laneInsert(p, lane, item, pos) {
  const items = p.lanes[lane];
  if (pos >= p._len) pos = p._len - 1;
  let at = items.length;
  for (let k = 0; k < items.length; k++) {
    const d = items[k].p - pos;
    if (d < SP && d > -SP) return false;
    if (items[k].p < pos && at === items.length) at = k;
  }
  items.splice(at, 0, { i: item, p: pos });
  return true;
}
export function laneCanInsert(p, lane, pos) {
  const items = p.lanes[lane];
  if (pos >= p._len) pos = p._len - 1;
  for (const it of items) { const d = it.p - pos; if (d < SP && d > -SP) return false; }
  return true;
}

function passStraight(t, lane, item, entry) {
  const items = t.lanes[lane];
  if (items.length && entry > items[items.length - 1].p - SP) return false;
  if (entry >= t._len) entry = t._len - 1;
  items.push({ i: item.i, p: entry });
  return true;
}

function tailLimit(t, lane, L) {
  const items = t.lanes[lane];
  return items.length ? items[items.length - 1].p + L - SP : Infinity;
}

function moveLane(p, li) {
  const items = p.lanes[li];
  if (!items.length) return;
  const L = p._len, sp = p.speed;
  const front = items[0];
  const np = front.p + sp;
  let ahead;
  if (p._outs) {
    // splitter half: alternate between the two outputs per lane
    const ent = p._ent;
    let moved = false;
    if (np >= L) {
      const pref = ent.tog[li];
      for (let k = 0; k < 2 && !moved; k++) {
        const idx = (pref + k) & 1, o = p._outs[idx];
        if (o && passStraight(o.p, li, front, np - L)) { moved = true; ent.tog[li] = idx ^ 1; ahead = np - L + L; }
      }
    }
    if (moved) items.shift();
    else {
      let lim = END;
      const a = p._outs[0], b = p._outs[1];
      if (a || b) lim = Math.max(a ? tailLimit(a.p, li, L) : -1, b ? tailLimit(b.p, li, L) : -1);
      if (lim > L - 1) lim = L - 1;
      if (np < lim) front.p = np; else if (lim > front.p) front.p = lim;
      ahead = front.p;
    }
  } else {
    const nx = p._next;
    if (!nx) {
      const lim = END;
      if (np < lim) front.p = np; else if (lim > front.p) front.p = lim;
      ahead = front.p;
    } else if (nx.side === -1) {
      const lim = tailLimit(nx.p, li, L);
      if (np >= L && np <= lim) {
        passStraight(nx.p, li, front, np - L);
        items.shift();
        ahead = np;
      } else {
        const cap = Math.min(lim, L - 1);
        if (np < cap) front.p = np; else if (cap > front.p) front.p = cap;
        ahead = front.p;
      }
    } else {
      // side-load: items enter the middle of the target's near lane
      if (np >= END && laneInsert(nx.p, nx.side, front.i, nx.p._len >> 1)) {
        items.shift();
        ahead = L + SP / 2;
      } else {
        if (np < END) front.p = np; else if (END > front.p) front.p = END;
        ahead = front.p;
      }
    }
  }
  // the rest follow with spacing
  const start = items[0] === front ? 1 : 0;
  for (let k = start; k < items.length; k++) {
    const it = items[k];
    let lim = ahead - SP;
    if (lim > L - 1) lim = L - 1;
    const q = it.p + sp;
    if (q < lim) it.p = q; else if (lim > it.p) it.p = lim;
    ahead = it.p;
  }
}

export function updateBelts(g) {
  const order = g._beltOrder;
  for (let k = 0; k < order.length; k++) {
    const p = order[k];
    moveLane(p, 0);
    moveLane(p, 1);
  }
}

// take one item from a piece (for inserters): highest position first, both lanes
export function pieceTake(p, accept) {
  let best = null, bl = -1, bk = -1;
  for (let l = 0; l < 2; l++) {
    const items = p.lanes[l];
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (accept(it.i) <= 0) continue;
      if (!best || it.p > best.p) { best = it; bl = l; bk = k; }
      break; // within a lane the front-most acceptable item is enough
    }
  }
  if (!best) return null;
  p.lanes[bl].splice(bk, 1);
  return best.i;
}

export function pieceItems(p) {
  const out = [];
  for (const l of p.lanes) for (const it of l) out.push(it.i);
  return out;
}
