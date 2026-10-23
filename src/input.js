// Touch / mouse / keyboard control: camera, tapping, building with a preview-and-confirm step, removing.
// Touch building: tap or drag shows a preview, then the player confirms (✓). Belts route under obstacles
// with underground belts automatically, and double-tapping a belt selects the whole connected line.
import { ITEMS, ENTITIES, DX, DY } from './data.js';
import { dims, isRotatable } from './sim/game.js';
import { drillArea } from './sim/machines.js';
import { invCount } from './sim/inventory.js';

const DIRV = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const UG_FOR = { 'transport-belt': 'underground-belt', 'fast-transport-belt': 'fast-underground-belt', 'express-transport-belt': 'express-underground-belt' };

export class Controller {
  constructor(app) {
    this.app = app;
    this.canvas = app.renderer.gl.canvas;
    this.mode = 'normal'; // normal | build | remove
    this.buildItem = null;
    this.buildDir = 0;
    this.pointers = new Map();
    this.drag = null;
    this.vel = [0, 0];
    this.hover = null;
    this.longTimer = 0;
    this.pending = null; // {kind:'build', ghosts} | {kind:'remove', ents}
    this.lastTap = { t: 0, x: -1, y: -1 };
    try { this.instant = localStorage.getItem('ironfield.instant') === '1'; } catch { this.instant = false; }
    // touchLike: the mouse behaves like a finger (preview → ✓, drag the preview, confirm removals, right-drag pans)
    try { this.touchLike = localStorage.getItem('ironfield.touchlike') === '1'; } catch { this.touchLike = false; }
    this.lastPointer = matchMedia('(pointer: fine)').matches ? 'mouse' : 'touch'; // drives the on-screen hints
    this._bind();
  }

  get dpr() { return this.app.dpr; }
  get cam() { return this.app.renderer.cam; }
  get game() { return this.app.session.game; }
  get me() { return this.game.players.get(this.app.session.localPid); }

  // --------------------------------------------------------------- modes
  // looking round another prefecture's plot: no building or removing
  get viewing() { return this.app.session.mode === 'view'; }
  selectItem(item) {
    if (this.viewing) { this.app.submit(); return; }
    if (!item || !ITEMS[item] || !ITEMS[item].place) { this.setMode('normal'); return; }
    if (this.mode === 'build' && this.buildItem === item && !this.pending) { this.setMode('normal'); return; }
    this.clearPending();
    this.buildItem = item;
    this.mode = 'build';
    const P = ENTITIES[ITEMS[item].place];
    if (!isRotatable(P)) this.buildDir = 0;
    this.app.ui.onModeChange();
    this._updateHoverGhost();
  }
  setMode(m) {
    if (this.viewing && m !== 'normal') { this.app.submit(); m = 'normal'; }
    this.mode = m;
    if (m !== 'build') this.buildItem = null;
    this.pending = null;
    const ov = this.app.renderer.overlay;
    ov.ghosts = []; ov.remove = null; ov.drillArea = null; ov.showPower = false;
    this.app.ui.onModeChange();
  }
  setInstant(on) {
    this.instant = !!on;
    try { localStorage.setItem('ironfield.instant', on ? '1' : '0'); } catch { /* private mode */ }
    this.app.ui.onModeChange();
  }
  setTouchLike(on) {
    this.touchLike = !!on;
    try { localStorage.setItem('ironfield.touchlike', on ? '1' : '0'); } catch { /* private mode */ }
    this.hover = null;
    this.setMode(this.mode === 'remove' ? 'remove' : 'normal');
  }
  // the mouse acts as a mouse (instant build, right-click removes) unless touchLike is on
  _isMouse(type) { return type === 'mouse' && !this.touchLike; }
  rotate(ccw = false) {
    if (this.mode === 'build') {
      this.buildDir = (this.buildDir + (ccw ? 3 : 1)) % 4;
      this.app.audio.play('rotate');
      const p = this.pending;
      if (p && p.kind === 'build' && p.ghosts.length === 1) {
        const g0 = p.ghosts[0];
        const P = ENTITIES[g0.name];
        const [w, h] = dims(P, g0.dir);
        this._setPending(this._finalize([this._ghostFor(this.buildItem, g0.x + Math.floor((w - 1) / 2), g0.y + Math.floor((h - 1) / 2), this.buildDir)]));
      } else this._updateHoverGhost();
      return;
    }
    const sel = this.app.ui.selected;
    if (sel) { this.app.submit({ type: 'rotate', id: sel.id, ccw }); this.app.audio.play('rotate'); }
  }

