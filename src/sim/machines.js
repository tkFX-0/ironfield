// Machine behaviour: inserters, drills, furnaces, assemblers (incl. chemical plant / refinery / silo), labs,
// boilers, pumps. All integer math. Progress units: 1 craft at speed 1000 for t seconds = t*60*1000.
import { ITEMS, RECIPES, TECHS, DX, DY, ROCKET_PARTS } from '../data.js';
import { stackOf, invAdd, invSpace, mapAdd } from './inventory.js';
import { pieceAt, pieceTake, laneInsert, laneCanInsert } from './belts.js';
import { rotPoint, netTake, netPut, netSpace, netHas } from './networks.js';

const fuelValue = item => (ITEMS[item] && ITEMS[item].fuel) || 0;
export const isFuel = item => fuelValue(item) > 0;
const SCI = new Set(['automation-science-pack', 'logistic-science-pack', 'chemical-science-pack']);

// ------------------------------------------------------------ smelting lookup
const SMELT = {};
for (const r of Object.values(RECIPES)) if (r.cat === 'smelting') SMELT[r.ing[0][0]] = r;
export function smeltRecipe(g, item) {
  const r = SMELT[item];
  return r && g.recipeEnabled(r.name) ? r : null;
}

// ------------------------------------------------------------ burner energy
function burn(e, need) {
  if (e.en >= need) { e.en -= need; return true; }
  if (e.fuel && e.fuel[1] > 0) {
    e.en += fuelValue(e.fuel[0]);
    e.fuel[1]--;
    if (e.fuel[1] === 0) e.fuel = null;
    if (e.en >= need) { e.en -= need; return true; }
  }
  return false;
}
const hasEnergy = (e, need) => e.en >= need || (e.fuel && e.fuel[1] > 0);

// ------------------------------------------------------------ crafting machine helpers
function ingLimit(rec, n) {
  const ticks = rec.time * 60;
  return ticks < 60 ? n * 3 : n * 2;
}

// how many of `item` this entity accepts automatically (inserters / drills)
export function accepts(g, e, item) {
  switch (e._kind) {
    case 'chest': return invSpace(e.inv, item);
    case 'furnace': {
      if (isFuel(item) && e._proto.burner) {
        if (e.fuel && e.fuel[0] !== item) return 0;
        return Math.max(0, 5 - (e.fuel ? e.fuel[1] : 0));
      }
      const r = smeltRecipe(g, item);
      if (!r) return 0;
      if (e.src && e.src[0] !== item) return 0;
      if (!e.src && e.act && e.rec !== r.name && e.out) return 0;
      const lim = Math.max(10, r.ing[0][1] * 2);
      return Math.max(0, lim - (e.src ? e.src[1] : 0));
    }
    case 'assembler': case 'silo': {
      const rec = e._rec;
      if (!rec) return 0;
      for (const [it, n] of rec.ing) if (it === item) return Math.max(0, ingLimit(rec, n) - (e.inv[item] || 0));
      return 0;
    }
    case 'lab': return SCI.has(item) ? Math.max(0, 4 - (e.inv[item] || 0)) : 0;
    case 'boiler': case 'drill': case 'inserter':
      if (!e._proto.burner || !isFuel(item)) return 0;
      if (e.fuel && e.fuel[0] !== item) return 0;
      return Math.max(0, 5 - (e.fuel ? e.fuel[1] : 0));
    default: return 0;
  }
}

// insert up to n items; returns inserted count
export function insertInto(g, e, item, n) {
  const k = Math.min(n, accepts(g, e, item));
  if (k <= 0) return 0;
  switch (e._kind) {
    case 'chest': return invAdd(e.inv, item, k);
    case 'furnace':
      if (isFuel(item) && e._proto.burner) { e.fuel = e.fuel ? [item, e.fuel[1] + k] : [item, k]; return k; }
      e.src = e.src ? [item, e.src[1] + k] : [item, k]; return k;
    case 'assembler': case 'silo': case 'lab': mapAdd(e.inv, item, k); return k;
    default: e.fuel = e.fuel ? [item, e.fuel[1] + k] : [item, k]; return k;
  }
}

