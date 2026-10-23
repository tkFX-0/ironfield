// Touch / mouse / keyboard control: camera, tapping, building lines, removing.
import { ITEMS, ENTITIES } from './data.js';
import { dims, isRotatable } from './sim/game.js';
import { drillArea } from './sim/machines.js';

const DIRV = [[0, -1], [1, 0], [0, 1], [-1, 0]];

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
    this._bind();
  }

  get dpr() { return this.app.dpr; }
  get cam() { return this.app.renderer.cam; }
  get game() { return this.app.session.game; }

  // --------------------------------------------------------------- modes
  selectItem(item) {
    if (!item || !ITEMS[item] || !ITEMS[item].place) { this.setMode('normal'); return; }
    if (this.mode === 'build' && this.buildItem === item) { this.setMode('normal'); return; }
    this.buildItem = item;
    this.mode = 'build';
    const P = ENTITIES[ITEMS[item].place];
    if (!isRotatable(P)) this.buildDir = 0;
    this.app.ui.onModeChange();
    this._updateHoverGhost();
  }
  setMode(m) {
    this.mode = m;
    if (m !== 'build') this.buildItem = null;
    this.app.renderer.overlay.ghosts = [];
    this.app.renderer.overlay.remove = null;
    this.app.renderer.overlay.drillArea = null;
    this.app.ui.onModeChange();
  }
  rotate(ccw = false) {
    if (this.mode === 'build') {
      this.buildDir = (this.buildDir + (ccw ? 3 : 1)) % 4;
      this.app.audio.play('rotate');
      this._updateHoverGhost();
      return;
    }
    const sel = this.app.ui.selected;
    if (sel) { this.app.submit({ type: 'rotate', id: sel.id, ccw }); this.app.audio.play('rotate'); }
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
    cam.x = Math.max(0, Math.min(g.W, cam.x));
    cam.y = Math.max(0, Math.min(g.H, cam.y));
  }

  // --------------------------------------------------------------- ghosts
  _ghostFor(item, x, y, dir, arrow = true) {
    const g = this.game;
    const name = ITEMS[item].place;
    const P = ENTITIES[name];
    const [w, h] = dims(P, isRotatable(P) ? dir : 0);
    const gx = x - Math.floor((w - 1) / 2), gy = y - Math.floor((h - 1) / 2);
    let chk = g.canPlace(name, gx, gy, dir);
    // dragging belts over belts re-points them
    if (!chk.ok && P.kind === 'belt') {
      const o = g.entAt(gx, gy);
      if (o && o._kind === 'belt') chk = { ok: true, dir };
    }
    return { name, x: gx, y: gy, dir: chk.dir ?? dir, ok: chk.ok, reason: chk.reason, ut: chk.ut, arrow: arrow && isRotatable(P) };
  }
  _lineGhosts(sx, sy, ex, ey) {
    const item = this.buildItem;
    const P = ENTITIES[ITEMS[item].place];
    if (P.w > 1 || P.h > 1) return [this._ghostFor(item, ex, ey, this.buildDir)];
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
    const ghosts = [];
    const isBelt = P.kind === 'belt';
    let dirs = pts.map(() => this.buildDir);
    if (pts.length > 1 && (isBelt || P.kind === 'underground' || P.kind === 'inserter' || P.kind === 'pipe-to-ground')) {
      dirs = pts.map((p, i) => {
        const q = pts[i + 1] || p, o = pts[i - 1] || p;
        const dx = i < pts.length - 1 ? q[0] - p[0] : p[0] - o[0];
        const dy = i < pts.length - 1 ? q[1] - p[1] : p[1] - o[1];
        return dx > 0 ? 1 : dx < 0 ? 3 : dy > 0 ? 2 : 0;
      });
      if (P.kind === 'inserter') dirs = dirs.map(() => this.buildDir);
    }
    let sel = pts.map((_, i) => i);
    if (P.kind === 'pole') {
      const step = Math.max(1, Math.floor(P.wire) - 1);
      sel = sel.filter(i => i % step === 0 || i === pts.length - 1);
    } else if (P.kind === 'underground' || P.kind === 'pipe-to-ground') {
      sel = pts.length > 1 ? [0, pts.length - 1] : [0];
      if (P.kind === 'pipe-to-ground' && pts.length > 1) {
        // first faces back toward the start, second faces forward
        dirs[0] = (dirs[0] + 2) % 4;
      }
    }
    for (const i of sel) ghosts.push(this._ghostFor(item, pts[i][0], pts[i][1], dirs[i], i === sel[sel.length - 1] || isBelt));
    return ghosts;
  }
  _updateHoverGhost() {
    const ov = this.app.renderer.overlay;
    if (this.mode !== 'build' || !this.buildItem) { ov.ghosts = []; ov.drillArea = null; return; }
    if (this.drag && this.drag.kind === 'build') return;
    let t = this.hover;
    if (!t) {
      const cv = this.canvas;
      t = this._tile(cv.width / 2, cv.height / 2);
    }
    ov.ghosts = [this._ghostFor(this.buildItem, t[0], t[1], this.buildDir)];
    this._drillPreview(ov.ghosts[0]);
  }
  _drillPreview(gh) {
    const ov = this.app.renderer.overlay;
    const P = gh && ENTITIES[gh.name];
    if (P && P.kind === 'drill') ov.drillArea = drillArea({ x: gh.x, y: gh.y, _proto: P });
    else ov.drillArea = null;
    const it = this.buildItem && ITEMS[this.buildItem];
    const PE = it && ENTITIES[it.place];
    ov.showPower = !!(PE && (PE.kind === 'pole' || PE.elec || PE.kind === 'engine' || PE.kind === 'solar'));
  }
  _placeGhosts(ghosts) {
    let placed = 0;
    for (const gh of ghosts) {
      if (!gh.ok) continue;
      const o = this.game.entAt(gh.x, gh.y);
      if (o && o._kind === 'belt') {
        if (o.dir === gh.dir && o.name === gh.name) continue;
        this.app.submit({ type: 'build', item: this.buildItem, x: gh.x, y: gh.y, dir: gh.dir, replace: true });
      } else this.app.submit({ type: 'build', item: this.buildItem, x: gh.x, y: gh.y, dir: gh.dir });
      placed++;
    }
    if (placed) this.app.audio.play('place', { pitch: 0.95 + Math.random() * 0.1 });
    else if (ghosts.length && !ghosts[0].ok && ghosts[0].reason) { this.app.ui.toast(ghosts[0].reason, 'err'); this.app.audio.play('error'); }
    if (ghosts.length && ghosts[ghosts.length - 1].dir !== undefined && ENTITIES[ghosts[0].name].kind === 'belt') this.buildDir = ghosts[ghosts.length - 1].dir;
  }

  // --------------------------------------------------------------- pointer handling
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this._down(e));
    c.addEventListener('pointermove', e => this._move(e));
    c.addEventListener('pointerup', e => this._up(e));
    c.addEventListener('pointercancel', e => this._cancel(e));
    c.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { this.hover = null; } });
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const [sx, sy] = this._local(e);
      this.zoomAt(sx, sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });
    // iOS Safari pinch gesture events would zoom the page; block them
    document.addEventListener('gesturestart', e => e.preventDefault());
    window.addEventListener('keydown', e => this._key(e));
  }

  _down(ev) {
    this.app.audio.unlock();
    this.canvas.setPointerCapture(ev.pointerId);
    const [sx, sy] = this._local(ev);
    this.pointers.set(ev.pointerId, { sx, sy, x0: sx, y0: sy, t0: performance.now(), type: ev.pointerType, button: ev.button });
    this.vel = [0, 0];
    this.app.ui.hideQuickMenu();
    if (this.pointers.size === 2) {
      // switch to pinch; abandon a single-finger action
      clearTimeout(this.longTimer);
      if (this.drag && this.drag.kind === 'build') this._updateHoverGhost();
      this.app.renderer.overlay.remove = null;
      const [a, b] = [...this.pointers.values()];
      this.drag = { kind: 'pinch', dist: Math.hypot(a.sx - b.sx, a.sy - b.sy), mx: (a.sx + b.sx) / 2, my: (a.sy + b.sy) / 2 };
      return;
    }
    if (this.pointers.size > 2) return;
    const [tx, ty] = this._tile(sx, sy);
    if (ev.pointerType === 'mouse' && ev.button === 2) {
      this.drag = { kind: 'remove', set: new Map(), mouseRight: true };
      this._addRemove(tx, ty);
      return;
    }
    if (ev.pointerType === 'mouse' && ev.button === 1) { this.drag = { kind: 'pan', moved: true }; return; }
    if (this.mode === 'build') {
      this.drag = { kind: 'build', sx: tx, sy: ty };
      this.app.renderer.overlay.ghosts = this._lineGhosts(tx, ty, tx, ty);
      this._drillPreview(this.app.renderer.overlay.ghosts[0]);
    } else if (this.mode === 'remove') {
      this.drag = { kind: 'remove', set: new Map() };
      this._addRemove(tx, ty);
    } else {
      this.drag = { kind: 'pan', moved: false, tx, ty };
      const e = this.game.entAt(tx, ty);
      if (e && ev.pointerType !== 'mouse') {
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
      this.hover = this._tile(sx, sy);
      if (this.mode === 'build') this._updateHoverGhost();
      this.app.mouseTile = this.hover;
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
      this.app.renderer.overlay.ghosts = this._lineGhosts(d.sx, d.sy, tx, ty);
      this._drillPreview(this.app.renderer.overlay.ghosts[0]);
    } else if (d.kind === 'remove') this._addRemove(tx, ty);
  }

  _addRemove(tx, ty) {
    const e = this.game.entAt(tx, ty);
    if (e && !this.drag.set.has(e.id)) {
      this.drag.set.set(e.id, e);
      this.app.renderer.overlay.remove = [...this.drag.set.values()];
    }
  }

  _up(ev) {
    const p = this.pointers.get(ev.pointerId);
    this.pointers.delete(ev.pointerId);
    clearTimeout(this.longTimer);
    const d = this.drag;
    if (!p || !d) return;
    if (d.kind === 'pinch') {
      if (this.pointers.size === 0) this.drag = null;
      else this.drag = { kind: 'none' };
      return;
    }
    if (this.pointers.size > 0) return;
    this.drag = null;
    const [sx, sy] = this._local(ev);
    const [tx, ty] = this._tile(sx, sy);
    if (d.kind === 'build') {
      this._placeGhosts(this.app.renderer.overlay.ghosts);
      if (p.type === 'mouse') { this.hover = [tx, ty]; }
      this._updateHoverGhost();
      return;
    }
    if (d.kind === 'remove') {
      const list = [...d.set.values()];
      for (const e of list) this.app.submit({ type: 'remove', id: e.id });
      if (list.length) this.app.audio.play('remove');
      this.app.renderer.overlay.remove = null;
      if (list.some(e => e === this.app.ui.selected)) this.app.ui.closeSheet();
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
      this.app.renderer.overlay.remove = null;
      this._updateHoverGhost();
    }
  }

  _tap(tx, ty) {
    const g = this.game;
    const e = g.entAt(tx, ty);
    const me = g.players.get(this.app.session.localPid);
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
    // keyboard pan
    const keys = this._keys || {};
    const sp = 18 * dt * (keys.Shift ? 2.5 : 1);
    if (keys.w || keys.ArrowUp) this.cam.y -= sp;
    if (keys.s || keys.ArrowDown) this.cam.y += sp;
    if (keys.a || keys.ArrowLeft) this.cam.x -= sp;
    if (keys.d || keys.ArrowRight) this.cam.x += sp;
    if (this.mode === 'build' && !this.drag && !this.hover) this._updateHoverGhost();
  }

  _key(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    this._keys ||= {};
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const up = () => { this._keys[k] = false; window.removeEventListener('keyup', onUp); };
    const onUp = ev => { const kk = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key; this._keys[kk] = false; if (kk === k) up(); };
    if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift'].includes(k)) {
      this._keys[k] = true;
      window.addEventListener('keyup', onUp);
      return;
    }
    const ui = this.app.ui;
    if (k === 'r') this.rotate(e.shiftKey);
    else if (k === 'q') {
      if (this.mode === 'build') this.setMode('normal');
      else if (this.hover) { const o = this.game.entAt(this.hover[0], this.hover[1]); if (o) this.selectItem(o._proto.item); }
    } else if (k === 'e') ui.toggleSheet('inventory');
    else if (k === 't') ui.toggleSheet('tech');
    else if (k === 'm') ui.toggleSheet('menu');
    else if (k === 'x') this.setMode(this.mode === 'remove' ? 'normal' : 'remove');
    else if (k === 'Escape') { if (ui.sheet) ui.closeSheet(); else this.setMode('normal'); }
    else if (k === 'Enter') ui.focusChat();
    else if (/^[1-9]$/.test(k)) ui.quickSelect(parseInt(k, 10) - 1);
  }
}

export function dirVec(d) { return DIRV[d]; }
