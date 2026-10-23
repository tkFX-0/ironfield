// Draws the world with the GL batcher. World pixel unit = atlas pixel (TILE px per tile).
import { GL } from './gl.js';
import { buildAtlas } from './atlas.js';
import { ENTITIES, DX, DY, RESOURCES } from '../data.js';
import { hash2 } from '../sim/util.js';
import { inserterTiles, drillArea } from '../sim/machines.js';
import { dims } from '../sim/game.js';

const T = 64;
const HALF_PI = Math.PI / 2;
const WHITE = 0xffffffff;
const rgba = GL.rgba;
const TIER = { 'transport-belt': 0, 'fast-transport-belt': 1, 'express-transport-belt': 2, 'underground-belt': 0, 'fast-underground-belt': 1,
  'express-underground-belt': 2, splitter: 0, 'fast-splitter': 1, 'express-splitter': 2 };
const BELT_TPS = [1.875, 3.75, 5.625]; // tiles per second

export class Renderer {
  constructor(canvas, spritesModule) {
    this.gl = new GL(canvas);
    this.S = spritesModule;
    const atlas = buildAtlas(spritesModule.registerSprites);
    this.sprites = atlas.map;
    this.gl.uploadAtlas(atlas.layers);
    this.atlasInfo = { layers: atlas.layers.length, count: atlas.count };
    // the canvases are no longer needed once uploaded
    for (const c of atlas.layers) { c.width = 1; c.height = 1; }
    this.wire = spritesModule.WIRE_ANCHORS || {};
    this.smokePts = spritesModule.SMOKE_POINTS || {};
    this.beltLoop = spritesModule.BELT_LOOP_TILES || 0.25;
    this.cam = { x: 256, y: 256, zoom: 48 }; // zoom = device px per tile
    this.particles = [];
    this.stamp = new Uint32Array(1);
    this.frameNo = 0;
    this.time = 0;
    this.mapTopo = -1;
    this.overlay = { ghosts: [], selection: null, remove: null, showPower: false, drillArea: null, cursors: [], mining: null };
    this.visibleCounts = {};
  }

  setMap(game) {
    this.game = game;
    this.gl.uploadMap(game.terrain, game.W, game.H);
    this.stamp = new Uint32Array(game.nextId + 100000);
  }

  sprite(key) { return this.sprites.get(key); }
  draw(key, wx, wy, col = WHITE) {
    const s = this.sprites.get(key);
    if (!s) { this.gl.quad(wx, wy, T, T, null, rgba(1, 0, 1, 0.5)); return; }
    this.gl.quad(wx - s.ax, wy - s.ay, s.w, s.h, s, col);
  }
  drawScaled(key, cx, cy, size, col = WHITE) {
    const s = this.sprites.get(key);
    this.gl.quad(cx - size / 2, cy - size / 2, size, size, s || null, s ? col : rgba(1, 0, 1, 0.6));
  }
  drawRot(key, cx, cy, w, h, ang, col = WHITE) {
    const s = this.sprites.get(key);
    this.gl.quadRot(cx, cy, w, h, ang, s || null, s ? col : rgba(1, 0, 1, 0.5));
  }

  screenToWorld(sx, sy) {
    const c = this.cam, cv = this.gl.canvas;
    return [c.x + (sx - cv.width / 2) / c.zoom, c.y + (sy - cv.height / 2) / c.zoom];
  }
  worldToScreen(wx, wy) {
    const c = this.cam, cv = this.gl.canvas;
    return [(wx - c.x) * c.zoom + cv.width / 2, (wy - c.y) * c.zoom + cv.height / 2];
  }