// drop onto a belt piece lane at the middle
function dropOnPiece(p, lane, item) {
  return laneInsert(p, lane, item, p._len >> 1);
}

// output of an entity at tile (x,y) coming from direction `fromDir` (direction of travel)
function outputTo(g, x, y, fromDir, item, n, laneHint) {
  const p = pieceAt(g, x, y);
  if (p) {
    let done = 0;
    while (done < n && dropOnPiece(p, laneHint(p), item)) done++;
    return done;
  }
  const t = g.entAt(x, y);
  if (!t) return 0;
  return insertInto(g, t, item, n);
}

// lane of a piece nearest to an object located on side `side` (direction from the piece to the object)
function nearLane(p, side) {
  const d = (p._ent || p).dir;
  if (side === (d + 3) % 4) return 0;
  if (side === (d + 1) % 4) return 1;
  return 1;
}

// ------------------------------------------------------------ pick from a source
function pickFrom(g, src, srcPiece, acceptFn, max) {
  if (srcPiece) {
    const it = pieceTake(srcPiece, acceptFn);
    return it ? [it, 1] : null;
  }
  if (!src) return null;
  switch (src._kind) {
    case 'chest': {
      for (const s of src.inv) {
        if (!s) continue;
        const a = acceptFn(s[0]);
        if (a <= 0) continue;
        const k = Math.min(s[1], a, max);
        s[1] -= k;
        const it = s[0];
        if (s[1] === 0) src.inv[src.inv.indexOf(s)] = null;
        return [it, k];
      }
      return null;
    }
    case 'furnace': {
      if (!src.out) return null;
      const a = acceptFn(src.out[0]);
      if (a <= 0) return null;
      const k = Math.min(src.out[1], a, max);
      const it = src.out[0];
      src.out[1] -= k; if (src.out[1] === 0) src.out = null;
      return [it, k];
    }
    case 'assembler': {
      for (const it of Object.keys(src.out)) {
        const a = acceptFn(it);
        if (a <= 0) continue;
        const k = Math.min(src.out[it], a, max);
        src.out[it] -= k; if (src.out[it] === 0) delete src.out[it];
        return [it, k];
      }
      return null;
    }
    default: return null;
  }
}

// ------------------------------------------------------------ inserters
export function inserterTiles(e) {
  const r = e._proto.reach;
  return [e.x - DX[e.dir] * r, e.y - DY[e.dir] * r, e.x + DX[e.dir] * r, e.y + DY[e.dir] * r];
}

function inserterAcceptFn(g, e, dst, dstPiece) {
  if (dstPiece) {
    const lane = nearLane(dstPiece, (e.dir + 2) % 4) ^ 1; // far lane
    const ok = laneCanInsert(dstPiece, lane, dstPiece._len >> 1);
    return () => (ok ? 1 : 0);
  }
  if (!dst) return () => 0;
  return item => accepts(g, dst, item);
}

export function inserterDemand(g, e) {
  const P = e._proto;
  e._dem = (e.ph === 1 || e.ph === 3) ? Math.floor(P.power / 60) : Math.floor(P.power / 600);
}

