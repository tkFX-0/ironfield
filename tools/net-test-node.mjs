// Node 24 runner: node tools/net-test-node.mjs [brokerIndex ...]
// Loads the vendored browser bundle of mqtt.js and runs the same scenario as net-test.html.
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
vm.runInThisContext(fs.readFileSync(root + 'src/vendor/mqtt.min.js', 'utf8'));
const net = await import(new URL('../src/net/session.js', import.meta.url));
const { runNetTest } = await import(new URL('./net-test-core.js', import.meta.url));

const brokers = process.argv.slice(2).map(Number);
let failed = 0;
for (const b of brokers.length ? brokers : [0]) {
  console.log(`\n=== broker ${b}: ${net.BROKERS[b]} ===`);
  const r = await runNetTest(net, { broker: b });
  failed += r.filter((x) => !x.ok).length;
}
process.exit(failed ? 1 : 0);