  // ------------------------------------------------------------------ frame
  render(dt, localPid) {
    const g = this.game;
    if (!g) return;
    const gl = this.gl;
    this.time += dt;
    this.frameNo++;
    const cv = gl.canvas, cam = this.cam;
    const wT = cv.width / cam.zoom, hT = cv.height / cam.zoom;
    const x0 = cam.x - wT / 2, y0 = cam.y - hT / 2;
    gl.drawTerrain(x0, y0, wT, hT, this.time, cam.zoom);
    gl.begin(cam.x * T, cam.y * T, cam.zoom / T);
    const tx0 = Math.max(0, Math.floor(x0) - 2), ty0 = Math.max(0, Math.floor(y0) - 2);
    const tx1 = Math.min(g.W - 1, Math.ceil(x0 + wT) + 2), ty1 = Math.min(g.H - 1, Math.ceil(y0 + hT) + 4);
    const far = cam.zoom < 22 * (window.devicePixelRatio || 1);
    this._drawGround(g, tx0, ty0, tx1, ty1, far);

    // gather visible entities (scan occupancy with a margin for big sprites)
    const st = ++this.stampVal || (this.stampVal = 1);
    if (this.stamp.length < g.nextId + 1) this.stamp = new Uint32Array(g.nextId + 100000);
    const ents = [];
    const W = g.W;
    const mx0 = Math.max(0, tx0 - 9), my0 = Math.max(0, ty0 - 3), mx1 = Math.min(W - 1, tx1 + 2), my1 = Math.min(g.H - 1, ty1 + 9);
    for (let y = my0; y <= my1; y++) {
      const row = y * W;
      for (let x = mx0; x <= mx1; x++) {
        const id = g.occ[row + x];
        if (id && this.stamp[id] !== st) { this.stamp[id] = st; const e = g.ents.get(id); if (e) ents.push(e); }
      }
    }
    // belts first (ground level), then their items
    const counts = { belts: 0, drills: 0, furnaces: 0, assemblers: 0, engines: 0, inserters: 0, pumps: 0, labs: 0 };
    const tick = g.tick;
    for (const e of ents) {
      const k = e._kind;
      if (k === 'belt') { this._drawBelt(e, e._shape || 0, e.x, e.y, e.dir); counts.belts++; }
      else if (k === 'underground') this._drawBelt(e, 0, e.x, e.y, e.dir);
      else if (k === 'splitter') { const t = g.splitterTiles(e); for (const [x, y] of t) this._drawBelt(e, 0, x, y, e.dir); }
    }
    if (!far) for (const e of ents) {
      const k = e._kind;
      if (k === 'belt' || k === 'underground') this._drawBeltItems(e, e, e._shape || 0);
      else if (k === 'splitter') for (const h of e.halves) this._drawBeltItems(e, h, 0);
    }
    // sorted pass: entities + trees/rocks
    const sorted = [];
    for (const e of ents) {
      const k = e._kind;
      if (k === 'belt') continue;
      sorted.push({ y: e.y + e._h, x: e.x, e });
    }
    for (let y = ty0; y <= Math.min(g.H - 1, ty1 + 2); y++) {
      const row = y * W;
      for (let x = tx0; x <= tx1; x++) {
        const d = g.decor[row + x];
        if (d) sorted.push({ y: y + 1, x, d, tx: x, ty: y });
      }
    }
    sorted.sort((a, b) => a.y - b.y || a.x - b.x);
    const night = 1 - g.daylight() / 1000;
    const lights = [];
    for (const it of sorted) {
      if (it.d) { this._drawDecor(it.d, it.tx, it.ty); continue; }
      this._drawEntity(it.e, tick, lights, counts);
    }
    // inserter arms on top
    for (const e of ents) if (e._kind === 'inserter') this._drawInserterArm(e);
    // wires
    for (const e of ents) if (e._kind === 'pole') this._drawWires(g, e);
    // status icons
    if (!far) for (const e of ents) this._drawStatus(e);
    // particles
    this._updateParticles(dt);
    // night
    if (night > 0.01) {
      gl.quad((cam.x - wT) * T, (cam.y - hT) * T, wT * 2 * T, hT * 2 * T, null, rgba(0.02, 0.03, 0.08, 0.72 * night));
      gl.setAdditive(true);
      const lc = night;
      for (const L of lights) this.drawScaled('fx:light', L.x, L.y, L.r * 2, rgba(L.c[0], L.c[1], L.c[2], L.a * lc));
      gl.setAdditive(false);
    }
    this._drawOverlay(g, localPid);
    gl.flush();
    this.visibleCounts = counts;
  }