export function updateInserter(g, e) {
  const P = e._proto;
  const T = P.swing * 1000;
  let step;
  if (P.burner) {
    const cost = Math.floor(P.power / 60);
    step = 0;
    if (e.ph === 1 || e.ph === 3) step = burn(e, cost) ? 1000 : 0;
  } else {
    step = e._net ? e._net.sat : 0;
  }
  e._on = false;
  if (e.ph === 0) {
    const [px, py, dx, dy] = inserterTiles(e);
    const srcPiece = pieceAt(g, px, py);
    const src = srcPiece ? null : g.entAt(px, py);
    const dstPiece = pieceAt(g, dx, dy);
    const dst = dstPiece ? null : g.entAt(dx, dy);
    // burner inserters feed themselves first
    if (P.burner && e.en < Math.floor(P.power / 60) * P.swing * 2 && !e.fuel) {
      const got = pickFrom(g, src, srcPiece, it => (isFuel(it) ? 1 : 0), 1);
      if (got) { e.fuel = got; return; }
    }
    if (!P.burner && step === 0) return;
    if (P.burner && !hasEnergy(e, Math.floor(P.power / 60))) return;
    if (!dst && !dstPiece) return;
    const acc = inserterAcceptFn(g, e, dst, dstPiece);
    const max = dstPiece || srcPiece ? 1 : 1 + g.bonus.inserterStack;
    const got = pickFrom(g, src, srcPiece, acc, max);
    if (got) { e.hand = got; e.ph = 1; e.t = 0; }
    return;
  }
  if (e.ph === 1) {
    e.t += step;
    if (step) e._on = true;
    if (e.t >= T) { e.t = T; e.ph = 2; }
    return;
  }
  if (e.ph === 2) {
    const [, , dx, dy] = inserterTiles(e);
    const dstPiece = pieceAt(g, dx, dy);
    let put = 0;
    if (dstPiece) {
      const lane = nearLane(dstPiece, (e.dir + 2) % 4) ^ 1;
      if (dropOnPiece(dstPiece, lane, e.hand[0])) put = 1;
    } else {
      const dst = g.entAt(dx, dy);
      if (dst) put = insertInto(g, dst, e.hand[0], e.hand[1]);
    }
    if (put > 0) {
      e.hand[1] -= put;
      if (e.hand[1] <= 0) { e.hand = null; e.ph = 3; e.t = T; }
    }
    return;
  }
  if (e.ph === 3) {
    e.t -= step;
    if (step) e._on = true;
    if (e.t <= 0) { e.t = 0; e.ph = 0; }
  }
}

// ------------------------------------------------------------ drills
export function drillArea(e) {
  const P = e._proto;
  const off = (P.area - P.w) / 2;
  return [e.x - off, e.y - off, P.area];
}
export function drillOut(e) {
  const P = e._proto;
  const [ox, oy] = rotPoint(P.out.x, P.out.y, P.w, P.h, e.dir);
  return [e.x + ox, e.y + oy];
}
function drillHasOre(g, e) {
  const [x0, y0, a] = drillArea(e);
  for (let y = y0; y < y0 + a; y++) for (let x = x0; x < x0 + a; x++) {
    const r = g.resAt(x, y);
    if (r && r <= 4) return true;
  }
  return false;
}

export function drillDemand(g, e) {
  e._dem = (!e.out && e._ore) ? Math.floor(e._proto.power / 60) : 0;
}

export function updateDrill(g, e) {
  const P = e._proto;
  e._on = false;
  if (e.out) {
    const [ox, oy] = drillOut(e);
    const put = outputTo(g, ox, oy, e.dir, e.out[0], e.out[1], p => nearLane(p, (e.dir + 2) % 4));
    if (put) { e.out[1] -= put; if (e.out[1] <= 0) e.out = null; }
    if (e.out) return;
  }
  if (!e._ore) return;
  let step;
  if (P.burner) step = burn(e, Math.floor(P.power / 60)) ? P.speed : 0;
  else step = e._net ? Math.floor(P.speed * e._net.sat / 1000) : 0;
  if (!step) return;
  e._on = true;
  e.prog += step;
  if (e.prog < 60000) return;
  e.prog -= 60000;
  const [x0, y0, a] = drillArea(e);
  const total = a * a;
  for (let k = 0; k < total; k++) {
    const idx = (e.cur + k) % total;
    const x = x0 + (idx % a), y = y0 + Math.floor(idx / a);
    const r = g.resAt(x, y);
    if (!r || r > 4) continue;
    const item = g.mineTile(x, y);
    e.cur = (idx + 1) % total;
    let n = 1;
    e.pacc += g.bonus.miningProd;
    if (e.pacc >= 1000) { e.pacc -= 1000; n++; }
    e.out = [item, n];
    break;
  }
  if (!drillHasOre(g, e)) e._ore = false;
  if (e.out) {
    const [ox, oy] = drillOut(e);
    const put = outputTo(g, ox, oy, e.dir, e.out[0], e.out[1], p => nearLane(p, (e.dir + 2) % 4));
    if (put) { e.out[1] -= put; if (e.out[1] <= 0) e.out = null; }
  }
}
export function refreshDrillOre(g, e) { e._ore = drillHasOre(g, e); }

