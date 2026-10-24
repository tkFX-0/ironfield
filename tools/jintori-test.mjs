// Headless checks for the territory battle rules: node tools/jintori-test.mjs
import assert from 'node:assert/strict';
import { PREFS } from '../src/jintori/japan.js';
import * as J from '../src/jintori/rules.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const jst = s => Date.parse(s + '+09:00');

ok('the day turns over at 05:00 Japan time', () => {
  assert.equal(J.dayIndex(jst('2026-10-24T04:59:59')), J.dayIndex(jst('2026-10-23T05:00:00')));
  assert.equal(J.dayIndex(jst('2026-10-24T05:00:00')), J.dayIndex(jst('2026-10-23T05:00:00')) + 1);
  assert.equal(J.nextResetAt(jst('2026-10-23T23:00:00')), jst('2026-10-24T05:00:00'));
});

ok('a season is a calendar month, starting at 05:00 on the 1st', () => {
  assert.equal(J.seasonOf(J.dayIndex(jst('2026-11-01T04:59:00'))), '2026-10');
  assert.equal(J.seasonOf(J.dayIndex(jst('2026-11-01T05:00:00'))), '2026-11');
  const d = J.dayIndex(jst('2026-10-23T12:00:00'));
  assert.equal(J.seasonStartDay(d), J.dayIndex(jst('2026-10-01T12:00:00')));
});

ok('3 flags a day, unused ones carry over for 2 days at most', () => {
  const w = J.newWallet(100);
  assert.equal(w.allow, 3);
  J.refillWallet(w, 101); assert.equal(w.allow, 6);
  J.refillWallet(w, 101); assert.equal(w.allow, 6, 'same day adds nothing');
  J.refillWallet(w, 110); assert.equal(w.allow, J.MAX_ALLOW);
  assert.equal(J.MAX_ALLOW, 9);
});

ok('days in a row', () => {
  const w = J.newWallet(10);
  J.spendWallet(w, 10); J.spendWallet(w, 10); assert.equal(w.streak, 1);
  J.spendWallet(w, 11); assert.equal(w.streak, 2);
  J.spendWallet(w, 13); assert.equal(w.streak, 1, 'a missed day starts over');
});

ok('every prefecture starts on its own office square', () => {
  const m = J.newMap(J.dayIndex(jst('2026-10-23T12:00:00')));
  for (let p = 1; p <= 47; p++) {
    assert.equal(m.owner[PREFS[p].capital], p);
    assert.equal(J.cellHome(PREFS[p].capital), p, PREFS[p].name);
  }
  assert.ok(J.N > 3500 && J.N < 5000, 'about 4,000 squares');
});

ok('all of Japan is connected (islands by sea crossings)', () => {
  const seen = new Uint8Array(J.N), st = [0];
  seen[0] = 1;
  let c = 1;
  while (st.length) for (const j of J.NEIGH[st.pop()]) if (!seen[j]) { seen[j] = 1; c++; st.push(j); }
  assert.equal(c, J.N);
  // Okinawa's office square must reach the main islands
  assert.ok(seen[PREFS[47].capital]);
});

ok('take, attack and defend', () => {
  const m = J.newMap(1000);
  const tokyo = 13, cap = PREFS[tokyo].capital;
  const next = J.NEIGH[cap].find(j => !m.owner[j]);
  assert.equal(J.flagAction(m, tokyo, next).kind, 'take');
  const far = PREFS[1].capital; // Hokkaido's office: not next to Tokyo, and an office anyway
  assert.equal(J.flagAction(m, tokyo, far).kind, null);
  const lonely = [...Array(J.N).keys()].find(i => !m.owner[i] && !J.NEIGH[i].some(j => m.owner[j] === tokyo));
  assert.equal(J.flagAction(m, tokyo, lonely).kind, null, 'not next to us');
  J.useFlag(m, tokyo, next);
  assert.equal(m.owner[next], tokyo); assert.equal(m.def[next], 0);
  assert.equal(J.useFlag(m, tokyo, next).kind, 'defend'); assert.equal(m.def[next], 1);
  // Kanagawa attacks it: first the defence goes, then the square
  const kana = 14;
  m.owner[J.NEIGH[next].find(j => !m.owner[j])] = kana;
  const r1 = J.useFlag(m, kana, next);
  assert.equal(r1.kind, 'attack'); assert.equal(r1.captured, false); assert.equal(m.owner[next], tokyo);
  const r2 = J.useFlag(m, kana, next);
  assert.equal(r2.captured, true); assert.equal(m.owner[next], kana);
  assert.equal(J.flagAction(m, kana, cap).kind, null, 'offices cannot be taken');
});