  // ------------------------------------------------------------------ ground: ores, decals
  _drawGround(g, tx0, ty0, tx1, ty1, far) {
    const W = g.W;
    for (let y = ty0; y <= ty1; y++) {
      const row = y * W;
      for (let x = tx0; x <= tx1; x++) {
        const i = row + x;
        const r = g.res[i];
        if (r) {
          if (r === 5) { this.draw('oil:' + ((x * 7 + y * 3) & 1), x * T, y * T); continue; }
          const a = g.amt[i];
          const dens = a < 150 ? 0 : a < 600 ? 1 : a < 2000 ? 2 : 3;
          const v = Math.floor(hash2(x, y, 7) * 6);
          this.draw(`ore:${RESOURCES[r].name}:${v}:${dens}`, x * T, y * T);
        } else if (!far && g.terrain[i] < 3) {
          const h = hash2(x, y, 11);
          if (h < 0.09) {
            const k = Math.floor(hash2(x, y, 12) * 8);
            this.draw('decal:' + k, x * T + Math.floor(hash2(x, y, 13) * 32), y * T + Math.floor(hash2(x, y, 14) * 32));
          }
        }
      }
    }
  }
  _drawDecor(d, x, y) {
    let key;
    if (d <= 8) key = 'tree:' + (d - 1);
    else if (d <= 10) key = 'deadtree:' + (d - 9);
    else key = 'rock:' + (d - 11);
    this.draw(key, x * T, y * T);
  }