// ------------------------------------------------------------ furnaces
function furnaceTryStart(g, e) {
  if (e.act || !e.src) return;
  const r = smeltRecipe(g, e.src[0]);
  if (!r) return;
  const [it, need] = r.ing[0];
  if (e.src[1] < need) return;
  const [rit, rn] = r.res[0];
  if (e.out && (e.out[0] !== rit || e.out[1] + rn > stackOf(rit))) return;
  e.src[1] -= need; if (e.src[1] === 0) e.src = null;
  e.rec = r.name; e.act = true; e.prog = 0;
  void it;
}
export function furnaceDemand(g, e) {
  furnaceTryStart(g, e);
  e._dem = e.act && e._elec ? Math.floor(e._proto.power / 60) : 0;
}
export function updateFurnace(g, e) {
  const P = e._proto;
  e._on = false;
  if (!e.act) return;
  let step;
  if (P.burner) step = burn(e, Math.floor(P.power / 60)) ? P.speed : 0;
  else step = e._net ? Math.floor(P.speed * e._net.sat / 1000) : 0;
  if (!step) return;
  e._on = true;
  e.prog += step;
  const r = RECIPES[e.rec];
  if (e.prog >= Math.round(r.time * 60) * 1000) {
    const [rit, rn] = r.res[0];
    if (e.out && e.out[0] !== rit) { e.prog = Math.round(r.time * 60) * 1000; return; }
    e.out = e.out ? [rit, e.out[1] + rn] : [rit, rn];
    e.act = false; e.prog = 0;
    g.stat(rit, rn);
  }
}

// ------------------------------------------------------------ assemblers (also chem plant, refinery, rocket silo)
function fluidBoxes(e, role) {
  const P = e._proto;
  const res = [];
  if (!P.fluid) return res;
  P.fluid.forEach((b, bi) => { if (b.role === role) res.push(bi); });
  return res;
}
function asmCanStart(g, e) {
  const rec = e._rec;
  for (const [it, n] of rec.ing) if ((e.inv[it] || 0) < n) return false;
  const ins = fluidBoxes(e, 'in');
  for (let k = 0; k < rec.fing.length; k++) {
    const net = e._fn && e._fn[ins[k]];
    if (netHas(net, rec.fing[k][0]) < rec.fing[k][1] * 60) return false;
  }
  for (const [it, n] of rec.res) if ((e.out[it] || 0) + n > Math.max(stackOf(it), n)) return false;
  const outs = fluidBoxes(e, 'out');
  for (let k = 0; k < rec.fres.length; k++) {
    const net = e._fn && e._fn[outs[k]];
    if (netSpace(net, rec.fres[k][0]) < rec.fres[k][1] * 60) return false;
  }
  return true;
}
function asmTryStart(g, e) {
  if (e.act || !e._rec) return;
  if (e._kind === 'silo' && e.launch > 0) return;
  if (!asmCanStart(g, e)) return;
  const rec = e._rec;
  for (const [it, n] of rec.ing) { e.inv[it] -= n; if (!e.inv[it]) delete e.inv[it]; }
  const ins = fluidBoxes(e, 'in');
  for (let k = 0; k < rec.fing.length; k++) netTake(e._fn[ins[k]], rec.fing[k][0], rec.fing[k][1] * 60);
  e.act = true; e.prog = 0;
}
export function asmDemand(g, e) {
  asmTryStart(g, e);
  e._dem = e.act ? Math.floor(e._proto.power / 60) : 0;
}
export function updateAssembler(g, e) {
  const P = e._proto;
  e._on = false;
  if (e._kind === 'silo' && e.launch > 0) {
    e.launch--;
    if (e.launch === 0) {
      g.rockets++;
      e.parts = 0;
      g.events.push({ t: 'rocket', id: e.id });
    }
    return;
  }
  if (!e.act) return;
  const step = e._net ? Math.floor(P.speed * e._net.sat / 1000) : 0;
  if (!step) return;
  e._on = true;
  const rec = e._rec;
  const total = Math.round(rec.time * 60) * 1000;
  e.prog += step;
  if (e.prog < total) return;
  // finish: fluid results need room
  const outs = fluidBoxes(e, 'out');
  for (let k = 0; k < rec.fres.length; k++) {
    if (netSpace(e._fn && e._fn[outs[k]], rec.fres[k][0]) < rec.fres[k][1] * 60) { e.prog = total; return; }
  }
  for (let k = 0; k < rec.fres.length; k++) netPut(e._fn[outs[k]], rec.fres[k][0], rec.fres[k][1] * 60);
  for (const [it, n] of rec.res) { mapAdd(e.out, it, n); g.stat(it, n); }
  e.act = false; e.prog = 0;
  if (e._kind === 'silo') {
    e.parts++;
    if (e.parts >= ROCKET_PARTS) { e.launch = 1200; g.events.push({ t: 'launching', id: e.id }); }
  }
}

