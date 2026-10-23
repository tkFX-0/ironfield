// The deterministic game simulation. Every peer runs this; only commands travel over the network.
import {
  ITEMS, RECIPES, RECIPE_LIST, ENTITIES, TECHS, TECH_LIST, RESOURCES, DX, DY,
  MAP_W, MAP_H, START_KIT, BASE_INVENTORY, ROCKET_PARTS,
} from '../data.js';
import { generateWorld, isTree, isRock, T_WATER } from './worldgen.js';
import { Hasher, bytesToB64, b64ToBytes, compress, decompress } from './util.js';
import { invAdd, invRemove, invCount, invCanFit, invSpace, newInv, stackOf, mapAdd, invSort } from './inventory.js';
import { rebuildBelts, updateBelts, splitterTiles, pieceItems, LANE } from './belts.js';
import { rebuildPower, rebuildFluids, resolvePower, flushFluids, neighbourFluids, boxFilter, rotPoint } from './networks.js';
import * as M from './machines.js';

export const DAY = 25000;
const KIND_LISTS = ['belt', 'underground', 'splitter', 'inserter', 'drill', 'furnace', 'assembler', 'silo', 'lab',
  'boiler', 'engine', 'offshore', 'pumpjack', 'pole', 'lamp', 'chest', 'solar', 'accumulator', 'pipe', 'pipe-to-ground', 'tank'];
const ITEM_IDX = Object.fromEntries(Object.keys(ITEMS).map((k, i) => [k, i + 1]));
const iid = n => ITEM_IDX[n] || 0;

export function dims(proto, dir) { return dir & 1 ? [proto.h, proto.w] : [proto.w, proto.h]; }
export function daylightAt(tick) {
  const p = tick % DAY;
  const f = p * 1000 / DAY;
  // day 0..450, dusk 450..550, night 550..750, dawn 750..850, day 850..1000
  if (f < 450 || f >= 850) return 1000;
  if (f < 550) return Math.floor(1000 - (f - 450) * 10);
  if (f < 750) return 0;
  return Math.floor((f - 750) * 10);
}

const MINE_TICKS = { ore: 75, tree: 45, rock: 100 };
const ROT_KINDS = new Set(['belt', 'underground', 'splitter', 'inserter', 'drill', 'boiler', 'engine', 'offshore', 'pumpjack', 'pipe-to-ground']);
export function isRotatable(P) { return ROT_KINDS.has(P.kind) || (P.kind === 'assembler' && !!P.fluid); }

export class Game {
  constructor() {
    this.events = [];
    this.lists = {};
    for (const k of KIND_LISTS) this.lists[k] = [];
    this.lists.fluid = [];
    this.ents = new Map();
    this.players = new Map();
    this._dirty = { belts: true, power: true, fluids: true, drills: true };
  }

  // ---------------------------------------------------------------- creation / loading
  static create({ seed = (Math.random() * 2 ** 31) | 0, name = 'Ironfield', sandbox = false } = {}) {
    const g = new Game();
    const w = generateWorld(seed);
    g.seed = seed; g.name = name; g.sandbox = !!sandbox;
    g.tick = 0; g.nextId = 1; g.rockets = 0;
    g.W = MAP_W; g.H = MAP_H;
    g.terrain = w.terrain; g.res = w.res; g.amt = w.amt; g.decor = w.decor;
    g.spawn = w.spawn;
    g.research = { cur: null, ud: 0, us: 0, done: [] };
    g.bonus = { inventory: 0, inserterStack: 0, miningProd: 0 };
    g.prod = {};
    g._init();
    return g;
  }

  _init() {
    this.occ = new Int32Array(this.W * this.H);
    this._unlocked = new Set();
    for (const t of this.research.done) for (const r of TECHS[t].unlocks) this._unlocked.add(r);
    this._doneSet = new Set(this.research.done);
  }

  async serialize() {
    flushFluids(this);
    const ents = [...this.ents.values()];
    const obj = {
      v: 1, seed: this.seed, name: this.name, sandbox: this.sandbox, tick: this.tick, nextId: this.nextId,
      rockets: this.rockets, spawn: this.spawn, research: this.research, bonus: this.bonus, prod: this.prod,
      players: [...this.players.values()],
      ents,
      terrain: bytesToB64(this.terrain), res: bytesToB64(this.res),
      amt: bytesToB64(new Uint8Array(this.amt.buffer)), decor: bytesToB64(this.decor),
    };
    const json = JSON.stringify(obj, (k, v) => (k[0] === '_' ? undefined : v));
    return compress(new TextEncoder().encode(json));
  }

