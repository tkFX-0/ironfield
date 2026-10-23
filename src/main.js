// Boot, title screen, session lifecycle and the frame loop.
import { Game } from './sim/game.js';
import { Renderer } from './render/renderer.js';
import { UI } from './ui/ui.js';
import { Controller } from './input.js';
import { audio } from './audio.js';
import { buildIconSheet, iconHTML } from './ui/icons.js';
import { OfflineSession, HostSession, ClientSession, listLobbies } from './net/session.js';
import { listSaves, putSave, getSave, deleteSave } from './saves.js';
import { TECHS, ITEMS } from './data.js';

const COLORS = ['#f0a64a', '#e8574a', '#5ea2d8', '#73b65b', '#c77ddb', '#e3d34f', '#4fd1c5', '#f2f2f2'];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('ironfield.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ironfield.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const app = {
  dpr: Math.min(window.devicePixelRatio || 1, 2),
  renderer: null, ui: null, ctrl: null, session: null, audio,
  saveId: null, running: false, mouseTile: null,
  submit(cmd) { if (this.session) this.session.submit(cmd); },
  shareUrl() {
    const base = location.origin + location.pathname;
    return this.session && this.session.shareUrl ? this.session.shareUrl(base) : base;
  },
  async saveNow(manual = false) {
    const s = this.session;
    if (!s || s.mode === 'client' || !s.game) return;
    try {
      const g = s.game;
      const bytes = await g.serialize();
      if (!this.saveId) this.saveId = 'w' + Date.now().toString(36);
      await putSave({ id: this.saveId, name: g.name, tick: g.tick, date: Date.now(), bytes });
      if (manual) this.ui.toast('保存しました', 'good');
    } catch (e) {
      if (manual) this.ui.toast('保存できませんでした: ' + e.message, 'err');
    }
  },
  async quitToTitle() {
    await this.saveNow();
    this.running = false;
    if (this.session) this.session.close();
    this.session = null;
    this.ui && this.ui.closeSheet();
    document.getElementById('hud').hidden = true;
    showTitle();
  },
};
window.__ironfield = app;

// ------------------------------------------------------------------ loading overlay
function loading(msg) {
  let el = document.getElementById('loading');
  if (!msg) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'loading'; el.className = 'loading'; document.body.appendChild(el); }
  el.innerHTML = `<div class="panel"><div class="spinner"></div><span>${esc(msg)}</span></div>`;
}

let spritesModule = null;
async function ensureRenderer() {
  if (app.renderer) return;
  loading('工場の部品を描いています…');
  await new Promise(r => setTimeout(r, 30));
  try { spritesModule = await import('./render/sprites.js'); if (typeof spritesModule.registerSprites !== 'function') throw new Error('incomplete'); }
  catch (e) { console.warn('sprites unavailable, using placeholder art', e); spritesModule = await import('./render/placeholder.js'); }
  const canvas = document.getElementById('view');
  app.renderer = new Renderer(canvas, spritesModule);
  buildIconSheet(spritesModule.drawIcon);
  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  loading(null);
}
function resize() {
  if (!app.renderer) return;
  app.dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(window.innerWidth * app.dpr), h = Math.round(window.innerHeight * app.dpr);
  app.renderer.gl.resize(w, h);
}

// ------------------------------------------------------------------ session start
// one stable id per device so a returning player gets their inventory back
function devicePid() {
  const fresh = new URLSearchParams(location.search).has('newpid'); // testing several tabs on one device
  let pid = fresh ? '' : store.get('pid', '');
  if (!/^[a-z0-9]{8}$/.test(pid)) {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    pid = [...a].map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
    if (!fresh) store.set('pid', pid);
    else app._freshPid = app._freshPid || pid;
  }
  return fresh ? (app._freshPid || pid) : pid;
}
function profile() { return { name: store.get('name', '') || 'プレイヤー', color: store.get('color', COLORS[0]), pid: devicePid() }; }

