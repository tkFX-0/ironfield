// Headless checks for the simulation: node tools/simtest.mjs
import { Game } from '../src/sim/game.js';
import { invCount } from '../src/sim/inventory.js';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };

const g = Game.create({ seed: 12345, sandbox: true });
const P = 'p1';
g.step([{ type: 'join', pid: P, name: 'tester', color: '#ff8800' }]);
const pl = g.players.get(P);
const give = (item, count) => g.apply({ pid: P, type: 'give', item, count });
const cmd = c => g.apply({ pid: P, ...c });
const run = n => { for (let i = 0; i < n; i++) g.step([]); };
const errs = () => g.events.filter(e => e.t === 'err').map(e => e.msg);

// find an ore patch tile with a free 4x4 area
function findRes(r, size = 4) {
  for (let rad = 0; rad < 120; rad++)
    for (let y = g.spawn.y - rad; y <= g.spawn.y + rad; y++)
      for (let x = g.spawn.x - rad; x <= g.spawn.x + rad; x++) {
        let good = true;
        for (let yy = 0; yy < size && good; yy++) for (let xx = 0; xx < size; xx++) if (g.resAt(x + xx, y + yy) !== r || g.terrainAt(x + xx, y + yy) >= 4) { good = false; break; }
        if (good) return [x, y];
      }
  return null;
}

// 1. burner drill -> stone furnace
{
  const [x, y] = findRes(1, 2);
  give('coal', 50);
  cmd({ type: 'build', item: 'burner-mining-drill', x, y: y + 2, dir: 0 }); // outputs north into furnace at y..y+1
  cmd({ type: 'build', item: 'stone-furnace', x, y, dir: 0 });
  const drill = g.entAt(x, y + 2), fur = g.entAt(x, y);
  ok(drill && drill.name === 'burner-mining-drill', 'drill placed ' + errs().join(','));
  ok(fur && fur.name === 'stone-furnace', 'furnace placed');
  cmd({ type: 'put', id: drill.id, item: 'coal', count: 10 });
  cmd({ type: 'put', id: fur.id, item: 'coal', count: 10 });
  run(60 * 60);
  ok(fur.out && fur.out[0] === 'iron-plate' && fur.out[1] >= 8, 'furnace smelted iron plates: ' + JSON.stringify(fur.out) + ' src ' + JSON.stringify(fur.src));
}

// 2. belt line with inserter into chest
{
  // free 14x8 land area
  let bx, by;
  outer: for (let rad = 4; rad < 150; rad++) for (let y = g.spawn.y - rad; y <= g.spawn.y + rad; y++) for (let x = g.spawn.x - rad; x <= g.spawn.x + rad; x++) {
    let free = true;
    for (let yy = y - 5; yy < y + 3 && free; yy++) for (let xx = x - 2; xx < x + 12; xx++) if (g.terrainAt(xx, yy) >= 4 || g.entAt(xx, yy) || g.resAt(xx, yy)) { free = false; break; }
    if (free) { bx = x; by = y; break outer; }
  }
  cmd({ type: 'build', item: 'iron-chest', x: bx - 1, y: by, dir: 0 });
  const src = g.entAt(bx - 1, by);
  give('iron-plate', 100);
  cmd({ type: 'put', id: src.id, item: 'iron-plate', count: 100 });
  cmd({ type: 'build', item: 'inserter', x: bx, y: by, dir: 1 });
  for (let k = 1; k < 8; k++) cmd({ type: 'build', item: 'transport-belt', x: bx + k, y: by, dir: 1 });
  cmd({ type: 'build', item: 'solar-panel', x: bx, y: by - 4, dir: 0 });
  cmd({ type: 'build', item: 'small-electric-pole', x: bx + 1, y: by - 1, dir: 0 });
  const ins = g.entAt(bx, by);
  ok(ins && ins.name === 'inserter', 'inserter placed');
  run(20 * 60);
  const belt = g.entAt(bx + 7, by);
  const items = belt.lanes[0].length + belt.lanes[1].length;
  ok(items >= 3, 'items travelled to belt end: ' + items + ' sat ' + (ins._net && ins._net.sat) + ' ' + errs().slice(-3).join(','));
  // count total items on belt line
  let total = 0;
  for (let k = 1; k < 8; k++) { const b = g.entAt(bx + k, by); total += b.lanes[0].length + b.lanes[1].length; }
  ok(total > 5, 'belt line holds items: ' + total);
}

