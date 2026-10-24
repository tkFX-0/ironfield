// Checks the territory server end to end. Start it first (from server/: npx wrangler dev), then
//   node tools/server-test.mjs [address]        (default http://127.0.0.1:8787)
// Use a fresh local store (wrangler dev --persist-to <empty folder>): the test uses real flags.
import assert from 'node:assert/strict';
import { PREFS } from '../src/jintori/japan.js';
import * as J from '../src/jintori/rules.js';

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const dev = () => 'test' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const post = async (path, body) => (await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8140' }, body: JSON.stringify(body) })).json();
const unpack = b => Uint8Array.from(Buffer.from(b, 'base64'));
const getMap = async () => {
  const r = await fetch(BASE + '/api/map', { headers: { Origin: 'http://localhost:8140' } });
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8140');
  const o = await r.json();
  return { ...o, owner: unpack(o.owner), def: unpack(o.def), prog: unpack(o.prog), progBy: unpack(o.progBy) };
};

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };

const a = dev(), b = dev();
const tokyo = 13, cap = PREFS[tokyo].capital;

await ok('the map: every prefecture on its office square', async () => {
  const m = await getMap();
  assert.equal(m.n, J.N);
  assert.equal(m.season, J.seasonOf(J.dayIndex(Date.now())));
  for (let p = 1; p <= 47; p++) assert.equal(m.owner[PREFS[p].capital], p);
});

await ok('a new device has 3 flags and no prefecture', async () => {
  const o = await post('/api/me', { device: a });
  assert.equal(o.ok, true); assert.equal(o.wallet.allow, 3); assert.equal(o.wallet.pref, 0);
});

await ok('bad requests are refused', async () => {
  assert.equal((await post('/api/me', { device: 'short' })).ok, false);
  assert.equal((await post('/api/flag', { device: a, cell: 0 })).why, '先に自分の県を選んでください');
  assert.equal((await post('/api/pref', { device: a, pref: 99 })).ok, false);
});

let next;
await ok('choose Tokyo, take a square next to the office', async () => {
  assert.equal((await post('/api/pref', { device: a, pref: tokyo })).ok, true);
  const m = await getMap();
  next = J.NEIGH[cap].find(j => !m.owner[j]);
  const o = await post('/api/flag', { device: a, cell: next });
  assert.equal(o.ok, true, o.why); assert.equal(o.r.kind, 'take'); assert.equal(o.r.power, 100);
  assert.equal(o.wallet.allow, 2); assert.equal(o.wallet.seasonUsed, 1);
  assert.equal(o.cell.owner, tokyo);
  const m2 = await getMap();
  assert.equal(m2.owner[next], tokyo, 'everybody sees it (after the short map cache)');
});

await ok('no changing prefecture after using a flag', async () => {
  const o = await post('/api/pref', { device: a, pref: 27 });
  assert.equal(o.ok, false); assert.equal(o.wallet.pref, tokyo);
});

await ok('squares not next to you are refused and cost nothing', async () => {
  const o = await post('/api/flag', { device: a, cell: PREFS[1].capital });
  assert.equal(o.ok, false); assert.equal(o.wallet.allow, 2);
});

await ok('the daily cap', async () => {
  assert.equal((await post('/api/flag', { device: a, cell: next })).r.kind, 'defend');
  assert.equal((await post('/api/flag', { device: a, cell: next })).r.kind, 'defend');
  const o = await post('/api/flag', { device: a, cell: next });
  assert.equal(o.ok, false); assert.match(o.why, /使い切りました/); assert.equal(o.wallet.allow, 0);
});

await ok('a second device of the same prefecture counts as a second player', async () => {
  assert.equal((await post('/api/pref', { device: b, pref: tokyo })).ok, true);
  const o = await post('/api/flag', { device: b, cell: next });
  assert.equal(o.ok, true, o.why); assert.equal(o.r.kind, 'defend');
  const m = await getMap();
  assert.equal(m.players[tokyo], 2);
});

await ok('one connection can only start a few new devices a day', async () => {
  // a and b already used two of today's three on this connection
  assert.equal((await post('/api/pref', { device: dev(), pref: 1 })).ok, true);
  const o = await post('/api/pref', { device: dev(), pref: 1 });
  assert.equal(o.ok, false); assert.match(o.why, /新しく始められません/);
});

console.log(`${n} server checks passed`);