ok('defence stops at the top', () => {
  const m = J.newMap(1000);
  const p = 27, i = J.NEIGH[PREFS[p].capital].find(j => !m.owner[j]);
  J.useFlag(m, p, i);
  for (let k = 0; k < J.MAX_DEF; k++) J.useFlag(m, p, i);
  assert.equal(m.def[i], J.MAX_DEF);
  assert.equal(J.flagAction(m, p, i).kind, null);
});

ok('crowd correction: more players, weaker flags, but more in total', () => {
  assert.equal(J.flagPower(1), 100);
  assert.equal(J.flagPower(J.CROWD_BASE), 100);
  assert.equal(J.flagPower(20), 50);
  for (let n = 1; n < 2000; n++) {
    assert.ok(J.flagPower(n + 1) <= J.flagPower(n), 'never stronger with more players');
    // (whole percents, so one more player can round the total down a little; twice the players never does)
    assert.ok(2 * n * J.flagPower(2 * n) > n * J.flagPower(n), 'a prefecture grows with its players');
  }
  assert.equal(J.flagPower(100000), 10, 'a floor, so a flag always does something');
});

ok('weak flags add up on the square', () => {
  const m = J.newMap(1000);
  const p = 13, i = J.NEIGH[PREFS[p].capital].find(j => !m.owner[j]);
  const r1 = J.applyFlag(m, p, i, 40);
  assert.equal(r1.partial, true); assert.equal(m.owner[i], 0); assert.equal(m.prog[i], 40);
  J.applyFlag(m, p, i, 40);
  const r3 = J.applyFlag(m, p, i, 40);
  assert.equal(r3.captured, true); assert.equal(m.owner[i], p);
  assert.equal(m.prog[i], 0, 'the total starts over once the square changes hands');
  // a full flag works exactly like useFlag
  const r4 = J.applyFlag(m, p, i);
  assert.equal(r4.kind, 'defend'); assert.equal(m.def[i], 1);
  // another prefecture adding up on the same square wipes the earlier total
  const q = 14;
  m.owner[J.NEIGH[i].find(j => !m.owner[j])] = q;
  J.applyFlag(m, p, i, 50); assert.equal(m.progBy[i], p);
  J.applyFlag(m, q, i, 30); assert.equal(m.progBy[i], q); assert.equal(m.prog[i], 30);
  assert.equal(J.applyFlag(m, q, PREFS[p].capital, 50).kind, null, 'refused flags change nothing');
});

ok('the stand-in players fill about a month of map, and are repeatable', () => {
  const day = J.dayIndex(jst('2026-10-31T12:00:00'));
  const t = Date.now();
  const a = J.newMap(day); J.catchUp(a, day);
  const ms = Date.now() - t;
  const b = J.newMap(day); J.catchUp(b, day);
  assert.deepEqual(a.owner, b.owner);
  const taken = J.counts(a).reduce((s, x) => s + x, 0);
  console.log(`   31 days: ${taken} of ${J.N} squares taken, ${ms} ms`);
  assert.ok(taken > J.N * 0.5);
  assert.equal(a.day, day);
});

console.log(`${n} checks passed`);