// 3. steam power: offshore pump -> boiler -> engine -> pole -> electric drill
{
  // find a shoreline tile: land with water to its south
  let found = null;
  for (let rad = 3; rad < 120 && !found; rad++)
    for (let y = g.spawn.y - rad; y <= g.spawn.y + rad && !found; y++)
      for (let x = g.spawn.x - rad; x <= g.spawn.x + rad; x++) {
        if (g.terrainAt(x, y) < 4 && g.terrainAt(x, y + 1) >= 4) {
          let free = true;
          for (let yy = y - 12; yy <= y && free; yy++) for (let xx = x - 3; xx <= x + 3; xx++) if (g.terrainAt(xx, yy) >= 4 || g.entAt(xx, yy) || g.resAt(xx, yy)) { free = false; break; }
          if (free) { found = [x, y]; break; }
        }
      }
  ok(!!found, 'found shoreline ' + found);
  const [x, y] = found;
  cmd({ type: 'build', item: 'offshore-pump', x, y, dir: 0 }); // outputs north
  // boiler facing north: 3x2, water inputs at left/right ends of bottom row -> need pipe from pump to boiler side
  cmd({ type: 'build', item: 'pipe', x, y: y - 1, dir: 0 });
  cmd({ type: 'build', item: 'boiler', x: x - 3, y: y - 3, dir: 0 }); // occupies x-3..x-1, y-3..y-2; east water conn at (x-1,y-2) facing east -> tile (x, y-2)
  cmd({ type: 'build', item: 'pipe', x, y: y - 2, dir: 0 });
  // steam out at top middle (x-2, y-3) facing north -> engine at x-3..x-1, y-8..y-4 (3x5) with south conn at (x-2, y-4)
  cmd({ type: 'build', item: 'steam-engine', x: x - 3, y: y - 8, dir: 0 });
  const boiler = g.entAt(x - 3, y - 3), eng = g.entAt(x - 3, y - 8);
  ok(boiler && boiler.name === 'boiler', 'boiler placed ' + errs().slice(-2).join(','));
  ok(eng && eng.name === 'steam-engine', 'engine placed ' + errs().slice(-2).join(','));
  give('coal', 50);
  cmd({ type: 'put', id: boiler.id, item: 'coal', count: 20 });
  cmd({ type: 'build', item: 'small-electric-pole', x: x - 4, y: y - 6, dir: 0 });
  cmd({ type: 'build', item: 'lamp' });
  // a lab as consumer
  cmd({ type: 'build', item: 'lab', x: x - 8, y: y - 8, dir: 0 });
  cmd({ type: 'build', item: 'small-electric-pole', x: x - 5, y: y - 9, dir: 0 });
  const lab = g.entAt(x - 8, y - 8);
  ok(lab && lab.name === 'lab', 'lab placed');
  cmd({ type: 'research', tech: 'automation' });
  give('automation-science-pack', 20);
  cmd({ type: 'put', id: lab.id, item: 'automation-science-pack', count: 20 });
  run(60 * 10);
  const net = eng._net;
  ok(net && net.stats.supply > 0, 'engine supplies power: ' + JSON.stringify(net && net.stats));
  ok(boiler._fn[0].fluid === 'water' || boiler._fn[1].fluid === 'steam', 'boiler networks have fluid: ' + boiler._fn[0].fluid + '/' + boiler._fn[1].fluid);
  run(60 * 100);
  ok(g.techDone('automation'), 'automation researched (ud=' + g.research.ud + ')');
}

// 4. hand crafting with intermediates
{
  give('iron-plate', 50); give('copper-plate', 50);
  const before = invCount(pl.inv, 'electronic-circuit');
  cmd({ type: 'craft', recipe: 'electronic-circuit', count: 3 });
  run(60 * 10);
  ok(invCount(pl.inv, 'electronic-circuit') === before + 3, 'hand crafted 3 circuits (with cables)');
  ok(Object.keys(pl.bank).length === 0, 'craft bank empty: ' + JSON.stringify(pl.bank));
}

// 5. determinism through serialize/load
{
  const bytes = await g.serialize();
  const g2 = await Game.load(bytes);
  ok(g2.hash() === g.hash(), `hash equal after load (${g.hash()} vs ${g2.hash()})`);
  for (let i = 0; i < 600; i++) { g.step([]); g2.step([]); }
  ok(g2.hash() === g.hash(), 'hash equal after 600 more ticks');
  console.log('snapshot bytes', bytes.length, 'entities', g.ents.size);
}
const t0 = performance.now();
run(600);
console.log('600 ticks ms', (performance.now() - t0).toFixed(1));
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