async function enterGame(session) {
  app.session = session;
  const g = session.game;
  app.renderer.setMap(g);
  const cam = app.renderer.cam;
  cam.x = g.spawn.x + 0.5; cam.y = g.spawn.y + 0.5;
  cam.zoom = 46 * app.dpr;
  document.getElementById('title').hidden = true;
  document.getElementById('hud').hidden = false;
  if (!app.ui) { app.ui = new UI(app); app.ctrl = new Controller(app); }
  app.ctrl.setMode('normal');
  app.ui.onModeChange();
  session.on('game', ng => { app.renderer.setMap(ng); });
  session.on('chat', m => {
    const p = app.session.game.players.get(m.pid);
    app.ui.chat(m.name || (p && p.name) || '?', (p && p.color) || '#fff', m.text);
    if (m.pid !== session.localPid) audio.play('chat');
  });
  session.on('presence', map => {
    const list = [];
    const entries = map instanceof Map ? [...map.entries()] : Object.entries(map || {});
    for (const [pid, pr] of entries) {
      if (pid === session.localPid || !pr) continue;
      if (typeof pr.x !== 'number' || typeof pr.y !== 'number') continue;
      list.push({ x: pr.cursorX ?? pr.x, y: pr.cursorY ?? pr.y, name: String(pr.name || '').slice(0, 20), color: pr.color });
    }
    app.renderer.overlay.cursors = list;
  });
  session.on('status', st => {
    if (!st) return;
    if (st.state === 'disconnected') app.ui.toast('ホストとの接続が切れました。メニューからタイトルへ戻れます', 'err');
    if (st.state === 'error') app.ui.toast(st.message || '接続エラー', 'err');
  });
  session.on('desync', () => app.ui.toast('ずれを直すため同期し直しています…'));
  session.on('players', () => {});
  app.running = true;
  app.lastFrame = performance.now();
  app.lastSave = performance.now();
  requestAnimationFrame(frame);
  if (!store.get('tutorialSeen', false)) {
    store.set('tutorialSeen', true);
    setTimeout(() => app.ui.toast('鉱石や木をタップすると手で掘れます。持ち物からクラフトしましょう'), 800);
    setTimeout(() => app.ui.toast('燃料式採掘機を鉄鉱石の上に置き、前に石の炉を置くと鉄板ができます'), 5200);
  }
}

async function startOffline(game) {
  await ensureRenderer();
  const p = profile();
  const s = new OfflineSession({ game, name: p.name, color: p.color, pid: p.pid });
  await enterGame(s);
}
async function startHost(game) {
  await ensureRenderer();
  loading('サーバーを立てています…');
  try {
    const p = profile();
    const s = await HostSession.create({ game, name: p.name, color: p.color, pid: p.pid, worldName: game.name });
    loading(null);
    await enterGame(s);
    app.ui.toast(`部屋番号 ${s.room} で公開しました。メニューから招待リンクを送れます`, 'good');
  } catch (e) {
    loading(null);
    alertTitle('サーバーを立てられませんでした: ' + (e && e.message ? e.message : e));
  }
}
async function startClient(room, broker) {
  await ensureRenderer();
  loading(`部屋 ${room} に接続しています…`);
  try {
    const p = profile();
    const s = await ClientSession.create({ room, broker, name: p.name, color: p.color, pid: p.pid, loadGame: bytes => Game.load(bytes) });
    loading(null);
    app.saveId = null;
    await enterGame(s);
    app.ui.toast(`${room} に参加しました`, 'good');
  } catch (e) {
    loading(null);
    alertTitle('参加できませんでした: ' + (e && e.message ? e.message : e));
  }
}

// ------------------------------------------------------------------ frame loop
function frame(now) {
  if (!app.running) return;
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - app.lastFrame) / 1000);
  app.lastFrame = now;
  const s = app.session;
  try { s.update(now); } catch (e) { console.error(e); }
  const g = s.game;
  if (app.renderer.game !== g) app.renderer.setMap(g);
  handleEvents(g);
  app.ctrl.update(dt);
  app.renderer.render(dt, s.localPid);
  app.ui.update(now);
  const cam = app.renderer.cam;
  const p = profile();
  const cur = app.mouseTile ? { cursorX: app.mouseTile[0] + 0.5, cursorY: app.mouseTile[1] + 0.5 } : { cursorX: cam.x, cursorY: cam.y };
  s.setPresence({ x: Math.round(cam.x * 10) / 10, y: Math.round(cam.y * 10) / 10, z: Math.round(cam.zoom), ...roundCur(cur), name: p.name, color: p.color });
  if (now - (app.lastAmb || 0) > 200) { app.lastAmb = now; audio.setAmbience(app.renderer.visibleCounts); audio.setDaylight(g.daylight() / 1000); }
  if (s.mode !== 'client' && now - app.lastSave > 30000) { app.lastSave = now; app.saveNow(); }
}
function roundCur(c) { return { cursorX: Math.round(c.cursorX * 10) / 10, cursorY: Math.round(c.cursorY * 10) / 10 }; }

