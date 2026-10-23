// Electric networks (poles) and fluid networks (connected fluid boxes behave as one tank, like Factorio 2.0).
import { DX, DY } from '../data.js';

// ------------------------------------------------------------ geometry
export function rotPoint(x, y, w, h, dir) {
  for (let r = 0; r < dir; r++) {
    const nx = h - 1 - y, ny = x;
    x = nx; y = ny;
    const t = w; w = h; h = t;
  }
  return [x, y];
}

// world-space connections of an entity's fluid boxes: [{box, x, y, d}]
export function fluidConns(e) {
  const P = e._proto;
  if (!P.fluid) return [];
  const out = [];
  P.fluid.forEach((box, bi) => {
    for (const c of box.conn) {
      let cx = c.x, cy = c.y, cd = c.d;
      if (e._kind !== 'pipe') {
        [cx, cy] = rotPoint(c.x, c.y, P.w, P.h, e.dir);
        cd = (c.d + e.dir) % 4;
      }
      out.push({ box: bi, x: e.x + cx, y: e.y + cy, d: cd });
    }
  });
  if (e._kind === 'pipe-to-ground') out[0].d = e.dir;
  return out;
}

// ------------------------------------------------------------ union find
function makeUF(n) {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  const find = a => { while (p[a] !== a) { p[a] = p[p[a]]; a = p[a]; } return a; };
  return { find, union(a, b) { a = find(a); b = find(b); if (a !== b) { if (a < b) p[b] = a; else p[a] = b; } } };
}

// ------------------------------------------------------------ fluids
export function flushFluids(g) {
  // write network contents back into boxes, proportional to capacity
  if (!g._fnets) return;
  for (const net of g._fnets) {
    let left = net.amount;
    const n = net.boxes.length;
    for (let k = 0; k < n; k++) {
      const [e, bi] = net.boxes[k];
      const cap = e._proto.fluid[bi].cap * 60;
      const share = k === n - 1 ? left : Math.min(left, Math.floor(net.amount * cap / net.cap));
      left -= share;
      e.fl[bi] = share > 0 ? { f: net.fluid, a: share } : { f: null, a: 0 };
    }
  }
}

function ptgPartner(g, e) {
  const u = (e.dir + 2) % 4;
  for (let k = 1; k <= e._proto.reach; k++) {
    const o = g.entAt(e.x + DX[u] * k, e.y + DY[u] * k);
    if (o && o._kind === 'pipe-to-ground') {
      if (o.dir === u) return o;
      if (o.dir === e.dir) return null;
    }
  }
  return null;
}

export function rebuildFluids(g) {
  flushFluids(g);
  const boxes = [];
  const index = new Map(); // "id:bi" -> idx
  const ents = g.lists.fluid;
  for (const e of ents) {
    e._fn = [];
    e._proto.fluid.forEach((_, bi) => { index.set(e.id * 8 + bi, boxes.length); boxes.push([e, bi]); });
  }
  const uf = makeUF(boxes.length);
  for (const e of ents) {
    const conns = fluidConns(e);
    e._conns = conns;
    for (const c of conns) {
      const nx = c.x + DX[c.d], ny = c.y + DY[c.d];
      const o = g.entAt(nx, ny);
      if (!o || !o._proto.fluid || o.id < e.id) continue;
      for (const oc of fluidConns(o)) {
        if (oc.x === nx && oc.y === ny && oc.d === (c.d + 2) % 4) uf.union(index.get(e.id * 8 + c.box), index.get(o.id * 8 + oc.box));
      }
    }
    if (e._kind === 'pipe-to-ground') {
      const o = ptgPartner(g, e);
      e._partner = o;
      if (o) uf.union(index.get(e.id * 8), index.get(o.id * 8));
    }
  }
  const nets = new Map();
  boxes.forEach(([e, bi], i) => {
    const r = uf.find(i);
    let net = nets.get(r);
    if (!net) { net = { id: r, fluid: null, amount: 0, cap: 0, boxes: [], _amounts: {} }; nets.set(r, net); }
    net.boxes.push([e, bi]);
    net.cap += e._proto.fluid[bi].cap * 60;
    const fl = e.fl[bi];
    if (fl && fl.f && fl.a > 0) net._amounts[fl.f] = (net._amounts[fl.f] || 0) + fl.a;
    e._fn[bi] = net;
  });
  for (const net of nets.values()) {
    let best = null;
    for (const [f, a] of Object.entries(net._amounts)) if (!best || a > net._amounts[best]) best = f;
    net.fluid = best;
    net.amount = best ? Math.min(net._amounts[best], net.cap) : 0;
    delete net._amounts;
  }
  g._fnets = [...nets.values()];
}

