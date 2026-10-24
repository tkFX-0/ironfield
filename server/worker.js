// The territory battle server (Cloudflare Workers + one Durable Object holding the whole Japan map).
// Design: docs/陣取り設計.md 5章. The rules are the same file the game uses (src/jintori/rules.js).
//
//   GET  /api/map            the map of this season (owner, defence, part-flag totals), base64
//   POST /api/me    {device}               your flags for today and your prefecture
//   POST /api/pref  {device, pref}         choose your prefecture (until you use a flag this season)
//   POST /api/flag  {device, cell}         use one flag on a square
//
// There are no accounts: a device is a random id the game makes once. What stops one person from
// playing as many devices is a per-connection (IP) limit, and the daily cap itself.
import { DurableObject } from 'cloudflare:workers';
import * as J from '../src/jintori/rules.js';

const ORIGINS = new Set(['https://tkfx-0.github.io', 'http://localhost:8140', 'http://127.0.0.1:8140']);
const NEW_DEVICES_PER_IP = 3;   // new devices one connection may start per day (a family can share a router)
const FLAGS_PER_IP = 45;        // flags one connection may use per day (5 devices' full days)
const MAP_CACHE_MS = 10000;     // each Worker instance re-reads the map at most this often

const DEVICE = /^[A-Za-z0-9_-]{16,40}$/;
const b64 = a => { let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };

function cors(req) {
  const o = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ORIGINS.has(o) ? o : 'https://tkfx-0.github.io',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (body, req, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(req), ...extra } });

// the connection's address, hashed so the raw address is never stored
async function ipKey(req, salt) {
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|' + ip)));
  return b64(h.subarray(0, 12)).replace(/[+/=]/g, '');
}

let mapCache = null; // { at, body } per Worker instance, so map reads rarely reach the Durable Object

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    if (!url.pathname.startsWith('/api/')) return new Response('Ironfield territory server', { headers: cors(req) });
    const map = env.MAP.get(env.MAP.idFromName('japan'));
    try {
      if (req.method === 'GET' && url.pathname === '/api/map') {
        if (!mapCache || Date.now() - mapCache.at > MAP_CACHE_MS) mapCache = { at: Date.now(), body: await map.mapJson() };
        return new Response(mapCache.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(req) } });
      }
      if (req.method !== 'POST') return json({ ok: false, why: 'not found' }, req, 404);
      let body;
      try { body = await req.json(); } catch { return json({ ok: false, why: 'bad request' }, req, 400); }
      if (!body || typeof body.device !== 'string' || !DEVICE.test(body.device)) return json({ ok: false, why: 'bad device' }, req, 400);
      const ip = await ipKey(req, env.SALT || 'ironfield');
      let out;
      if (url.pathname === '/api/me') out = await map.me(body.device);
      else if (url.pathname === '/api/pref') out = await map.choose(body.device, body.pref | 0, ip);
      else if (url.pathname === '/api/flag') { out = await map.flag(body.device, body.cell | 0, ip); if (out.ok) mapCache = null; }
      else return json({ ok: false, why: 'not found' }, req, 404);
      return json(out, req);
    } catch (e) {
      return json({ ok: false, why: 'サーバーで問題が起きました。少しあとでもう一度試してください' }, req, 500);
    }
  },
};

