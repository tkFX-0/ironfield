// HUD and panels (DOM). Panels re-render from game state a few times a second; clicks use data-a delegation.
import { ITEMS, RECIPES, RECIPE_LIST, TECHS, TECH_LIST, FLUIDS, ENTITIES, RESOURCES, ROCKET_PARTS, recipeName } from '../data.js';
import { invCount } from '../sim/inventory.js';
import { iconHTML } from './icons.js';
import { isFuel, smeltRecipe, drillArea } from '../sim/machines.js';
import { isRotatable } from '../sim/game.js';
import { plotOfRoom } from '../net/session.js';
import { PREFS } from '../jintori/japan.js';
import { PLOT_AT, PLOT_COLS, PLOT_ROWS, plotAtCell } from '../plots.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = n => (n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n));
const fmtW = j => { const w = j * 60; return w >= 1e6 ? (w / 1e6).toFixed(2) + ' MW' : (w / 1e3).toFixed(w >= 1e5 ? 0 : 1) + ' kW'; };
const itemJa = n => (ITEMS[n] ? ITEMS[n].ja : FLUIDS[n] ? FLUIDS[n].ja : n);
const SVG = {
  bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
  flask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/><path d="M7.5 15h9"/></svg>',
  pick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4c3 0 6 2 7 5-3-2-6-2-9-1"/><path d="M14 4c-2 2-3 5-2 8"/><path d="M12 9 3 20"/></svg>',
  rot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 4v5h-5"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  hammer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 5l5 5-2 2-5-5z"/><path d="M12 7 4 15l3 3 8-8"/><path d="M15 4l2-1 4 4-1 2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.5c3 0 5.5 1.5 5.5 4.5"/></svg>',
};

export class UI {
  constructor(app) {
    this.app = app;
    this.sheet = null;      // 'inventory' | 'tech' | 'menu' | 'entity'
    this.selected = null;   // entity for the entity sheet
    this.invTab = 'craft';
    this.craftGroup = 'logistics';
    this.mult = 1;
    this.tipRecipe = null;
    this.pickRecipe = false;
    this.lastSig = '';
    this.chatLines = [];
    this.lastRender = 0;
    this._build();
  }
  get g() { return this.app.session.game; }
  get me() { return this.g.players.get(this.app.session.localPid); }