  static async load(bytes) {
    const raw = await decompress(bytes);
    const o = JSON.parse(new TextDecoder().decode(raw));
    const g = new Game();
    g.seed = o.seed; g.name = o.name; g.sandbox = !!o.sandbox; g.tick = o.tick; g.nextId = o.nextId;
    g.rockets = o.rockets || 0; g.spawn = o.spawn; g.research = o.research; g.bonus = o.bonus; g.prod = o.prod || {};
    g.W = MAP_W; g.H = MAP_H;
    g.terrain = b64ToBytes(o.terrain); g.res = b64ToBytes(o.res); g.decor = b64ToBytes(o.decor);
    const ab = b64ToBytes(o.amt);
    g.amt = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4).slice();
    g._init();
    for (const p of o.players) g.players.set(p.pid, p);
    for (const e of o.ents) g._attach(e);
    g._rebuild();
    return g;
  }

  // ---------------------------------------------------------------- map queries
  inMap(x, y) { return x >= 0 && y >= 0 && x < this.W && y < this.H; }
  idx(x, y) { return y * this.W + x; }
  entAt(x, y) {
    if (!this.inMap(x, y)) return null;
    const id = this.occ[y * this.W + x];
    return id ? this.ents.get(id) : null;
  }
  resAt(x, y) { return this.inMap(x, y) ? this.res[y * this.W + x] : 0; }
  amtAt(x, y) { return this.inMap(x, y) ? this.amt[y * this.W + x] : 0; }
  terrainAt(x, y) { return this.inMap(x, y) ? this.terrain[y * this.W + x] : 5; }
  decorAt(x, y) { return this.inMap(x, y) ? this.decor[y * this.W + x] : 0; }
  mineTile(x, y) {
    const i = y * this.W + x;
    const item = RESOURCES[this.res[i]].item;
    if (this.amt[i] > 1) this.amt[i]--;
    else { this.amt[i] = 0; this.res[i] = 0; this.events.push({ t: 'depleted', x, y }); }
    return item;
  }
  recipeEnabled(r) { return !!(RECIPES[r] && (RECIPES[r].enabled || this._unlocked.has(r))); }
  techDone(t) { return this._doneSet.has(t); }
  techAvailable(t) { return !this._doneSet.has(t) && TECHS[t].prereq.every(p => this._doneSet.has(p)); }
  stat(item, n) { this.prod[item] = (this.prod[item] || 0) + n; }
  daylight() { return daylightAt(this.tick); }

  // ---------------------------------------------------------------- entities
  _attach(e) {
    const P = ENTITIES[e.name];
    Object.defineProperty(e, '_proto', { value: P, enumerable: false, writable: true });
    e._kind = P.kind;
    const [w, h] = dims(P, e.dir);
    e._w = w; e._h = h;
    e._elec = !!(P.elec || P.kind === 'engine' || P.kind === 'solar' || P.kind === 'accumulator');
    if (e.recipe) e._rec = RECIPES[e.recipe];
    if (P.kind === 'silo') e._rec = RECIPES['rocket-part'];
    this.ents.set(e.id, e);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) this.occ[(e.y + yy) * this.W + e.x + xx] = e.id;
    const list = this.lists[P.kind];
    if (list) list.push(e);
    if (P.fluid) this.lists.fluid.push(e);
    return e;
  }
  _detach(e) {
    this.ents.delete(e.id);
    for (let yy = 0; yy < e._h; yy++) for (let xx = 0; xx < e._w; xx++) this.occ[(e.y + yy) * this.W + e.x + xx] = 0;
    const list = this.lists[e._kind];
    if (list) list.splice(list.indexOf(e), 1);
    if (e._proto.fluid) this.lists.fluid.splice(this.lists.fluid.indexOf(e), 1);
  }

  _newEntity(name, x, y, dir, extra = {}) {
    const P = ENTITIES[name];
    const e = { id: this.nextId++, name, x, y, dir: dir | 0 };
    switch (P.kind) {
      case 'chest': e.inv = newInv(P.slots); break;
      case 'belt': e.lanes = [[], []]; break;
      case 'underground': e.lanes = [[], []]; e.ut = extra.ut || 'in'; break;
      case 'splitter': e.halves = [{ lanes: [[], []] }, { lanes: [[], []] }]; e.tog = [0, 0]; break;
      case 'inserter': e.hand = null; e.ph = 0; e.t = 0; e.fuel = null; e.en = 0; break;
      case 'drill': e.prog = 0; e.fuel = null; e.en = 0; e.out = null; e.cur = 0; e.pacc = 0; break;
      case 'furnace': e.src = null; e.out = null; e.fuel = null; e.en = 0; e.prog = 0; e.act = false; e.rec = null; break;
      case 'assembler': e.recipe = null; e.inv = {}; e.out = {}; e.prog = 0; e.act = false; break;
      case 'silo': e.inv = {}; e.out = {}; e.prog = 0; e.act = false; e.parts = 0; e.launch = 0; break;
      case 'lab': e.inv = {}; e.prog = 0; e.act = false; e.rt = null; break;
      case 'boiler': e.fuel = null; e.en = 0; break;
      case 'accumulator': e.charge = 0; break;
      case 'pumpjack': e.acc = 0; break;
      default: break;
    }
    if (P.fluid) e.fl = P.fluid.map(() => ({ f: null, a: 0 }));
    return e;
  }

  footprintFree(x, y, w, h, ignoreId = 0) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      if (!this.inMap(xx, yy)) return false;
      if (this.terrain[yy * this.W + xx] >= T_WATER) return false;
      const o = this.occ[yy * this.W + xx];
      if (o && o !== ignoreId) return false;
    }
    return true;
  }

  // returns {ok, reason, ut?, dir?} - also used by the UI for ghost colouring
  canPlace(name, x, y, dir, opts = {}) {
    const P = ENTITIES[name];
    if (!P) return { ok: false, reason: '置けません' };
    if (!isRotatable(P)) dir = 0;
    const [w, h] = dims(P, dir);
    if (!this.footprintFree(x, y, w, h, opts.ignoreId)) return { ok: false, reason: '場所がふさがっています' };
    if (P.kind === 'offshore') {
      const bx = x - DX[dir], by = y - DY[dir];
      if (this.terrainAt(bx, by) < T_WATER) return { ok: false, reason: '水辺に向けて置いてください' };
    }
    if (P.kind === 'pumpjack') {
      if (this.resAt(x + 1, y + 1) !== 5) return { ok: false, reason: '原油の湧き出る場所の上に置いてください' };
    }
    if (P.kind === 'drill') {
      const off = (P.area - P.w) / 2;
      let any = false;
      for (let yy = y - off; yy < y - off + P.area && !any; yy++) for (let xx = x - off; xx < x - off + P.area; xx++) {
        const r = this.resAt(xx, yy);
        if (r && r <= 4) { any = true; break; }
      }
      if (!any) return { ok: false, reason: '鉱石の上に置いてください' };
    }
    const res = { ok: true, dir };
    if (P.kind === 'underground') {
      // become an exit if an unpaired entrance of the same type faces us from behind
      res.ut = 'in';
      for (let k = 1; k <= P.reach; k++) {
        const o = this.entAt(x - DX[dir] * k, y - DY[dir] * k);
        if (!o || o._kind !== 'underground' || o.name !== name) continue;
        if (o.dir !== dir) continue;
        if (o.ut === 'in' && !o._partner) res.ut = 'out';
        break;
      }
    }
    if (P.kind === 'pipe-to-ground') {
      // flip to face the partner when placed in a line
      const u = (dir + 2) % 4;
      let found = false;
      for (let k = 1; k <= P.reach; k++) {
        const o = this.entAt(x + DX[u] * k, y + DY[u] * k);
        if (o && o._kind === 'pipe-to-ground') { found = o.dir === u; break; }
      }
      if (!found) {
        for (let k = 1; k <= P.reach; k++) {
          const o = this.entAt(x + DX[dir] * k, y + DY[dir] * k);
          if (o && o._kind === 'pipe-to-ground') { if (o.dir === dir && !o._partner) res.dir = u; break; }
        }
      }
    }
    if (P.fluid) {
      const probe = this._newEntityProbe(name, x, y, res.dir);
      const per = neighbourFluids(this, probe);
      for (let b = 0; b < per.length; b++) {
        const set = per[b];
        if (!set) continue;
        const filt = P.fluid[b] && P.fluid[b].filter;
        if (set.size > 1 || (filt && set.size === 1 && !set.has(filt))) return { ok: false, reason: '別の液体が混ざります' };
      }
    }
    return res;
  }
  _newEntityProbe(name, x, y, dir) {
    const P = ENTITIES[name];
    const [w, h] = dims(P, dir);
    const e = { id: -1, name, x, y, dir, _kind: P.kind, _w: w, _h: h };
    Object.defineProperty(e, '_proto', { value: P, enumerable: false });
    return e;
  }

  _placeEntity(name, x, y, dir, extra) {
    const e = this._newEntity(name, x, y, dir, extra);
    this._attach(e);
    this._markDirty(e);
    // clear trees/rocks under it
    for (let yy = 0; yy < e._h; yy++) for (let xx = 0; xx < e._w; xx++) this.decor[(y + yy) * this.W + x + xx] = 0;
    return e;
  }
  _markDirty(e) {
    const k = e._kind;
    if (k === 'belt' || k === 'underground' || k === 'splitter') this._dirty.belts = true;
    if (e._elec || k === 'pole') this._dirty.power = true;
    if (e._proto.fluid) this._dirty.fluids = true;
    if (k === 'drill') e._ore = undefined;
    // anything can change belt endpoints for inserters, nothing cached there
  }
  _rebuild() {
    const d = this._dirty;
    if (d.belts || d.fluids || d.power) this._topo = (this._topo || 0) + 1;
    if (d.belts) { rebuildBelts(this); d.belts = false; }
    if (d.fluids) { rebuildFluids(this); d.fluids = false; }
    if (d.power) { rebuildPower(this); d.power = false; }
    for (const e of this.lists.drill) if (e._ore === undefined) M.refreshDrillOre(this, e);
  }

  entityContents(e) {
    const out = [];
    const add = (it, n) => { if (it && n > 0) out.push([it, n]); };
    switch (e._kind) {
      case 'chest': for (const s of e.inv) if (s) add(s[0], s[1]); break;
      case 'belt': case 'underground': for (const it of pieceItems(e)) add(it, 1); break;
      case 'splitter': for (const h of e.halves) for (const it of pieceItems(h)) add(it, 1); break;
      case 'inserter': if (e.hand) add(e.hand[0], e.hand[1]); if (e.fuel) add(e.fuel[0], e.fuel[1]); break;
      case 'drill': if (e.fuel) add(e.fuel[0], e.fuel[1]); if (e.out) add(e.out[0], e.out[1]); break;
      case 'furnace':
        if (e.src) add(e.src[0], e.src[1]); if (e.out) add(e.out[0], e.out[1]); if (e.fuel) add(e.fuel[0], e.fuel[1]);
        if (e.act && e.rec) for (const [it, n] of RECIPES[e.rec].ing) add(it, n);
        break;
      case 'assembler': case 'silo':
        for (const [it, n] of Object.entries(e.inv)) add(it, n);
        for (const [it, n] of Object.entries(e.out)) add(it, n);
        if (e.act && e._rec) for (const [it, n] of e._rec.ing) add(it, n);
        break;
      case 'lab': for (const [it, n] of Object.entries(e.inv)) add(it, n); break;
      case 'boiler': if (e.fuel) add(e.fuel[0], e.fuel[1]); break;
      default: break;
    }
    // merge duplicates
    const m = new Map();
    for (const [it, n] of out) m.set(it, (m.get(it) || 0) + n);
    return [...m.entries()];
  }

  // ---------------------------------------------------------------- players
  _newPlayer(pid, name, color) {
    const p = { pid, name, color, inv: newInv(BASE_INVENTORY + this.bonus.inventory), craft: [], bank: {}, mine: null, online: true };
    for (const [it, n] of START_KIT) invAdd(p.inv, it, n);
    if (this.sandbox) {
      for (const it of ['transport-belt', 'inserter', 'small-electric-pole', 'electric-mining-drill', 'assembling-machine-2', 'stone-furnace',
        'boiler', 'steam-engine', 'offshore-pump', 'pipe', 'iron-chest', 'lab', 'coal', 'underground-belt', 'splitter', 'solar-panel']) {
        invAdd(p.inv, it, stackOf(it));
      }
    }
    return p;
  }
  err(pid, msg) { this.events.push({ t: 'err', pid, msg }); }

  // ---------------------------------------------------------------- commands
  apply(cmd) {
    if (!cmd || typeof cmd.type !== 'string') return;
    const pid = cmd.pid;
    if (cmd.type === 'join') {
      let p = this.players.get(pid);
      if (!p) { p = this._newPlayer(pid, String(cmd.name || 'player').slice(0, 20), cmd.color || '#e0a030'); this.players.set(pid, p); }
      else { p.online = true; if (cmd.name) p.name = String(cmd.name).slice(0, 20); if (cmd.color) p.color = cmd.color; }
      this.events.push({ t: 'join', pid });
      return;
    }
    const p = this.players.get(pid);
    if (!p) return;
    const h = this['c_' + cmd.type];
    if (typeof h === 'function') {
      try { h.call(this, p, cmd); } catch (err) { this.err(pid, 'エラー: ' + err.message); }
    }
  }

  c_leave(p) { p.online = false; p.mine = null; this.events.push({ t: 'leave', pid: p.pid }); }

  c_build(p, c) {
    const item = c.item;
    const it = ITEMS[item];
    if (!it || !it.place) return;
    const x = c.x | 0, y = c.y | 0, dir = (c.dir | 0) & 3;
    if (invCount(p.inv, item) < 1) return this.err(p.pid, `${it.ja} を持っていません`);
    const P = ENTITIES[it.place];
    // dragging belts over belts: re-point, or swap tier keeping the items
    if (P.kind === 'belt') {
      const o = this.entAt(x, y);
      if (o && o._kind === 'belt') {
        if (o.name === it.place) {
          if (o.dir !== dir) { o.dir = dir; this._dirty.belts = true; this.events.push({ t: 'rotated', pid: p.pid, x, y }); }
          return;
        }
        invRemove(p.inv, item, 1);
        invAdd(p.inv, o.name, 1);
        this._detach(o);
        const e = this._newEntity(it.place, x, y, dir);
        e.lanes = o.lanes;
        this._attach(e);
        this._dirty.belts = true;
        this.events.push({ t: 'built', pid: p.pid, id: e.id, name: e.name, x, y });
        return;
      }
    }
    const chk = this.canPlace(it.place, x, y, dir);
    if (!chk.ok) return this.err(p.pid, chk.reason);
    // trees/rocks under the footprint give their items
    const [w, h] = dims(P, chk.dir);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const d = this.decor[yy * this.W + xx];
      if (isTree(d)) invAdd(p.inv, 'wood', 4);
      else if (isRock(d)) invAdd(p.inv, 'stone', 20);
    }
    invRemove(p.inv, item, 1);
    const e = this._placeEntity(it.place, x, y, chk.dir, { ut: chk.ut });
    if (c.recipe && (P.kind === 'assembler')) this._setRecipe(e, c.recipe, null);
    this.events.push({ t: 'built', pid: p.pid, id: e.id, name: e.name, x, y });
  }

  c_remove(p, c) {
    const e = this.ents.get(c.id | 0);
    if (!e) return;
    const items = [[e._proto.item, 1], ...this.entityContents(e)];
    if (!invCanFit(p.inv, items)) return this.err(p.pid, 'インベントリがいっぱいです');
    for (const [it, n] of items) invAdd(p.inv, it, n);
    if (e._kind === 'pole' || e._elec) this._dirty.power = true;
    this._detach(e);
    this._markDirty(e);
    // neighbouring drills may need to re-scan nothing; belts/fluids/power rebuild handles links
    this.events.push({ t: 'removed', pid: p.pid, name: e.name, x: e.x, y: e.y });
  }

  c_rotate(p, c) {
    const e = this.ents.get(c.id | 0);
    if (!e) return;
    const k = e._kind;
    if (!isRotatable(e._proto)) return;
    if (k === 'underground') {
      // flip direction and role of the pair
      const partner = e._partner;
      e.dir = (e.dir + 2) % 4; e.ut = e.ut === 'in' ? 'out' : 'in';
      if (partner) { partner.dir = (partner.dir + 2) % 4; partner.ut = partner.ut === 'in' ? 'out' : 'in'; }
      this._dirty.belts = true;
      this.events.push({ t: 'rotated', pid: p.pid, x: e.x, y: e.y });
      return;
    }
    const nd = (e.dir + (c.ccw ? 3 : 1)) % 4;
    const [w, h] = dims(e._proto, nd);
    if (w !== e._w) {
      // non-square: needs a free footprint (rotate about the centre)
      const nx = e.x + Math.floor((e._w - w) / 2), ny = e.y + Math.floor((e._h - h) / 2);
      if (!this.footprintFree(nx, ny, w, h, e.id)) return this.err(p.pid, '回転する場所がありません');
      this._detach(e);
      e.x = nx; e.y = ny; e.dir = nd;
      this._attach(e);
    } else {
      e.dir = nd;
      if (k === 'drill') e._ore = undefined;
    }
    this._markDirty(e);
    if (e._proto.fluid) this._dirty.fluids = true;
    this.events.push({ t: 'rotated', pid: p.pid, x: e.x, y: e.y });
  }

  _setRecipe(e, r, p) {
    const rec = RECIPES[r];
    if (r && (!rec || !e._proto.cats || !e._proto.cats.includes(rec.cat) || !this.recipeEnabled(r))) return false;
    if (rec && rec.cat === 'crafting-fluid' && !e._proto.fluid) return false;
    if (e.recipe === r) return true;
    const back = [];
    for (const [it, n] of Object.entries(e.inv)) back.push([it, n]);
    for (const [it, n] of Object.entries(e.out)) back.push([it, n]);
    if (e.act && e._rec) for (const [it, n] of e._rec.ing) back.push([it, n]);
    if (p) for (const [it, n] of back) invAdd(p.inv, it, n);
    e.inv = {}; e.out = {}; e.act = false; e.prog = 0;
    e.recipe = r || null;
    e._rec = r ? rec : null;
    if (e._proto.fluid) this._dirty.fluids = true;
    return true;
  }
  c_setRecipe(p, c) {
    const e = this.ents.get(c.id | 0);
    if (!e || e._kind !== 'assembler') return;
    if (!this._setRecipe(e, c.recipe || null, p)) this.err(p.pid, 'このレシピは使えません');
  }

  c_research(p, c) {
    const t = c.tech;
    if (!TECHS[t] || !this.techAvailable(t)) return;
    if (this.research.cur === t) return;
    this.research.cur = t; this.research.ud = 0; this.research.us = 0;
    for (const lab of this.lists.lab) { lab.act = false; lab.prog = 0; }
    this.events.push({ t: 'research-start', tech: t, pid: p.pid });
  }

  handRecipeFor(item) {
    for (const r of RECIPE_LIST) {
      const rec = RECIPES[r];
      if (rec.cat !== 'crafting' || rec.nohand || rec.fing.length || rec.fres.length) continue;
      if (!rec.res.some(([it]) => it === item)) continue;
      if (!this.recipeEnabled(r)) continue;
      return rec;
    }
    return null;
  }
  // plan a hand craft; consumes from the player's inventory if possible. Returns queue entries or null.
  _planCraft(p, rname, count) {
    const invV = new Map();
    for (const s of p.inv) if (s) invV.set(s[0], (invV.get(s[0]) || 0) + s[1]);
    const extraV = new Map();
    const entries = [];
    const take = (item, n, con, fb) => {
      let rem = n;
      const ex = Math.min(extraV.get(item) || 0, rem);
      if (ex) { extraV.set(item, extraV.get(item) - ex); fb.push([item, ex]); rem -= ex; }
      const iv = Math.min(invV.get(item) || 0, rem);
      if (iv) { invV.set(item, invV.get(item) - iv); con.push([item, iv]); rem -= iv; }
      return rem;
    };
    const craftOne = (rec, depth) => {
      const con = [], fb = [];
      for (const [item, n] of rec.ing) {
        let rem = take(item, n, con, fb);
        while (rem > 0) {
          const sub = this.handRecipeFor(item);
          if (!sub || depth > 6) return false;
          if (!craftOne(sub, depth + 1)) return false;
          const made = sub.res.find(([it]) => it === item)[1];
          extraV.set(item, (extraV.get(item) || 0) + made);
          const k = Math.min(extraV.get(item), rem);
          extraV.set(item, extraV.get(item) - k);
          fb.push([item, k]);
          rem -= k;
        }
      }
      entries.push({ r: rec.name, t: Math.max(1, Math.round(rec.time * 60)), con, fb, sub: depth > 0 });
      return true;
    };
    const rec = RECIPES[rname];
    for (let i = 0; i < count; i++) {
      const before = entries.length;
      if (!craftOne(rec, 0)) { entries.length = before; break; }
    }
    return entries;
  }
  c_craft(p, c) {
    const rec = RECIPES[c.recipe];
    if (!rec || rec.cat !== 'crafting' || rec.nohand || rec.fing.length || !this.recipeEnabled(rec.name)) return this.err(p.pid, '手作業では作れません');
    const n = Math.max(1, Math.min(100, c.count | 0));
    if (p.craft.length > 400) return this.err(p.pid, 'クラフトの予約が多すぎます');
    const entries = this._planCraft(p, rec.name, n);
    if (!entries.length) return this.err(p.pid, '材料が足りません');
    for (const en of entries) for (const [it, k] of en.con) invRemove(p.inv, it, k);
    p.craft.push(...entries);
    this.events.push({ t: 'craft-queued', pid: p.pid });
  }
  c_cancelCraft(p) {
    const back = [];
    for (const en of p.craft) for (const pair of en.con) back.push(pair);
    for (const [it, n] of Object.entries(p.bank)) back.push([it, n]);
    for (const [it, n] of back) invAdd(p.inv, it, n);
    p.craft = []; p.bank = {};
  }
  _updateCraft(p) {
    const en = p.craft[0];
    if (!en) return;
    if (en.t > 1) { en.t--; return; }
    const rec = RECIPES[en.r];
    for (const [it, n] of en.fb) { p.bank[it] = (p.bank[it] || 0) - n; if (p.bank[it] <= 0) delete p.bank[it]; }
    if (en.sub) {
      for (const [it, n] of rec.res) mapAdd(p.bank, it, n);
    } else {
      if (!invCanFit(p.inv, rec.res)) { en.t = 1; for (const [it, n] of en.fb) mapAdd(p.bank, it, n); return; }
      for (const [it, n] of rec.res) invAdd(p.inv, it, n);
      this.events.push({ t: 'crafted', pid: p.pid, item: rec.res[0][0] });
    }
    for (const [it, n] of rec.res) this.stat(it, n);
    p.craft.shift();
    // surplus intermediates nobody in the queue still needs go to the inventory
    const need = {};
    for (const q of p.craft) for (const [it, n] of q.fb) need[it] = (need[it] || 0) + n;
    for (const it of Object.keys(p.bank)) {
      const surplus = p.bank[it] - (need[it] || 0);
      if (surplus > 0) { const k = invAdd(p.inv, it, surplus); p.bank[it] -= k; if (p.bank[it] <= 0) delete p.bank[it]; }
    }
  }

  c_mine(p, c) {
    const x = c.x | 0, y = c.y | 0;
    if (!this.inMap(x, y)) return;
    const d = this.decor[this.idx(x, y)];
    const r = this.res[this.idx(x, y)];
    if (!d && !(r && r <= 4)) return;
    if (this.occ[this.idx(x, y)]) return;
    p.mine = { x, y, t: 0 };
  }
  c_mineStop(p) { p.mine = null; }
  _updateMining(p) {
    const m = p.mine;
    if (!m) return;
    const i = this.idx(m.x, m.y);
    const d = this.decor[i];
    const r = this.res[i];
    const kind = isTree(d) ? 'tree' : isRock(d) ? 'rock' : (r && r <= 4) ? 'ore' : null;
    if (!kind || this.occ[i]) { p.mine = null; return; }
    m.t++;
    if (m.t % 20 === 0) this.events.push({ t: 'mine-hit', pid: p.pid, kind, x: m.x, y: m.y });
    if (m.t < MINE_TICKS[kind]) return;
    m.t = 0;
    if (kind === 'tree') {
      if (invAdd(p.inv, 'wood', 4) === 0) { p.mine = null; return this.err(p.pid, 'インベントリがいっぱいです'); }
      this.decor[i] = 0; p.mine = null;
    } else if (kind === 'rock') {
      if (invAdd(p.inv, 'stone', 20) === 0) { p.mine = null; return this.err(p.pid, 'インベントリがいっぱいです'); }
      if (isRock(d)) invAdd(p.inv, 'coal', d === 13 ? 10 : 0);
      this.decor[i] = 0; p.mine = null;
    } else {
      const item = RESOURCES[r].item;
      if (invSpace(p.inv, item) < 1) { p.mine = null; return this.err(p.pid, 'インベントリがいっぱいです'); }
      this.mineTile(m.x, m.y);
      invAdd(p.inv, item, 1);
      this.stat(item, 1);
    }
    this.events.push({ t: 'mined', pid: p.pid, kind });
  }

  // move items between the player and an entity
  c_take(p, c) {
    const e = this.ents.get(c.id | 0);
    if (!e) return;
    const slot = String(c.slot || '');
    const giveBack = (it, n) => invAdd(p.inv, it, n);
    const takePair = (pair, setter) => {
      if (!pair) return;
      const k = giveBack(pair[0], pair[1]);
      pair[1] -= k;
      setter(pair[1] > 0 ? pair : null);
    };
    switch (e._kind) {
      case 'chest': {
        const i = parseInt(slot.slice(2), 10);
        if (slot.startsWith('c:') && e.inv[i]) takePair(e.inv[i], v => { e.inv[i] = v; });
        else if (slot === 'all') for (let k = 0; k < e.inv.length; k++) if (e.inv[k]) takePair(e.inv[k], v => { e.inv[k] = v; });
        break;
      }
      case 'furnace': case 'drill': case 'boiler': case 'inserter':
        if (slot === 'fuel') takePair(e.fuel, v => { e.fuel = v; });
        if (slot === 'src') takePair(e.src, v => { e.src = v; });
        if (slot === 'out') takePair(e.out, v => { e.out = v; });
        break;
      case 'assembler': case 'silo': case 'lab': {
        const [kind, it] = slot.split(':');
        const m = kind === 'out' ? e.out : e.inv;
        if (m && m[it]) { const k = giveBack(it, m[it]); m[it] -= k; if (!m[it]) delete m[it]; }
        break;
      }
      default: break;
    }
  }
  c_put(p, c) {
    const e = this.ents.get(c.id | 0);
    const item = c.item;
    if (!e || !ITEMS[item]) return;
    const have = invCount(p.inv, item);
    let n = c.count === -1 ? have : Math.min(have, c.count | 0);
    if (n <= 0) return;
    let put = 0;
    const st = stackOf(item);
    switch (e._kind) {
      case 'chest': put = invAdd(e.inv, item, n); break;
      case 'furnace': case 'drill': case 'boiler': case 'inserter':
        if (M.isFuel(item) && e._proto.burner) {
          if (!e.fuel || e.fuel[0] === item) { put = Math.min(n, st - (e.fuel ? e.fuel[1] : 0)); if (put > 0) e.fuel = [item, (e.fuel ? e.fuel[1] : 0) + put]; }
        } else if (e._kind === 'furnace' && M.smeltRecipe(this, item)) {
          if (!e.src || e.src[0] === item) { put = Math.min(n, st - (e.src ? e.src[1] : 0)); if (put > 0) e.src = [item, (e.src ? e.src[1] : 0) + put]; }
        }
        break;
      case 'assembler': case 'silo':
        if (e._rec && e._rec.ing.some(([it]) => it === item)) { put = Math.min(n, st - (e.inv[item] || 0)); if (put > 0) mapAdd(e.inv, item, put); }
        break;
      case 'lab':
        if (item.endsWith('science-pack')) { put = Math.min(n, st - (e.inv[item] || 0)); if (put > 0) mapAdd(e.inv, item, put); }
        break;
      default: break;
    }
    if (put > 0) invRemove(p.inv, item, put);
    else this.err(p.pid, 'ここには入れられません');
  }
  c_sortInv(p) { invSort(p.inv); }
  c_give(p, c) {
    if (!this.sandbox || !ITEMS[c.item]) return;
    invAdd(p.inv, c.item, Math.min(stackOf(c.item), Math.max(1, c.count | 0)));
  }

  // ---------------------------------------------------------------- simulation step
  step(cmds) {
    if (cmds) for (const c of cmds) this.apply(c);
    this._rebuild();
    const day = this.daylight();
    for (const p of this.players.values()) {
      if (p.craft.length) this._updateCraft(p);
      if (p.mine) this._updateMining(p);
    }
    const L = this.lists;
    // producers of fluids and consumers' power demand
    for (const e of L.offshore) M.updateOffshore(this, e);
    for (const e of L.boiler) M.updateBoiler(this, e);
    for (const e of L.drill) if (e._elec) M.drillDemand(this, e);
    for (const e of L.furnace) M.furnaceDemand(this, e);
    for (const e of L.assembler) M.asmDemand(this, e);
    for (const e of L.silo) M.asmDemand(this, e);
    for (const e of L.lab) M.labDemand(this, e);
    for (const e of L.inserter) if (e._elec) M.inserterDemand(this, e);
    for (const e of L.pumpjack) M.pumpjackDemand(this, e);
    for (const e of L.lamp) M.lampDemand(this, e, day);
    resolvePower(this, day);
    // machines
    for (const e of L.pumpjack) M.updatePumpjack(this, e);
    for (const e of L.drill) M.updateDrill(this, e);
    for (const e of L.furnace) M.updateFurnace(this, e);
    for (const e of L.assembler) M.updateAssembler(this, e);
    for (const e of L.silo) M.updateAssembler(this, e);
    for (const e of L.lab) M.updateLab(this, e);
    for (const e of L.lamp) M.updateLamp(this, e, day);
    updateBelts(this);
    for (const e of L.inserter) M.updateInserter(this, e);
    this._updateResearch();
    this.tick++;
  }

  _updateResearch() {
    const R = this.research;
    if (!R.cur) return;
    const t = TECHS[R.cur];
    if (R.ud >= t.units) {
      R.done.push(R.cur);
      this._doneSet.add(R.cur);
      for (const r of t.unlocks) this._unlocked.add(r);
      if (t.effect) {
        if (t.effect.inventory) {
          this.bonus.inventory += t.effect.inventory;
          for (const p of this.players.values()) for (let k = 0; k < t.effect.inventory; k++) p.inv.push(null);
        }
        if (t.effect.inserterStack) this.bonus.inserterStack += t.effect.inserterStack;
        if (t.effect.miningProd) this.bonus.miningProd += t.effect.miningProd;
      }
      this.events.push({ t: 'researched', tech: R.cur });
      R.cur = null; R.ud = 0; R.us = 0;
      for (const lab of this.lists.lab) { lab.act = false; lab.prog = 0; }
    }
  }

  // ---------------------------------------------------------------- checksum
  hash() {
    const h = new Hasher();
    h.n(this.tick).n(this.ents.size).n(this.nextId).n(this.research.ud).n(this.research.us).n(this.research.done.length);
    const pair = s => { if (s) h.n(iid(s[0])).n(s[1]); else h.n(0); };
    const map = m => { for (const k of Object.keys(m).sort()) h.n(iid(k)).n(m[k]); };
    const lanes = ls => { for (const l of ls) { h.n(l.length); for (const it of l) h.n(iid(it.i)).n(it.p); } };
    for (const e of this.ents.values()) {
      h.n(e.id).n(e.x).n(e.y).n(e.dir);
      switch (e._kind) {
        case 'chest': for (const s of e.inv) pair(s); break;
        case 'belt': case 'underground': lanes(e.lanes); break;
        case 'splitter': lanes(e.halves[0].lanes); lanes(e.halves[1].lanes); h.n(e.tog[0]).n(e.tog[1]); break;
        case 'inserter': pair(e.hand); h.n(e.ph).n(e.t).n(e.en); pair(e.fuel); break;
        case 'drill': h.n(e.prog).n(e.en).n(e.cur); pair(e.fuel); pair(e.out); break;
        case 'furnace': h.n(e.prog).n(e.en); pair(e.src); pair(e.out); pair(e.fuel); break;
        case 'assembler': case 'silo': h.n(e.prog); map(e.inv); map(e.out); break;
        case 'lab': h.n(e.prog); map(e.inv); break;
        case 'boiler': h.n(e.en); pair(e.fuel); break;
        case 'accumulator': h.n(e.charge); break;
        default: break;
      }
    }
    if (this._fnets) for (const n of this._fnets) h.n(n.amount);
    for (const p of this.players.values()) { for (const s of p.inv) pair(s); h.n(p.craft.length); }
    return h.value;
  }

  // ---------------------------------------------------------------- helpers for UI / renderer
  playerOf(pid) { return this.players.get(pid); }
  netStatsAt(e) { return e && e._net ? e._net.stats : null; }
  rocketProgress(e) { return e.parts / ROCKET_PARTS; }
  beltPieceLen() { return LANE; }
  splitterTiles(e) { return splitterTiles(e); }
  boxFilter(e, b) { return boxFilter(e, b); }
  fluidConnsWorld(e) { return e._conns || []; }
  rotPoint(x, y, w, h, d) { return rotPoint(x, y, w, h, d); }
}