// One instance holds the whole map. Every square that differs from the season's start is one stored
// row ("c:<season>:<i>"), so a flag writes one row for the square plus one for the device.
export class JapanMap extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.m = null;
    this.ver = Date.now();
    this.ip = new Map(); // "<day>:<ip>" -> { nd, nf }. Memory only: a restart forgets it, which is fine
    ctx.blockConcurrencyWhile(async () => {
      this.act = (await ctx.storage.get('act')) || { day: -1, today: new Array(48).fill(0), yday: new Array(48).fill(0) };
      await this._loadSeason(J.dayIndex(Date.now()));
    });
  }

  async _loadSeason(day) {
    const season = J.seasonOf(day);
    const m = J.newMap(day);
    const rows = await this.ctx.storage.list({ prefix: `c:${season}:` });
    for (const [k, v] of rows) {
      const i = parseInt(k.slice(season.length + 3), 10);
      if (i >= 0 && i < J.N) { m.owner[i] = v[0]; m.def[i] = v[1]; m.prog[i] = v[2]; m.progBy[i] = v[3]; }
    }
    this.m = m;
    this.ver++;
    // last season's squares are no longer needed
    for (;;) {
      const old = await this.ctx.storage.list({ start: 'c:', end: `c:${season}`, limit: 128 });
      if (!old.size) break;
      await this.ctx.storage.delete([...old.keys()]);
    }
  }

  async _today() {
    const day = J.dayIndex(Date.now());
    if (this.m.season !== J.seasonOf(day)) await this._loadSeason(day);
    if (this.act.day !== day) {
      this.act = { day, today: new Array(48).fill(0), yday: this.act.day === day - 1 ? this.act.today : new Array(48).fill(0) };
      this.ip.clear();
      await this.ctx.storage.put('act', this.act);
    }
    return day;
  }

  async _wallet(device, day) {
    const w = (await this.ctx.storage.get('w:' + device)) || null;
    const fresh = !w;
    const out = w || { ...J.newWallet(day), pref: 0, season: J.seasonOf(day), seasonUsed: 0, activeDay: -1 };
    J.refillWallet(out, day);
    if (out.season !== J.seasonOf(day)) { out.season = J.seasonOf(day); out.seasonUsed = 0; out.pref = 0; }
    return { w: out, fresh };
  }
  _ip(day, ip) {
    const k = day + ':' + ip;
    let v = this.ip.get(k);
    if (!v) this.ip.set(k, (v = { nd: 0, nf: 0 }));
    return v;
  }
  _players() {
    return this.act.today.map((n, p) => Math.max(n, this.act.yday[p]));
  }

  async mapJson() {
    await this._today();
    const m = this.m;
    return JSON.stringify({
      ok: true, ver: this.ver, season: m.season, day: this.act.day, n: J.N,
      owner: b64(m.owner), def: b64(m.def), prog: b64(m.prog), progBy: b64(m.progBy),
      players: this._players(),
    });
  }

  async me(device) {
    const day = await this._today();
    const { w } = await this._wallet(device, day);
    return { ok: true, wallet: w, ver: this.ver };
  }

  async choose(device, pref, ip) {
    const day = await this._today();
    const { w, fresh } = await this._wallet(device, day);
    if (!(pref >= 1 && pref <= 47)) return { ok: false, why: 'その県はありません', wallet: w };
    if (w.seasonUsed && pref !== w.pref) return { ok: false, why: 'このシーズンは旗を使ったので、県は来月まで変えられません', wallet: w };
    if (fresh) {
      const c = this._ip(day, ip);
      if (c.nd >= NEW_DEVICES_PER_IP) return { ok: false, why: 'この回線からは、今日はもう新しく始められません。明日の朝5時からまた始められます', wallet: w };
      c.nd++;
    }
    w.pref = pref;
    await this.ctx.storage.put('w:' + device, w);
    return { ok: true, wallet: w };
  }

  async flag(device, i, ip) {
    const day = await this._today();
    const { w } = await this._wallet(device, day);
    if (!w.pref) return { ok: false, why: '先に自分の県を選んでください', wallet: w };
    if (w.allow <= 0) return { ok: false, why: '今日の旗はもう使い切りました。朝5時に3本増えます', wallet: w };
    const c = this._ip(day, ip);
    if (c.nf >= FLAGS_PER_IP) return { ok: false, why: 'この回線から今日使える旗の数をこえました。明日の朝5時からまた使えます', wallet: w };
    const m = this.m, p = w.pref;
    if (!J.flagAction(m, p, i).kind) return { ok: false, why: J.flagAction(m, p, i).why, wallet: w };
    // the first flag of the day counts you as one of today's players in your prefecture
    const puts = {};
    if (w.activeDay !== day) { w.activeDay = day; this.act.today[p]++; puts.act = this.act; }
    const power = J.flagPower(this._players()[p]);
    const r = J.applyFlag(m, p, i, power);
    J.spendWallet(w, day);
    w.seasonUsed = (w.seasonUsed || 0) + 1;
    c.nf++;
    this.ver++;
    puts['w:' + device] = w;
    puts[`c:${m.season}:${i}`] = [m.owner[i], m.def[i], m.prog[i], m.progBy[i]];
    await this.ctx.storage.put(puts);
    return { ok: true, r: { ...r, power }, wallet: w, ver: this.ver, cell: { i, owner: m.owner[i], def: m.def[i], prog: m.prog[i], progBy: m.progBy[i] } };
  }
}
