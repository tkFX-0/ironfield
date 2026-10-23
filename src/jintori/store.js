// Where the territory battle keeps its state. For now everything lives on this device and the other
// players are imitated (rules.js simulateDay). Step 3 of docs/陣取り設計.md replaces this with the server;
// the screen only uses the methods below, so that swap should not touch it.
import * as J from './rules.js';

const KEY = 'ironfield.jintori.';
const read = (k, d) => { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* private mode: lives until the tab closes */ } };
const pack = a => { let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
const unpack = (b, n) => {
  try { const s = atob(b); if (s.length !== n) return null; const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = s.charCodeAt(i); return a; } catch { return null; }
};

export class LocalJintori {
  constructor() {
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

  // a flag has left the factory inventory: put it on square i
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
    return { season: o.season, day: o.day | 0, owner, def };
  }
  _saveMap() { const m = this.map; write('map', { season: m.season, day: m.day, owner: pack(m.owner), def: pack(m.def) }); }
}
