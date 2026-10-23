// Rough per-tick cost of a big factory: node tools/stress.mjs
import { Game } from '../src/sim/game.js';
const g = Game.create({ seed: 7, sandbox: true });
g.step([{ type: 'join', pid: 'p1', name: 't', color: '#ffffff' }]);
// flatten an area: clear water/decor for the test
const X0 = 150, Y0 = 150, W = 200, H = 200;
for (let y = Y0; y < Y0 + H; y++) for (let x = X0; x < X0 + W; x++) { const i = y * g.W + x; g.terrain[i] = 0; g.decor[i] = 0; g.res[i] = 0; }
const place = (name, x, y, dir = 0) => { const e = g._placeEntity(name, x, y, dir); return e; };
let belts = 0, ins = 0, asm = 0;
// 40 rows: belt line of 150 tiles, with an assembler block alongside every 4 tiles
for (let r = 0; r < 40; r++) {
  const y = Y0 + 2 + r * 5;
  for (let k = 0; k < 150; k++) { const b = place('transport-belt', X0 + 5 + k, y, 1); b.lanes[0].push({ i: 'iron-plate', p: 0 }); belts++; }
  for (let k = 0; k < 36; k++) {
    const x = X0 + 6 + k * 4;
    place('inserter', x + 1, y + 1, 2); ins++;
    const a = place('assembling-machine-2', x, y + 2 - 0, 0); a.recipe = 'iron-gear-wheel'; a._rec = (await import('../src/data.js')).RECIPES['iron-gear-wheel']; asm++;
  }
}
// power: solar panels + poles
for (let k = 0; k < 400; k++) place('solar-panel', 360 + (k % 20) * 3, 150 + Math.floor(k / 20) * 3);
for (let y = Y0; y < Y0 + H; y += 6) for (let x = X0; x < 420; x += 6) if (!g.entAt(x, y)) place('medium-electric-pole', x, y);
g._dirty.belts = g._dirty.power = g._dirty.fluids = true;
const t0 = performance.now();
for (let i = 0; i < 300; i++) g.step([]);
const ms = (performance.now() - t0) / 300;
console.log(`entities ${g.ents.size} belts ${belts} inserters ${ins} assemblers ${asm}: ${ms.toFixed(2)} ms/tick`);
const t1 = performance.now(); const h = g.hash(); console.log('hash ms', (performance.now() - t1).toFixed(2));
const t2 = performance.now(); const bytes = await g.serialize(); console.log('serialize ms', (performance.now() - t2).toFixed(1), 'bytes', bytes.length);