  // ------------------------------------------------------------------ belts
  _beltFrame(tier) {
    const loops = this.time * BELT_TPS[tier] / this.beltLoop;
    return Math.floor((loops - Math.floor(loops)) * 16) & 15;
  }
  _drawBelt(e, shape, x, y, dir) {
    const tier = TIER[e.name] || 0;
    const sh = shape === 1 ? 'cl' : shape === 2 ? 'cr' : 's';
    this.drawRot(`belt:${tier}:${sh}:${this._beltFrame(tier)}`, x * T + 32, y * T + 32, T, T, dir * HALF_PI);
  }
  _drawBeltItems(e, p, shape) {
    const dir = e.dir;
    const c = Math.cos(dir * HALF_PI), s = Math.sin(dir * HALF_PI);
    const cx = p.x * T + 32, cy = p.y * T + 32;
    const isUg = e._kind === 'underground';
    const len = p._len || 256;
    for (let lane = 0; lane < 2; lane++) {
      const items = p.lanes[lane];
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        let pos = it.p;
        let lx, ly;
        if (isUg) {
          if (e.ut === 'in') { if (pos >= 112) continue; }
          else if (pos < 144) continue;
          ly = 1 - pos / 256;
          lx = 0.5 + (lane ? 0.22 : -0.22);
        } else if (shape === 0) {
          ly = 1 - pos / len; lx = 0.5 + (lane ? 0.22 : -0.22);
        } else {
          const t = pos / 256, th = HALF_PI * (1 - t);
          if (shape === 1) { const r = lane ? 0.72 : 0.28; lx = r * Math.cos(th); ly = r * Math.sin(th); }
          else { const r = lane ? 0.28 : 0.72; lx = 1 - r * Math.cos(th); ly = r * Math.sin(th); }
        }
        const ox = (lx - 0.5) * T, oy = (ly - 0.5) * T;
        const wx = cx + ox * c - oy * s, wy = cy + ox * s + oy * c;
        this.gl.quad(wx - 11, wy - 7, 26, 18, null, rgba(0, 0, 0, 0.25));
        this.drawScaled('item:' + it.i, wx, wy, 27);
      }
    }
  }

  // ------------------------------------------------------------------ entities
  _anim(e, frames, speed) {
    if (e._on) e._anim = (e._anim || 0) + speed;
    return Math.floor(e._anim || 0) % frames;
  }
  _pipeMask(e) {
    const g = this.game;
    if (e._mt === g._topo) return e._mask;
    let m = 0;
    for (let d = 0; d < 4; d++) {
      const nx = e.x + DX[d], ny = e.y + DY[d];
      const o = g.entAt(nx, ny);
      if (!o || !o._conns) continue;
      for (const c of o._conns) if (c.x === nx && c.y === ny && c.d === (d + 2) % 4) { m |= 1 << d; break; }
    }
    e._mask = m; e._mt = g._topo;
    return m;
  }
  _drawEntity(e, tick, lights, counts) {
    const k = e._kind, n = e.name, x = e.x * T, y = e.y * T, d = e.dir;
    switch (k) {
      case 'underground': {
        const tier = TIER[n] || 0;
        this.drawRot(`ub:${tier}:${e.ut}`, x + 32, y + 32, T, T, d * HALF_PI);
        return;
      }
      case 'splitter': {
        const tier = TIER[n] || 0;
        const [w, h] = dims(e._proto, d);
        this.drawRot(`splitter:${tier}`, x + w * 32, y + h * 32, 128, 64, d * HALF_PI);
        return;
      }
      case 'inserter': this.draw(`ins:${n}:base`, x, y); counts.inserters++; return;
      case 'pipe': this.draw('pipe:' + this._pipeMask(e), x, y); return;
      case 'pipe-to-ground': this.draw(`ent:pipe-to-ground:${d}`, x, y); return;
      case 'tank': this.draw('ent:storage-tank', x, y); return;
      case 'chest': case 'pole': case 'solar': case 'silo': this.draw('ent:' + n, x, y);
        if (k === 'silo') this._drawSilo(e, x, y, lights);
        return;
      case 'lamp':
        this.draw(e._on ? 'ent:small-lamp:on' : 'ent:small-lamp', x, y);
        if (e._on) lights.push({ x: x + 32, y: y + 32, r: 7 * T, c: [1, 0.92, 0.75], a: 0.75 });
        return;
      case 'accumulator': this.draw(e._on === 1 ? 'ent:accumulator:on' : 'ent:accumulator', x, y); return;
      case 'drill': {
        const burner = n === 'burner-mining-drill';
        const f = this._anim(e, burner ? 4 : 8, burner ? 0.15 : 0.25);
        this.draw(`ent:${n}:${d}:f${f}`, x, y);
        if (e._on) { counts.drills++; if (burner) this._smoke(e, x, y, 0.02, 'fx:smoke', d); }
        if (burner && e._on) lights.push({ x: x + 64, y: y + 64, r: 2 * T, c: [1, 0.55, 0.2], a: 0.5 });
        return;
      }
      case 'offshore': this.draw(`ent:offshore-pump:${d}`, x, y); if (e._on) counts.pumps++; return;
      case 'boiler':
        this.draw(`ent:boiler:${d}${e._on ? ':on' : ''}`, x, y);
        if (e._on) { this._smoke(e, x, y, 0.06, 'fx:smoke', d); lights.push({ x: x + e._w * 32, y: y + e._h * 32, r: 3 * T, c: [1, 0.5, 0.15], a: 0.6 }); }
        return;
      case 'engine': {
        const f = this._anim(e, 8, Math.min(0.5, 0.15 + (e._on || 0) / 15000 * 0.35));
        this.draw(`ent:steam-engine:${d}:f${f}`, x, y);
        if (e._on) counts.engines++;
        return;
      }
      case 'furnace':
        this.draw(`ent:${n}${e._on ? ':on' : ''}`, x, y);
        if (e._on) {
          counts.furnaces++;
          if (n !== 'electric-furnace') this._smoke(e, x, y, 0.03, 'fx:smoke');
          lights.push({ x: x + e._w * 32, y: y + e._h * 32, r: 3 * T, c: [1, 0.55, 0.2], a: 0.7 });
        }
        return;
      case 'assembler': {
        if (n === 'oil-refinery') {
          this.draw(`ent:oil-refinery:${d}${e._on ? ':on' : ''}`, x, y);
          if (e._on) { this._smoke(e, x, y, 0.05, 'fx:smoke', d); lights.push({ x: x + 160, y: y + 160, r: 5 * T, c: [1, 0.6, 0.25], a: 0.5 }); }
        } else if (n === 'chemical-plant') {
          this.draw(`ent:chemical-plant:${d}:f${this._anim(e, 4, 0.12)}`, x, y);
        } else {
          this.draw(`ent:${n}:f${this._anim(e, 8, 0.3)}`, x, y);
        }
        this._drawPorts(e);
        if (e._on) counts.assemblers++;
        return;
      }
      case 'pumpjack': this.draw(`ent:pumpjack:${d}:f${this._anim(e, 8, 0.12)}`, x, y); if (e._on) counts.pumps++; return;
      case 'lab': this.draw(`ent:lab:f${this._anim(e, 8, 0.2)}`, x, y); if (e._on) { counts.labs++; lights.push({ x: x + 96, y: y + 96, r: 3 * T, c: [0.4, 0.7, 1], a: 0.5 }); } return;
      default: this.draw('ent:' + n, x, y);
    }
  }
  _drawPorts(e) {
    const P = e._proto;
    if (!P.fluid || !e._conns) return;
    const rec = e._rec;
    const always = e.name === 'oil-refinery' || e.name === 'chemical-plant';
    if (!always && !(rec && (rec.fing.length || rec.fres.length))) return;
    for (const c of e._conns) this.draw(`pipe-port:${c.d}`, c.x * T, c.y * T);
  }
  _drawSilo(e, x, y, lights) {
    const prog = e.launch > 0 ? 1 - e.launch / 1200 : 0;
    if (e.parts > 0 || e.launch > 0) {
      const lift = e.launch > 0 ? Math.max(0, prog - 0.6) / 0.4 : 0;
      const rise = lift * lift * 40 * T;
      const s = this.sprites.get('fx:rocket');
      const alpha = Math.min(1, e.parts / 5 + (e.launch > 0 ? 1 : 0));
      if (s) this.gl.quad(x + 4.5 * T - s.w / 2, y + 4.5 * T - s.h + T - rise, s.w, s.h, s, rgba(1, 1, 1, alpha));
      if (lift > 0) {
        this.gl.setAdditive(true);
        const fl = this.sprites.get('fx:rocket-flame');
        if (fl) this.gl.quad(x + 4.5 * T - fl.w / 2, y + 4.6 * T - rise, fl.w, fl.h, fl, rgba(1, 0.8, 0.5, 0.9));
        this.gl.setAdditive(false);
        lights.push({ x: x + 4.5 * T, y: y + 5 * T - rise, r: 14 * T, c: [1, 0.7, 0.4], a: 1 });
      }
    }
  }
  _drawStatus(e) {
    const g = this.game;
    const k = e._kind;
    let icon = null;
    const elec = e._elec && k !== 'engine' && k !== 'solar' && k !== 'accumulator';
    if (k === 'assembler' && !e._rec) icon = 'icon:no-recipe';
    else if (elec && (k !== 'inserter' && k !== 'lamp') && (!e._net || e._net.sat === 0) && (e._dem > 0 || k === 'assembler' || k === 'lab' || k === 'drill')) icon = 'icon:no-power';
    else if (elec && e._net && e._net.sat < 1000 && e._dem > 0 && (this.frameNo >> 5) & 1) icon = 'icon:no-power';
    else if (e._proto.burner && !e.fuel && e.en <= 0 && (k === 'furnace' || k === 'boiler' || k === 'drill')) {
      if (k !== 'furnace' || e.act || e.src) icon = 'icon:no-fuel';
    }
    if (!icon) return;
    if (((this.frameNo >> 4) & 3) === 0) return;
    this.drawScaled(icon, (e.x + e._w / 2) * T, (e.y + e._h / 2) * T, 34);
    void g;
  }

  _drawInserterArm(e) {
    const P = e._proto;
    const T2 = P.swing * 1000;
    const frac = e.ph === 0 ? 0 : e.ph === 2 ? 1 : Math.min(1, Math.max(0, e.t / T2));
    const r = P.reach;
    const cx = e.x * T + 32, cy = e.y * T + 32 - 6;
    const a0 = Math.atan2(-DY[e.dir], -DX[e.dir]);
    const ang = a0 + frac * Math.PI;
    const R = r * T * (1 - 0.35 * Math.sin(frac * Math.PI)) * 0.92;
    const hx = cx + Math.cos(ang) * R, hy = cy + Math.sin(ang) * R;
    const dist = Math.hypot(hx - cx, hy - cy);
    const phi = Math.atan2(hy - cy, hx - cx) + HALF_PI;
    this.drawRot(`ins:${e.name}:arm`, (cx + hx) / 2, (cy + hy) / 2, 16, dist * 64 / 48, phi);
    this.drawRot(e.hand ? `ins:${e.name}:handc` : `ins:${e.name}:hand`, hx, hy, 32, 32, phi);
    if (e.hand) this.drawScaled('item:' + e.hand[0], hx, hy, 24);
  }

  _drawWires(g, e) {
    const a = this.wire[e.name] || [32, -100];
    const ax = e.x * T + a[0], ay = e.y * T + a[1];
    for (const id of e._links || []) {
      if (id < e.id) continue;
      const o = g.ents.get(id);
      if (!o) continue;
      const b = this.wire[o.name] || [32, -100];
      const bx = o.x * T + b[0], by = o.y * T + b[1];
      const len = Math.hypot(bx - ax, by - ay);
      const sag = Math.min(40, len * 0.08);
      let px = ax, py = ay;
      for (let s = 1; s <= 8; s++) {
        const t = s / 8;
        const qx = ax + (bx - ax) * t, qy = ay + (by - ay) * t + Math.sin(t * Math.PI) * sag;
        this.gl.line(px, py, qx, qy, 2.2, rgba(0.12, 0.08, 0.05, 0.85));
        px = qx; py = qy;
      }
    }
  }

  // ------------------------------------------------------------------ particles
  _smoke(e, x, y, rate, key, dir) {
    if (Math.random() > rate * 4) return;
    let pts = this.smokePts[e.name];
    if (pts && !Array.isArray(pts)) pts = pts[dir || 0];
    const p = pts && pts.length ? pts[(Math.random() * pts.length) | 0] : [e._w * 32, 0];
    if (this.particles.length > 400) return;
    this.particles.push({ x: x + p[0], y: y + p[1], vx: 6 + Math.random() * 6, vy: -18 - Math.random() * 10, life: 0, max: 2.5 + Math.random(), key, s: 22 + Math.random() * 10 });
  }
  _updateParticles(dt) {
    const out = [];
    for (const p of this.particles) {
      p.life += dt;
      if (p.life >= p.max) continue;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const t = p.life / p.max;
      const size = p.s * (1 + t * 2.2);
      this.drawScaled(p.key, p.x, p.y, size, rgba(1, 1, 1, 0.45 * (1 - t) * Math.min(1, p.life * 4)));
      out.push(p);
    }
    this.particles = out;
  }

  // ------------------------------------------------------------------ overlays (ghosts, selection)
  _drawOverlay(g, localPid) {
    const o = this.overlay;
    const gl = this.gl;
    if (o.showPower) {
      for (const p of g.lists.pole) {
        const s = p._proto.supply;
        const cx = (p.x + p._w / 2) * T, cy = (p.y + p._h / 2) * T;
        gl.quad(cx - s * T, cy - s * T, s * 2 * T, s * 2 * T, null, rgba(0.25, 0.55, 1, 0.13));
      }
    }
    if (o.drillArea) {
      const [ax, ay, a] = o.drillArea;
      gl.quad(ax * T, ay * T, a * T, a * T, null, rgba(0.3, 0.9, 0.4, 0.15));
    }
    for (const gh of o.ghosts) this._drawGhost(gh);
    if (o.selection) {
      const e = o.selection;
      this._brackets(e.x * T, e.y * T, e._w * T, e._h * T, rgba(1, 0.8, 0.2, 0.95));
      if (e._kind === 'inserter') {
        const [px, py, dx, dy] = inserterTiles(e);
        gl.quad(px * T + 16, py * T + 16, 32, 32, null, rgba(0.3, 0.9, 0.3, 0.35));
        gl.quad(dx * T + 16, dy * T + 16, 32, 32, null, rgba(0.95, 0.4, 0.2, 0.35));
      }
      if (e._kind === 'drill') { const [ax, ay, a] = drillArea(e); gl.quad(ax * T, ay * T, a * T, a * T, null, rgba(0.3, 0.9, 0.4, 0.12)); }
    }
    if (o.remove) for (const e of o.remove) gl.quad(e.x * T, e.y * T, e._w * T, e._h * T, null, rgba(1, 0.2, 0.15, 0.3));
    const p = g.players.get(localPid);
    if (p && p.mine) {
      const m = p.mine;
      const d = g.decorAt(m.x, m.y);
      const tot = d ? (d >= 11 ? 100 : 45) : 75;
      const f = Math.min(1, m.t / tot);
      gl.quad(m.x * T + 4, m.y * T - 12, 56, 9, null, rgba(0, 0, 0, 0.6));
      gl.quad(m.x * T + 6, m.y * T - 10, 52 * f, 5, null, rgba(1, 0.75, 0.2, 1));
      this._brackets(m.x * T, m.y * T, T, T, rgba(1, 0.75, 0.2, 0.8));
    }
    for (const c of o.cursors) {
      const cx = c.x * T, cy = c.y * T;
      const col = hexCol(c.color, 0.9);
      gl.quadRot(cx, cy, 18, 18, Math.PI / 4, null, rgba(0, 0, 0, 0.5));
      gl.quadRot(cx, cy, 13, 13, Math.PI / 4, null, col);
    }
  }
  _brackets(x, y, w, h, col) {
    const L = Math.min(18, w / 3), th = 4, gl = this.gl;
    gl.quad(x - 2, y - 2, L, th, null, col); gl.quad(x - 2, y - 2, th, L, null, col);
    gl.quad(x + w + 2 - L, y - 2, L, th, null, col); gl.quad(x + w - 2, y - 2, th, L, null, col);
    gl.quad(x - 2, y + h - 2, L, th, null, col); gl.quad(x - 2, y + h + 2 - L, th, L, null, col);
    gl.quad(x + w + 2 - L, y + h - 2, L, th, null, col); gl.quad(x + w - 2, y + h + 2 - L, th, L, null, col);
  }
  _drawGhost(gh) {
    const P = ENTITIES[gh.name];
    const [w, h] = dims(P, gh.dir);
    const x = gh.x * T, y = gh.y * T;
    const col = gh.ok ? rgba(0.55, 0.85, 1, 0.55) : rgba(1, 0.3, 0.25, 0.55);
    const k = P.kind;
    const d = gh.dir;
    let key;
    if (k === 'belt') { this.drawRot(`belt:${TIER[gh.name]}:s:0`, x + 32, y + 32, T, T, d * HALF_PI, col); }
    else if (k === 'underground') { this.drawRot(`belt:${TIER[gh.name]}:s:0`, x + 32, y + 32, T, T, d * HALF_PI, col); this.drawRot(`ub:${TIER[gh.name]}:${gh.ut || 'in'}`, x + 32, y + 32, T, T, d * HALF_PI, col); }
    else if (k === 'splitter') this.drawRot(`splitter:${TIER[gh.name]}`, x + w * 32, y + h * 32, 128, 64, d * HALF_PI, col);
    else if (k === 'inserter') { this.draw(`ins:${gh.name}:base`, x, y, col); }
    else {
      if (k === 'pipe') key = 'pipe:0';
      else if (k === 'pipe-to-ground') key = `ent:pipe-to-ground:${d}`;
      else if (k === 'tank') key = 'ent:storage-tank';
      else if (k === 'drill') key = `ent:${gh.name}:${d}:f0`;
      else if (k === 'offshore') key = `ent:offshore-pump:${d}`;
      else if (k === 'boiler') key = `ent:boiler:${d}`;
      else if (k === 'engine') key = `ent:steam-engine:${d}:f0`;
      else if (k === 'assembler') key = gh.name === 'oil-refinery' ? `ent:oil-refinery:${d}` : gh.name === 'chemical-plant' ? `ent:chemical-plant:${d}:f0` : `ent:${gh.name}:f0`;
      else if (k === 'pumpjack') key = `ent:pumpjack:${d}:f0`;
      else if (k === 'lab') key = 'ent:lab:f0';
      else key = 'ent:' + gh.name;
      this.draw(key, x, y, col);
    }
    this.gl.quad(x, y, w * T, h * T, null, gh.ok ? rgba(0.4, 0.8, 1, 0.12) : rgba(1, 0.2, 0.2, 0.18));
    if (gh.arrow) this.drawRot('fx:arrow', x + w * 32, y + h * 32, 40, 40, d * HALF_PI, rgba(1, 1, 1, 0.85));
  }
}

function hexCol(hex, a) {
  const v = parseInt((hex || '#ffffff').slice(1), 16);
  return rgba(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, a);
}
