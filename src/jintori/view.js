// The Japan map screen: pick your prefecture, look around, put flags made in the factory on squares.
import { GRID, PREFS, BRIDGES } from './japan.js';
import * as J from './rules.js';
import { LocalJintori } from './store.js';
import { invCount } from '../sim/inventory.js';
import { iconHTML } from '../ui/icons.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const REGIONS = [['北海道・東北', 1, 7], ['関東', 8, 14], ['中部', 15, 23], ['近畿', 24, 30], ['中国', 31, 35], ['四国', 36, 39], ['九州・沖縄', 40, 47]];
const HUE = PREFS.map(p => (p ? parseFloat(p.color.slice(4)) : 0));
const LAND = PREFS.map((p, k) => (p ? `hsl(${HUE[k]},14%,27%)` : '#000')); // unclaimed land, faintly in its prefecture's colour
const SEA = '#14202b';
const FIT = { x0: 0, y0: 0, x1: 226, y1: 222 }; // the main islands and Okinawa (far Pacific islands stay off the first view)

export class JintoriView {
  constructor(app) {
    this.app = app;
    this.store = new LocalJintori();
    this.isOpen = false;
    this.sel = -1;
    this.pending = null;   // a flag sent to the factory, waiting for it to leave the inventory
    this.msg = null;       // { text, kind } shown on the card after an action
    this.sheet = null;     // 'pref' | 'rank'
    this.cam = null;
    this.at = new Int32Array(GRID.cols * GRID.rows).fill(-1);
    for (let i = 0; i < J.N; i++) this.at[J.cellY(i) * GRID.cols + J.cellX(i)] = i;
    this._front = null;
  }