function handleEvents(g) {
  const evs = g.events;
  if (!evs.length) return;
  g.events = [];
  const me = app.session.localPid;
  const cam = app.renderer.cam;
  const near = (x, y) => Math.abs(x - cam.x) < 30 && Math.abs(y - cam.y) < 20;
  let crafted = 0;
  for (const e of evs) {
    switch (e.t) {
      case 'err': if (e.pid === me) { app.ui.toast(e.msg, 'err'); audio.play('error'); } break;
      case 'built': if (e.pid !== me && near(e.x, e.y)) audio.play('place', { volume: 0.4 }); break;
      case 'removed': if (e.pid !== me && near(e.x, e.y)) audio.play('remove', { volume: 0.4 }); break;
      case 'crafted': if (e.pid === me) crafted++; break;
      case 'mine-hit': if (e.pid === me) audio.play(e.kind === 'tree' ? 'mine-wood' : 'mine-hit', { volume: 0.7 }); break;
      case 'mined': if (e.pid === me) audio.play('pickup', { volume: 0.5 }); break;
      case 'researched': app.ui.toast(`研究完了: ${TECHS[e.tech].ja}`, 'good'); audio.play('research-done'); break;
      case 'research-start': if (e.pid !== me) app.ui.toast(`研究開始: ${TECHS[e.tech].ja}`); break;
      case 'join': { const p = g.players.get(e.pid); if (p && e.pid !== me) { app.ui.toast(`${p.name} が参加しました`, 'good'); audio.play('join'); } break; }
      case 'leave': { const p = g.players.get(e.pid); if (p && e.pid !== me) app.ui.toast(`${p.name} が抜けました`); break; }
      case 'launching': app.ui.toast('ロケットの打ち上げ準備ができました！', 'good'); audio.play('alert'); break;
      case 'rocket': app.ui.toast('ロケットを打ち上げました！おめでとうございます！', 'good'); audio.play('rocket-launch'); break;
      default: break;
    }
  }
  if (crafted) audio.play('craft-done', { volume: 0.6 });
}

// ------------------------------------------------------------------ title screen
function alertTitle(msg) {
  showTitle();
  const el = document.getElementById('title-msg');
  if (el) { el.textContent = msg; el.hidden = false; }
}