  // --------------------------------------------------------------- pending (preview, then confirm)
  _setPending(ghosts) {
    this.pending = { kind: 'build', ghosts };
    this.app.renderer.overlay.ghosts = ghosts;
    this._drillPreview(ghosts[0]);
    this.app.ui.onModeChange();
  }
  clearPending() {
    if (!this.pending) return;
    this.pending = null;
    this.app.renderer.overlay.ghosts = [];
    this.app.renderer.overlay.remove = null;
    this.app.ui.onModeChange();
    this._updateHoverGhost();
  }
  confirm() {
    const p = this.pending;
    if (!p) return;
    if (p.kind === 'build') {
      // re-check against the current world (others may have built meanwhile)
      this._placeGhosts(this._finalize(p.ghosts.map(g => this._recheck(g))));
    } else {
      const list = p.ents.filter(e => this.game.ents.has(e.id));
      for (const e of list) this.app.submit({ type: 'remove', id: e.id });
      if (list.length) this.app.audio.play('remove');
      if (list.some(e => e === this.app.ui.selected)) this.app.ui.closeSheet();
    }
    this.pending = null;
    this.app.renderer.overlay.ghosts = [];
    this.app.renderer.overlay.remove = null;
    this.app.ui.onModeChange();
    this._updateHoverGhost();
  }
  pendingInfo() {
    const p = this.pending;
    if (!p) return null;
    if (p.kind === 'remove') return { kind: 'remove', n: p.ents.length };
    const ok = p.ghosts.filter(g => g.ok).length;
    const bad = p.ghosts.find(g => !g.ok);
    return { kind: 'build', n: ok, total: p.ghosts.length, reason: bad ? bad.reason : null };
  }

  // --------------------------------------------------------------- coordinates
  _local(ev) {
    const r = this.canvas.getBoundingClientRect();
    return [(ev.clientX - r.left) * this.dpr, (ev.clientY - r.top) * this.dpr];
  }
  _tile(sx, sy) {
    const [wx, wy] = this.app.renderer.screenToWorld(sx, sy);
    return [Math.floor(wx), Math.floor(wy)];
  }
  zoomAt(sx, sy, factor) {
    const cam = this.cam;
    const [wx, wy] = this.app.renderer.screenToWorld(sx, sy);
    const minZ = 9 * this.dpr, maxZ = 140 * this.dpr;
    cam.zoom = Math.max(minZ, Math.min(maxZ, cam.zoom * factor));
    const [nx, ny] = this.app.renderer.screenToWorld(sx, sy);
    cam.x += wx - nx; cam.y += wy - ny;
    this._clampCam();
  }
  _clampCam() {
    const g = this.game, cam = this.cam;
    // a little past the edge, to look over the border at the neighbouring plot
    cam.x = Math.max(-16, Math.min(g.W + 16, cam.x));
    cam.y = Math.max(-16, Math.min(g.H + 16, cam.y));
  }

