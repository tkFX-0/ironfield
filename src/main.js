// Boot, title screen, session lifecycle and the frame loop.
import { Game } from './sim/game.js';
import { Renderer } from './render/renderer.js';
import { UI } from './ui/ui.js';
import { Controller } from './input.js';
import { audio } from './audio.js';
import { buildIconSheet, iconHTML } from './ui/icons.js';
import { HostSession, ClientSession, ViewSession, listLobbies, OPEN_BROKER, probeOpenWorld, newerCopy, plotRoom, plotOfRoom } from './net/session.js';
import { putSave, getSave } from './saves.js';
import { TECHS, ITEMS } from './data.js';
import { JintoriView } from './jintori/view.js';
import { LocalJintori } from './jintori/store.js';
import { PREFS } from './jintori/japan.js';
import { PLOT_AT, PLOT_COLS, PLOT_ROWS, plotSeed, plotPlace, plotAtCell } from './plots.js';

const COLORS = ['#f0a64a', '#e8574a', '#5ea2d8', '#73b65b', '#c77ddb', '#e3d34f', '#4fd1c5', '#f2f2f2'];
const plotSaveId = p => 'plot2-' + p; // this device's copy of a prefecture plot (2: land runs on across plot borders)
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem('ironfield.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ironfield.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const app = {
  dpr: Math.min(window.devicePixelRatio || 1, 2),
  renderer: null, ui: null, ctrl: null, session: null, audio,
  running: false, mouseTile: null,
  jintoriStore: new LocalJintori(), // shared by the title screen (your prefecture = your plot) and the map
  submit(cmd) { if (this.session) this.session.submit(cmd); },
  shareUrl() { return location.origin + location.pathname; }, // everyone picks their own prefecture's plot
  async saveNow(manual = false) {
    const s = this.session;
    if (!s || !s.game || !s.open) return;
    try {
      const g = s.game;
      const tick = g.tick;
      const bytes = await g.serialize();
      // everyone in a plot keeps a copy, so it survives even if the broker copy is lost
      await putSave({ id: plotSaveId(plotOfRoom(s.room)), name: g.name, tick, date: Date.now(), bytes, epoch: s.mode === 'host' ? s.epoch : s.hostEpoch });
      if (s.mode === 'host') s.publishWorld(bytes, tick);
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
    stopNeighbours();
    this.ui && this.ui.closeSheet();
    document.getElementById('hud').hidden = true;
    document.body.classList.remove('viewing');
    if (app.jintori) app.jintori.close();
    showTitle();
  },
  // your prefecture changed on the map: your factory moves to that plot
  async movePlot(p) {
    await this.quitToTitle();
    enterPlot(p);
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
  const g = session.game;
  app.renderer.setMap(g);
  const cam = app.renderer.cam;
  cam.x = g.spawn.x + 0.5; cam.y = g.spawn.y + 0.5;
  cam.zoom = 46 * app.dpr;
  document.getElementById('title').hidden = true;
  document.getElementById('hud').hidden = false;
  if (!app.ui) { app.ui = new UI(app); app.ctrl = new Controller(app); app.jintori = new JintoriView(app, app.jintoriStore); }
  bindSession(session);
  document.body.classList.toggle('viewing', session.mode === 'view');
  app.ctrl.setMode('normal');
  app.ui.onModeChange();
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

// Makes `session` the live one. Also used mid-game when the shared world changes hands.
function bindSession(session) {
  app.session = session;
  const live = () => app.session === session;
  session.on('game', ng => { if (live()) app.renderer.setMap(ng); });
  session.on('chat', m => {
    if (!live()) return;
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
    if (live()) app.renderer.overlay.cursors = list;
  });
  session.on('status', st => {
    if (!st || !live() || st.message === 'Closed') return; // we closed it ourselves
    if (st.state === 'disconnected' && session.mode === 'client') { scheduleTakeover(session); return; }
    if (st.state === 'disconnected') app.ui.toast('ホストとの接続が切れました。メニューからタイトルへ戻れます', 'err');
    if (st.state === 'error') app.ui.toast(st.message || '接続エラー', 'err');
  });
  let told = 0;
  session.on('viewonly', () => { if (live() && performance.now() - told > 2500) { told = performance.now(); app.ui.toast('見に来ているだけなので、さわれません'); } });
  session.on('desync', () => { if (live()) app.ui.toast('ずれを直すため同期し直しています…'); });
  session.on('rival', () => { if (live()) yieldToRival(session); });
}

// ------------------------------------------------------------------ the plots of the big world
function joinOpen(room, joinTimeoutMs) {
  const p = profile();
  return ClientSession.create({ room, broker: OPEN_BROKER, name: p.name, color: p.color, pid: p.pid, joinTimeoutMs, loadGame: bytes => Game.load(bytes) });
}
function hostOpen(room, game, epoch) {
  const p = profile();
  return HostSession.create({ game, name: p.name, color: p.color, pid: p.pid, worldName: game.name, open: room, epoch });
}
const errText = e => (e && e.message ? e.message : String(e));

// The newest copy of a plot: the broker's retained copy or this device's own, whichever is later.
// Without any copy, a new plot (or null when `create` is false).
async function newestPlot(pref, remote, lastHost, create = true) {
  let local = null;
  try { local = await getSave(plotSaveId(pref)); } catch { /* no local copy */ }
  const copies = [];
  if (remote) copies.push(remote);
  if (local && local.bytes) copies.push({ bytes: local.bytes, tick: local.tick | 0, epoch: local.epoch | 0 });
  copies.sort((a, b) => (newerCopy(a.epoch, a.tick, b.epoch, b.tick) ? -1 : 1));
  const epoch = Math.max(lastHost ? lastHost.e : 0, ...copies.map(c => c.epoch));
  for (const c of copies) {
    try { return { game: await Game.load(c.bytes), epoch }; } catch (e) { console.warn('[plot] unusable world copy', e); }
  }
  return { game: create ? Game.create({ seed: plotSeed(pref), name: `${PREFS[pref].name}の区画`, plot: pref, at: plotPlace(pref) }) : null, epoch };
}

// The neighbouring plots' saved copies, drawn around yours (renderer._drawAround). Read one at a time in the
// background after you enter, then again every few minutes: they are a view, not a live game.
const NEIGHBOUR_REFRESH_MS = 5 * 60 * 1000;
let neighbourRun = 0;
function stopNeighbours() {
  neighbourRun++;
  if (app.renderer) app.renderer.neighbours = null;
}
async function watchNeighbours(pref) {
  stopNeighbours();
  const run = neighbourRun, live = () => run === neighbourRun;
  const map = app.renderer.neighbours = new Map();
  const { c, r } = PLOT_AT.get(pref);
  const at = steps => steps.map(([dc, dr]) => plotAtCell(c + dc, r + dr)).filter(Boolean);
  const sides = at([[1, 0], [-1, 0], [0, -1], [0, 1]]), corners = at([[1, 1], [-1, 1], [1, -1], [-1, -1]]);
  const read = async p => {
    try {
      const probe = await probeOpenWorld(plotRoom(p));
      const { game } = live() ? await newestPlot(p, probe.world, null, false) : {};
      if (live() && game) map.set(p, game);
    } catch (e) { console.warn('[plot] neighbour', p, errText(e)); }
  };
  while (live()) {
    // the sides first (most of what you see), each group at once
    await Promise.all(sides.map(read));
    if (live()) await Promise.all(corners.map(read));
    await new Promise(res => setTimeout(res, NEIGHBOUR_REFRESH_MS));
  }
}

// Look round another prefecture's plot: its newest saved copy runs here only (net/session.js ViewSession).
// Every minute a newer copy, if any, replaces it, so what you see follows the real plot with a short delay.
const VIEW_REFRESH_MS = 60 * 1000;
async function viewPlot(pref) {
  const P = PREFS[pref], room = plotRoom(pref);
  await ensureRenderer();
  loading(`${P.name}の区画を見に行っています…`);
  let probe = {}, game = null;
  try { probe = await probeOpenWorld(room); } catch { /* fall back to this device's copy */ }
  try { ({ game } = await newestPlot(pref, probe.world, null)); }
  catch (e) { loading(null); alertTitle(`${P.name}の区画を開けませんでした: ` + errText(e)); return; }
  const p = profile();
  const s = await ViewSession.create({ game, room, name: p.name, color: p.color, pid: p.pid });
  s.seen = { tick: game.tick, epoch: probe.world ? probe.world.epoch : 0 };
  loading(null);
  await enterGame(s);
  app.ui.toast(probe.world || game.ents.size ? `${P.name}の区画を見ています（見るだけ）` : `${P.name}の区画は、まだだれも作っていません`, 'good');
  watchNeighbours(pref);
  const run = neighbourRun; // stopNeighbours() (leaving the plot) ends this loop too
  while (true) {
    await new Promise(res => setTimeout(res, VIEW_REFRESH_MS));
    if (run !== neighbourRun || app.session !== s) return;
    try {
      const probe2 = await probeOpenWorld(room);
      const w = probe2.world;
      if (!w || !newerCopy(w.epoch, w.tick, s.seen.epoch, s.seen.tick)) continue;
      const ng = await Game.load(w.bytes);
      if (run !== neighbourRun || app.session !== s) return;
      s.seen = w;
      s.replaceGame(ng);
    } catch (e) { console.warn('[view] refresh', errText(e)); }
  }
}
app.viewPlot = async p => { await app.quitToTitle(); viewPlot(p); };

async function enterPlot(pref) {
  const P = PREFS[pref], room = plotRoom(pref);
  await ensureRenderer();
  loading(`${P.name}の区画を探しています…`);
  let probe;
  try { probe = await probeOpenWorld(room); }
  catch (e) { loading(null); alertTitle(`${P.name}の区画につながりませんでした: ` + errText(e)); return; }
  if (probe.host) {
    loading(`${P.name}の区画に入っています…`);
    try {
      const s = await joinOpen(room, probe.live ? 20000 : 12000);
      loading(null);
      await enterGame(s);
      app.ui.toast(`${P.name}の区画に入りました`, 'good');
      watchNeighbours(pref);
      return;
    } catch (e) {
      if (!/did not answer/.test(errText(e))) { loading(null); alertTitle('入れませんでした: ' + errText(e)); return; }
    }
  }
  // nobody inside: this device opens the plot from the newest copy
  loading('だれもいないので、あなたが区画を開いています…');
  try {
    const { game, epoch } = await newestPlot(pref, probe.world, probe.host);
    const h = await hostOpen(room, game, epoch + 1);
    loading(null);
    await enterGame(h);
    app.ui.toast(`${P.name}の区画を開きました。同じ県の人が入ってこられます`, 'good');
    app.saveNow();
    watchNeighbours(pref);
  } catch (e) {
    loading(null);
    alertTitle('区画を開けませんでした: ' + errText(e));
  }
}

// The host left the plot. Remaining players take over in join order, a few seconds apart,
// so normally one of them does; the others see its frames and switch to it on their own.
function scheduleTakeover(s) {
  if (s._takeover) return;
  app.ui.toast('ワールドを動かしていた人が抜けました。引き継いでいます…');
  const order = s.players.filter(p => p.pid !== s.hostPid).map(p => p.pid);
  const rank = Math.max(0, order.indexOf(s.localPid));
  s._takeover = setTimeout(async () => {
    if (app.session !== s || s.status.state !== 'disconnected' || !s.game) { s._takeover = null; return; }
    const game = s.game, epoch = s.hostEpoch + 1;
    s.close();
    try {
      bindSession(await hostOpen(s.room, game, epoch));
      app.ui.toast('あなたがワールドを引き継ぎました', 'good');
      app.saveNow();
    } catch (e) {
      app.ui.toast('引き継げませんでした: ' + errText(e), 'err');
    }
  }, 1500 + rank * 3000 + Math.random() * 600);
}

// Another host is running the plot (we woke from the background, or two of us opened it at once).
async function yieldToRival(h) {
  await app.saveNow(); // keep our side on this device
  h.close();
  app.ui.toast('別の人がワールドを動かしていたので、そちらに合流します');
  try {
    bindSession(await joinOpen(h.room, 15000));
  } catch (e) {
    app.ui.toast('合流できませんでした。タイトルから入り直してください: ' + errText(e), 'err');
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
  if (app.jintori.isOpen) app.jintori.update(now); // the map covers the factory: no need to draw it
  else app.renderer.render(dt, s.localPid);
  app.ui.update(now);
  const cam = app.renderer.cam;
  const p = profile();
  const cur = app.mouseTile ? { cursorX: app.mouseTile[0] + 0.5, cursorY: app.mouseTile[1] + 0.5 } : { cursorX: cam.x, cursorY: cam.y };
  s.setPresence({ x: Math.round(cam.x * 10) / 10, y: Math.round(cam.y * 10) / 10, z: Math.round(cam.zoom), ...roundCur(cur), name: p.name, color: p.color });
  if (now - (app.lastAmb || 0) > 200) { app.lastAmb = now; audio.setAmbience(app.renderer.visibleCounts); audio.setDaylight(g.daylight() / 1000); }
  if (now - app.lastSave > 30000) { app.lastSave = now; app.saveNow(); }
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
      case 'err': if (e.pid === me) { app.ui.toast(e.msg, 'err'); audio.play('error'); app.jintori.onError(e.msg); } break;
      case 'flag-used': if (e.pid === me) app.jintori.onFlagUsed(e); break;
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

async function showTitle() {
  const t = document.getElementById('title');
  t.hidden = false;
  const name = store.get('name', '');
  const color = store.get('color', COLORS[0]);
  const js = app.jintoriStore;
  js.refresh(Date.now());
  const tiles = [];
  for (const [pref, { c, r }] of PLOT_AT) {
    const P = PREFS[pref];
    tiles.push(`<button class="plot${P.short.length > 2 ? ' l3' : ''}" data-p="${pref}" style="grid-column:${c + 1};grid-row:${r + 1};--pc:${P.color}" aria-label="${esc(P.name)}">${esc(P.short)}<i></i></button>`);
  }
  t.innerHTML = `<div class="card panel">
    <div class="logo"><div class="word">IRONFIELD</div><div class="sub">みんなで作る 自動化工場</div></div>
    <div id="title-msg" class="toast panel err" hidden></div>
    <div class="section"><h3>あなたの名前</h3>
      <input type="text" id="t-name" maxlength="20" placeholder="プレイヤー" value="${esc(name)}" autocomplete="nickname">
      <div class="colors" id="t-colors">${COLORS.map(c => `<button style="background:${c}" data-c="${c}" class="${c === color ? 'on' : ''}" aria-label="色 ${c}"></button>`).join('')}</div></div>
    <div class="section"><h3>自分の県の区画を選ぶ</h3>
      <div class="muted" style="font-size:12px">ひとつの大きなワールドを、47の都道府県の区画に分けています。自分の県の区画で、同じ県の人と工場を作ります。</div>
      <div class="plots" id="t-plots" style="grid-template-columns:repeat(${PLOT_COLS},1fr);grid-template-rows:repeat(${PLOT_ROWS},1fr)">${tiles.join('')}</div>
      <div class="muted" id="t-plot-note" style="font-size:12px;min-height:1.5em"></div>
      <div class="row"><button class="btn primary" id="t-enter" style="flex:1"></button><button class="btn" id="t-view" hidden>見に行く</button></div></div>
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
  let pick = js.pref;
  const people = new Map();
  const locked = !js.canChoosePref();
  const paint = () => {
    for (const b of $('t-plots').children) {
      const p = +b.dataset.p, n = people.get(p) || 0;
      b.classList.toggle('on', p === pick);
      b.classList.toggle('busy', n > 0);
      b.title = `${PREFS[p].name}${n ? `（${n}人）` : ''}`;
    }
    const P = PREFS[pick], n = people.get(pick) || 0;
    const other = !!pick && pick !== js.pref; // looking round another prefecture is always allowed
    $('t-enter').disabled = !pick || (locked && other);
    $('t-enter').textContent = P ? `${P.name}の区画に入る` : '県をえらんでください';
    $('t-view').hidden = !other;
    $('t-plot-note').textContent = locked && other
      ? 'このシーズンは陣取りで旗を使ったので、県は来月まで変えられません。「見に行く」で見るだけはできます'
      : P ? (n ? `いま${n}人が作業しています` : 'いまはだれもいません。入ると、あなたが区画を開きます') : '';
  };
  $('t-plots').onclick = e => {
    const b = e.target.closest('button[data-p]');
    if (!b || b.disabled) return;
    audio.unlock();
    pick = +b.dataset.p;
    audio.play('click');
    paint();
  };
  $('t-enter').onclick = () => {
    if (!pick) return;
    audio.unlock(); saveName();
    if (pick !== js.pref && !js.choosePref(pick)) { alertTitle('県を変えられませんでした'); return; }
    enterPlot(pick);
  };
  $('t-view').onclick = () => {
    if (!pick) return;
    audio.unlock(); saveName();
    viewPlot(pick);
  };
  paint();
  // how many people are in each plot right now (each plot's host keeps a lobby entry up to date)
  try {
    for (const l of await listLobbies(2500)) { const p = plotOfRoom(l.room); if (p) people.set(p, l.players); }
  } catch { /* the counts are only a hint */ }
  if ($('t-plots')) paint();
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
