// Network layer test: deterministic stub game + scripted host/client scenario against a real public broker.
// Used by tools/net-test.html (browser) and tools/net-test-node.mjs (Node 24).

const enc = new TextEncoder();
const dec = new TextDecoder();

function fnv(h, str) {
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

// State = tick + rolling hash of every applied command + per-player counters.
export class StubGame {
  constructor(s = {}) {
    this.tick = s.tick ?? 0;
    this.acc = s.acc ?? 0x811c9dc5;
    this.players = s.players ?? {};
    this.pad = s.pad ?? 0;
    this.hashes = new Map();
  }
  step(cmds) {
    let a = this.acc;
    for (const c of cmds) {
      a = fnv(a, stable(c));
      if (c.type === 'join') this.players[c.pid] = this.players[c.pid] || { n: 0, k: 0 };
      else if (c.type === 'leave') delete this.players[c.pid];
      else if (c.type === 'add' && this.players[c.pid]) {
        this.players[c.pid].n = (this.players[c.pid].n + (c.v | 0)) | 0;
        this.players[c.pid].k++;
      }
    }
    this.acc = fnv(a, 't' + (this.tick + 1));
    this.tick++;
    this.hashes.set(this.tick, this.hash());
    if (this.hashes.size > 6000) this.hashes.delete(this.hashes.keys().next().value);
  }
  hash() {
    let h = this.acc;
    for (const k of Object.keys(this.players).sort()) h = fnv(h, k + ':' + this.players[k].n + ':' + this.players[k].k);
    return h >>> 0;
  }
  async serialize() {
    await new Promise((r) => setTimeout(r, 30)); // pretend compression takes time
    const head = enc.encode(JSON.stringify({ tick: this.tick, acc: this.acc, players: this.players, pad: this.pad }));
    const out = new Uint8Array(4 + head.length + this.pad);
    new DataView(out.buffer).setUint32(0, head.length);
    out.set(head, 4);
    let x = this.tick | 1;
    for (let i = 0; i < this.pad; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      out[4 + head.length + i] = x & 255;
    }
    return out;
  }
}

export async function loadStubGame(bytes) {
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const s = JSON.parse(dec.decode(bytes.subarray(4, 4 + len)));
  if (bytes.length !== 4 + len + s.pad) throw new Error('snapshot length mismatch');
  return new StubGame(s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(step);
  }
  return !!fn();
}

export async function runNetTest(net, { broker = 0, log = console.log, padBytes = 120000 } = {}) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail });
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  };
  const sessions = [];
  const loop = setInterval(() => {
    const now = performance.now();
    for (const s of sessions) s.update(now);
  }, 8);
  const rnd = () => (Math.random() * 100) | 0;
  let submitting = true;
  const submitter = setInterval(() => {
    if (!submitting) return;
    for (const s of sessions) if (s.status.state === 'playing') s.submit({ type: 'add', v: rnd(), pid: 'spoofed1' });
  }, 90);
  const counters = new Map();
  const watchStatus = (s, label) => {
    let prev = s.status.state;
    s.on('status', (st) => {
      if (st.state !== prev) log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${label} status ${prev} -> ${st.state} ${st.message}`);
      prev = st.state;
    });
  };
  const count = (s, ev) => {
    const k = s.localPid + ev;
    s.on(ev, () => counters.set(k, (counters.get(k) || 0) + 1));
  };
  const cnt = (s, ev) => counters.get(s.localPid + ev) || 0;
  const t0 = Date.now();

  const sameAt = (list, T) => {
    const hs = list.map((s) => s.game.hashes.get(T));
    return { ok: hs.every((h) => h !== undefined && h === hs[0]), hs };
  };
  const converge = async (list, label) => {
    submitting = false;
    await sleep(300);
    const host = list[0];
    const T = host.game.tick + 6;
    const reached = await waitFor(() => list.every((s) => s.game.tick >= T + 2), 15000);
    const r = sameAt(list, T);
    check(`${label}: all peers have the same hash at tick ${T}`, reached && r.ok, r.hs.map((h) => (h ?? 0).toString(16)).join(' / '));
    submitting = true;
    return r.ok;
  };

  let host, a, b;
  try {
    // ---- host
    const hg = new StubGame({ pad: padBytes });
    host = await net.HostSession.create({ game: hg, name: 'Host', color: '#ff8800', worldName: 'Test world', broker });
    sessions.push(host);
    watchStatus(host, 'host');
    count(host, 'chat');
    count(host, 'presence');
    check('host connected', host.status.state === 'playing',
      `broker ${host.brokerIndex} (${net.BROKERS[host.brokerIndex]}), room ${host.room}, ${Date.now() - t0} ms`);
    check('shareUrl format', host.shareUrl('https://x.github.io/ironfield/') === `https://x.github.io/ironfield/?room=${host.room}&b=${host.brokerIndex}`, host.shareUrl('https://x.github.io/ironfield/'));
    await sleep(500);

    // ---- client A
    const ta = Date.now();
    a = await net.ClientSession.create({ room: host.room, broker: host.brokerIndex, name: 'Alice', color: '#00aaff', loadGame: loadStubGame });
    sessions.push(a);
    ['desync', 'game', 'chat', 'presence', 'players'].forEach((e) => count(a, e));
    check('client A joined (snapshot loaded)', a.status.state === 'playing' && a.game instanceof StubGame,
      `${Date.now() - ta} ms, snapshot tick ${a.game.tick}, ${Math.ceil((padBytes + 200) / 36864)} chunks`);
    await sleep(4000);
    await converge([host, a], 'host + A after ~4 s');

    // ---- late join B
    const tb = Date.now();
    b = await net.ClientSession.create({ room: host.room, broker: host.brokerIndex, name: 'Bob', color: '#33cc66', loadGame: loadStubGame });
    sessions.push(b);
    ['desync', 'game', 'chat', 'presence', 'players'].forEach((e) => count(b, e));
    check('client B late-joined', b.status.state === 'playing', `${Date.now() - tb} ms, snapshot tick ${b.game.tick}`);
    await sleep(5000);
    await converge([host, a, b], 'host + A + B (late join)');

    const hp = host.game.players;
    const pids = [host.localPid, a.localPid, b.localPid];
    check('commands from all three peers were applied with the right pid',
      pids.every((p) => hp[p] && hp[p].k > 5) && !hp.spoofed1,
      pids.map((p) => `${p}:${hp[p]?.k}`).join(' '));
    await waitFor(() => [host, a, b].every((s) => s.players.length === 3), 5000);
    check('players list has 3 entries on every peer', [host, a, b].every((s) => s.players.length === 3),
      [host, a, b].map((s) => s.players.length).join('/'));
    check('client ping measured', Number.isInteger(a.status.ping), `A ping ${a.status.ping} ms, B ping ${b.status.ping} ms`);
    check('no desync so far', cnt(a, 'desync') === 0 && cnt(b, 'desync') === 0);
    check('no frame gaps during normal play (publish budget respected)', a.stats.gaps === 0 && b.stats.gaps === 0,
      `A ${JSON.stringify(a.stats)} B ${JSON.stringify(b.stats)} host ${JSON.stringify(host.stats)}`);

    // ---- chat + presence
    a.sendChat('hello \u0007from A' + 'x'.repeat(300));
    host.setPresence({ x: 10, y: 20, z: 0, cursorX: 5, cursorY: 6 });
    await waitFor(() => cnt(host, 'chat') > 0 && cnt(b, 'chat') > 0 && b.presence.has(host.localPid), 4000);
    check('chat delivered (host, B)', cnt(host, 'chat') > 0 && cnt(b, 'chat') > 0);
    check('presence delivered (B sees host)', b.presence.get(host.localPid)?.x === 10);

    // ---- garbage injection on the open broker
    const junk = globalThis.mqtt.connect(net.BROKERS[host.brokerIndex], { clientId: 'if-junk' + ((Math.random() * 1e9) | 0), reconnectPeriod: 0, forceNativeWebSocket: true });
    junk.on('error', () => {});
    await waitFor(() => junk.connected, 8000);
    const base = `ironfield/v1/${host.room}/`;
    const bad = ['not json', '[]', 'null', '{"k":"hello","pid":"BAD","v":1}', '{"k":"c","pid":"zzzzzzzz","c":{"type":"add","v":1}}',
      JSON.stringify({ k: 'c', pid: a.localPid, cs: [{ type: 'x'.repeat(100) }, { notype: 1 }, { type: 'add', v: 1, big: 'y'.repeat(5000) }] }),
      '{"__proto__":{"polluted":1},"k":"hb","pid":"aaaaaaaa"}', 'z'.repeat(70000)];
    for (const m of bad) junk.publish(base + 'up', m);
    for (const m of ['{"k":"f","p":"x"}', '{"k":"pl","l":5}', '{"k":"f","p":5,"t":1}', '{"k":"pl","l":[{"pid":"<script>"}]}']) junk.publish(base + 'down', m);
    junk.publish(base + 'p', '{"k":"p","pid":"qqqqqqqq","x":"NaN","n":"‮evil"}');
    junk.publish(base + 'chat', '{"k":"m","pid":"qqqqqqqq","text":5}');
    junk.publish(base + 'to/' + a.localPid, '{"k":"s","id":"x","i":0,"n":99999,"d":"!!"}');
    await sleep(1500);
    junk.end(true);
    check('garbage ignored (no crash, no prototype pollution)', ({}).polluted === undefined && host.status.state === 'playing');
    await converge([host, a, b], 'after garbage injection');

    // ---- dropped frames -> replay from host history (no snapshot)
    const gamesBefore = cnt(b, 'game');
    const orig = b._onMessage.bind(b);
    let dropped = 0;
    b._onMessage = (topic, payload) => {
      if (topic.endsWith('/down') && dropped < 5 && String.fromCharCode(...payload.subarray(0, 8)).includes('"f"')) {
        dropped++;
        return;
      }
      orig(topic, payload);
    };
    await sleep(3000);
    b._onMessage = orig;
    await converge([host, a, b], 'B after 5 dropped frames (gap replay)');
    check('gap repaired by replay, not a full snapshot', cnt(b, 'game') === gamesBefore, `snapshot loads: ${cnt(b, 'game') - gamesBefore}`);

    // ---- MQTT reconnect of client A
    const gA = cnt(a, 'game');
    a._mq.stream.destroy();
    await sleep(500);
    await waitFor(() => a._mq.connected, 15000);
    check('client A MQTT reconnected', a._mq.connected);
    await sleep(2000);
    await converge([host, a, b], 'after A reconnect');
    log(`  (A snapshot loads after reconnect: ${cnt(a, 'game') - gA})`);

    // ---- forced desync -> automatic resync
    const gA2 = cnt(a, 'game');
    a.game.acc ^= 0xdead;
    const desynced = await waitFor(() => cnt(a, 'desync') > 0, 5000);
    check('forced desync detected', desynced);
    const resynced = await waitFor(() => cnt(a, 'game') > gA2, 15000);
    check('automatic resync loaded a fresh snapshot', resynced);
    await sleep(1500);
    await converge([host, a, b], 'after forced resync');

    log(`  stats: A ${JSON.stringify(a.stats)} B ${JSON.stringify(b.stats)} host ${JSON.stringify(host.stats)}`);
    // ---- lobby
    const lob = await net.listLobbies();
    const mine = lob.find((l) => l.room === host.room);
    check('listLobbies sees the host', !!mine && mine.broker === host.brokerIndex && mine.world === 'Test world',
      mine ? JSON.stringify(mine) : `got ${lob.length} lobbies: ${lob.map((l) => l.room).join(',')}`);

    // ---- leave
    b.close();
    sessions.splice(sessions.indexOf(b), 1);
    await waitFor(() => host.players.length === 2 && !host.game.players[b.localPid], 5000);
    check('B left: host players list and game updated', host.players.length === 2 && !host.game.players[b.localPid]);
    await converge([host, a], 'host + A after B left');

    // ---- host close
    host.close();
    sessions.splice(sessions.indexOf(host), 1);
    await waitFor(() => a.status.state === 'disconnected', 5000);
    check('A sees host closed', a.status.state === 'disconnected', a.status.message);
    await sleep(1000);
    const lob2 = await net.listLobbies(3000);
    check('lobby entry cleared after close', !lob2.some((l) => l.room === host.room));
  } catch (e) {
    check('unexpected exception', false, e && (e.stack || e.message || String(e)));
  } finally {
    clearInterval(loop);
    clearInterval(submitter);
    for (const s of [b, a, host]) try { s && s.close(); } catch {}
  }
  const passed = results.filter((r) => r.ok).length;
  log(`\n${passed}/${results.length} checks passed (broker ${broker}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return results;
}