  // ------------------------------------------------------------ static HUD
  _build() {
    const hud = document.getElementById('hud');
    hud.innerHTML = `
      <div id="labels"></div>
      <div id="topbar">
        <div class="col" style="gap:6px;max-width:52vw;pointer-events:none">
          <div id="research-chip" class="panel" data-a="sheet" data-s="tech" role="button" tabindex="0" aria-label="研究" style="pointer-events:auto">
            <span id="rc-icon"></span>
            <div style="min-width:0;flex:1"><div class="t" id="rc-name">研究を選ぶ</div><div class="bar"><i id="rc-bar"></i></div></div>
          </div>
          <div id="goal-chip" class="panel" data-a="goal-toggle" role="button" tabindex="0" style="pointer-events:auto"></div>
        </div>
        <div class="sp"></div>
        <div class="col" style="gap:6px;align-items:flex-end">
          <div id="netbadge" class="panel" data-a="sheet" data-s="menu" role="button" tabindex="0" aria-label="メニュー"></div>
          <div id="flag-chip" class="panel" data-a="jintori" role="button" tabindex="0" aria-label="陣取りの地図"></div>
        </div>
        <div id="minimap-wrap" class="panel"><canvas id="minimap" width="256" height="256" aria-label="地図"></canvas></div>
      </div>
      <div id="toasts" aria-live="polite"></div>
      <div id="chatlog"></div>
      <div id="sheet-backdrop" hidden></div>
      <div id="sheet" class="sheet panel" hidden role="dialog"><header id="sheet-head"></header><div class="body" id="sheet-body"></div></div>
      <div id="quickmenu" class="panel" hidden></div>
      <div id="bottom">
        <div id="viewbar" class="panel" hidden></div>
        <div id="buildbar" class="panel" hidden></div>
        <div id="dock">
          <div class="side panel">
            <button class="btn dockbtn primary" data-a="sheet" data-s="build" aria-label="建設メニュー">${SVG.hammer}<span>建設</span></button>
            <button class="btn dockbtn" id="btn-remove" data-a="mode-remove" aria-label="撤去モード">${SVG.pick}<span>撤去</span></button>
          </div>
          <div id="quickbar" class="panel" aria-label="設置できる物"></div>
          <div class="side panel">
            <button class="btn dockbtn" data-a="sheet" data-s="inventory" aria-label="持ち物とクラフト">${SVG.bag}<span>持ち物</span></button>
            <button class="btn dockbtn wide-only" data-a="sheet" data-s="tech" aria-label="研究">${SVG.flask}<span>研究</span></button>
            <button class="btn dockbtn wide-only" data-a="sheet" data-s="menu" aria-label="メニュー">${SVG.menu}<span>メニュー</span></button>
          </div>
        </div>
      </div>`;
    this.el = id => document.getElementById(id);
    hud.addEventListener('click', e => this._click(e));
    hud.addEventListener('pointerdown', e => this._pdown(e));
    hud.addEventListener('pointerup', () => clearTimeout(this._lp));
    hud.addEventListener('pointercancel', () => clearTimeout(this._lp));
    hud.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset && e.target.dataset.a && e.target.tagName !== 'BUTTON') this._click(e); });
    this.el('sheet-backdrop').addEventListener('click', () => this.closeSheet());
    this._initMinimap();
  }

  // ------------------------------------------------------------ actions
  _pdown(e) {
    const t = e.target.closest('[data-long]');
    if (!t) return;
    clearTimeout(this._lp);
    this._lp = setTimeout(() => { this._longFired = t; this._act(t, true); if (navigator.vibrate) navigator.vibrate(10); }, 450);
  }
  _click(e) {
    const t = e.target.closest('[data-a]');
    if (!t) return;
    clearTimeout(this._lp);
    if (this._longFired === t) { this._longFired = null; return; }
    this.app.audio.unlock();
    this._act(t, false);
  }
  _act(t, long) {
    const a = t.dataset.a, d = t.dataset, app = this.app;
    const sub = c => app.submit(c);
    switch (a) {
      case 'sheet': this.toggleSheet(d.s); break;
      case 'jintori': this.closeSheet(); app.jintori.open(); break;
      case 'goal-toggle': this.goalsOpen = !this.goalsOpen; this._goalHTML = ''; this._renderGoal(); break;
      case 'close': this.closeSheet(); break;
      case 'mode-remove': app.ctrl.setMode(app.ctrl.mode === 'remove' ? 'normal' : 'remove'); break;
      case 'mode-normal': app.ctrl.setMode('normal'); break;
      case 'confirm': app.ctrl.confirm(); break;
      case 'cancel-pending': app.ctrl.clearPending(); break;
      case 'instant': app.ctrl.setInstant(!app.ctrl.instant); break;
      case 'touchlike': app.ctrl.setTouchLike(!app.ctrl.touchLike); this.refresh(true); break;
      case 'bgroup': this.buildGroup = d.g; this.refresh(true); app.audio.play('click'); break;
      case 'build-pick': {
        const item = d.item;
        const have = invCount(this.me.inv, item);
        if (have <= 0) {
          const rec = this.g.handRecipeFor(item);
          if (rec && this._canCraft(rec.name)) {
            const n = ITEMS[item].stack >= 100 ? 5 : 1;
            sub({ type: 'craft', recipe: rec.name, count: n });
            this.toast(`${ITEMS[item].ja} を作っています。できたら置けます`);
            app.audio.play('craft-start');
          } else { this.toast(`${ITEMS[item].ja} の材料が足りません`, 'err'); app.audio.play('error'); break; }
        }
        app.ctrl.selectItem(item);
        this.closeSheet();
        break;
      }
      case 'rotate-build': app.ctrl.rotate(); break;
      case 'quick': app.ctrl.selectItem(d.item); app.audio.play('click'); break;
      case 'tab': this.invTab = d.tab; this.pickRecipe = false; this.refresh(true); app.audio.play('click'); break;
      case 'group': this.craftGroup = d.g; this.refresh(true); app.audio.play('click'); break;
      case 'mult': this.mult = +d.m; this.refresh(true); app.audio.play('click'); break;
      case 'craft':
        this.tipRecipe = d.r;
        if (long) { this.refresh(true); break; }
        sub({ type: 'craft', recipe: d.r, count: this.mult });
        app.audio.play('craft-start');
        this.refresh(true);
        break;
      case 'cancelcraft': sub({ type: 'cancelCraft' }); app.audio.play('click'); break;
      case 'inv-item': {
        const it = ITEMS[d.item];
        if (it && it.place) { app.ctrl.selectItem(d.item); this.closeSheet(); }
        else this.toast(`${it ? it.ja : d.item}（${invCount(this.me.inv, d.item)}個）`);
        break;
      }
      case 'sort': sub({ type: 'sortInv' }); break;
      case 'take': sub({ type: 'take', id: +d.id, slot: d.slot }); app.audio.play('pickup'); break;
      case 'put': sub({ type: 'put', id: +d.id, item: d.item, count: long ? -1 : +(d.n || -1) }); app.audio.play('pickup'); break;
      case 'pickrec': this.pickRecipe = !this.pickRecipe; this.refresh(true); app.audio.play('click'); break;
      case 'setrec': sub({ type: 'setRecipe', id: +d.id, recipe: d.r }); this.pickRecipe = false; app.audio.play('click'); setTimeout(() => this.refresh(true), 60); break;
      case 'research': sub({ type: 'research', tech: d.t }); app.audio.play('click'); break;
      case 'ent-rotate': if (this.selected) { sub({ type: 'rotate', id: this.selected.id }); app.audio.play('rotate'); } break;
      case 'ent-remove': if (this.selected) { sub({ type: 'remove', id: this.selected.id }); app.audio.play('remove'); this.closeSheet(); } break;
      case 'ent-pipette': if (this.selected) { app.ctrl.selectItem(this.selected._proto.item); this.closeSheet(); } break;
      case 'qm': this._quickAction(d.q); break;
      case 'copy': this._copy(d.text); break;
      case 'share': this._share(); break;
      case 'chat-send': this._sendChat(); break;
      case 'sound': app.audio.setMuted(!app.audio.muted); this.refresh(true); break;
      case 'save': app.saveNow(true); break;
      case 'quit': app.quitToTitle(); break;
      case 'visit': this.closeSheet(); app.audio.play('click'); if (+d.p === app.jintoriStore.pref) this._goHome(); else app.viewPlot(+d.p); break;
      case 'go-home': this.closeSheet(); this._goHome(); break;
      case 'give': sub({ type: 'give', item: d.item, count: 50 }); break;
      case 'home': { const s = this.g.spawn; app.renderer.cam.x = s.x; app.renderer.cam.y = s.y; this.closeSheet(); break; }
      default: break;
    }
  }

  // back to your own prefecture's plot (or the title, if you came to look before choosing one)
  _goHome() {
    const p = this.app.jintoriStore.pref;
    if (p) this.app.movePlot(p); else this.app.quitToTitle();
  }

  // ------------------------------------------------------------ public api
  onModeChange() {
    const c = this.app.ctrl;
    const bb = this.el('buildbar');
    this.el('btn-remove').classList.toggle('on', c.mode === 'remove');
    const pi = c.pendingInfo();
    this._pendSig = JSON.stringify(pi);
    const mouse = c.lastPointer === 'mouse'; // hints follow whatever the player is using now
    const asMouse = mouse && !c.touchLike;
    if (pi) {
      bb.hidden = false;
      const g0 = c.pending.kind === 'build' && c.pending.ghosts.length === 1 ? c.pending.ghosts[0] : null;
      const canRot = g0 && isRotatable(ENTITIES[g0.name]);
      const label = pi.kind === 'remove' ? `${pi.n}個を撤去` : pi.n ? `${pi.n}個置く` : '置けません';
      const sub = pi.kind === 'remove' ? (c.pending.line ? 'つながったベルトを選びました' : '囲んだ物を撤去します')
        : pi.reason && pi.n < pi.total ? pi.reason : mouse ? '予定図はドラッグで動かせます・Enter で確定' : '予定図は指で動かせます';
      bb.innerHTML = `<div style="min-width:0;max-width:38vw"><div class="name">${esc(label)}</div><div class="hint">${esc(sub)}</div></div>
        ${canRot ? `<button class="btn icon" data-a="rotate-build" aria-label="回転">${SVG.rot}</button>` : ''}
        <button class="btn icon" data-a="cancel-pending" aria-label="取り消す">${SVG.x}</button>
        <button class="btn ${pi.kind === 'remove' ? 'danger' : 'go'} confirm" data-a="confirm" ${pi.n ? '' : 'disabled'} aria-label="${esc(label)}">${SVG.check}</button>`;
    } else if (c.mode === 'build' && c.buildItem) {
      const it = ITEMS[c.buildItem];
      const P = ENTITIES[it.place];
      bb.hidden = false;
      bb.innerHTML = `${iconHTML('item:' + c.buildItem, 30)}<div style="min-width:0"><div class="name">${esc(it.ja)}</div>
        <div class="hint">${asMouse ? 'クリック・ドラッグですぐ置きます・右クリックで撤去'
          : mouse ? `${c.instant ? 'クリック・ドラッグですぐ置きます' : 'クリック・ドラッグで予定図を出す'}・右ドラッグで移動`
          : `${c.instant ? 'タップ・なぞるとすぐ置きます' : 'タップ・なぞって予定図を出す'}・2本指で移動`}</div></div>
        ${asMouse ? '' : `<button class="btn small ${c.instant ? 'on' : ''}" data-a="instant" aria-pressed="${c.instant}">すぐ置く</button>`}
        ${isRotatable(P) ? `<button class="btn icon" data-a="rotate-build" aria-label="回転">${SVG.rot}</button>` : ''}
        <button class="btn icon" data-a="mode-normal" aria-label="やめる">${SVG.x}</button>`;
    } else if (c.mode === 'remove') {
      bb.hidden = false;
      bb.innerHTML = `<div style="min-width:0"><div class="name">撤去モード</div><div class="hint">${asMouse ? 'クリック・ドラッグで囲んだ物をすぐ撤去します。ベルトはダブルクリックでまとめて選べます'
          : mouse ? 'ドラッグで四角く囲んで選びます。ベルトはダブルクリックでまとめて選べます'
          : '指で四角く囲んで選びます。ベルトはダブルタップでまとめて選べます'}</div></div>
        <button class="btn icon" data-a="mode-normal" aria-label="やめる">${SVG.x}</button>`;
    } else bb.hidden = true;
    this.lastQuick = '';
    this._renderQuickbar();
  }
  quickSelect(i) {
    const items = this._quickItems();
    if (items[i]) this.app.ctrl.selectItem(items[i]);
  }
  toggleSheet(name) {
    if (this.sheet === name) { this.closeSheet(); return; }
    this.sheet = name;
    this.selected = null;
    this.pickRecipe = false;
    this.app.renderer.overlay.selection = null;
    this._showSheet();
    this.app.audio.play('open');
  }
  openEntity(e) {
    this.sheet = 'entity';
    this.selected = e;
    this.pickRecipe = e._kind === 'assembler' && !e._rec;
    this.app.renderer.overlay.selection = e;
    this._showSheet();
    // on portrait phones the panel covers the lower half: keep the machine visible above it
    if (window.innerHeight > window.innerWidth && window.innerWidth <= 600) {
      const r = this.app.renderer, cam = r.cam;
      const cy = e.y + e._h / 2, cx = e.x + e._w / 2;
      const hT = r.gl.canvas.height / cam.zoom;
      cam.x = cx;
      cam.y = cy + hT * 0.22;
    }
  }
  closeSheet() {
    if (!this.sheet) return;
    this.sheet = null;
    this.selected = null;
    this.app.renderer.overlay.selection = null;
    this.el('sheet').hidden = true;
    this.el('sheet-backdrop').hidden = true;
    this.app.audio.play('close');
  }
  _showSheet() {
    this.el('sheet').hidden = false;
    this.el('sheet-backdrop').hidden = !(window.innerWidth < 900 && this.sheet !== 'entity');
    this.el('sheet-body').scrollTop = 0;
    this.refresh(true);
  }
  focusChat() { this.toggleSheet('menu'); setTimeout(() => { const i = document.getElementById('chat-in'); if (i) i.focus(); }, 50); }

  toast(msg, kind = '') {
    const box = this.el('toasts');
    const el = document.createElement('div');
    el.className = 'toast panel ' + kind;
    el.textContent = msg;
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => el.remove(), kind === 'err' ? 2600 : 3600);
  }
  chat(name, color, text) {
    const log = this.el('chatlog');
    const el = document.createElement('div');
    el.innerHTML = `<b style="color:${/^#[0-9a-f]{6}$/i.test(color) ? color : '#fff'}">${esc(name)}</b> ${esc(text)}`;
    log.appendChild(el);
    while (log.children.length > 6) log.firstChild.remove();
    setTimeout(() => el.remove(), 12000);
    this.chatLines.push({ name, color, text });
    if (this.chatLines.length > 50) this.chatLines.shift();
    if (this.sheet === 'menu') this.refresh(true);
  }

  showQuickMenu(e, x, y) {
    const qm = this.el('quickmenu');
    this._qmEnt = e;
    const rot = isRotatable(e._proto);
    qm.innerHTML = `<button class="btn small" data-a="qm" data-q="open">開く</button>
      ${rot ? '<button class="btn small" data-a="qm" data-q="rotate">回転</button>' : ''}
      <button class="btn small" data-a="qm" data-q="pipette">同じ物を持つ</button>
      <button class="btn small danger" data-a="qm" data-q="remove">撤去</button>`;
    qm.style.left = Math.max(120, Math.min(window.innerWidth - 120, x)) + 'px';
    qm.style.top = Math.max(110, y) + 'px';
    qm.hidden = false;
  }
  hideQuickMenu() { this.el('quickmenu').hidden = true; }
  _quickAction(q) {
    const e = this._qmEnt;
    this.hideQuickMenu();
    if (!e || !this.g.ents.has(e.id)) return;
    if (q === 'open') this.openEntity(e);
    if (q === 'rotate') { this.app.submit({ type: 'rotate', id: e.id }); this.app.audio.play('rotate'); }
    if (q === 'remove') { this.app.submit({ type: 'remove', id: e.id }); this.app.audio.play('remove'); }
    if (q === 'pipette') this.app.ctrl.selectItem(e._proto.item);
  }

  async _copy(text) {
    try { await navigator.clipboard.writeText(text); this.toast('コピーしました', 'good'); }
    catch { this.toast('長押しして選んでコピーしてください'); }
  }
  async _share() {
    const url = this.app.shareUrl();
    if (navigator.share) { try { await navigator.share({ title: 'Ironfield', text: '一緒に工場を作ろう', url }); return; } catch { /* cancelled */ } }
    this._copy(url);
  }
  _sendChat() {
    const i = document.getElementById('chat-in');
    if (!i || !i.value.trim()) return;
    this.app.session.sendChat(i.value.trim().slice(0, 200));
    i.value = '';
  }

  // ------------------------------------------------------------ per frame
  update(now) {
    if (now - this.lastRender > 250) { this.lastRender = now; this.refresh(false); this._renderHUD(); }
    if (now - (this.lastMini || 0) > 800) { this.lastMini = now; this._drawMinimap(); }
    this._renderLabels();
  }

  refresh(force) {
    if (!this.sheet) return;
    if (this.sheet === 'entity' && (!this.selected || !this.g.ents.has(this.selected.id))) {
      // entity was removed or replaced (e.g. by rotation of a non-square machine)
      const s = this.selected;
      const again = s ? this.g.entAt(s.x + (s._w >> 1), s.y + (s._h >> 1)) : null;
      if (again && again.name === s.name) { this.selected = again; this.app.renderer.overlay.selection = again; }
      else { this.closeSheet(); return; }
    }
    if (!force && this.app.ctrl.pointers.size === 0 && document.activeElement && document.activeElement.id === 'chat-in') return;
    let head = '', body = '';
    if (this.sheet === 'inventory') [head, body] = this._sheetInventory();
    else if (this.sheet === 'build') [head, body] = this._sheetBuild();
    else if (this.sheet === 'tech') [head, body] = this._sheetTech();
    else if (this.sheet === 'menu') [head, body] = this._sheetMenu();
    else if (this.sheet === 'visit') [head, body] = this._sheetVisit();
    else if (this.sheet === 'entity') [head, body] = this._sheetEntity(this.selected);
    const sig = head + body;
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    const hb = this.el('sheet-head');
    hb.innerHTML = head + `<button class="btn icon x" data-a="close" aria-label="閉じる">${SVG.x}</button>`;
    const bd = this.el('sheet-body');
    const st = bd.scrollTop;
    // keep the chat input's text across refreshes
    const ci = document.getElementById('chat-in');
    const chatVal = ci ? ci.value : '';
    bd.innerHTML = body;
    bd.scrollTop = st;
    const ci2 = document.getElementById('chat-in');
    if (ci2) {
      ci2.value = chatVal;
      ci2.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this._sendChat(); } });
    }
  }

  // ------------------------------------------------------------ HUD pieces
  _quickItems() {
    const me = this.me;
    if (!me) return [];
    const set = new Map();
    for (const s of me.inv) if (s && ITEMS[s[0]].place) set.set(s[0], (set.get(s[0]) || 0) + s[1]);
    return [...set.keys()].sort((a, b) => ITEMS[a].order - ITEMS[b].order);
  }
  _renderQuickbar() {
    const me = this.me;
    if (!me) return;
    const items = this._quickItems();
    const sel = this.app.ctrl.mode === 'build' ? this.app.ctrl.buildItem : null;
    const sig = items.map(i => i + invCount(me.inv, i)).join(',') + '|' + sel;
    if (sig === this.lastQuick) return;
    this.lastQuick = sig;
    const qb = this.el('quickbar');
    qb.innerHTML = items.length ? items.map(i => `<button class="slot qslot ${i === sel ? 'sel' : ''}" data-a="quick" data-item="${i}" aria-label="${esc(ITEMS[i].ja)}">${iconHTML('item:' + i, 34)}<span class="n">${fmtN(invCount(me.inv, i))}</span></button>`).join('')
      : '<span class="empty-note">設置できる物がありません。持ち物からクラフトしましょう</span>';
  }
  _renderHUD() {
    const g = this.g, R = g.research;
    this._renderQuickbar();
    const name = this.el('rc-name'), bar = this.el('rc-bar'), ic = this.el('rc-icon');
    if (R.cur) {
      const t = TECHS[R.cur];
      name.textContent = t.ja;
      bar.style.width = Math.floor(R.ud / t.units * 100) + '%';
      const k = 'item:' + (t.unlocks.find(u => RECIPES[u] && RECIPES[u].res.length) ? RECIPES[t.unlocks.find(u => RECIPES[u] && RECIPES[u].res.length)].res[0][0] : t.packs[t.packs.length - 1]);
      if (ic.dataset.k !== k) { ic.innerHTML = iconHTML(k, 30); ic.dataset.k = k; }
    } else {
      name.textContent = g.lists.lab.length ? '研究を選ぶ' : '研究（研究所を置く）';
      bar.style.width = '0%';
      if (ic.dataset.k !== 'none') { ic.innerHTML = iconHTML('item:lab', 30); ic.dataset.k = 'none'; }
    }
    this._renderGoal();
    if (this.app.ctrl.pending && JSON.stringify(this.app.ctrl.pendingInfo()) !== this._pendSig) this.onModeChange();
    const s = this.app.session;
    const st = s.status || {};
    const n = (s.players || []).length || [...g.players.values()].filter(p => p.online).length;
    const plot = PREFS[plotOfRoom(s.room)];
    const viewing = s.mode === 'view';
    const mode = s.mode === 'offline' ? 'ひとり' : viewing ? '見学' : plot ? plot.short : s.mode === 'host' ? 'ホスト' : '参加中';
    const col = st.state === 'playing' || s.mode === 'offline' || viewing ? '#8fd16f' : st.state === 'disconnected' || st.state === 'error' ? '#ff7a6a' : '#ffcf7a';
    const jt = this.app.jintori && this.app.jintori.chipText();
    if (jt) {
      const sig = jt.allow + ':' + jt.flags;
      if (this._flagSig !== sig) { this._flagSig = sig; this.el('flag-chip').innerHTML = `${iconHTML('item:flag', 22)}<span>陣取り</span><b>${jt.flags}</b><span class="muted">今日あと${jt.allow}本</span>`; }
    }
    this.el('netbadge').innerHTML = `<span class="dot" style="background:${col}"></span>${mode}${s.mode !== 'offline' && !viewing ? ` ${SVG.people.replace('<svg', '<svg style="width:14px;height:14px"')} ${n}` : ''}`;
    const vb = this.el('viewbar');
    vb.hidden = !viewing;
    const here = String(plotOfRoom(s.room));
    if (viewing && vb.dataset.p !== here) {
      vb.dataset.p = here;
      vb.innerHTML = `<div style="min-width:0"><div class="name" style="color:${plot ? plot.color : '#fff'}">${esc(plot ? plot.name : '')}の区画</div><div class="hint">見るだけ・さわれません</div></div>
        <button class="btn" data-a="sheet" data-s="visit">ほかの県</button>
        <button class="btn primary" data-a="go-home">${this.app.jintoriStore.pref ? '自分の区画へ戻る' : 'タイトルへ'}</button>`;
    }
  }
  _renderGoal() {
    const g = this.g, me = this.me;
    const el = this.el('goal-chip');
    if (!me) return;
    let idx = GOALS.findIndex(([, done]) => { try { return !done(g, me); } catch { return true; } });
    let html;
    if (idx < 0) html = '<div class="t" style="font-size:12px">すべての目標を達成しました</div>';
    else if (this.goalsOpen) {
      html = GOALS.map(([txt, done, prog], i) => {
        let ok = false; try { ok = done(g, me); } catch { ok = false; }
        const p = !ok && prog ? (() => { const [a, b] = prog(g, me); return ` (${Math.min(a, b)}/${b})`; })() : '';
        return `<div style="font-size:12px;${ok ? 'opacity:.5;text-decoration:line-through' : i === idx ? 'color:var(--amber-hi);font-weight:700' : ''}">${i + 1}. ${esc(txt)}${p}</div>`;
      }).join('');
    } else {
      const [txt, , prog] = GOALS[idx];
      const p = prog ? (() => { const [a, b] = prog(g, me); return ` (${Math.min(a, b)}/${b})`; })() : '';
      html = `<div style="font-size:12px;line-height:1.35"><span style="color:var(--amber-hi);font-weight:700">目標 ${idx + 1}</span> ${esc(txt)}${p}</div>`;
    }
    if (html !== this._goalHTML) { el.innerHTML = html; this._goalHTML = html; }
    el.style.padding = '6px 10px';
    el.style.cursor = 'pointer';
  }
  _renderLabels() {
    const box = this.el('labels');
    const cursors = this.app.renderer.overlay.cursors;
    const r = this.app.renderer;
    const dpr = this.app.dpr;
    let html = '';
    for (const c of cursors) {
      const [sx, sy] = r.worldToScreen(c.x, c.y);
      if (sx < -50 || sy < -50 || sx > r.gl.canvas.width + 50 || sy > r.gl.canvas.height + 50) continue;
      html += `<div class="plabel" style="left:${sx / dpr}px;top:${sy / dpr}px;color:${/^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#fff'}">${esc(c.name || '')}</div>`;
    }
    // the names of the neighbouring plots, just over the border, level with the camera
    const g = this.g, at = PLOT_AT.get(g.plot);
    if (at) {
      const cam = r.cam, cx = Math.max(6, Math.min(g.W - 6, cam.x)), cy = Math.max(6, Math.min(g.H - 6, cam.y));
      for (const [dc, dr, wx, wy] of [[1, 0, g.W + 5, cy], [-1, 0, -5, cy], [0, -1, cx, -3], [0, 1, cx, g.H + 6]]) {
        const np = plotAtCell(at.c + dc, at.r + dr), P = PREFS[np];
        if (!P) continue;
        const [sx, sy] = r.worldToScreen(wx, wy);
        if (sx < 0 || sy < 0 || sx > r.gl.canvas.width || sy > r.gl.canvas.height) continue;
        html += `<div class="plabel nb" data-a="visit" data-p="${np}" role="button" tabindex="0" style="left:${sx / dpr}px;top:${sy / dpr}px;color:${P.color}">${esc(P.name)}の区画 ›</div>`;
      }
    }
    if (html !== this._lastLabels) { box.innerHTML = html; this._lastLabels = html; }
  }

  // ------------------------------------------------------------ minimap
  _initMinimap() {
    const c = this.el('minimap');
    const move = e => {
      const r = c.getBoundingClientRect();
      const g = this.g;
      const cam = this.app.renderer.cam;
      cam.x = (e.clientX - r.left) / r.width * g.W;
      cam.y = (e.clientY - r.top) / r.height * g.H;
    };
    let down = false;
    c.addEventListener('pointerdown', e => { down = true; c.setPointerCapture(e.pointerId); move(e); });
    c.addEventListener('pointermove', e => { if (down) move(e); });
    c.addEventListener('pointerup', () => { down = false; });
  }
  _drawMinimap() {
    const g = this.g;
    if (!g) return;
    const c = this.el('minimap');
    const ctx = c.getContext('2d');
    if (this._mmGame !== g || !this._mmBase || this._mmTick + 600 < g.tick || this._mmTopo !== g._topo) {
      // terrain + resources base image at 1px per tile
      const W = g.W, H = g.H;
      const img = new ImageData(W, H);
      const pal = [[66, 82, 34], [96, 90, 46], [104, 80, 52], [168, 148, 104], [30, 64, 82], [16, 40, 62]];
      const resPal = RESOURCES.map(r => r && hexRGB(r.map));
      for (let i = 0; i < W * H; i++) {
        let col = pal[g.terrain[i]] || pal[0];
        if (g.res[i]) col = resPal[g.res[i]];
        else if (g.decor[i] && g.decor[i] <= 10) col = [44, 60, 26];
        const o = i * 4;
        img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
      }
      for (const e of g.ents.values()) {
        const col = e._kind === 'belt' || e._kind === 'underground' || e._kind === 'splitter' ? [200, 170, 60] : e._kind === 'pole' ? [120, 140, 200] : [150, 160, 170];
        for (let y = 0; y < e._h; y++) for (let x = 0; x < e._w; x++) {
          const o = ((e.y + y) * W + e.x + x) * 4;
          img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2];
        }
      }
      if (!this._mmBase) { this._mmBase = document.createElement('canvas'); this._mmBase.width = W; this._mmBase.height = H; }
      this._mmBase.getContext('2d').putImageData(img, 0, 0);
      this._mmGame = g; this._mmTick = g.tick; this._mmTopo = g._topo;
      this._mmCount = g.ents.size;
    }
    if (this._mmCount !== g.ents.size) this._mmTick = -1e9;
    ctx.imageSmoothingEnabled = false;
    // zoomed around the camera: show a 256-tile window
    const cam = this.app.renderer.cam;
    const span = 192;
    const sx = Math.max(0, Math.min(g.W - span, cam.x - span / 2)), sy = Math.max(0, Math.min(g.H - span, cam.y - span / 2));
    ctx.drawImage(this._mmBase, sx, sy, span, span, 0, 0, c.width, c.height);
    const k = c.width / span;
    const r = this.app.renderer;
    const vw = r.gl.canvas.width / cam.zoom, vh = r.gl.canvas.height / cam.zoom;
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.5;
    ctx.strokeRect((cam.x - vw / 2 - sx) * k, (cam.y - vh / 2 - sy) * k, vw * k, vh * k);
    for (const cu of r.overlay.cursors) {
      ctx.fillStyle = cu.color || '#fff';
      ctx.fillRect((cu.x - sx) * k - 3, (cu.y - sy) * k - 3, 6, 6);
    }
    this._mmView = { sx, sy, span };
  }

  // ------------------------------------------------------------ sheets
  _slot(key, n, attrs = '', cls = '', size = 34) {
    return `<button class="slot ${cls}" ${attrs}>${key ? iconHTML(key, size) : ''}${n ? `<span class="n">${fmtN(n)}</span>` : ''}</button>`;
  }

  _sheetInventory() {
    const me = this.me;
    const g = this.g;
    const head = `<div class="tabs"><button class="tab ${this.invTab === 'craft' ? 'on' : ''}" data-a="tab" data-tab="craft">クラフト</button>
      <button class="tab ${this.invTab === 'inv' ? 'on' : ''}" data-a="tab" data-tab="inv">持ち物</button></div>`;
    let b = '';
    if (me.craft.length) {
      const first = me.craft[0];
      const tops = me.craft.filter(q => !q.sub).slice(0, 14);
      const total = Math.max(1, Math.round(RECIPES[first.r].time * 60));
      b += `<div class="section"><div class="row"><h3>クラフト中</h3><span class="muted" style="font-size:12px">${me.craft.length}件</span><div class="sp"></div>
        <button class="btn small danger" data-a="cancelcraft">すべて取り消す</button></div>
        <div class="bar"><i style="width:${Math.floor((1 - first.t / total) * 100)}%"></i></div>
        <div class="queue">${tops.map(q => this._slot('item:' + RECIPES[q.r].res[0][0], RECIPES[q.r].res[0][1] > 1 ? RECIPES[q.r].res[0][1] : 0, '', 'empty', 28)).join('')}</div></div>`;
    }
    if (this.invTab === 'craft') {
      const groups = [['logistics', '物流'], ['production', '生産'], ['intermediate', '素材'], ['science', '研究']];
      b += `<div class="row">${groups.map(([k, ja]) => `<button class="btn small ${this.craftGroup === k ? 'on' : ''}" data-a="group" data-g="${k}">${ja}</button>`).join('')}
        <div class="sp"></div>${[1, 5, 10].map(m => `<button class="btn small ${this.mult === m ? 'on' : ''}" data-a="mult" data-m="${m}">×${m}</button>`).join('')}</div>`;
      const list = RECIPE_LIST.filter(r => {
        const rec = RECIPES[r];
        if (rec.cat !== 'crafting' || rec.nohand || rec.fing.length || !rec.res.length) return false;
        if (!g.recipeEnabled(r)) return false;
        return ITEMS[rec.res[0][0]].group === this.craftGroup;
      });
      b += `<div class="grid">${list.map(r => {
        const rec = RECIPES[r];
        const can = this._canCraft(r);
        const have = invCount(me.inv, rec.res[0][0]);
        return this._slot('item:' + rec.res[0][0], have, `data-a="craft" data-r="${r}" data-long="1" aria-label="${esc(recipeName(r))}"`, (can ? '' : 'dim') + (this.tipRecipe === r ? ' sel' : ''));
      }).join('')}</div>`;
      const tr = this.tipRecipe && RECIPES[this.tipRecipe];
      if (tr) {
        b += `<div class="recipe-tip inset"><div class="row"><b>${esc(recipeName(tr.name))}</b><span class="muted">${tr.time}秒</span></div>
          <div class="flow">${tr.ing.map(([it, n]) => `<span class="chip">${iconHTML('item:' + it, 20)} ${n} <span class="${invCount(me.inv, it) >= n ? 'muted' : ''}" style="${invCount(me.inv, it) >= n ? '' : 'color:#ff9c8f'}">(${fmtN(invCount(me.inv, it))})</span></span>`).join('')}
          <span class="arrow">→</span>${tr.res.map(([it, n]) => `<span class="chip">${iconHTML('item:' + it, 20)} ${n}</span>`).join('')}</div>
          <div class="muted" style="font-size:12px">タップで作る・長押しで材料を見る。足りない部品は自動で作ります</div></div>`;
      } else b += '<div class="muted" style="font-size:12px">アイコンをタップすると作り始めます。長押しで材料を確認できます。</div>';
    } else {
      b += `<div class="row"><span class="muted">${me.inv.filter(Boolean).length} / ${me.inv.length} 枠</span><div class="sp"></div><button class="btn small" data-a="sort">整理</button></div>`;
      b += `<div class="grid">${me.inv.map(s => s ? this._slot('item:' + s[0], s[1], `data-a="inv-item" data-item="${s[0]}" aria-label="${esc(ITEMS[s[0]].ja)}"`) : this._slot(null, 0, '', 'empty')).join('')}</div>`;
      b += '<div class="muted" style="font-size:12px">設置できる物をタップすると、そのまま置くモードになります。</div>';
      if (g.sandbox) {
        b += `<h3>クリエイティブ（物を出す）</h3><div class="grid">${Object.keys(ITEMS).map(k => this._slot('item:' + k, 0, `data-a="give" data-item="${k}" aria-label="${esc(ITEMS[k].ja)}"`)).join('')}</div>`;
      }
    }
    return [head, b];
  }
  _sheetBuild() {
    const g = this.g, me = this.me;
    const groups = [['logistics', '物流'], ['production', '生産'], ['power', '電力'], ['fluid', '液体']];
    const groupOf = name => {
      const k = ENTITIES[ITEMS[name].place].kind;
      if (['pole', 'boiler', 'engine', 'offshore', 'solar', 'accumulator', 'lamp'].includes(k)) return 'power';
      if (['pipe', 'pipe-to-ground', 'tank', 'pumpjack'].includes(k)) return 'fluid';
      if (['belt', 'underground', 'splitter', 'inserter', 'chest'].includes(k)) return 'logistics';
      return 'production';
    };
    this.buildGroup ||= 'logistics';
    const head = `<h2>建設</h2><div class="tabs" style="margin-left:6px">${groups.map(([k, ja]) => `<button class="tab ${this.buildGroup === k ? 'on' : ''}" data-a="bgroup" data-g="${k}">${ja}</button>`).join('')}</div>`;
    const list = Object.keys(ITEMS).filter(n => ITEMS[n].place && groupOf(n) === this.buildGroup && (g.recipeEnabled(n) || invCount(me.inv, n) > 0));
    const tiles = list.map(n => {
      const have = invCount(me.inv, n);
      const rec = g.handRecipeFor(n);
      const can = have > 0 || (rec && this._canCraft(rec.name));
      return `<button class="btile ${can ? '' : 'dim'}" data-a="build-pick" data-item="${n}" aria-label="${esc(ITEMS[n].ja)}">
        ${iconHTML('item:' + n, 44)}<span class="bn">${esc(ITEMS[n].ja)}</span>
        <span class="bc">${have > 0 ? fmtN(have) : can ? '作る' : '材料不足'}</span></button>`;
    }).join('');
    const b = `<div class="bgrid">${tiles || '<div class="muted">まだありません。研究で増えます</div>'}</div>
      <div class="muted" style="font-size:12px">持っていない物は、選ぶと手作業でクラフトを始めます。</div>`;
    return [head, b];
  }
  _canCraft(r) {
    // cheap check: plan 1 craft without committing
    try { return this.g._planCraft(this.me, r, 1).length > 0; } catch { return false; }
  }

  _sheetTech() {
    const g = this.g, R = g.research;
    const head = `<h2>研究</h2>`;
    const card = (t, cls) => {
      const T = TECHS[t];
      const prog = R.cur === t ? Math.floor(R.ud / T.units * 100) : 0;
      const unl = T.unlocks.filter(u => RECIPES[u] && RECIPES[u].res.length).map(u => iconHTML('item:' + RECIPES[u].res[0][0], 26)).join('')
        || (T.unlocks[0] ? iconHTML('fluid:petroleum-gas', 26) : iconHTML('icon:warning', 26));
      const packs = T.packs.map(p => iconHTML('item:' + p, 16)).join('');
      return `<div class="tech ${cls}" ${cls === 'avail' || cls === 'cur' ? `data-a="research" data-t="${t}" role="button" tabindex="0"` : ''}>
        <div class="row" style="gap:2px;flex-wrap:nowrap">${unl}</div>
        <div style="flex:1;min-width:0"><div class="nm">${esc(T.ja)}</div>
        <div class="meta">${packs} × ${T.units}　${T.time}秒/回${T.effect ? '　' + effectText(T.effect) : ''}</div>
        ${R.cur === t ? `<div class="bar" style="margin-top:4px"><i style="width:${prog}%"></i></div>` : ''}
        ${cls === 'locked' ? `<div class="meta">必要: ${T.prereq.filter(p => !g.techDone(p)).map(p => esc(TECHS[p].ja)).join('、')}</div>` : ''}</div></div>`;
    };
    let b = '';
    if (!g.lists.lab.length) b += '<div class="muted">研究には「研究所」を置いて電気を通し、サイエンスパックを入れます。</div>';
    if (R.cur) b += `<div class="section"><h3>研究中</h3>${card(R.cur, 'cur')}</div>`;
    const avail = TECH_LIST.filter(t => t !== R.cur && g.techAvailable(t));
    b += `<div class="section"><h3>研究できる</h3>${avail.length ? avail.map(t => card(t, 'avail')).join('') : '<div class="muted">今はありません</div>'}</div>`;
    const locked = TECH_LIST.filter(t => !g.techDone(t) && !g.techAvailable(t));
    if (locked.length) b += `<div class="section"><h3>まだ研究できない</h3>${locked.map(t => card(t, 'locked')).join('')}</div>`;
    const done = R.done;
    if (done.length) b += `<div class="section"><h3>完了（${done.length}）</h3>${done.map(t => card(t, 'done')).join('')}</div>`;
    return [head, b];
  }

  // the 47 plots, laid out like the title screen: tap one to go and look
  _sheetVisit() {
    const mine = this.app.jintoriStore.pref, here = plotOfRoom(this.app.session.room);
    const tiles = [];
    for (const [pref, { c, r }] of PLOT_AT) {
      const P = PREFS[pref];
      tiles.push(`<button class="plot${P.short.length > 2 ? ' l3' : ''}${pref === here ? ' on' : ''}" data-a="visit" data-p="${pref}" style="grid-column:${c + 1};grid-row:${r + 1};--pc:${P.color}" aria-label="${esc(P.name)}${pref === mine ? '（自分の県）' : ''}">${pref === mine ? '自分' : esc(P.short)}<i></i></button>`);
    }
    const head = '<h2>ほかの県を見に行く</h2>';
    const b = `<div class="muted" style="font-size:12px">県をえらぶと、その区画の工場を見に行けます。見るだけで、建てたりこわしたりはできません。最新の保存を1分ごとに読み直します。「自分」を押すと自分の区画へ戻ります。</div>
      <div class="plots" style="grid-template-columns:repeat(${PLOT_COLS},1fr);grid-template-rows:repeat(${PLOT_ROWS},1fr)">${tiles.join('')}</div>`;
    return [head, b];
  }

  _sheetMenu() {
    const s = this.app.session, g = this.g;
    const head = `<h2>${esc(g.name)}</h2>`;
    let b = '';
    const mine = this.app.jintoriStore.pref, here = plotOfRoom(s.room);
    b += `<div class="section"><h3>ほかの県の区画</h3>
      <div class="row"><button class="btn" data-a="sheet" data-s="visit">ほかの県を見に行く</button>${s.mode === 'view' ? `<button class="btn primary" data-a="go-home">${mine ? '自分の区画へ戻る' : 'タイトルへ'}</button>` : ''}</div>
      <div class="muted" style="font-size:12px">${s.mode === 'view' ? `いまは${esc(PREFS[here] ? PREFS[here].name : '')}の区画を見に来ています。見るだけで、建てたりこわしたりはできません。` : 'ほかの県の工場を見て回れます（見るだけ）。区画の境に出ている県の名前をタップしても行けます。'}</div></div>`;
    if (s.mode === 'host' || s.mode === 'client') {
      const url = this.app.shareUrl();
      b += `<div class="section"><h3>友だちをさそう</h3>
        <div class="sharebox"><code class="inset">${esc(url)}</code></div>
        <div class="row"><button class="btn primary" data-a="share">リンクを送る</button><button class="btn" data-a="copy" data-text="${esc(url)}">コピー</button></div>
        <div class="muted" style="font-size:12px">ひとつの大きなワールドを47の都道府県の区画に分けています。同じ県の人はこの区画に入ってきます。区画を動かしている人が抜けても、残った人が自動で引き継ぎます。全員が抜けても、次に入った人が続きから遊べます。</div></div>`;
      const st = s.status || {};
      b += `<div class="section"><h3>参加者</h3>${(s.players || []).map(p => `<div class="row"><span class="dot" style="background:${/^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#fff'}"></span>${esc(p.name)}${p.pid === s.localPid ? '<span class="muted">（あなた）</span>' : ''}</div>`).join('') || '<div class="muted">まだだれもいません</div>'}
        <div class="muted" style="font-size:12px">${st.state === 'playing' ? `接続中${st.ping ? `・遅れ ${Math.round(st.ping)}ms` : ''}` : esc(st.message || st.state || '')}</div></div>`;
      b += `<div class="section"><h3>チャット</h3>
        <div class="inset" style="padding:8px;max-height:160px;overflow-y:auto;font-size:13px">${this.chatLines.slice(-30).map(l => `<div><b style="color:${/^#[0-9a-f]{6}$/i.test(l.color) ? l.color : '#fff'}">${esc(l.name)}</b> ${esc(l.text)}</div>`).join('') || '<span class="muted">メッセージはまだありません</span>'}</div>
        <div class="row" style="flex-wrap:nowrap"><input type="text" id="chat-in" maxlength="200" placeholder="メッセージ" autocomplete="off"><button class="btn" data-a="chat-send">送る</button></div></div>`;
    }
    const day = g.daylight();
    b += `<div class="section"><h3>ワールド</h3><div class="kv">
      <span class="muted">経過</span><b>${fmtTime(g.tick)}</b>
      <span class="muted">時間帯</span><b>${day >= 1000 ? '昼' : day <= 0 ? '夜' : '夕方/明け方'}</b>
      <span class="muted">建物</span><b>${g.ents.size}</b>
      <span class="muted">研究完了</span><b>${g.research.done.length} / ${TECH_LIST.length}</b>
      <span class="muted">ロケット打ち上げ</span><b>${g.rockets}</b></div></div>`;
    const prod = Object.entries(g.prod).filter(([k]) => ITEMS[k]).sort((a, b) => b[1] - a[1]).slice(0, 24);
    if (prod.length) b += `<div class="section"><h3>これまでに作った数</h3><div class="grid">${prod.map(([k, n]) => this._slot('item:' + k, n, `aria-label="${esc(ITEMS[k].ja)} ${n}"`, 'empty')).join('')}</div></div>`;
    b += `<div class="section"><h3>設定</h3><div class="row">
      <button class="btn" data-a="sound">${this.app.audio.muted ? '音を出す' : '音を消す'}</button>
      <button class="btn" data-a="home">スタート地点へ</button>
      ${s.mode === 'host' ? '<button class="btn" data-a="save">今すぐ保存</button>' : ''}
      <button class="btn danger" data-a="quit">タイトルへ</button></div>
      ${matchMedia('(any-pointer: fine)').matches ? `<div class="row"><button class="btn ${this.app.ctrl.touchLike ? 'on' : ''}" data-a="touchlike" aria-pressed="${this.app.ctrl.touchLike}">マウスでもスマホと同じ操作</button></div>` : ''}
      <div class="muted" style="font-size:12px">スマホ: 1本指で移動、2本指で拡大縮小。建物は長押しで回転・撤去。<br>
      パソコン: ホイールで拡大縮小、中ボタンのドラッグか WASD で移動、長押しでメニュー。R で回転、Q で持ち替え、E で持ち物、X で撤去モード、Enter で確定、Esc で取り消し。<br>
      「スマホと同じ操作」をオンにすると、クリックは指のタップと同じになります（予定図 → ✓、囲んで確認してから撤去、右ドラッグで移動）。</div></div>`;
    return [head, b];
  }

  _status(e) {
    const g = this.g, k = e._kind;
    if (k === 'assembler' && !e._rec) return ['warn', 'レシピを選んでください'];
    if (e._elec && k !== 'engine' && k !== 'solar' && k !== 'accumulator') {
      if (!e._net) return ['bad', '電柱につながっていません'];
      if (e._net.sat === 0 && (e._dem > 0 || e.act)) return ['bad', '電力がありません'];
    }
    if (e._proto.burner && !e.fuel && e.en <= 0 && k !== 'inserter') return ['bad', '燃料を入れてください'];
    if (k === 'drill' && !e._ore) return ['bad', '掘れる資源がありません'];
    if (k === 'drill' && e.out) return ['warn', '出す先がいっぱいです'];
    if (e._on) {
      if (e._elec && e._net && e._net.sat < 1000) return ['warn', `電力不足で遅くなっています（${Math.floor(e._net.sat / 10)}%）`];
      return ['ok', '稼働中'];
    }
    if (k === 'lab') return g.research.cur ? ['warn', 'サイエンスパックを待っています'] : ['warn', '研究テーマが選ばれていません'];
    if (k === 'assembler' || k === 'furnace' || k === 'silo') return ['warn', '材料を待っています'];
    if (k === 'boiler') return ['warn', '水か燃料を待っています'];
    if (k === 'engine') return ['warn', '蒸気を待っています'];
    return ['ok', '待機中'];
  }

  _putChips(e, filter) {
    const me = this.me;
    const seen = new Set();
    const chips = [];
    for (const s of me.inv) {
      if (!s || seen.has(s[0])) continue;
      seen.add(s[0]);
      if (!filter(s[0])) continue;
      chips.push(this._slot('item:' + s[0], invCount(me.inv, s[0]), `data-a="put" data-id="${e.id}" data-item="${s[0]}" data-n="${ITEMS[s[0]].stack}" data-long="1" aria-label="${esc(ITEMS[s[0]].ja)}を入れる"`));
    }
    if (!chips.length) return '';
    return `<div class="section"><h3>持ち物から入れる</h3><div class="grid">${chips.join('')}</div><div class="muted" style="font-size:12px">タップで1スタック、長押しで全部入れます</div></div>`;
  }
  _fluids(e) {
    if (!e._fn) return '';
    return `<div class="section"><h3>液体</h3>${e._fn.map((net, bi) => {
      if (!net) return '';
      const filt = this.g.boxFilter(e, bi);
      const f = net.fluid || filt;
      const pct = net.cap ? Math.round(net.amount / net.cap * 100) : 0;
      const col = f ? FLUIDS[f].color : '#555';
      return `<div class="fluidbar">${iconHTML('fluid:' + (f || 'water'), 22)}<span style="min-width:62px">${f ? esc(FLUIDS[f].ja) : '空'}</span>
        <div class="bar"><i style="width:${pct}%;background:${col}"></i></div><b style="min-width:58px;text-align:right">${Math.floor(net.amount / 60)}/${Math.floor(net.cap / 60)}</b></div>`;
    }).join('')}</div>`;
  }
  _power(e) {
    const net = e._net;
    if (!net) return '';
    const st = net.stats;
    return `<div class="section"><h3>電力網</h3><div class="kv">
      <span class="muted">使用</span><b>${fmtW(st.demand)}</b>
      <span class="muted">供給</span><b>${fmtW(st.supply)}（最大 ${fmtW(st.cap)}）</b>
      <span class="muted">満足度</span><b>${Math.floor(st.sat / 10)}%</b>
      <span class="muted">内訳</span><b>蒸気 ${fmtW(st.steam || 0)}・太陽光 ${fmtW(st.solar || 0)}・蓄電池 ${fmtW(st.acc || 0)}</b></div>
      <div class="bar ${st.sat >= 1000 ? 'green' : ''}"><i style="width:${Math.min(100, st.cap ? st.supply / st.cap * 100 : 0)}%"></i></div></div>`;
  }

  _sheetEntity(e) {
    const g = this.g, k = e._kind, P = e._proto;
    const [scls, stext] = this._status(e);
    const head = `${iconHTML('item:' + P.item, 30)}<h2>${esc(P.ja)}</h2>`;
    let b = `<div class="status ${scls}"><span class="dot" style="background:currentColor"></span>${esc(stext)}</div>`;
    const sl = (key, pair, slot, label) => `<div class="col" style="gap:3px;align-items:center"><span class="muted" style="font-size:11px">${label}</span>${pair ? this._slot('item:' + pair[0], pair[1], `data-a="take" data-id="${e.id}" data-slot="${slot}" aria-label="${label}を取る"`) : this._slot(null, 0, '', 'empty')}</div>`;
    const progBar = (v, tot) => `<div class="bar"><i style="width:${tot ? Math.min(100, Math.floor(v / tot * 100)) : 0}%"></i></div>`;
    switch (k) {
      case 'chest': {
        b += `<div class="row"><span class="muted">${e.inv.filter(Boolean).length} / ${e.inv.length} 枠</span><div class="sp"></div><button class="btn small" data-a="take" data-id="${e.id}" data-slot="all">全部取る</button></div>`;
        b += `<div class="grid">${e.inv.map((s, i) => s ? this._slot('item:' + s[0], s[1], `data-a="take" data-id="${e.id}" data-slot="c:${i}"`) : this._slot(null, 0, '', 'empty')).join('')}</div>`;
        b += this._putChips(e, () => true);
        break;
      }
      case 'furnace': {
        const r = e.rec && RECIPES[e.rec];
        b += `<div class="flow">${P.burner ? sl('', e.fuel, 'fuel', '燃料') : ''}${sl('', e.src, 'src', '材料')}<span class="arrow">→</span>${sl('', e.out, 'out', '製品')}</div>`;
        b += progBar(e.prog, r ? Math.round(r.time * 60) * 1000 : 0);
        b += this._putChips(e, it => (P.burner && isFuel(it)) || !!smeltRecipe(g, it));
        break;
      }
      case 'drill': {
        const [x0, y0, a] = drillArea(e);
        const totals = {};
        for (let y = y0; y < y0 + a; y++) for (let x = x0; x < x0 + a; x++) { const r = g.resAt(x, y); if (r && r <= 4) totals[r] = (totals[r] || 0) + g.amtAt(x, y); }
        b += `<div class="flow">${P.burner ? sl('', e.fuel, 'fuel', '燃料') : ''}${sl('', e.out, 'out', '出力待ち')}</div>`;
        b += progBar(e.prog, 60000);
        b += `<div class="kv">${Object.entries(totals).map(([r, n]) => `<span class="muted">${esc(RESOURCES[r].ja)} の残り</span><b>${fmtN(n)}</b>`).join('') || '<span class="muted">資源</span><b>なし</b>'}
          <span class="muted">採掘速度</span><b>${(P.speed / 1000).toFixed(2)} 個/秒</b></div>`;
        if (P.burner) b += this._putChips(e, isFuel);
        break;
      }
      case 'assembler': case 'silo': {
        const rec = e._rec;
        if (k === 'assembler') {
          b += `<div class="row">${rec ? `${iconHTML(rec.res.length ? 'item:' + rec.res[0][0] : 'fluid:' + rec.fres[0][0], 28)}<b>${esc(recipeName(rec.name))}</b><span class="muted">${(rec.time / (P.speed / 1000)).toFixed(1)}秒</span>` : '<span class="muted">レシピなし</span>'}
            <div class="sp"></div><button class="btn small ${this.pickRecipe ? 'on' : ''}" data-a="pickrec">レシピを${rec ? '変える' : '選ぶ'}</button></div>`;
        } else {
          b += `<div class="row"><b>ロケット部品 ${e.parts} / ${ROCKET_PARTS}</b></div>${progBar(e.parts, ROCKET_PARTS)}`;
          if (e.launch > 0) b += `<div class="status ok">打ち上げまで ${Math.ceil(e.launch / 60)} 秒</div>`;
        }
        if (this.pickRecipe && k === 'assembler') {
          const list = RECIPE_LIST.filter(r => { const rc = RECIPES[r]; return !rc.hidden && P.cats.includes(rc.cat) && g.recipeEnabled(r) && !(rc.cat === 'crafting-fluid' && !P.fluid); });
          b += `<div class="grid">${list.map(r => {
            const rc = RECIPES[r];
            const key = rc.res.length ? 'item:' + rc.res[0][0] : 'fluid:' + rc.fres[0][0];
            return this._slot(key, 0, `data-a="setrec" data-id="${e.id}" data-r="${r}" aria-label="${esc(recipeName(r))}"`, e.recipe === r ? 'sel' : '');
          }).join('')}</div>`;
        }
        if (rec) {
          b += `<div class="flow">${rec.ing.map(([it, n]) => `<div class="col" style="gap:2px;align-items:center">${this._slot('item:' + it, e.inv[it] || 0, `data-a="take" data-id="${e.id}" data-slot="in:${it}"`, (e.inv[it] || 0) >= n ? '' : 'dim')}<span class="muted" style="font-size:11px">${n}個</span></div>`).join('')}
            ${rec.fing.map(([f, n]) => `<div class="col" style="gap:2px;align-items:center">${this._slot('fluid:' + f, 0, '', 'empty')}<span class="muted" style="font-size:11px">${n}</span></div>`).join('')}
            <span class="arrow">→</span>
            ${rec.res.map(([it, n]) => `<div class="col" style="gap:2px;align-items:center">${this._slot('item:' + it, e.out[it] || 0, `data-a="take" data-id="${e.id}" data-slot="out:${it}"`)}<span class="muted" style="font-size:11px">${n}個</span></div>`).join('')}
            ${rec.fres.map(([f, n]) => `<div class="col" style="gap:2px;align-items:center">${this._slot('fluid:' + f, 0, '', 'empty')}<span class="muted" style="font-size:11px">${n}</span></div>`).join('')}</div>`;
          b += progBar(e.prog, Math.round(rec.time * 60) * 1000);
          b += this._putChips(e, it => rec.ing.some(([x]) => x === it));
        }
        if ((rec && (rec.fing.length || rec.fres.length)) || e.name === 'oil-refinery' || e.name === 'chemical-plant') b += this._fluids(e);
        break;
      }
      case 'lab': {
        const R = g.research;
        const t = R.cur && TECHS[R.cur];
        b += t ? `<div class="row"><b>${esc(t.ja)}</b><span class="muted">${R.ud}/${t.units}</span></div>${progBar(R.ud, t.units)}` : '<div class="row"><span class="muted">研究テーマなし</span><button class="btn small primary" data-a="sheet" data-s="tech">研究を選ぶ</button></div>';
        b += `<div class="flow">${['automation-science-pack', 'logistic-science-pack', 'chemical-science-pack'].map(p => this._slot('item:' + p, e.inv[p] || 0, `data-a="take" data-id="${e.id}" data-slot="in:${p}"`, e.inv[p] ? '' : 'dim')).join('')}</div>`;
        b += this._putChips(e, it => it.endsWith('science-pack'));
        break;
      }
      case 'boiler':
        b += `<div class="flow">${sl('', e.fuel, 'fuel', '燃料')}</div>`;
        b += this._fluids(e);
        b += this._putChips(e, isFuel);
        break;
      case 'engine':
        b += `<div class="kv"><span class="muted">発電</span><b>${fmtW(e._on || 0)} / 900 kW</b></div>`;
        b += this._fluids(e);
        b += this._power(e);
        break;
      case 'solar':
        b += `<div class="kv"><span class="muted">発電</span><b>${fmtW(Math.floor(g.daylight()))} / 60 kW</b></div>`;
        b += this._power(e);
        break;
      case 'accumulator':
        b += `<div class="kv"><span class="muted">蓄電</span><b>${(e.charge / 1e6).toFixed(2)} / 5 MJ</b></div>${progBar(e.charge, 5e6)}`;
        b += this._power(e);
        break;
      case 'pole': b += this._power(e) || '<div class="muted">発電機や他の電柱につながっていません</div>'; break;
      case 'inserter':
        b += `<div class="flow">${P.burner ? sl('', e.fuel, 'fuel', '燃料') : ''}<div class="col" style="gap:3px;align-items:center"><span class="muted" style="font-size:11px">手の中</span>${e.hand ? this._slot('item:' + e.hand[0], e.hand[1], '', 'empty') : this._slot(null, 0, '', 'empty')}</div></div>`;
        b += '<div class="muted" style="font-size:12px">後ろ（緑）から取って、前（赤）へ置きます。</div>';
        if (P.burner) b += this._putChips(e, isFuel);
        break;
      case 'belt': case 'underground': case 'splitter': {
        const n = k === 'splitter' ? e.halves.reduce((s, h) => s + h.lanes[0].length + h.lanes[1].length, 0) : e.lanes[0].length + e.lanes[1].length;
        b += `<div class="kv"><span class="muted">運搬速度</span><b>${[15, 30, 45][P.tier]} 個/秒</b><span class="muted">載っている数</span><b>${n}</b></div>`;
        if (k === 'underground') b += `<div class="muted">${e.ut === 'in' ? '入口' : '出口'}${e._partner ? '（つながっています）' : '（相手がいません。最大' + P.reach + 'マス先に置く）'}</div>`;
        break;
      }
      case 'pumpjack':
        b += `<div class="kv"><span class="muted">産出量</span><b>${(g.amtAt(e.x + 1, e.y + 1) / 10).toFixed(1)} /秒</b></div>`;
        b += this._fluids(e);
        break;
      case 'lamp': b += `<div class="muted">夜になると電気を使って周りを照らします。</div>`; break;
      default: b += this._fluids(e);
    }
    const rot = isRotatable(P);
    b += `<div class="row">${rot ? `<button class="btn" data-a="ent-rotate">${SVG.rot} 回転</button>` : ''}
      <button class="btn" data-a="ent-pipette">同じ物を持つ</button><div class="sp"></div>
      <button class="btn danger" data-a="ent-remove">撤去</button></div>`;
    return [head, b];
  }
}