export function netTake(net, fluid, n) {
  if (!net || net.fluid !== fluid || n <= 0) return 0;
  const k = Math.min(net.amount, n);
  net.amount -= k;
  if (net.amount === 0) net.fluid = null;
  return k;
}
export function netSpace(net, fluid) {
  if (!net) return 0;
  if (net.fluid && net.fluid !== fluid) return 0;
  return net.cap - net.amount;
}
export function netPut(net, fluid, n) {
  const k = Math.min(netSpace(net, fluid), n);
  if (k > 0) { net.amount += k; net.fluid = fluid; }
  return k;
}
export function netHas(net, fluid) { return net && net.fluid === fluid ? net.amount : 0; }

// fluid types of the networks a new entity would touch, per box (for mixing checks)
export function neighbourFluids(g, e) {
  const per = [];
  for (const c of fluidConns(e)) {
    const nx = c.x + DX[c.d], ny = c.y + DY[c.d];
    const o = g.entAt(nx, ny);
    if (!o || !o._fn) continue;
    for (const oc of (o._conns || [])) {
      if (oc.x === nx && oc.y === ny && oc.d === (c.d + 2) % 4) {
        const net = o._fn[oc.box];
        (per[c.box] ||= new Set());
        if (net && net.fluid) per[c.box].add(net.fluid);
        const filt = boxFilter(o, oc.box);
        if (filt) per[c.box].add(filt);
      }
    }
  }
  if (e._kind === 'pipe-to-ground') {
    const o = ptgPartner(g, e);
    if (o && o._fn && o._fn[0] && o._fn[0].fluid) (per[0] ||= new Set()).add(o._fn[0].fluid);
  }
  return per;
}

// fixed fluid of a box (static filters and machine recipes)
export function boxFilter(e, bi) {
  const P = e._proto;
  const box = P.fluid[bi];
  if (box.filter) return box.filter;
  if (P.kind === 'offshore') return 'water';
  if (P.kind === 'pumpjack') return 'crude-oil';
  if (box.role && e._rec) {
    const ins = P.fluid.filter(b => b.role === 'in');
    const outs = P.fluid.filter(b => b.role === 'out');
    if (box.role === 'in') { const k = ins.indexOf(box); return e._rec.fing[k] ? e._rec.fing[k][0] : null; }
    const k = outs.indexOf(box); return e._rec.fres[k] ? e._rec.fres[k][0] : null;
  }
  return null;
}

// ------------------------------------------------------------ electricity
export function poleCenter(e) { return [e.x + e._w / 2, e.y + e._h / 2]; }

