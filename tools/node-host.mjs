// Headless host for integration tests: node tools/node-host.mjs  (prints the room, runs for N seconds)
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
vm.runInThisContext(fs.readFileSync(root + 'src/vendor/mqtt.min.js', 'utf8'));
const { HostSession } = await import('../src/net/session.js');
const { Game } = await import('../src/sim/game.js');
const secs = +(process.argv[2] || 240);
const game = Game.create({ seed: 4242, name: 'テスト工場' });
const s = await HostSession.create({ game, name: 'node-host', color: '#73b65b', worldName: game.name, broker: 0 });
console.log('ROOM', s.room, 'BROKER', s.brokerIndex);
const t0 = Date.now();
const iv = setInterval(() => {
  s.update(performance.now());
  game.events.length = 0;
}, 16);
const rep = setInterval(() => {
  console.log('tick', game.tick, 'players', s.players.map(p => p.pid).join(','), 'furnaces', game.lists.furnace.map(e => e.x + ',' + e.y).join(' '), 'hash', game.hash());
}, 5000);
setTimeout(async () => { clearInterval(iv); clearInterval(rep); await s.close(); process.exit(0); }, secs * 1000);