  // --------------------------------------------------------------- ghosts
  _ghostFor(item, x, y, dir, arrow = true) {
    const g = this.game;
    const name = ITEMS[item].place;
    const P = ENTITIES[name];
    const d = isRotatable(P) ? dir : 0;
    const [w, h] = dims(P, d);
    const gx = x - Math.floor((w - 1) / 2), gy = y - Math.floor((h - 1) / 2);
    let chk = g.canPlace(name, gx, gy, d);
    if (!chk.ok && P.kind === 'belt') {
      const o = g.entAt(gx, gy);
      if (o && o._kind === 'belt') chk = { ok: true, dir: d };
    }
    return { item, name, x: gx, y: gy, dir: chk.dir ?? d, ok: chk.ok, reason: chk.reason, ut: chk.ut, arrow: arrow && isRotatable(P) };
  }
  _recheck(gh) {
    const P = ENTITIES[gh.name];
    const [w, h] = dims(P, gh.dir);
    const n = this._ghostFor(gh.item, gh.x + Math.floor((w - 1) / 2), gh.y + Math.floor((h - 1) / 2), gh.dir, gh.arrow);
    if (gh.forceUt) { n.ut = gh.forceUt; n.forceUt = gh.forceUt; }
    return n;
  }
  // mark ghosts the player cannot afford
  _finalize(ghosts) {
    const me = this.me;
    if (!me) return ghosts;
    const used = {};
    for (const gh of ghosts) {
      if (!gh.ok) continue;
      const o = this.game.entAt(gh.x, gh.y);
      if (o && o._kind === 'belt' && o.name === gh.name) continue; // re-pointing costs nothing
      used[gh.item] = (used[gh.item] || 0) + 1;
      if (used[gh.item] > invCount(me.inv, gh.item)) { gh.ok = false; gh.reason = `${ITEMS[gh.item].ja} が足りません`; }
    }
    return ghosts;
  }
  _blocked(name, x, y) {
    const g = this.game;
    const o = g.entAt(x, y);
    if (o && o._kind === 'belt') return false;
    return !g.canPlace(name, x, y, 0).ok;
  }
  _lineGhosts(sx, sy, ex, ey) {
    const item = this.buildItem;
    const P = ENTITIES[ITEMS[item].place];
    if (P.w > 1 || P.h > 1) return this._finalize([this._ghostFor(item, ex, ey, this.buildDir)]);
    const pts = [];
    const horizFirst = Math.abs(ex - sx) >= Math.abs(ey - sy);
    let x = sx, y = sy;
    pts.push([x, y]);
    const stepTo = (tx, ty) => {
      while (x !== tx || y !== ty) {
        if (x !== tx) x += Math.sign(tx - x); else y += Math.sign(ty - y);
        pts.push([x, y]);
      }
    };
    if (horizFirst) { stepTo(ex, sy); stepTo(ex, ey); } else { stepTo(sx, ey); stepTo(ex, ey); }
    const isBelt = P.kind === 'belt';
    let dirs = pts.map(() => this.buildDir);
    if (pts.length > 1 && (isBelt || P.kind === 'underground' || P.kind === 'pipe-to-ground')) {
      dirs = pts.map((p, i) => {
        const q = pts[i + 1] || p, o = pts[i - 1] || p;
        const dx = i < pts.length - 1 ? q[0] - p[0] : p[0] - o[0];
        const dy = i < pts.length - 1 ? q[1] - p[1] : p[1] - o[1];
        return dx > 0 ? 1 : dx < 0 ? 3 : dy > 0 ? 2 : 0;
      });
    }
    const ghosts = [];
    if (isBelt && pts.length > 1) {
      // belts: dive under anything in the way with underground belts
      const ugItem = UG_FOR[item];
      const reach = ENTITIES[ugItem].reach;
      for (let i = 0; i < pts.length; i++) {
        const [px, py] = pts[i];
        if (i > 0 && this._blocked(P.name, px, py)) {
          const d = dirs[i - 1];
          let j = i;
          while (j < pts.length && dirs[j] === d && this._blocked(P.name, pts[j][0], pts[j][1])) j++;
          const entry = i - 1;
          if (j < pts.length && j - entry <= reach && dirs[entry] === d && !this.game.entAt(pts[entry][0], pts[entry][1])) {
            ghosts.pop();
            const a = this._ghostFor(ugItem, pts[entry][0], pts[entry][1], d, false);
            a.ut = 'in'; a.forceUt = 'in';
            const b = this._ghostFor(ugItem, pts[j][0], pts[j][1], d, false);
            b.ut = 'out'; b.forceUt = 'out'; b.ok = b.ok || false;
            if (!b.ok && b.reason === undefined) b.reason = '置けません';
            ghosts.push(a, b);
            i = j;
            continue;
          }
        }
        ghosts.push(this._ghostFor(item, px, py, dirs[i], i === pts.length - 1 || true));
      }
      return this._finalize(ghosts);
    }
    let sel = pts.map((_, i) => i);
    if (P.kind === 'pole') {
      const step = Math.max(1, Math.floor(P.wire) - 1);
      sel = sel.filter(i => i % step === 0 || i === pts.length - 1);
    } else if (P.kind === 'underground' || P.kind === 'pipe-to-ground') {
      sel = pts.length > 1 ? [0, pts.length - 1] : [0];
      if (P.kind === 'pipe-to-ground' && pts.length > 1) dirs[0] = (dirs[0] + 2) % 4;
    } else if (P.kind === 'inserter') {
      dirs = dirs.map(() => this.buildDir);
    }
    for (const i of sel) ghosts.push(this._ghostFor(item, pts[i][0], pts[i][1], dirs[i], i === sel[sel.length - 1] || isBelt));
    return this._finalize(ghosts);
  }
  _updateHoverGhost() {
    const ov = this.app.renderer.overlay;
    if (this.pending) return;
    if (this.mode !== 'build' || !this.buildItem) { ov.ghosts = []; ov.drillArea = null; return; }
    if (this.drag && (this.drag.kind === 'build' || this.drag.kind === 'move')) return;
    // touch: no floating preview until the player taps; mouse: follow the cursor
    if (!this.hover) { ov.ghosts = []; this._drillPreview(null); return; }
    ov.ghosts = this._finalize([this._ghostFor(this.buildItem, this.hover[0], this.hover[1], this.buildDir)]);
    this._drillPreview(ov.ghosts[0]);
  }
  _drillPreview(gh) {
    const ov = this.app.renderer.overlay;
    const P = gh && ENTITIES[gh.name];
    ov.drillArea = P && P.kind === 'drill' ? drillArea({ x: gh.x, y: gh.y, _proto: P }) : null;
    const it = this.buildItem && ITEMS[this.buildItem];
    const PE = it && ENTITIES[it.place];
    ov.showPower = !!(PE && (PE.kind === 'pole' || PE.elec || PE.kind === 'engine' || PE.kind === 'solar'));
  }
  _placeGhosts(ghosts) {
    let placed = 0;
    for (const gh of ghosts) {
      if (!gh.ok) continue;
      const o = this.game.entAt(gh.x, gh.y);
      if (o && o._kind === 'belt' && o.dir === gh.dir && o.name === gh.name) continue;
      this.app.submit({ type: 'build', item: gh.item, x: gh.x, y: gh.y, dir: gh.dir });
      placed++;
    }
    if (placed) this.app.audio.play('place', { pitch: 0.95 + Math.random() * 0.1 });
    else if (ghosts.length && ghosts[0].reason) { this.app.ui.toast(ghosts[0].reason, 'err'); this.app.audio.play('error'); }
    const last = ghosts[ghosts.length - 1];
    if (last && ENTITIES[last.name].kind === 'belt') this.buildDir = last.dir;
    return placed;
  }