  // ------------------------------------------------------------ open / close
  open() {
    if (!this.el) this._build();
    this.store.refresh(Date.now());
    this._front = null;
    this.isOpen = true;
    this.el.hidden = false;
    if (!this.cam) this._initCam();
    if (!this.store.pref) this.sheet = 'pref';
    this._resize();
    this._renderAll();
    this.app.audio.play('open');
  }
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.hidden = true;
    this.sheet = null;
    this.app.audio.play('close');
  }

  // called from the frame loop while open
  update(now) {
    if (now - (this._lastUi || 0) < 500) return;
    this._lastUi = now;
    if (this.store.refresh(Date.now())) { this._front = null; this._draw(); }
    if (this.pending && now - this.pending.t > 6000) { this.pending = null; this._renderCard(); }
    const sig = this._flags() + ':' + this.store.wallet.allow + ':' + Math.floor(Date.now() / 60000);
    if (sig !== this._statusSig) { this._statusSig = sig; this._renderStatus(); this._renderCard(); }
  }

  // the factory took one flag out of the inventory: it lands on the map now
  onFlagUsed(e) {
    this.pending = null;
    const r = this.store.commit(e.cell, Date.now());
    const P = PREFS[this.store.pref];
    if (!r.kind) this.msg = { text: '旗は使いましたが、マスが変わっていて取れませんでした: ' + r.why, kind: 'err' };
    else if (r.kind === 'take') this.msg = { text: `このマスを${P.name}のものにしました`, kind: 'good' };
    else if (r.kind === 'defend') this.msg = { text: `守りが ${r.def} になりました`, kind: 'good' };
    else if (r.captured) this.msg = { text: `このマスを奪って${P.name}のものにしました`, kind: 'good' };
    else this.msg = { text: `守りを1つ崩しました（のこり ${r.def}）`, kind: 'good' };
    this.app.audio.play(r.kind ? 'research-done' : 'error');
    this._front = null;
    if (this.isOpen) { this._draw(); this._renderStatus(); this._renderCard(); if (this.sheet === 'rank') this._renderSheet(); }
  }
  onError(text) {
    if (!this.pending) return;
    this.pending = null;
    this.msg = { text, kind: 'err' };
    if (this.isOpen) this._renderCard();
  }

  // small summary for the factory HUD chip
  chipText() {
    if (Date.now() - (this._chipAt || 0) > 30000) { this._chipAt = Date.now(); this.store.refresh(Date.now()); }
    return { allow: this.store.wallet.allow, flags: this._flags() };
  }

  // ------------------------------------------------------------ DOM
  _build() {
    const el = document.createElement('div');
    el.id = 'jintori';
    el.hidden = true;
    el.innerHTML = `
      <header class="jt-top panel">
        <button class="btn small" data-j="close" aria-label="工場へ戻る">← 工場へ</button>
        <div class="jt-title"><b>陣取り</b> <span class="muted" id="jt-season"></span></div>
        <button class="btn small" data-j="rank">順位</button>
      </header>
      <div class="jt-status panel" id="jt-status"></div>
      <div class="jt-mapwrap"><canvas id="jt-map" aria-label="日本地図のマス。タップで選びます"></canvas>
        <div class="jt-zoom"><button class="btn icon" data-j="zin" aria-label="大きく">＋</button><button class="btn icon" data-j="zout" aria-label="小さく">－</button><button class="btn icon" data-j="home" aria-label="自分の県へ">⌂</button></div>
        <div class="jt-note">見本：ほかの人の動きは、コンピューターがまねしています</div></div>
      <div class="jt-card panel" id="jt-card"></div>
      <div class="jt-sheet panel" id="jt-sheet" hidden role="dialog"></div>`;
    document.body.appendChild(el);
    this.el = el;
    this.canvas = el.querySelector('#jt-map');
    this.ctx = this.canvas.getContext('2d');
    el.addEventListener('click', e => this._click(e));
    this._gestures();
    window.addEventListener('resize', () => { if (this.isOpen) { this._resize(); this._draw(); } });
    window.addEventListener('keydown', e => { if (this.isOpen && e.key === 'Escape') { if (this.sheet && this.store.pref) { this.sheet = null; this._renderSheet(); } else this.close(); } });
  }

  _click(e) {
    const t = e.target.closest('[data-j]');
    if (!t) return;
    this.app.audio.unlock();
    const a = t.dataset.j;
    switch (a) {
      case 'close': this.close(); break;
      case 'rank': this.sheet = this.sheet === 'rank' ? null : 'rank'; this._renderSheet(); this.app.audio.play('click'); break;
      case 'pref-open': if (this.store.canChoosePref()) { this.sheet = 'pref'; this._renderSheet(); } else { this.msg = { text: 'このシーズンは旗を使ったので、県は来月まで変えられません', kind: 'err' }; this._renderCard(); } break;
      case 'pref': {
        const p = parseInt(t.dataset.p, 10);
        if (this.store.choosePref(p)) {
          this.sheet = null; this._front = null; this.sel = -1;
          this.msg = { text: `${PREFS[p].name}の一員になりました。県庁のとなりのマスから広げていきましょう`, kind: 'good' };
          this._focus(PREFS[p].capital, 14);
          this._renderAll();
          this.app.audio.play('research-done');
        }
        break;
      }
      case 'sheet-close': this.sheet = null; this._renderSheet(); break;
      case 'use': this._useFlag(); break;
      case 'zin': this._zoomAt(this.cssW / 2, this.cssH / 2, 1.6); break;
      case 'zout': this._zoomAt(this.cssW / 2, this.cssH / 2, 1 / 1.6); break;
      case 'home': if (this.store.pref) this._focus(PREFS[this.store.pref].capital, 14); else this._fitAll(); this._draw(); break;
      case 'goto': { const i = parseInt(t.dataset.i, 10); this.sheet = null; this._renderSheet(); this._focus(i, 10); this._draw(); break; }
      default: break;
    }
  }

  _flags() {
    const s = this.app.session;
    const me = s && s.game && s.game.players.get(s.localPid);
    return me ? invCount(me.inv, 'flag') : 0;
  }

  _useFlag() {
    const i = this.sel, st = this.store;
    const a = st.action(i);
    if (!a.kind || this.pending) return;
    st.refresh(Date.now());
    if (st.wallet.allow <= 0) { this.msg = { text: '今日の旗はもう使い切りました。朝5時に3本増えます', kind: 'err' }; this._renderCard(); return; }
    if (this._flags() < 1) { this.msg = { text: '旗を持っていません。工場で作りましょう', kind: 'err' }; this._renderCard(); return; }
    const nonce = (Math.random() * 1e9) | 0;
    this.pending = { cell: i, nonce, t: performance.now() };
    this.msg = null;
    this.app.submit({ type: 'useFlag', cell: i, nonce });
    this.app.audio.play('place');
    this._renderCard();
  }

  _renderAll() { this._renderStatus(); this._renderCard(); this._renderSheet(); this._draw(); }

  _renderStatus() {
    const st = this.store, w = st.wallet, P = PREFS[st.pref];
    const m = /^(\d+)-(\d+)$/.exec(w.season || '');
    this.el.querySelector('#jt-season').textContent = m ? `${parseInt(m[2], 10)}月のシーズン` : '';
    const left = J.nextResetAt(Date.now()) - Date.now();
    const hh = Math.floor(left / 3600000), mm = Math.floor(left / 60000) % 60;
    const pips = Array.from({ length: J.MAX_ALLOW }, (_, k) => `<i class="${k < w.allow ? 'on' : ''}"></i>`).join('');
    this.el.querySelector('#jt-status').innerHTML = `
      <button class="jt-pref" data-j="pref-open" aria-label="自分の県">${P ? `<span class="dot" style="background:${P.color}"></span><b>${esc(P.name)}</b>` : '<b>県を選ぶ</b>'}</button>
      <div class="jt-stat"><span class="muted">今日使える旗</span><div class="row" style="gap:6px;flex-wrap:nowrap"><b class="big">${w.allow}</b><span class="jt-pips" aria-hidden="true">${pips}</span></div></div>
      <div class="jt-stat"><span class="muted">持っている旗</span><div class="row" style="gap:4px;flex-wrap:nowrap">${iconHTML('item:flag', 22)}<b class="big">${this._flags()}</b></div></div>
      <div class="jt-stat"><span class="muted">朝5時に3本ふえる</span><b>あと${hh}時間${mm}分</b></div>
      ${w.streak > 1 && w.lastDay >= J.dayIndex(Date.now()) - 1 ? `<div class="jt-stat"><span class="muted">続けた日数</span><b>${w.streak}日</b></div>` : ''}`;
  }

  _renderCard() {
    const card = this.el.querySelector('#jt-card'), st = this.store, i = this.sel;
    const msg = this.msg ? `<div class="jt-msg ${this.msg.kind}">${esc(this.msg.text)}</div>` : '';
    if (i < 0) {
      card.innerHTML = `${msg}<div class="muted" style="font-size:13px">${st.pref
        ? '光っているマスをタップすると、旗を使えます。旗は工場で作り、持ち物に入れておきます（持ち物 → クラフト → 素材 → 旗）。'
        : '最初に、自分の都道府県を選んでください。'}</div>`;
      return;
    }
    const home = PREFS[J.cellHome(i)], o = st.map.owner[i], def = st.map.def[i], cap = J.capitalOf(i);
    const owner = o ? `<span class="chip"><span class="dot" style="background:${PREFS[o].color}"></span>${esc(PREFS[o].name)}</span>` : '<span class="chip">だれのものでもない</span>';
    const defPips = cap ? '<b>県庁（取られません）</b>' : o ? `<span class="jt-pips def">${Array.from({ length: J.MAX_DEF }, (_, k) => `<i class="${k < def ? 'on' : ''}"></i>`).join('')}</span><span class="muted">${def} / ${J.MAX_DEF}</span>` : '<span class="muted">なし</span>';
    const a = st.action(i);
    let btn = '', why = '';
    if (a.kind) {
      const label = a.kind === 'take' ? '旗を1本使って取る'
        : a.kind === 'defend' ? '旗を1本使って守りを上げる'
        : def > 0 ? `旗を1本使って守りを崩す（取るまで あと${def + 1}本）` : '旗を1本使って奪う';
      const noFlag = this._flags() < 1, noAllow = st.wallet.allow <= 0;
      btn = `<button class="btn primary jt-use" data-j="use" ${noFlag || noAllow || this.pending ? 'disabled' : ''}>${iconHTML('item:flag', 22)}${this.pending ? '旗を運んでいます…' : label}</button>`;
      if (noAllow) why = '今日の旗はもう使い切りました。朝5時に3本増えます（使わなかった分は2日分までたまります）。';
      else if (noFlag) why = '旗を持っていません。工場で作って、持ち物に入れておきましょう。';
    } else why = a.why;
    card.innerHTML = `${msg}
      <div class="row" style="gap:8px"><b>${esc(home.name)}のマス</b>${owner}</div>
      <div class="row" style="gap:6px"><span class="muted">守り</span>${defPips}</div>
      ${btn}${why ? `<div class="muted" style="font-size:12px">${esc(why)}</div>` : ''}`;
  }

  _renderSheet() {
    const sh = this.el.querySelector('#jt-sheet'), st = this.store;
    if (!this.sheet) { sh.hidden = true; return; }
    sh.hidden = false;
    if (this.sheet === 'pref') {
      sh.innerHTML = `<header><b>自分の都道府県を選ぶ</b>${st.pref ? '<button class="btn small" data-j="sheet-close">閉じる</button>' : ''}</header>
        <div class="body"><div class="muted" style="font-size:12px">住んでいる県でも、好きな県でもかまいません。このシーズン中に旗を1本でも使うと、来月まで変えられません。</div>
        ${REGIONS.map(([name, a, b]) => `<div class="jt-region"><h3>${name}</h3><div class="jt-prefs">${PREFS.slice(a, b + 1).map((p, k) => `<button class="btn small ${a + k === st.pref ? 'on' : ''}" data-j="pref" data-p="${a + k}"><span class="dot" style="background:${p.color}"></span>${esc(p.short)}</button>`).join('')}</div></div>`).join('')}</div>`;
    } else {
      const rk = J.ranking(st.map);
      const max = Math.max(1, rk[0].n);
      sh.innerHTML = `<header><b>マスの数の順位</b><button class="btn small" data-j="sheet-close">閉じる</button></header>
        <div class="body">${rk.map((r, k) => `<div class="jt-rank ${r.pref === st.pref ? 'me' : ''}" data-j="goto" data-i="${PREFS[r.pref].capital}" role="button" tabindex="0">
          <span class="n">${k + 1}</span><span class="dot" style="background:${PREFS[r.pref].color}"></span><span class="nm">${esc(PREFS[r.pref].name)}</span>
          <span class="bar"><i style="width:${(r.n / max * 100).toFixed(1)}%;background:${PREFS[r.pref].color}"></i></span><b>${r.n}</b></div>`).join('')}</div>`;
    }
  }

  // ------------------------------------------------------------ camera and gestures
  _resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = Math.max(1, r.width); this.cssH = Math.max(1, r.height);
    this.canvas.width = Math.round(this.cssW * this.dpr); this.canvas.height = Math.round(this.cssH * this.dpr);
  }
  _initCam() {
    this._resize();
    if (this.store.pref) this._focus(PREFS[this.store.pref].capital, 14);
    else this._fitAll();
  }
  _fitAll() {
    const s = Math.min(this.cssW / (FIT.x1 - FIT.x0), this.cssH / (FIT.y1 - FIT.y0));
    this.cam = { x: (FIT.x0 + FIT.x1) / 2, y: (FIT.y0 + FIT.y1) / 2, s };
  }
  _focus(i, s) { this.cam = { x: J.cellX(i) + 0.5, y: J.cellY(i) + 0.5, s: Math.max(this.cam ? this.cam.s : 0, s) }; }
  _zoomAt(px, py, f) {
    const c = this.cam;
    const wx = (px - this.cssW / 2) / c.s + c.x, wy = (py - this.cssH / 2) / c.s + c.y;
    c.s = Math.max(1, Math.min(60, c.s * f));
    c.x = wx - (px - this.cssW / 2) / c.s; c.y = wy - (py - this.cssH / 2) / c.s;
    this._draw();
  }
  _atXY(x, y) { return x < 0 || y < 0 || x >= GRID.cols || y >= GRID.rows ? -1 : this.at[y * GRID.cols + x]; }
  _cellAt(px, py) {
    const c = this.cam;
    const x = Math.floor((px - this.cssW / 2) / c.s + c.x), y = Math.floor((py - this.cssH / 2) / c.s + c.y);
    if (x < 0 || y < 0 || x >= GRID.cols || y >= GRID.rows) return -1;
    return this.at[y * GRID.cols + x];
  }
  _gestures() {
    const cv = this.canvas, pts = new Map();
    let start = null, pinch = null;
    const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, pos(e));
      if (pts.size === 1) start = { p: pos(e), t: performance.now(), moved: false };
      else { start && (start.moved = true); const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; }
    });
    cv.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId), p = pos(e);
      pts.set(e.pointerId, p);
      if (pts.size === 1) {
        if (start && Math.hypot(p[0] - start.p[0], p[1] - start.p[1]) > 8) start.moved = true;
        if (start && start.moved) { this.cam.x -= (p[0] - prev[0]) / this.cam.s; this.cam.y -= (p[1] - prev[1]) / this.cam.s; this._draw(); }
      } else if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        // pan with the midpoint, zoom with the spread
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const pm = pinch.m || [mx, my];
        this.cam.x -= (mx - pm[0]) / this.cam.s; this.cam.y -= (my - pm[1]) / this.cam.s;
        pinch.m = [mx, my];
        if (pinch.d > 0) this._zoomAt(mx, my, d / pinch.d);
        pinch.d = d;
      }
    });
    const up = e => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0 && start && !start.moved && performance.now() - start.t < 600) this._tap(start.p[0], start.p[1]);
      if (pts.size === 0) start = null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', e => { e.preventDefault(); const [x, y] = pos(e); this._zoomAt(x, y, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  }
  _tap(px, py) {
    const i = this._cellAt(px, py);
    this.sel = i === this.sel ? -1 : i;
    this.msg = null;
    if (this.sel >= 0) this.app.audio.play('click');
    this._renderCard();
    this._draw();
  }

  // ------------------------------------------------------------ drawing
  _frontier() {
    if (this._front) return this._front;
    const f = new Uint8Array(J.N), st = this.store;
    if (st.pref) for (let i = 0; i < J.N; i++) { const k = st.action(i).kind; if (k === 'take' || k === 'attack') f[i] = 1; }
    return (this._front = f);
  }
  _draw() {
    if (!this.isOpen || !this.cam) return;
    const ctx = this.ctx, c = this.cam, s = c.s, W = this.cssW, H = this.cssH, m = this.store.map, me = this.store.pref;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = SEA; ctx.fillRect(0, 0, W, H);
    const ox = W / 2 - c.x * s, oy = H / 2 - c.y * s;
    const vis = i => { const x = J.cellX(i) * s + ox, y = J.cellY(i) * s + oy; return x > -s && y > -s && x < W && y < H; };
    // sea crossings
    ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(140,175,205,.45)'; ctx.lineWidth = 1; ctx.beginPath();
    for (const [a, b] of BRIDGES) { ctx.moveTo((J.cellX(a) + 0.5) * s + ox, (J.cellY(a) + 0.5) * s + oy); ctx.lineTo((J.cellX(b) + 0.5) * s + ox, (J.cellY(b) + 0.5) * s + oy); }
    ctx.stroke(); ctx.setLineDash([]);
    // squares
    const pad = s > 3 ? 0.5 : 0.8;
    for (let i = 0; i < J.N; i++) {
      if (!vis(i)) continue;
      const o = m.owner[i];
      ctx.fillStyle = o ? PREFS[o].color : LAND[J.cellHome(i)];
      ctx.fillRect(J.cellX(i) * s + ox, J.cellY(i) * s + oy, s + pad, s + pad);
    }
    // prefecture borders (where the land is) and territory borders (who owns it)
    const home = new Path2D(), terr = new Path2D();
    for (let i = 0; i < J.N; i++) {
      if (!vis(i)) continue;
      const x = J.cellX(i), y = J.cellY(i);
      const R = x + 1 < GRID.cols ? this.at[y * GRID.cols + x + 1] : -1, D = y + 1 < GRID.rows ? this.at[(y + 1) * GRID.cols + x] : -1;
      const sx = x * s + ox, sy = y * s + oy;
      if (R >= 0 && J.cellHome(R) !== J.cellHome(i)) { home.moveTo(sx + s, sy); home.lineTo(sx + s, sy + s); }
      if (D >= 0 && J.cellHome(D) !== J.cellHome(i)) { home.moveTo(sx, sy + s); home.lineTo(sx + s, sy + s); }
      if (R >= 0 && m.owner[R] !== m.owner[i]) { terr.moveTo(sx + s, sy); terr.lineTo(sx + s, sy + s); }
      if (D >= 0 && m.owner[D] !== m.owner[i]) { terr.moveTo(sx, sy + s); terr.lineTo(sx + s, sy + s); }
    }
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1; ctx.stroke(home);
    if (s >= 3) { ctx.strokeStyle = 'rgba(10,10,10,.85)'; ctx.lineWidth = Math.min(2.5, s / 5); ctx.stroke(terr); }
    // your prefecture's land gets a bright edge so it is easy to find
    if (me) {
      const mine = new Path2D();
      for (let i = 0; i < J.N; i++) {
        if (m.owner[i] !== me || !vis(i)) continue;
        const x = J.cellX(i), y = J.cellY(i), sx = x * s + ox, sy = y * s + oy;
        const own = (dx, dy) => { const j = this._atXY(x + dx, y + dy); return j >= 0 && m.owner[j] === me; };
        if (!own(0, -1)) { mine.moveTo(sx, sy); mine.lineTo(sx + s, sy); }
        if (!own(1, 0)) { mine.moveTo(sx + s, sy); mine.lineTo(sx + s, sy + s); }
        if (!own(0, 1)) { mine.moveTo(sx, sy + s); mine.lineTo(sx + s, sy + s); }
        if (!own(-1, 0)) { mine.moveTo(sx, sy); mine.lineTo(sx, sy + s); }
      }
      ctx.lineCap = 'round'; ctx.strokeStyle = '#111'; ctx.lineWidth = Math.max(3, Math.min(6, s / 4)); ctx.stroke(mine);
      ctx.strokeStyle = '#ffe2b0'; ctx.lineWidth = Math.max(1.5, Math.min(3, s / 8)); ctx.stroke(mine); ctx.lineCap = 'butt';
    }
    // where your flags can go
    if (me && s >= 4) {
      const f = this._frontier(), t = performance.now() / 1000;
      ctx.strokeStyle = `rgba(255,236,190,${0.55 + 0.25 * Math.sin(t * 3)})`; ctx.lineWidth = Math.max(1, Math.min(2, s / 8));
      const inset = Math.max(1, s * 0.12);
      ctx.beginPath();
      for (let i = 0; i < J.N; i++) if (f[i] && vis(i)) ctx.rect(J.cellX(i) * s + ox + inset, J.cellY(i) * s + oy + inset, s - 2 * inset, s - 2 * inset);
      ctx.stroke();
    }
    // defence pips and offices
    for (let i = 0; i < J.N; i++) {
      if (!vis(i)) continue;
      const sx = J.cellX(i) * s + ox, sy = J.cellY(i) * s + oy;
      if (J.capitalOf(i)) {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
        const r = Math.max(2, Math.min(s * 0.36, 9));
        star(ctx, sx + s / 2, sy + s / 2, r); ctx.stroke(); ctx.fill();
      } else if (m.def[i] && s >= 14) {
        const n = m.def[i], r = Math.min(2.4, s / 12), gap = r * 2.6;
        ctx.fillStyle = 'rgba(255,255,255,.9)';
        for (let k = 0; k < n; k++) { ctx.beginPath(); ctx.arc(sx + s / 2 + (k - (n - 1) / 2) * gap, sy + s - r * 2.2, r, 0, Math.PI * 2); ctx.fill(); }
      }
    }
    // selection
    if (this.sel >= 0) {
      ctx.strokeStyle = '#ffc677'; ctx.lineWidth = 3;
      ctx.strokeRect(J.cellX(this.sel) * s + ox - 1, J.cellY(this.sel) * s + oy - 1, s + 2, s + 2);
    }
    // prefecture names at their offices
    if (s >= 2.5) {
      const fs = Math.max(10, Math.min(15, s * 1.2));
      ctx.font = `700 ${fs}px 'M PLUS 1p', 'Hiragino Sans', sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)';
      for (let p = 1; p <= 47; p++) {
        const i = PREFS[p].capital;
        if (!vis(i)) continue;
        if (s < 6 && p !== me && (p - 1) % 2) continue; // thin out when far away
        const x = (J.cellX(i) + 0.5) * s + ox, y = J.cellY(i) * s + oy - 1;
        ctx.strokeText(PREFS[p].short, x, y); ctx.fillStyle = p === me ? '#ffe2b0' : '#fff'; ctx.fillText(PREFS[p].short, x, y);
      }
    }
    // keep the "you can put a flag here" outline breathing
    if (me && s >= 4 && !this._anim) { this._anim = true; requestAnimationFrame(() => { this._anim = false; this._draw(); }); }
  }
}

function star(ctx, x, y, r) {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}