function getInvite() {
  const q = new URLSearchParams(location.search);
  const room = (q.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const b = parseInt(q.get('b') || '0', 10) || 0;
  return room ? { room, broker: b } : null;
}

async function showTitle() {
  const t = document.getElementById('title');
  t.hidden = false;
  const name = store.get('name', '');
  const color = store.get('color', COLORS[0]);
  const inv = getInvite();
  t.innerHTML = `<div class="card panel">
    <div class="logo"><div class="word">IRONFIELD</div><div class="sub">みんなで作る 自動化工場</div></div>
    <div id="title-msg" class="toast panel err" hidden></div>
    ${inv ? `<div class="section inset" style="padding:12px"><h3>招待されています</h3><div class="row"><span class="room-code">${esc(inv.room)}</span><div class="sp"></div><button class="btn primary" id="t-invite">参加する</button></div></div>` : ''}
    <div class="section"><h3>あなたの名前</h3>
      <input type="text" id="t-name" maxlength="20" placeholder="プレイヤー" value="${esc(name)}" autocomplete="nickname">
      <div class="colors" id="t-colors">${COLORS.map(c => `<button style="background:${c}" data-c="${c}" class="${c === color ? 'on' : ''}" aria-label="色 ${c}"></button>`).join('')}</div></div>
    <div class="section"><h3>新しいワールド</h3>
      <div class="row"><button class="btn primary" id="t-host" style="flex:1">サーバーを立てる（だれでも参加可）</button></div>
      <div class="row"><button class="btn" id="t-solo" style="flex:1">ひとりで遊ぶ</button>
      <label class="row" style="gap:6px;font-size:13px"><input type="checkbox" id="t-sandbox"> クリエイティブ</label></div></div>
    <div class="section"><h3>部屋に参加</h3>
      <div class="row" style="flex-wrap:nowrap"><input type="text" id="t-room" maxlength="8" placeholder="部屋番号（例 K7Q2XM）" style="text-transform:uppercase" autocomplete="off"><button class="btn go" id="t-join">参加</button></div>
      <div class="row"><h3 style="font-size:13px">公開中のワールド</h3><div class="sp"></div><button class="btn small" id="t-refresh">更新</button></div>
      <div class="lobby" id="t-lobby"><div class="muted">探しています…</div></div></div>
    <div class="section"><h3>保存したワールド</h3><div class="col saves" id="t-saves"><div class="muted">読み込み中…</div></div></div>
    <div class="muted" style="font-size:11px;text-align:center">iPhone では共有ボタンから「ホーム画面に追加」すると全画面で遊べます</div>
  </div>`;
  const $ = id => document.getElementById(id);
  const saveName = () => store.set('name', $('t-name').value.trim().slice(0, 20));
  $('t-name').addEventListener('change', saveName);
  $('t-colors').addEventListener('click', e => {
    const b = e.target.closest('button[data-c]');
    if (!b) return;
    store.set('color', b.dataset.c);
    for (const x of $('t-colors').children) x.classList.toggle('on', x === b);
  });
  const newGame = () => Game.create({ name: `${(store.get('name', '') || 'プレイヤー')}の工場`, sandbox: $('t-sandbox').checked });
  $('t-solo').onclick = () => { audio.unlock(); saveName(); app.saveId = null; startOffline(newGame()); };
  $('t-host').onclick = () => { audio.unlock(); saveName(); app.saveId = null; startHost(newGame()); };
  $('t-join').onclick = () => {
    audio.unlock(); saveName();
    const code = $('t-room').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const [room, b] = code.length > 6 ? [code.slice(0, 6), parseInt(code.slice(6), 10) || 0] : [code, 0];
    if (room.length < 4) { $('title-msg').textContent = '部屋番号を入れてください'; $('title-msg').hidden = false; return; }
    startClient(room, b);
  };
  if (inv) $('t-invite').onclick = () => { audio.unlock(); saveName(); startClient(inv.room, inv.broker); };
  $('t-refresh').onclick = () => refreshLobby();
  refreshLobby();
  refreshSaves();
}

async function refreshLobby() {
  const box = document.getElementById('t-lobby');
  if (!box) return;
  box.innerHTML = '<div class="muted">探しています…</div>';
  let list = [];
  try { list = await listLobbies(2500); } catch { list = []; }
  if (!document.getElementById('t-lobby')) return;
  if (!list.length) { box.innerHTML = '<div class="muted">今は公開中のワールドがありません</div>'; return; }
  box.innerHTML = list.map(l => `<div class="item" data-room="${esc(l.room)}" data-b="${l.broker | 0}" role="button" tabindex="0">
    <div style="flex:1;min-width:0"><b>${esc(l.world || '名前のない工場')}</b><div class="muted" style="font-size:12px">ホスト ${esc(l.host || '?')}・${l.players | 0}人</div></div>
    <span class="chip">${esc(l.room)}</span></div>`).join('');
  box.onclick = e => {
    const it = e.target.closest('.item');
    if (!it) return;
    audio.unlock();
    store.set('name', document.getElementById('t-name').value.trim().slice(0, 20));
    startClient(it.dataset.room, parseInt(it.dataset.b, 10) || 0);
  };
}

async function refreshSaves() {
  const box = document.getElementById('t-saves');
  if (!box) return;
  const saves = await listSaves();
  if (!saves.length) { box.innerHTML = '<div class="muted">まだありません</div>'; return; }
  box.innerHTML = saves.map(s => `<div class="item"><div style="flex:1;min-width:0"><b>${esc(s.name)}</b>
    <div class="muted" style="font-size:12px">${new Date(s.date).toLocaleString('ja-JP')}・${Math.floor(s.tick / 3600)}分</div></div>
    <button class="btn small" data-act="solo" data-id="${s.id}">続ける</button>
    <button class="btn small primary" data-act="host" data-id="${s.id}">公開</button>
    <button class="btn small danger" data-act="del" data-id="${s.id}" aria-label="削除">✕</button></div>`).join('');
  box.onclick = async e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    audio.unlock();
    const id = b.dataset.id;
    if (b.dataset.act === 'del') {
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = '削除する'; return; }
      await deleteSave(id); refreshSaves(); return;
    }
    const rec = await getSave(id);
    if (!rec) return;
    loading('ワールドを読み込んでいます…');
    const g = await Game.load(rec.bytes);
    loading(null);
    app.saveId = id;
    store.set('name', document.getElementById('t-name').value.trim().slice(0, 20));
    if (b.dataset.act === 'host') startHost(g); else startOffline(g);
  };
}

// Hidden tabs get no animation frames. A worker timer keeps the simulation (and a host's world) running
// while the tab is in the background on desktop browsers. Phones suspend the page entirely anyway.
(function backgroundClock() {
  let w;
  try {
    const src = 'let t=null;onmessage=e=>{clearInterval(t);if(e.data)t=setInterval(()=>postMessage(0),50)}';
    w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  } catch { return; }
  w.onmessage = () => {
    if (!document.hidden || !app.running || !app.session) return;
    try { app.session.update(performance.now()); handleEvents(app.session.game); } catch (e) { console.error(e); }
  };
  const sync = () => w.postMessage(document.hidden);
  document.addEventListener('visibilitychange', sync);
  sync();
})();

// save when the page goes to the background (iOS kills tabs without warning)
document.addEventListener('visibilitychange', () => { if (document.hidden) app.saveNow(); });
window.addEventListener('pagehide', () => app.saveNow());

showTitle();
void ITEMS; void iconHTML;