export function rebuildPower(g) {
  const poles = g.lists.pole;
  const uf = makeUF(poles.length);
  const edges = [];
  for (let a = 0; a < poles.length; a++) {
    const [ax, ay] = poleCenter(poles[a]);
    for (let b = a + 1; b < poles.length; b++) {
      const [bx, by] = poleCenter(poles[b]);
      const reach = Math.min(poles[a]._proto.wire, poles[b]._proto.wire);
      const d2 = (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
      if (d2 <= reach * reach) edges.push([d2, a, b]);
    }
  }
  edges.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  for (const p of poles) p._links = [];
  for (const [, a, b] of edges) {
    if (uf.find(a) === uf.find(b)) continue;
    uf.union(a, b);
    poles[a]._links.push(poles[b].id);
    poles[b]._links.push(poles[a].id);
  }
  const nets = new Map();
  const netOf = [];
  poles.forEach((p, i) => {
    const r = uf.find(i);
    if (!nets.has(r)) nets.set(r, { id: poles[r].id, poles: [], cons: [], engines: [], solars: [], accs: [], stats: { demand: 0, supply: 0, cap: 0, sat: 1000 } });
    nets.get(r).poles.push(p);
    netOf[i] = nets.get(r);
    p._net = netOf[i];
  });
  // reset coverage
  for (const e of g.ents.values()) if (e._elec) e._net = null;
  poles.forEach((p, i) => {
    const [cx, cy] = poleCenter(p);
    const s = p._proto.supply;
    const x0 = Math.floor(cx - s), x1 = Math.ceil(cx + s) - 1;
    const y0 = Math.floor(cy - s), y1 = Math.ceil(cy + s) - 1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const e = g.entAt(x, y);
      if (e && e._elec && !e._net) e._net = netOf[i];
    }
  });
  for (const e of g.ents.values()) {
    if (!e._elec || !e._net) continue;
    const k = e._kind;
    if (k === 'engine') e._net.engines.push(e);
    else if (k === 'solar') e._net.solars.push(e);
    else if (k === 'accumulator') e._net.accs.push(e);
    else e._net.cons.push(e);
  }
  g._pnets = [...nets.values()];
}

// distribute amount across items proportionally to caps (integers, deterministic)
function share(total, caps, capSum) {
  const out = new Array(caps.length).fill(0);
  if (capSum <= 0 || total <= 0) return out;
  let left = total;
  for (let k = 0; k < caps.length; k++) {
    const v = k === caps.length - 1 ? left : Math.min(left, Math.floor(total * caps[k] / capSum));
    out[k] = v; left -= v;
  }
  return out;
}

export function resolvePower(g, daylight) {
  for (const net of g._pnets) {
    let demand = 0;
    for (const e of net.cons) demand += e._dem || 0;
    const solarCap = net.solars.length * Math.floor(1000 * daylight / 1000);
    const ecaps = net.engines.map(e => {
      const fn = e._fn[0];
      const steam = fn && fn.fluid === 'steam' ? fn.amount : 0;
      return Math.min(15000, steam * 500);
    });
    let ecap = 0; for (const c of ecaps) ecap += c;
    const acaps = net.accs.map(a => Math.min(5000, a.charge));
    let acap = 0; for (const c of acaps) acap += c;

    let need = demand;
    const fromSolar = Math.min(need, solarCap); need -= fromSolar;
    const fromEng = Math.min(need, ecap); need -= fromEng;
    const fromAcc = Math.min(need, acap); need -= fromAcc;
    // surplus charges accumulators (solar first, then steam)
    let chargeRoom = 0;
    for (const a of net.accs) chargeRoom += Math.min(5000, a._proto.cap - a.charge);
    const solarSpare = solarCap - fromSolar;
    const fromSolarCh = Math.min(chargeRoom, solarSpare);
    const engCh = Math.min(chargeRoom - fromSolarCh, ecap - fromEng);
    const engTotal = fromEng + engCh;
    // engines
    const eprod = share(engTotal, ecaps, ecap);
    net.engines.forEach((e, k) => {
      e._on = eprod[k] > 0 ? eprod[k] : 0;
      if (eprod[k] > 0) {
        const steam = Math.ceil(eprod[k] / 500);
        const fn = e._fn[0];
        fn.amount -= Math.min(fn.amount, steam);
        if (fn.amount === 0) fn.fluid = null;
      }
    });
    // accumulators
    const adis = share(fromAcc, acaps, acap);
    const chargeTotal = fromSolarCh + engCh;
    const rooms = net.accs.map(a => Math.min(5000, a._proto.cap - a.charge));
    const ach = share(chargeTotal, rooms, chargeRoom);
    net.accs.forEach((a, k) => {
      a.charge += ach[k] - adis[k];
      a._on = ach[k] > 0 ? 1 : adis[k] > 0 ? -1 : 0;
    });
    const supplied = demand - need;
    const sat = demand > 0 ? Math.floor(supplied * 1000 / demand) : 1000;
    net.sat = sat;
    const st = net.stats;
    st.demand = demand; st.supply = supplied; st.cap = solarCap + ecap + acap; st.sat = sat;
    st.solar = fromSolar; st.steam = fromEng; st.acc = fromAcc;
  }
}
