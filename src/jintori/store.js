// Where the territory battle keeps its state. ServerJintori talks to the shared server (server/worker.js);
// LocalJintori keeps everything on this device and imitates the other players (rules.js simulateDay),
// for when no server address is set. The screen uses the same methods on both.
import * as J from './rules.js';

// the shared server; empty until it is deployed. ?jt=<address> overrides it (?jt=local: this device only)
const SERVER = '';
export function makeJintori() {
  let s = SERVER;
  try { const q = new URLSearchParams(location.search).get('jt'); if (q) s = q === 'local' ? '' : q; } catch { /* not in a browser */ }
  return s ? new ServerJintori(s.replace(/\/$/, '')) : new LocalJintori();
}

const KEY = 'ironfield.jintori.';
const read = (k, d) => { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* private mode: lives until the tab closes */ } };
const pack = a => { let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
const unpack = (b, n) => {
  try { const s = atob(b); if (s.length !== n) return null; const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = s.charCodeAt(i); return a; } catch { return null; }
};

export class LocalJintori {
  constructor() {
    this.shared = false;
    this.pref = read('pref', 0) | 0;     // your prefecture this season (0 = not chosen)
    this.wallet = read('wallet', null);
    this.map = null;
    this.refresh(Date.now());
  }

  // turns the day / season over if needed. Returns true when the map changed.
  refresh(now) {
    const day = J.dayIndex(now);
    const before = JSON.stringify(this.wallet);
    if (!this.wallet || typeof this.wallet.allow !== 'number') this.wallet = J.newWallet(day);
    J.refillWallet(this.wallet, day);
    const season = J.seasonOf(day);
    if (this.wallet.season !== season) { this.wallet.season = season; this.wallet.seasonUsed = 0; this.pref = 0; write('pref', 0); }
    let changed = false;
    if (!this.map) this.map = this._loadMap(season);
    if (!this.map || this.map.season !== season) { this.map = J.newMap(day); changed = true; }
    if (this.map.day < day) { J.catchUp(this.map, day); changed = true; }
    if (changed) this._saveMap();
    if (JSON.stringify(this.wallet) !== before) write('wallet', this.wallet);
    return changed;
  }

  // you can change prefecture until you have used a flag this season
  canChoosePref() { return !this.wallet.seasonUsed; }
  choosePref(p) {
    if (!(p >= 1 && p <= 47) || !this.canChoosePref()) return false;
    this.pref = p; write('pref', p);
    return true;
  }

  action(i) { return this.pref ? J.flagAction(this.map, this.pref, i) : { kind: null, why: '先に自分の県を選んでください' }; }
  power() { return J.FULL; } // one player per prefecture here, so no crowd correction

  // puts one flag on square i
  commit(i, now) {
    this.refresh(now);
    if (this.wallet.allow <= 0) return { kind: null, why: '今日の旗はもう使い切りました' };
    const r = J.useFlag(this.map, this.pref, i);
    if (!r.kind) return r;
    J.spendWallet(this.wallet, J.dayIndex(now));
    this.wallet.seasonUsed = (this.wallet.seasonUsed || 0) + 1;
    write('wallet', this.wallet);
    this._saveMap();
    return r;
  }

  _loadMap(season) {
    const o = read('map', null);
    if (!o || o.season !== season) return null;
    const owner = unpack(o.owner, J.N), def = unpack(o.def, J.N);
    if (!owner || !def) return null; // the squares changed since this was saved
    return { season: o.season, day: o.day | 0, owner, def, prog: new Uint8Array(J.N), progBy: new Uint8Array(J.N) };
  }
  _saveMap() { const m = this.map; write('map', { season: m.season, day: m.day, owner: pack(m.owner), def: pack(m.def) }); }
}

// ---------------------------------------------------------------------------- the shared server
const SKEY = 'ironfield.jtsrv.';
const sread = (k, d) => { try { const v = localStorage.getItem(SKEY + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const swrite = (k, v) => { try { localStorage.setItem(SKEY + k, JSON.stringify(v)); } catch { /* private mode */ } };
const MAP_EVERY = 30000;     // while the map screen is open
const WALLET_EVERY = 600000; // otherwise, only your flags for the day now and then

function deviceId() {
  let d = sread('device', '');
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(d)) {
    const a = new Uint8Array(18);
    crypto.getRandomValues(a);
    d = pack(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    swrite('device', d);
  }
  return d;
}

export class ServerJintori {
  constructor(base) {
    this.shared = true;
    this.base = base;
    this.device = deviceId();
    this.online = null;      // null = not asked yet, true / false = last answer
    this.players = new Array(48).fill(0);
    const day = J.dayIndex(Date.now());
    // last answers, so the screen has something to show before the server replies
    this.wallet = sread('wallet', null) || { ...J.newWallet(day), allow: 0, pref: 0, season: J.seasonOf(day), seasonUsed: 0 };
    this.pref = this.wallet.pref | 0;
    this.map = this._fromJson(sread('map', null)) || J.newMap(day);
    this.ver = 0;
    this._mapAt = 0; this._walletAt = 0; this._busy = false; this._changed = false;
    this.refresh(Date.now());
  }

  // asks the server again when it is time. live = the map screen is open. Returns true once after
  // new data has arrived, so the screen redraws.
  refresh(now, live = false) {
    const due = !this._busy && (now - this._walletAt > (live ? MAP_EVERY : WALLET_EVERY) || (live && now - this._mapAt > MAP_EVERY));
    if (due) this._sync(live);
    J.refillWallet(this.wallet, J.dayIndex(now)); // the morning refill, until the server confirms it
    const c = this._changed; this._changed = false;
    return c;
  }

  async _sync(live) {
    this._busy = true;
    try {
      const jobs = [this._post('/api/me', {}).then(o => { this._walletAt = Date.now(); this._setWallet(o.wallet); })];
      if (live || !this._mapAt) jobs.push(this._get('/api/map').then(o => { this._mapAt = Date.now(); this._setMap(o); }));
      await Promise.all(jobs);
      this.online = true;
    } catch {
      this.online = false;
      this._walletAt = this._mapAt = Date.now() - MAP_EVERY + 10000; // try again in 10 seconds
    }
    this._busy = false;
    this._changed = true;
  }

  async _get(path) {
    const r = await fetch(this.base + path, { cache: 'no-store' });
    const o = await r.json();
    if (!o.ok) throw new Error(o.why);
    return o;
  }
  async _post(path, body) {
    const r = await fetch(this.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: this.device, ...body }) });
    let o;
    try { o = await r.json(); } catch { throw new Error('サーバーの返事が読めませんでした'); }
    if (r.status >= 500 || (!o.ok && !o.wallet)) throw new Error(o.why || 'サーバーにつながりません');
    return o;
  }

  _setWallet(w) {
    if (!w) return;
    this.wallet = w;
    this.pref = w.pref | 0;
    swrite('wallet', w);
  }
  _fromJson(o) {
    if (!o || o.n !== J.N) return null; // the squares changed since this was saved
    const m = { season: o.season, day: o.day, owner: unpack(o.owner, J.N), def: unpack(o.def, J.N), prog: unpack(o.prog, J.N), progBy: unpack(o.progBy, J.N) };
    return m.owner && m.def && m.prog && m.progBy ? m : null;
  }
  _setMap(o) {
    const m = this._fromJson(o);
    if (!m) return;
    this.map = m;
    this.ver = o.ver;
    if (Array.isArray(o.players)) this.players = o.players;
    swrite('map', o);
  }

  canChoosePref() { return !this.wallet.seasonUsed; }
  // takes effect on screen at once; if the server says no, it goes back and onError explains why
  choosePref(p) {
    if (!(p >= 1 && p <= 47) || !this.canChoosePref()) return false;
    const before = this.pref;
    this.pref = p; this.wallet.pref = p;
    this._post('/api/pref', { pref: p }).then(o => {
      this._setWallet(o.wallet);
      if (!o.ok) { this.pref = before; this.wallet.pref = before; if (this.onError) this.onError(o.why); }
      this._changed = true;
    }).catch(() => { if (this.onError) this.onError('サーバーにつながらないので、県を選べませんでした。電波のよい所でもう一度選んでください'); this.pref = before; this.wallet.pref = before; this._changed = true; });
    return true;
  }

  action(i) { return this.pref ? J.flagAction(this.map, this.pref, i) : { kind: null, why: '先に自分の県を選んでください' }; }
  // what a flag from your prefecture is worth today (hundredths), from the players the server counted
  power() { return J.flagPower(Math.max(1, this.players[this.pref] || 0)); }

  // asks the server to put one flag on square i. Resolves to the result, like LocalJintori.commit
  async commit(i) {
    let o;
    try { o = await this._post('/api/flag', { cell: i }); } catch (e) { this.online = false; return { kind: null, why: 'サーバーにつながりません。電波のよい所でもう一度試してください', offline: true }; }
    this.online = true;
    this._setWallet(o.wallet);
    if (!o.ok) { this._mapAt = 0; return { kind: null, why: o.why }; } // the map may be out of date: fetch it again
    const c = o.cell, m = this.map;
    m.owner[c.i] = c.owner; m.def[c.i] = c.def; m.prog[c.i] = c.prog; m.progBy[c.i] = c.progBy;
    this._changed = true;
    return o.r;
  }
}