// guided goals: [text, done(game, me) -> bool, progress?(game, me) -> [have, need]]
const anyEnt = (g, name, pred) => (g.lists[ENTITIES[name].kind] || []).some(e => e.name === name && (!pred || pred(e)));
export const GOALS = [
  ['木や石をタップして手で掘る', (g, me) => invCount(me.inv, 'wood') + invCount(me.inv, 'stone') >= 5 || g.ents.size > 2],
  ['燃料式採掘機を鉄鉱石の上に置き、出口の前に石の炉を置く', g => anyEnt(g, 'burner-mining-drill') && anyEnt(g, 'stone-furnace')],
  ['採掘機と炉に石炭を入れて鉄板を20枚作る', g => (g.prod['iron-plate'] || 0) >= 20, g => [g.prod['iron-plate'] || 0, 20]],
  ['汲み上げポンプ・ボイラー・蒸気機関で電気を起こす', g => anyEnt(g, 'steam-engine', e => e._on > 0)],
  ['研究所を電柱につなぎ、「自動化」を研究する', g => g.techDone('automation')],
  ['組立機で歯車や電子回路を自動で作る', g => anyEnt(g, 'assembling-machine-1', e => !!e._rec) || anyEnt(g, 'assembling-machine-2', e => !!e._rec)],
  ['物流サイエンスパックを研究して作る', g => (g.prod['logistic-science-pack'] || 0) >= 10, g => [g.prod['logistic-science-pack'] || 0, 10]],
  ['原油ポンプと石油精製所で石油ガスを作る', g => g.techDone('oil-processing') && anyEnt(g, 'oil-refinery', e => !!e._rec)],
  ['化学サイエンスパックを作る', g => (g.prod['chemical-science-pack'] || 0) >= 10, g => [g.prod['chemical-science-pack'] || 0, 10]],
  ['「ロケットサイロ」を研究して建てる', g => g.lists.silo.length > 0],
  ['ロケットを打ち上げる', g => g.rockets > 0],
];

function effectText(ef) {
  if (ef.inventory) return `持ち物 +${ef.inventory}枠`;
  if (ef.inserterStack) return 'インサータが一度に運ぶ数 +1';
  if (ef.miningProd) return `採掘量 +${ef.miningProd / 10}%`;
  return '';
}
function fmtTime(t) {
  const s = Math.floor(t / 60), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return h ? `${h}時間${m}分` : `${m}分${s % 60}秒`;
}
function hexRGB(h) { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