  // belts connected to e (following the line both ways)
  _beltLine(e) {
    const g = this.game;
    const seen = new Set([e.id]);
    const out = [e];
    const q = [e];
    const isB = o => o && (o._kind === 'belt' || o._kind === 'underground' || o._kind === 'splitter');
    while (q.length && out.length < 2000) {
      const c = q.shift();
      const near = [];
      if (c._next && c._next.p) near.push(c._next.p._ent || c._next.p);
      if (c._partner) near.push(c._partner);
      // whatever feeds into c
      for (let d = 0; d < 4; d++) {
        const o = g.entAt(c.x + DX[d], c.y + DY[d]);
        if (!isB(o) || o === c) continue;
        if (o._next && (o._next.p === c || (o._next.p && o._next.p._ent === c))) near.push(o);
        if (o._kind === 'splitter' || c._kind === 'splitter') if ((o.dir === c.dir)) near.push(o);
      }
      for (const n of near) if (isB(n) && !seen.has(n.id)) { seen.add(n.id); out.push(n); q.push(n); }
    }
    return out;
  }

  // --------------------------------------------------------------- pointer handling
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this._down(e));
    c.addEventListener('pointermove', e => this._move(e));
    c.addEventListener('pointerup', e => this._up(e));
    c.addEventListener('pointercancel', e => this._cancel(e));
    c.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { this.hover = null; this._updateHoverGhost(); } });
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const [sx, sy] = this._local(e);
      this.zoomAt(sx, sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });
    document.addEventListener('gesturestart', e => e.preventDefault());
    window.addEventListener('keydown', e => this._key(e));
  }

  _insidePending(tx, ty) {
    const p = this.pending;
    if (!p || p.kind !== 'build' || p.ghosts.length !== 1) return false;
    const g0 = p.ghosts[0];
    const [w, h] = dims(ENTITIES[g0.name], g0.dir);
    return tx >= g0.x - 1 && ty >= g0.y - 1 && tx <= g0.x + w && ty <= g0.y + h;
  }

  _down(ev) {
    this.app.audio.unlock();
    try { this.canvas.setPointerCapture(ev.pointerId); } catch { /* synthetic or already released */ }
    const [sx, sy] = this._local(ev);
    this.pointers.set(ev.pointerId, { sx, sy, x0: sx, y0: sy, t0: performance.now(), type: ev.pointerType, button: ev.button });
    this.vel = [0, 0];
    this.app.ui.hideQuickMenu();
    if (this.lastPointer !== ev.pointerType) { this.lastPointer = ev.pointerType; this.app.ui.onModeChange(); }
    if (this.pointers.size === 2) {
      clearTimeout(this.longTimer);
      // a second finger means pan/zoom: undo whatever the first finger started
      if (this.drag && (this.drag.kind === 'build' || this.drag.kind === 'move')) {
        if (this.pending) this.app.renderer.overlay.ghosts = this.pending.ghosts;
        else this._updateHoverGhost();
      }
      if (this.drag && this.drag.kind === 'remove') this.app.renderer.overlay.remove = this.pending ? this.pending.ents : null;
      const [a, b] = [...this.pointers.values()];
      this.drag = { kind: 'pinch', dist: Math.hypot(a.sx - b.sx, a.sy - b.sy), mx: (a.sx + b.sx) / 2, my: (a.sy + b.sy) / 2 };
      return;
    }
    if (this.pointers.size > 2) return;
    const [tx, ty] = this._tile(sx, sy);
    const mouse = this._isMouse(ev.pointerType);
    if (mouse && ev.button === 2) { this.drag = { kind: 'remove', sx: tx, sy: ty, quick: true }; this._removeRect(tx, ty, tx, ty); return; }
    // middle drag pans; in touchLike mode right drag pans too (the two-finger drag of a phone)
    if (ev.pointerType === 'mouse' && (ev.button === 1 || ev.button === 2)) { this.drag = { kind: 'pan', moved: true }; return; }
    if (this.mode === 'build') {
      if (!mouse && this._insidePending(tx, ty)) { this.drag = { kind: 'move', ox: tx - this.pending.ghosts[0].x, oy: ty - this.pending.ghosts[0].y }; return; }
      this.drag = { kind: 'build', sx: tx, sy: ty };
      const gh = this._lineGhosts(tx, ty, tx, ty);
      this.app.renderer.overlay.ghosts = gh;
      this._drillPreview(gh[0]);
    } else if (this.mode === 'remove') {
      this.drag = { kind: 'remove', sx: tx, sy: ty };
      this._removeRect(tx, ty, tx, ty);
    } else {
      this.drag = { kind: 'pan', moved: false, tx, ty };
      const e = this.game.entAt(tx, ty);
      if (e) { // long press (finger or held mouse button) opens the quick menu
        this.longTimer = setTimeout(() => {
          if (this.drag && this.drag.kind === 'pan' && !this.drag.moved) {
            this.drag = { kind: 'none' };
            this.app.ui.showQuickMenu(e, sx / this.dpr, sy / this.dpr);
            if (navigator.vibrate) navigator.vibrate(12);
          }
        }, 430);
      }
    }
  }

  _move(ev) {
    const [sx, sy] = this._local(ev);
    if (ev.pointerType === 'mouse' && !this.pointers.size) {
      this.app.mouseTile = this._tile(sx, sy);
      this.hover = this.touchLike ? null : this.app.mouseTile; // a finger has no hover preview
      if (this.mode === 'build') this._updateHoverGhost();
      return;
    }
    const p = this.pointers.get(ev.pointerId);
    if (!p) return;
    const psx = p.sx, psy = p.sy;
    p.sx = sx; p.sy = sy;
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.sx - b.sx, a.sy - b.sy);
      const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
      const cam = this.cam;
      cam.x -= (mx - d.mx) / cam.zoom; cam.y -= (my - d.my) / cam.zoom;
      if (d.dist > 0) this.zoomAt(mx, my, dist / d.dist);
      d.dist = dist; d.mx = mx; d.my = my;
      this._clampCam();
      return;
    }
    if (d.kind === 'pan') {
      if (!d.moved && Math.hypot(sx - p.x0, sy - p.y0) > 9 * this.dpr) { d.moved = true; clearTimeout(this.longTimer); }
      if (d.moved) {
        const cam = this.cam;
        const dx = (sx - psx) / cam.zoom, dy = (sy - psy) / cam.zoom;
        cam.x -= dx; cam.y -= dy;
        this.vel = [dx, dy];
        this._clampCam();
      }
      return;
    }
    const [tx, ty] = this._tile(sx, sy);
    if (d.kind === 'build') {
      const gh = this._lineGhosts(d.sx, d.sy, tx, ty);
      this.app.renderer.overlay.ghosts = gh;
      this._drillPreview(gh[0]);
    } else if (d.kind === 'move') {
      const g0 = this.pending.ghosts[0];
      const nx = tx - d.ox, ny = ty - d.oy;
      if (nx !== g0.x || ny !== g0.y) {
        const P = ENTITIES[g0.name];
        const [w, h] = dims(P, g0.dir);
        this._setPending(this._finalize([this._ghostFor(g0.item, nx + Math.floor((w - 1) / 2), ny + Math.floor((h - 1) / 2), g0.dir)]));
      }
    } else if (d.kind === 'remove') this._removeRect(d.sx, d.sy, tx, ty);
  }

  _removeRect(x0, y0, x1, y1) {
    const g = this.game;
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
    const set = new Map();
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
      const e = g.entAt(x, y);
      if (e) set.set(e.id, e);
    }
    this.drag.ents = [...set.values()];
    this.drag.rect = [ax, ay, bx, by];
    this.app.renderer.overlay.remove = this.drag.ents;
  }

  _up(ev) {
    const p = this.pointers.get(ev.pointerId);
    this.pointers.delete(ev.pointerId);
    clearTimeout(this.longTimer);
    const d = this.drag;
    if (!p || !d) return;
    if (d.kind === 'pinch') { this.drag = this.pointers.size === 0 ? null : { kind: 'none' }; return; }
    if (this.pointers.size > 0) return;
    this.drag = null;
    const [sx, sy] = this._local(ev);
    const [tx, ty] = this._tile(sx, sy);
    const quick = this._isMouse(p.type) || this.instant;
    if (d.kind === 'build') {
      const ghosts = this.app.renderer.overlay.ghosts;
      if (quick) {
        this._placeGhosts(ghosts);
        if (this._isMouse(p.type)) this.hover = [tx, ty];
        this._updateHoverGhost();
      } else if (ghosts.length) this._setPending(ghosts);
      return;
    }
    if (d.kind === 'move') return;
    if (d.kind === 'remove') {
      const list = d.ents || [];
      if (quick || d.quick) {
        for (const e of list) this.app.submit({ type: 'remove', id: e.id });
        if (list.length) this.app.audio.play('remove');
        this.app.renderer.overlay.remove = null;
        if (list.some(e => e === this.app.ui.selected)) this.app.ui.closeSheet();
      } else if (list.length) {
        this.pending = { kind: 'remove', ents: list };
        this.app.renderer.overlay.remove = list;
        this.app.ui.onModeChange();
      } else this.clearPending();
      return;
    }
    if (d.kind === 'pan') {
      if (d.moved) return;
      this._tap(tx, ty);
    }
  }
  _cancel(ev) {
    this.pointers.delete(ev.pointerId);
    clearTimeout(this.longTimer);
    if (!this.pointers.size) {
      this.drag = null;
      const ov = this.app.renderer.overlay;
      ov.remove = this.pending && this.pending.kind === 'remove' ? this.pending.ents : null;
      if (this.pending && this.pending.kind === 'build') ov.ghosts = this.pending.ghosts;
      else this._updateHoverGhost();
    }
  }

  _tap(tx, ty) {
    const g = this.game;
    const e = g.entAt(tx, ty);
    const me = this.me;
    const now = performance.now();
    const dbl = now - this.lastTap.t < 330 && this.lastTap.x === tx && this.lastTap.y === ty;
    this.lastTap = { t: now, x: tx, y: ty };
    const beltLike = e && (e._kind === 'belt' || e._kind === 'underground' || e._kind === 'splitter');
    clearTimeout(this._openTimer);
    if (beltLike && !dbl) {
      // wait briefly: a second tap selects the whole line instead of opening the panel
      this._openTimer = setTimeout(() => { if (this.game.ents.has(e.id)) { this.app.ui.openEntity(e); this.app.audio.play('open'); } }, 300);
      return;
    }
    if (beltLike && dbl) {
      // double tap: select the whole connected belt line
      const line = this._beltLine(e);
      this.app.ui.closeSheet();
      this.mode = 'remove';
      this.pending = { kind: 'remove', ents: line, line: true };
      this.app.renderer.overlay.remove = line;
      this.app.ui.onModeChange();
      this.app.audio.play('click');
      return;
    }
    if (e) {
      this.app.ui.openEntity(e);
      this.app.audio.play('open');
      return;
    }
    if (g.decorAt(tx, ty) || (g.resAt(tx, ty) && g.resAt(tx, ty) <= 4)) {
      if (me && me.mine && me.mine.x === tx && me.mine.y === ty) this.app.submit({ type: 'mineStop' });
      else this.app.submit({ type: 'mine', x: tx, y: ty });
      return;
    }
    if (me && me.mine) this.app.submit({ type: 'mineStop' });
    this.app.ui.closeSheet();
  }

  // --------------------------------------------------------------- per frame
  update(dt) {
    if (!this.pointers.size && (Math.abs(this.vel[0]) > 0.0005 || Math.abs(this.vel[1]) > 0.0005)) {
      const cam = this.cam;
      cam.x -= this.vel[0]; cam.y -= this.vel[1];
      const k = Math.pow(0.0025, dt);
      this.vel[0] *= k; this.vel[1] *= k;
      this._clampCam();
    }
    const keys = this._keys || {};
    const sp = 18 * dt * (keys.Shift ? 2.5 : 1);
    if (keys.w || keys.ArrowUp) this.cam.y -= sp;
    if (keys.s || keys.ArrowDown) this.cam.y += sp;
    if (keys.a || keys.ArrowLeft) this.cam.x -= sp;
    if (keys.d || keys.ArrowRight) this.cam.x += sp;
    // a pending preview follows changes in the inventory (e.g. crafting finished)
    if (this.pending && this.pending.kind === 'build' && (this._pt = (this._pt || 0) + dt) > 0.4) {
      this._pt = 0;
      const ng = this._finalize(this.pending.ghosts.map(g => this._recheck(g)));
      this.pending.ghosts = ng;
      this.app.renderer.overlay.ghosts = ng;
    }
  }

  _key(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (this.app.jintori && this.app.jintori.isOpen) return; // the map screen is on top
    this._keys ||= {};
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const onUp = ev => { const kk = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key; this._keys[kk] = false; if (kk === k) window.removeEventListener('keyup', onUp); };
    if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift'].includes(k)) {
      this._keys[k] = true;
      window.addEventListener('keyup', onUp);
      return;
    }
    const ui = this.app.ui;
    if (k === 'r') this.rotate(e.shiftKey);
    else if (k === 'q') {
      if (this.mode === 'build') this.setMode('normal');
      else if (this.app.mouseTile) { const t = this.app.mouseTile, o = this.game.entAt(t[0], t[1]); if (o) this.selectItem(o._proto.item); }
    } else if (k === 'b') ui.toggleSheet('build');
    else if (k === 'e') ui.toggleSheet('inventory');
    else if (k === 't') ui.toggleSheet('tech');
    else if (k === 'm') ui.toggleSheet('menu');
    else if (k === 'x') this.setMode(this.mode === 'remove' ? 'normal' : 'remove');
    else if (k === 'Enter' && this.pending) this.confirm();
    else if (k === 'Escape') { if (this.pending) this.clearPending(); else if (ui.sheet) ui.closeSheet(); else this.setMode('normal'); }
    else if (k === 'Enter') ui.focusChat();
    else if (/^[1-9]$/.test(k)) ui.quickSelect(parseInt(k, 10) - 1);
  }
}

export function dirVec(d) { return DIRV[d]; }