// ------------------------------------------------------------ labs
export function labDemand(g, e) {
  const R = g.research;
  const tech = R.cur ? TECHS[R.cur] : null;
  if (!e.act && tech && R.us < tech.units) {
    let ok = true;
    for (const p of tech.packs) if (!(e.inv[p] > 0)) { ok = false; break; }
    if (ok) {
      for (const p of tech.packs) { e.inv[p]--; if (!e.inv[p]) delete e.inv[p]; }
      e.act = true; e.prog = 0; e.rt = R.cur; R.us++;
    }
  }
  e._dem = e.act ? Math.floor(e._proto.power / 60) : 0;
}
export function updateLab(g, e) {
  e._on = false;
  if (!e.act) return;
  if (e.rt !== g.research.cur) { e.act = false; e.prog = 0; return; }
  const step = e._net ? Math.floor(e._proto.speed * e._net.sat / 1000) : 0;
  if (!step) return;
  e._on = true;
  e.prog += step;
  const tech = TECHS[e.rt];
  if (e.prog >= tech.time * 60 * 1000) {
    e.act = false; e.prog = 0;
    g.research.ud++;
  }
}

// ------------------------------------------------------------ boilers, pumps
export function updateBoiler(g, e) {
  e._on = false;
  const win = e._fn && e._fn[0], sout = e._fn && e._fn[1];
  const water = netHas(win, 'water');
  const room = netSpace(sout, 'steam');
  const amount = Math.min(60, water, room);
  if (amount <= 0) return;
  const need = amount * 500;
  if (!burn(e, need)) return;
  netTake(win, 'water', amount);
  netPut(sout, 'steam', amount);
  e._on = true;
}
export function updateOffshore(g, e) {
  const fn = e._fn && e._fn[0];
  e._on = netPut(fn, 'water', e._proto.rate) > 0;
}
export function pumpjackDemand(g, e) {
  const fn = e._fn && e._fn[0];
  e._dem = netSpace(fn, 'crude-oil') > 0 ? Math.floor(e._proto.power / 60) : 0;
}
export function updatePumpjack(g, e) {
  e._on = false;
  const sat = e._net ? e._net.sat : 0;
  if (!sat) return;
  const yieldPct = g.amtAt(e.x + 1, e.y + 1);
  e.acc += yieldPct * 10 * sat;
  const n = Math.floor(e.acc / 100000);
  if (n > 0) {
    e.acc -= n * 100000;
    if (netPut(e._fn && e._fn[0], 'crude-oil', n) > 0) e._on = true;
    else e.acc = Math.min(e.acc, 100000);
  }
}
export function lampDemand(g, e, daylight) {
  e._dem = daylight < 600 ? Math.floor(e._proto.power / 60) : 0;
}
export function updateLamp(g, e, daylight) {
  e._on = daylight < 600 && e._net && e._net.sat > 0;
}
