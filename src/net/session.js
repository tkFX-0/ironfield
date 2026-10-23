// Ironfield multiplayer layer: host-sequenced deterministic lockstep over public MQTT brokers.
// Only player commands travel; every peer runs the same simulation. All incoming data is untrusted.

export const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const PREFIX = 'ironfield/v1/';

// Open rooms: fixed rooms that anyone can enter. Whoever is inside hosts one; when the host leaves, a
// remaining player takes over, and a retained copy on the broker lets the next visitor resume it when
// nobody is inside. Each of the 47 prefecture plots of the big world is one open room.
export const OPEN_ROOM = 'PLAZA2'; // the old single shared world, no longer offered on the title screen
export const OPEN_BROKER = 0;
// KENY: the second version of the plots (land runs on across plot borders); KENZ rooms were the first
export const plotRoom = (p) => 'KENY' + ROOM_ALPHABET[p >> 5] + ROOM_ALPHABET[p & 31]; // p = 1..47
export const plotOfRoom = (r) => {
  const m = /^KENY([A-HJ-NP-Z2-9])([A-HJ-NP-Z2-9])$/.exec(r || '');
  const p = m ? ROOM_ALPHABET.indexOf(m[1]) * 32 + ROOM_ALPHABET.indexOf(m[2]) : 0;
  return p >= 1 && p <= 47 ? p : 0;
};
const isOpenRoom = (r) => r === OPEN_ROOM || plotOfRoom(r) > 0;
const MAX_WORLD_CHUNKS = 64; // ~2.3 MB retained world copy
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ROOM_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const PID_RE = /^[a-z0-9]{8}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// Per-broker publish budgets (measured 2026-10-23). broker.emqx.io silently drops publishes above
// ~10 msg/s per connection (delivery to subscribers is not limited); HiveMQ and Mosquitto took
// 20 msg/s and bursts of 30 x 48 KB without loss. On EMQX the host therefore sends a frame every
// 10 ticks (every 20 while a snapshot is being sent) instead of every 3.
const PROFILES = [
  { maxPerSec: 8, frameTicks: 10, busyFrameTicks: 20, presenceMs: 1000, cmdFlushMs: 250 },
  { maxPerSec: 40, frameTicks: 3, busyFrameTicks: 3, presenceMs: 250, cmdFlushMs: 100 },
  { maxPerSec: 40, frameTicks: 3, busyFrameTicks: 3, presenceMs: 250, cmdFlushMs: 100 },
];
const PRIO_FRAME = 0;
const PRIO_CTRL = 1;
const PRIO_LOW = 2;
const QUEUE_CAP = [300, 4000, 200];
const QUEUE_BYTES_CAP = 32 * 1024 * 1024;

const TICK_MS = 1000 / 60;
const MAX_CATCHUP = 8;
const HASH_EVERY = 60;
const CLIENT_LAG = 6;
const FAR_BEHIND = 30;
const RESNAP_BEHIND = 1800; // ~30 s behind: a snapshot is cheaper than catching up

const CHUNK_B64 = 48 * 1024;
const CHUNK_RAW = (CHUNK_B64 / 4) * 3;
const MAX_CHUNKS = 512; // ~18 MB snapshot cap
const MAX_CMD_JSON = 2048;
const MAX_UP_BYTES = 64 * 1024;
const MAX_DOWN_BYTES = 1024 * 1024;
const MAX_TO_BYTES = CHUNK_B64 + 1024;
const MAX_SMALL_BYTES = 2048;
const HOST_HISTORY = 600; // frames (~30 s) kept for gap replay
const CLIENT_RECENT = 1200; // frames (~60 s) kept to rebuild after a snapshot load
const MAX_CLIENTS = 32;

const HOST_CONNECT_MS = 6000;
const CLIENT_CONNECT_MS = 10000;
const HELLO_RETRY_MS = 2000;
const JOIN_GIVEUP_MS = 30000;
const HB_MS = 4000;
const CLIENT_DROP_MS = 20000;
const NO_FRAME_MS = 8000;
const PRESENCE_TTL_MS = 10000;
const PRESENCE_KEEPALIVE_MS = 4000;
const RESYNC_MIN_MS = 10000;
const SNAP_COOLDOWN_MS = 3000;
const LOBBY_MS = 30000;
const LOBBY_MAX_AGE_MS = 120000;

// ---------------------------------------------------------------- helpers

const mono = () => (globalThis.performance ? performance.now() : Date.now());
const isInt = (v) => Number.isInteger(v);
const decoder = new TextDecoder();
const reviver = (k, v) => (k === '__proto__' ? undefined : v);

function randomString(n, alphabet) {
  // Rejection sampling keeps the distribution uniform.
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < n) {
    const buf = crypto.getRandomValues(new Uint8Array(n * 2));
    for (const b of buf) {
      if (b < limit && out.length < n) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

export function makeRoomCode() {
  return randomString(6, ROOM_ALPHABET);
}

const makePid = () => randomString(8, PID_ALPHABET);

/** Validates ?room=..&b=.. from a URL search string. Returns {room, broker} or null. */
export function parseJoinParams(search = globalThis.location ? location.search : '') {
  try {
    const q = new URLSearchParams(search);
    const room = (q.get('room') || '').toUpperCase();
    const broker = Number(q.get('b') ?? '0');
    if (!ROOM_RE.test(room) || !isInt(broker) || broker < 0 || broker >= BROKERS.length) return null;
    return { room, broker };
  } catch {
    return null;
  }
}

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  // Strip control chars and bidi overrides.
  s = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim();
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join('') : s;
}
const cleanName = (s) => cleanText(s, 20) || 'Player';
const cleanColor = (c, fallback = '#888888') => (typeof c === 'string' && COLOR_RE.test(c) ? c.toLowerCase() : fallback);

function parseMsg(payload, maxBytes) {
  if (!payload || payload.length === 0 || payload.length > maxBytes) return null;
  let o;
  try {
    o = JSON.parse(typeof payload === 'string' ? payload : decoder.decode(payload), reviver);
  } catch {
    return null;
  }
  return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
}

function isPlainCmd(c) {
  return !!c && typeof c === 'object' && !Array.isArray(c) && typeof c.type === 'string' && c.type.length > 0 && c.type.length <= 40;
}

// Returns the canonical JSON of a command with pid forced, or null if invalid/too big.
function cmdJson(cmd, pid) {
  if (!isPlainCmd(cmd)) return null;
  let s;
  try {
    s = JSON.stringify({ ...cmd, pid });
  } catch {
    return null;
  }
  return s && s.length <= MAX_CMD_JSON + 32 ? s : null;
}

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(str) {
  const s = atob(str);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

function bucket(ratePerSec, burst) {
  return { tokens: burst, last: mono(), rate: ratePerSec, burst };
}
function take(b, now = mono()) {
  b.tokens = Math.min(b.burst, b.tokens + ((now - b.last) * b.rate) / 1000);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

const num = (v) => (Number.isFinite(v) && Math.abs(v) < 1e7 ? Math.round(v * 100) / 100 : 0);
// Two hosts in one room (a takeover race, or a frozen phone waking up): the higher epoch wins, then the smaller pid.
const beats = (e1, p1, e2, p2) => e1 > e2 || (e1 === e2 && p1 < p2);
// Which of two world copies is newer: a later host epoch, then a later tick.
export const newerCopy = (e1, t1, e2, t2) => e1 > e2 || (e1 === e2 && t1 > t2);
const hostOf = (m) => (typeof m.hp === 'string' && PID_RE.test(m.hp) && isInt(m.e) && m.e >= 0 ? { hp: m.hp, e: m.e } : null);
const yieldNow = () => new Promise((r) => setTimeout(r, 0));

function mqttLib() {
  const m = globalThis.mqtt;
  if (!m || typeof m.connect !== 'function') throw new Error('MQTT library not loaded');
  return m;
}

function mqttOptions(timeoutMs, extra) {
  return {
    clientId: 'if-' + randomString(16, PID_ALPHABET),
    clean: true,
    protocolVersion: 4,
    keepalive: 20,
    reconnectPeriod: 2000,
    connectTimeout: timeoutMs,
    resubscribe: false, // we resubscribe ourselves on every 'connect'
    forceNativeWebSocket: true,
    ...extra,
  };
}

function connectBroker(index, timeoutMs, extra) {
  return new Promise((resolve, reject) => {
    let client;
    let done = false;
    try {
      client = mqttLib().connect(BROKERS[index], mqttOptions(timeoutMs, extra));
    } catch (e) {
      reject(e);
      return;
    }
    client.on('error', () => {}); // never let an 'error' event throw
    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { client.end(true); } catch {}
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('Timed out connecting to ' + BROKERS[index])), timeoutMs);
    client.once('connect', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(client);
    });
    client.once('error', (e) => fail(e instanceof Error ? e : new Error(String(e))));
  });
}

// Rate-limited, prioritised publisher (sliding 1 s window). Messages pushed while offline are
// dropped: frames are replayed from host history and commands wait in the session.
class Outbox {
  constructor(mq, maxPerSec) {
    this.mq = mq;
    this.max = maxPerSec;
    this.sent = [];
    this.q = [[], [], []];
    this.bytes = 0;
    this.timer = null;
  }
  push(topic, payload, opts, prio = PRIO_CTRL, key) {
    if (!this.mq.connected) return false;
    const q = this.q[prio];
    if (key) {
      const i = q.findIndex((m) => m.key === key);
      if (i >= 0) this.bytes -= q.splice(i, 1)[0].payload.length;
    }
    while (q.length && (q.length >= QUEUE_CAP[prio] || this.bytes + payload.length > QUEUE_BYTES_CAP)) {
      this.bytes -= q.shift().payload.length;
    }
    q.push({ topic, payload, opts, key });
    this.bytes += payload.length;
    this.pump();
    return true;
  }
  backlog() {
    return this.q[PRIO_CTRL].length + this.q[PRIO_LOW].length;
  }
  size() {
    return this.q[0].length + this.q[1].length + this.q[2].length;
  }
  clear() {
    this.q = [[], [], []];
    this.bytes = 0;
  }
  pump() {
    clearTimeout(this.timer);
    this.timer = null;
    const now = mono();
    while (this.sent.length && now - this.sent[0] >= 1000) this.sent.shift();
    while (this.sent.length < this.max && this.mq.connected) {
      const q = this.q.find((x) => x.length);
      if (!q) break;
      const m = q.shift();
      this.bytes -= m.payload.length;
      try {
        this.mq.publish(m.topic, m.payload, { qos: 0, retain: false, ...m.opts });
      } catch (e) {
        console.warn('[net] publish failed', e);
      }
      this.sent.push(now);
    }
    if (this.size() && this.mq.connected) {
      this.timer = setTimeout(() => this.pump(), Math.max(5, 1001 - (now - this.sent[0])));
    }
  }
  drain(ms) {
    const t0 = mono();
    return new Promise((resolve) => {
      const check = () => (!this.size() || !this.mq.connected || mono() - t0 > ms ? resolve() : setTimeout(check, 50));
      check();
    });
  }
}

function readFrame(m) {
  const { p, t } = m;
  if (!isInt(p) || !isInt(t) || p < 0 || t <= p || t - p > 600) return null;
  const c = [];
  if (m.c !== undefined) {
    if (!Array.isArray(m.c) || m.c.length > 4096) return null;
    let last = p;
    for (const e of m.c) {
      if (!Array.isArray(e) || e.length !== 2) return null;
      const [tick, cmd] = e;
      if (!isInt(tick) || tick <= p || tick > t || tick < last) return null;
      if (!isPlainCmd(cmd) || typeof cmd.pid !== 'string' || !PID_RE.test(cmd.pid)) return null;
      last = tick;
      c.push(e);
    }
  }
  let h = null;
  let ht = null;
  if (m.h !== undefined) {
    if (!isInt(m.h) || m.h < 0 || m.h > 0xffffffff || !isInt(m.ht) || m.ht <= p || m.ht > t) return null;
    h = m.h;
    ht = m.ht;
  }
  return { p, t, c, h, ht };
}

function readPlayers(l) {
  if (!Array.isArray(l) || l.length > 64) return null;
  const out = [];
  for (const e of l) {
    if (!e || typeof e !== 'object' || typeof e.pid !== 'string' || !PID_RE.test(e.pid)) return null;
    const p = { pid: e.pid, name: cleanName(e.name), color: cleanColor(e.color) };
    if (isInt(e.ping) && e.ping >= 0 && e.ping < 60000) p.ping = e.ping;
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- base

class BaseSession {
  constructor(mode, { game, name, color, pid }) {
    this.mode = mode;
    this.game = game;
    this.localPid = typeof pid === 'string' && PID_RE.test(pid) ? pid : makePid();
    this.name = cleanName(name);
    this.color = cleanColor(color, '#e0a030');
    this.room = null;
    this.brokerIndex = null;
    this.players = [];
    this.presence = new Map();
    this.status = { state: 'connecting', message: '', ping: null };
    this.paused = false;
    this._handlers = new Map();
    this._closed = false;
    this._acc = 0;
    this._last = null;
    this._presOut = null;
    this._presLast = '';
    this._presSentAt = -1e9;
    this._chatBucket = bucket(5, 10);
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
  }
  _emit(event, data) {
    for (const fn of this._handlers.get(event) || []) {
      try { fn(data); } catch (e) { console.error('[net] listener error', event, e); }
    }
  }

  _setStatus(state, message = '') {
    if (this.status.state === state && this.status.message === message) return;
    this.status = { ...this.status, state, message };
    this._emit('status', this.status);
  }

  _setPlayers(list) {
    if (JSON.stringify(list) === JSON.stringify(this.players)) return;
    this.players = list;
    this._emit('players', list);
  }

  shareUrl(baseUrl = globalThis.location ? location.origin + location.pathname : '') {
    if (!this.room) return null;
    const base = String(baseUrl).split(/[?#]/)[0];
    return `${base}?room=${this.room}&b=${this.brokerIndex}`;
  }

  setPaused() {
    return false;
  }

  // Round-trips the command through JSON so every peer applies an identical object.
  _localCmd(cmd) {
    const s = cmdJson(cmd, this.localPid);
    if (!s) {
      console.warn('[net] dropped invalid or oversized command', cmd && cmd.type);
      return null;
    }
    return s;
  }

  _fixedTicks(nowMs) {
    if (this._last == null || !Number.isFinite(nowMs)) {
      this._last = nowMs;
      return 0;
    }
    const dt = nowMs - this._last;
    this._last = nowMs;
    if (!(dt > 0)) return 0;
    // Cap catch-up; excess time is dropped so a backgrounded tab does not spiral.
    this._acc = Math.min(this._acc + dt, MAX_CATCHUP * TICK_MS + 0.01);
    const n = Math.floor(this._acc / TICK_MS);
    this._acc -= n * TICK_MS;
    return n;
  }

  // ---- presence / chat (not part of the simulation)

  setPresence(obj) {
    if (!obj || typeof obj !== 'object') return;
    this._presOut = {
      x: num(obj.x), y: num(obj.y), z: num(obj.z), cx: num(obj.cursorX), cy: num(obj.cursorY),
      n: obj.name !== undefined ? cleanName(obj.name) : this.name,
      c: cleanColor(obj.color, this.color),
    };
  }

  _flushPresence(now = mono()) {
    if (!this._presOut || !this._mq || !this._mq.connected) return;
    if (now - this._presSentAt < this._profile.presenceMs) return;
    const s = JSON.stringify(this._presOut);
    // Unchanged positions are re-sent slowly so others do not expire us.
    if (s === this._presLast && now - this._presSentAt < PRESENCE_KEEPALIVE_MS) return;
    this._presLast = s;
    this._presSentAt = now;
    this._pub(this._t('p'), JSON.stringify({ k: 'p', pid: this.localPid, ...this._presOut }), null, PRIO_LOW, 'presence');
  }

  _onPresence(m) {
    if (typeof m.pid !== 'string' || !PID_RE.test(m.pid) || m.pid === this.localPid) return;
    const prev = this.presence.get(m.pid);
    const now = Date.now();
    if (prev && now - prev.t < 150) return; // per-sender flood guard
    if (!prev && this.presence.size >= 64) return;
    const known = this.players.find((p) => p.pid === m.pid);
    this.presence.set(m.pid, {
      x: num(m.x), y: num(m.y), z: num(m.z), cursorX: num(m.cx), cursorY: num(m.cy),
      name: known ? known.name : cleanName(m.n),
      color: known ? known.color : cleanColor(m.c),
      t: now,
    });
    this._emit('presence', this.presence);
  }

  _prunePresence() {
    const now = Date.now();
    let changed = false;
    for (const [pid, e] of this.presence) {
      if (now - e.t > PRESENCE_TTL_MS) {
        this.presence.delete(pid);
        changed = true;
      }
    }
    if (changed) this._emit('presence', this.presence);
  }

  sendChat(text) {
    text = cleanText(text, 200);
    if (!text) return false;
    if (this._mq) this._pub(this._t('chat'), JSON.stringify({ k: 'm', pid: this.localPid, n: this.name, text }), null, PRIO_LOW);
    this._emit('chat', { pid: this.localPid, name: this.name, text });
    return true;
  }

  _onChat(m) {
    if (typeof m.pid !== 'string' || !PID_RE.test(m.pid) || m.pid === this.localPid) return;
    const text = cleanText(m.text, 200);
    if (!text || !take(this._chatBucket)) return;
    const known = this.players.find((p) => p.pid === m.pid);
    this._emit('chat', { pid: m.pid, name: known ? known.name : cleanName(m.n), text });
  }

  // ---- transport

  _t(sub) {
    return PREFIX + this.room + '/' + sub;
  }

  get _profile() {
    return PROFILES[this.brokerIndex] || PROFILES[1];
  }

  _attach(mq) {
    this._mq = mq;
    this._outbox = new Outbox(mq, this._profile.maxPerSec);
    mq.on('close', () => this._outbox.clear());
  }

  _pub(topic, payload, opts = null, prio = PRIO_CTRL, key = undefined) {
    if (!this._outbox || this._closedTransport) return false;
    return this._outbox.push(topic, payload, opts, prio, key);
  }

  // Lets queued messages (bye, lobby clear, 'end') leave before the socket closes.
  async _endTransport() {
    const mq = this._mq;
    if (!mq) return;
    await this._outbox.drain(1500);
    this._closedTransport = true;
    await new Promise((r) => setTimeout(r, 300));
    try { mq.end(false); } catch {}
  }
}

// ---------------------------------------------------------------- offline

export class OfflineSession extends BaseSession {
  constructor({ game, name, color, pid } = {}) {
    super('offline', { game, name, color, pid });
    this._pending = [];
    this._queueJson(JSON.stringify({ type: 'join', pid: this.localPid, name: this.name, color: this.color }));
    this.players = [{ pid: this.localPid, name: this.name, color: this.color }];
    this.status = { state: 'playing', message: '', ping: null };
  }

  static async create(opts) {
    return new OfflineSession(opts);
  }

  _queueJson(s) {
    this._pending.push(JSON.parse(s, reviver));
  }

  submit(cmd) {
    const s = this._localCmd(cmd);
    if (s) this._queueJson(s);
  }

  setPaused(b) {
    this.paused = !!b;
    this._last = null;
    this._acc = 0;
    return this.paused;
  }

  update(nowMs = mono()) {
    if (this._closed) return 0;
    if (this.paused) {
      this._last = nowMs;
      return 0;
    }
    const n = this._fixedTicks(nowMs);
    for (let i = 0; i < n; i++) {
      const cmds = this._pending;
      this._pending = [];
      this.game.step(cmds);
    }
    return n;
  }

  setPresence() {}

  close() {
    this._closed = true;
    this._setStatus('disconnected', 'Closed');
  }
}

// ---------------------------------------------------------------- view

// Looking round another prefecture's plot: a saved copy of it runs on this device only.
// Nothing reaches the plot's real game, and it is never saved (no `open`, so app.saveNow skips it).
export class ViewSession extends OfflineSession {
  constructor(opts) {
    super(opts);
    this.mode = 'view';
    this.room = opts.room;
    this.players = [];
  }
  static async create(opts) { return new ViewSession(opts); }
  submit() { this._emit('viewonly'); }
  // a newer saved copy of the plot came in
  replaceGame(game) {
    this.game = game;
    this._pending = [];
    this._queueJson(JSON.stringify({ type: 'join', pid: this.localPid, name: this.name, color: this.color }));
    this._emit('game', game);
  }
}

// ---------------------------------------------------------------- host

export class HostSession extends BaseSession {
  constructor(opts) {
    super('host', opts);
    this.worldName = cleanText(opts.worldName, 32) || 'Ironfield';
    this.open = isOpenRoom(opts.open); // open: the open room's name, or nothing for a private room
    this.room = this.open ? opts.open : makeRoomCode();
    this.epoch = isInt(opts.epoch) && opts.epoch >= 0 ? opts.epoch : 0;
    this._pending = []; // [{json, cmd}] applied at the next tick
    this._frameBuf = [];
    this._frameHash = null;
    this._lastFrameTick = this.game.tick;
    this._history = [];
    this._clients = new Map();
    this._snapReq = new Map();
    this._serializing = false;
    this._playersDirty = true;
    this._plSentAt = -1e9;
    this._plPending = null;
    this._acks = new Map(); // pid -> heartbeat ts, echoed inside the next frame
    this._lobbyAt = -1e9;
    this._unknownReplies = new Map();
    this.stats = { frames: 0, snapshots: 0, replays: 0, droppedCmds: 0 };
    // Players still marked online in a loaded or taken-over world are gone until they say hello again.
    for (const p of this.game.players.values()) {
      if (p.online && p.pid !== this.localPid) this._queueJson(JSON.stringify({ type: 'leave', pid: p.pid }));
    }
    this._queueJson(JSON.stringify({ type: 'join', pid: this.localPid, name: this.name, color: this.color }));
  }

  static async create({ game, name, color, worldName, pid, broker, open, epoch } = {}) {
    if (!game || !isInt(game.tick)) throw new Error('HostSession needs a game');
    const s = new HostSession({ game, name, color, worldName, pid, open, epoch });
    await s._connect(s.open ? OPEN_BROKER : isInt(broker) && broker >= 0 && broker < BROKERS.length ? broker : 0);
    return s;
  }

  async _connect(preferred) {
    // The open world lives on one broker so that everybody meets there.
    const order = this.open ? [preferred] : [preferred, ...BROKERS.map((_, i) => i).filter((i) => i !== preferred)];
    const lobbyTopic = PREFIX + 'lobby/' + this.room;
    const errors = [];
    let mq = null;
    for (const i of order) {
      this._setStatus('connecting', `Connecting to relay ${i + 1}/${BROKERS.length}`);
      try {
        // queueQoSZero off: frames lost while offline are replayed from history on request.
        // No last will in the open world: it would fire after a takeover and erase the new host's entry.
        mq = await connectBroker(i, HOST_CONNECT_MS, {
          queueQoSZero: false,
          ...(this.open ? {} : { will: { topic: lobbyTopic, payload: '', qos: 0, retain: true } }),
        });
        this.brokerIndex = i;
        break;
      } catch (e) {
        errors.push(`${BROKERS[i]}: ${e.message}`);
      }
      if (this._closed) throw new Error('Closed');
    }
    if (mq) this._attach(mq);
    if (!this._mq) {
      this._setStatus('error', 'Could not reach any relay server');
      throw new Error('Could not reach any broker. ' + errors.join('; '));
    }
    this._lobbyTopic = lobbyTopic;
    this._mq.on('message', (topic, payload) => this._onMessage(topic, payload));
    this._mq.on('connect', () => this._onConnect());
    this._mq.on('close', () => {
      if (!this._closed) this._setStatus('connecting', 'Reconnecting to relay');
    });
    this._onConnect();
    this._timer = setInterval(() => this._housekeeping(), 500);
  }

  _onConnect() {
    if (this._closed) return;
    const topics = [this._t('up'), this._t('p'), this._t('chat')];
    if (this.open) topics.push(this._t('down'), this._lobbyTopic); // to notice a rival host; whose lobby entry is up
    this._mq.subscribe(topics, { qos: 0 });
    this._publishLobby();
    // Publish again shortly: a stale last-will from the previous connection may clear it.
    this._lobbyAt = mono() - LOBBY_MS + 5000;
    this._setStatus('playing', '');
  }

  _queueJson(json) {
    this._pending.push({ json, cmd: JSON.parse(json, reviver) });
  }

  submit(cmd) {
    const s = this._localCmd(cmd);
    if (s) this._queueJson(s);
  }

  update(nowMs = mono()) {
    if (this._closed) return 0;
    const n = this._fixedTicks(nowMs);
    let stepped = 0;
    // While a snapshot is being serialized the simulation must not advance.
    while (stepped < n && !this._serializing) {
      this._stepOnce();
      stepped++;
    }
    this._flushPresence();
    return stepped;
  }

  _stepOnce() {
    const batch = this._pending;
    this._pending = [];
    const tick = this.game.tick + 1;
    for (const e of batch) this._frameBuf.push(`[${tick},${e.json}]`);
    this.game.step(batch.map((e) => e.cmd));
    if (this.game.tick % HASH_EVERY === 0) this._frameHash = [this.game.hash() >>> 0, this.game.tick];
    const prof = this._profile;
    const every = this._outbox && this._outbox.backlog() > 0 ? prof.busyFrameTicks : prof.frameTicks;
    if (this.game.tick - this._lastFrameTick >= every) this._publishFrame();
  }

  _publishFrame() {
    const p = this._lastFrameTick;
    const t = this.game.tick;
    let s = `{"k":"f","p":${p},"t":${t},"hp":"${this.localPid}","e":${this.epoch}`;
    if (this._frameBuf.length) s += `,"c":[${this._frameBuf.join(',')}]`;
    if (this._frameHash) s += `,"h":${this._frameHash[0]},"ht":${this._frameHash[1]}`;
    if (this._acks.size) s += `,"a":${JSON.stringify(Object.fromEntries(this._acks))}`;
    if (this._plPending) s += `,"pl":${this._plPending}`;
    s += '}';
    this._frameBuf = [];
    this._frameHash = null;
    this._acks.clear();
    this._plPending = null;
    this._lastFrameTick = t;
    this._history.push({ p, t, s });
    if (this._history.length > HOST_HISTORY + 50) this._history.splice(0, this._history.length - HOST_HISTORY);
    this.stats.frames++;
    this._pub(this._t('down'), s, null, PRIO_FRAME);
    if (this._snapReq.size && !this._serializing) this._takeSnapshot();
  }

  // Snapshot at a frame boundary T; joins are queued for tick T+1.
  async _takeSnapshot() {
    this._serializing = true;
    const reqs = [...this._snapReq.keys()];
    this._snapReq.clear();
    const T = this.game.tick;
    let bytes;
    try {
      bytes = await this.game.serialize();
    } catch (e) {
      console.error('[net] serialize failed', e);
      this._serializing = false;
      return;
    }
    if (this._closed) return;
    if (this.game.tick !== T) console.warn('[net] game advanced during serialize');
    const joins = [];
    for (const pid of reqs) {
      const c = this._clients.get(pid);
      if (c && !c.inWorld) {
        c.inWorld = true;
        joins.push(JSON.stringify({ type: 'join', pid, name: c.name, color: c.color }));
        this._playersDirty = true;
      }
    }
    const rest = this._pending;
    this._pending = [];
    for (const j of joins) this._queueJson(j);
    this._pending.push(...rest);
    this._serializing = false;
    for (const pid of reqs) {
      if (this._clients.has(pid)) await this._sendSnapshot(pid, bytes, T);
    }
    this.stats.snapshots++;
  }

  async _sendSnapshot(pid, bytes, T) {
    const id = randomString(6, PID_ALPHABET);
    const n = Math.max(1, Math.ceil(bytes.length / CHUNK_RAW));
    const topic = this._t('to/' + pid);
    for (let i = 0; i < n; i++) {
      const d = toB64(bytes.subarray(i * CHUNK_RAW, (i + 1) * CHUNK_RAW));
      this._pub(topic, JSON.stringify({ k: 's', id, i, n, d }));
      if (i % 4 === 3) await yieldNow();
      if (this._closed) return;
    }
    this._pub(topic, JSON.stringify({ k: 'se', id, t: T, n, hp: this.localPid, e: this.epoch }));
  }

  /** Leaves a retained copy of the world on the broker, alternating two slots so a half-written copy
   *  never replaces the only whole one. Every chunk carries the tick and epoch it belongs to. */
  publishWorld(bytes, tick) {
    const n = Math.max(1, Math.ceil(bytes.length / CHUNK_RAW));
    if (!this.open || !this._mq || !this._mq.connected || n > MAX_WORLD_CHUNKS || this._closed) return false;
    this._worldSlot = this._worldSlot ? 0 : 1;
    const slot = this._worldSlot;
    const id = randomString(6, PID_ALPHABET);
    for (let i = 0; i < n; i++) {
      const d = toB64(bytes.subarray(i * CHUNK_RAW, (i + 1) * CHUNK_RAW));
      this._pub(this._t(`save/${slot}/${i}`), JSON.stringify({ k: 'w', id, i, n, t: tick, e: this.epoch, d }), { retain: true, qos: 1 }, PRIO_CTRL, `w${slot}/${i}`);
    }
    return true;
  }

  _onRival(m) {
    const h = hostOf(m);
    if (!h || h.hp === this.localPid || this._yielded || !beats(h.e, h.hp, this.epoch, this.localPid)) return;
    this._yielded = true; // the other host keeps the world; main switches us to a client
    this._emit('rival', h);
  }

  // Re-sends frames after tick `from` to one client. Returns false if history does not reach back.
  _replay(pid, from) {
    if (from >= this._lastFrameTick) return true;
    const h = this._history;
    if (!h.length || h[0].p > from) return false;
    let i = h.findIndex((f) => f.t > from);
    if (i < 0) return true;
    this.stats.replays++;
    const topic = this._t('to/' + pid);
    let batch = [];
    let size = 0;
    const flush = () => {
      if (batch.length) this._pub(topic, `{"k":"fr","fs":[${batch.join(',')}]}`);
      batch = [];
      size = 0;
    };
    for (; i < h.length; i++) {
      if (size + h[i].s.length > CHUNK_B64 || batch.length >= 200) flush();
      batch.push(h[i].s);
      size += h[i].s.length;
    }
    flush();
    return true;
  }

  _onMessage(topic, payload) {
    if (this._closed) return;
    if (topic === this._t('up')) return this._onUp(parseMsg(payload, MAX_UP_BYTES));
    if (topic === this._t('down')) {
      const f = parseMsg(payload, MAX_DOWN_BYTES);
      if (f && f.k === 'f') this._onRival(f);
      return;
    }
    if (topic === this._lobbyTopic) {
      const l = parseMsg(payload, MAX_SMALL_BYTES);
      this._lobbyOwner = l && typeof l.hp === 'string' ? l.hp : null;
      return;
    }
    const m = parseMsg(payload, MAX_SMALL_BYTES);
    if (!m) return;
    if (topic === this._t('p') && m.k === 'p') this._onPresence(m);
    else if (topic === this._t('chat') && m.k === 'm') this._onChat(m);
  }

  _onUp(m) {
    if (!m || typeof m.pid !== 'string' || !PID_RE.test(m.pid)) return;
    if (m.pid === this.localPid) {
      // Same device opened twice with one stored id: tell the would-be client instead of timing out.
      if (m.k === 'hello') this._pub(this._t('to/' + m.pid), '{"k":"err","e":"pid"}', null, PRIO_LOW, 'pid-err');
      return;
    }
    const now = mono();
    const pid = m.pid;
    let c = this._clients.get(pid);
    switch (m.k) {
      case 'hello': {
        if (m.v !== 1) return this._pub(this._t('to/' + pid), '{"k":"err","e":"version"}');
        if (!c) {
          if (this._clients.size >= MAX_CLIENTS) return this._pub(this._t('to/' + pid), '{"k":"err","e":"full"}');
          c = {
            pid, name: cleanName(m.name), color: cleanColor(m.color), inWorld: false,
            lastSeen: now, lastSnap: -1e9, lastReplay: -1e9, ping: undefined, bucket: bucket(30, 45),
          };
          this._clients.set(pid, c);
        }
        c.lastSeen = now;
        if (c.inWorld && isInt(m.from) && m.from >= 0 && now - c.lastReplay > 500) {
          c.lastReplay = now;
          if (this._replay(pid, m.from)) return;
        }
        if (now - c.lastSnap < SNAP_COOLDOWN_MS) return;
        c.lastSnap = now;
        this._snapReq.set(pid, true);
        return;
      }
      case 'c': {
        if (!c || !c.inWorld) return this._tellRejoin(pid, now);
        c.lastSeen = now;
        const list = Array.isArray(m.cs) ? m.cs.slice(0, 32) : [m.c];
        for (const cmd of list) {
          if (!take(c.bucket, now)) {
            this.stats.droppedCmds++; // rate limit: drop excess
            continue;
          }
          const s = cmdJson(cmd, pid); // pid comes from the envelope, never from the payload
          if (s) this._queueJson(s);
          else this.stats.droppedCmds++;
        }
        return;
      }
      case 'hb': {
        if (!c) return this._tellRejoin(pid, now);
        c.lastSeen = now;
        if (!c.inWorld) return;
        if (isInt(m.ping) && m.ping >= 0 && m.ping < 60000 && m.ping !== c.ping) {
          c.ping = m.ping;
          this._playersDirty = true;
        }
        if (Number.isFinite(m.ts)) this._acks.set(pid, m.ts); // echoed in the next frame
        return;
      }
      case 'bye': {
        if (!c) return;
        if (c.inWorld) this._queueJson(JSON.stringify({ type: 'leave', pid }));
        this._clients.delete(pid);
        this._playersDirty = true;
        return;
      }
    }
  }

  // A client the host does not know (e.g. dropped after a long stall) is asked to rejoin.
  _tellRejoin(pid, now) {
    const last = this._unknownReplies.get(pid) || -1e9;
    if (now - last < 3000) return;
    if (this._unknownReplies.size > 256) this._unknownReplies.clear();
    this._unknownReplies.set(pid, now);
    this._pub(this._t('to/' + pid), '{"k":"rejoin"}');
  }

  _housekeeping() {
    if (this._closed) return;
    const now = mono();
    for (const [pid, c] of this._clients) {
      if (now - c.lastSeen > CLIENT_DROP_MS) {
        if (c.inWorld) this._queueJson(JSON.stringify({ type: 'leave', pid }));
        this._clients.delete(pid);
        this._snapReq.delete(pid);
        this._playersDirty = true;
      }
    }
    if (this._playersDirty || now - this._plSentAt > 3000) this._sendPlayers(now);
    if (now - this._lobbyAt > LOBBY_MS) this._publishLobby();
    this._prunePresence();
    this._flushPresence(now);
  }

  _sendPlayers(now) {
    const list = [{ pid: this.localPid, name: this.name, color: this.color, ping: 0 }];
    for (const c of this._clients.values()) {
      if (!c.inWorld) continue;
      const p = { pid: c.pid, name: c.name, color: c.color };
      if (c.ping !== undefined) p.ping = c.ping;
      list.push(p);
    }
    this._playersDirty = false;
    this._plSentAt = now;
    this._setPlayers(list);
    this._plPending = JSON.stringify(list); // rides along in the next frame
  }

  _publishLobby() {
    if (!this._mq || !this._mq.connected) return;
    this._lobbyAt = mono();
    const info = {
      room: this.room, broker: this.brokerIndex, world: this.worldName, host: this.name,
      players: 1 + [...this._clients.values()].filter((c) => c.inWorld).length,
      tick: this.game.tick, v: 1, ts: Date.now(), hp: this.localPid, e: this.epoch,
    };
    if (this.open) info.open = true;
    this._pub(this._lobbyTopic, JSON.stringify(info), { retain: true }, PRIO_LOW, 'lobby');
  }

  /** Returns a promise that resolves once the goodbye messages are flushed and the socket is closed. */
  close() {
    if (this._closed) return this._closing || Promise.resolve();
    this._closed = true;
    clearInterval(this._timer);
    this._setStatus('disconnected', 'Closed');
    if (!this._mq) return Promise.resolve();
    this._outbox.q[PRIO_LOW] = []; // presence/lobby refreshes are moot now
    this._pub(this._t('down'), `{"k":"end","hp":"${this.localPid}"}`, null, PRIO_FRAME);
    // Clear the retained lobby entry, unless (in the open world) another host's entry has replaced ours.
    if (!this.open || !this._lobbyOwner || this._lobbyOwner === this.localPid) this._pub(this._lobbyTopic, '', { retain: true }, PRIO_FRAME);
    return (this._closing = this._endTransport());
  }
}

// ---------------------------------------------------------------- client

export class ClientSession extends BaseSession {
  constructor(opts) {
    super('client', opts);
    this.room = opts.room;
    this.brokerIndex = opts.broker;
    this.open = isOpenRoom(opts.room);
    this._host = null; // {hp, e} of the host we follow
    this._joinGiveupMs = isInt(opts.joinTimeoutMs) && opts.joinTimeoutMs > 0 ? opts.joinTimeoutMs : JOIN_GIVEUP_MS;
    this._loadGame = opts.loadGame;
    this._recvTick = -1; // newest contiguous tick received
    this._cmds = new Map(); // tick -> cmds
    this._expected = new Map(); // tick -> host hash
    this._recent = []; // validated frames, for rebuilding after a snapshot load
    this._ahead = []; // frames past a gap
    this._snaps = new Map();
    this._outCmds = [];
    this._awaitSnap = null; // {since, lastHello, lastProgress, initial}
    this._snapWanted = false;
    this._lastSnapReq = -1e9;
    this._gapSince = 0;
    this._gapAsked = -1e9;
    this._loading = false;
    this._lastFrameAt = mono();
    this._lastHb = -1e9;
    this._connectedOnce = false;
    this._cmdFlushAt = -1e9;
    this._span = 3; // recent frame length in ticks (host cadence depends on the broker)
    this._onPageHide = () => this._sayBye();
    this.stats = { frames: 0, gaps: 0, snapshots: 0, desyncs: 0 };
  }

  get hostEpoch() { return this._host ? this._host.e : 0; }
  get hostPid() { return this._host ? this._host.hp : null; }

  static async create({ room, broker, name, color, loadGame, pid, onStatus, joinTimeoutMs } = {}) {
    room = String(room || '').toUpperCase();
    broker = Number(broker ?? 0);
    if (!ROOM_RE.test(room)) throw new Error('Invalid room code');
    if (!isInt(broker) || broker < 0 || broker >= BROKERS.length) throw new Error('Invalid broker index');
    if (typeof loadGame !== 'function') throw new Error('ClientSession needs loadGame');
    const s = new ClientSession({ room, broker, name, color, loadGame, pid, joinTimeoutMs, game: null });
    if (typeof onStatus === 'function') s.on('status', onStatus);
    try {
      await s._start();
    } catch (e) {
      s.close();
      throw e;
    }
    return s;
  }

  _start() {
    return new Promise(async (resolve, reject) => {
      this._joinResolve = resolve;
      this._joinReject = reject;
      this._setStatus('connecting', 'Connecting to relay');
      try {
        // No last-will "bye": a session takeover on reconnect could deliver it late and kick us out.
        this._attach(await connectBroker(this.brokerIndex, CLIENT_CONNECT_MS, { queueQoSZero: false }));
      } catch (e) {
        this._setStatus('error', 'Could not reach the relay server');
        reject(e);
        return;
      }
      if (this._closed) return reject(new Error('Closed'));
      this._mq.on('message', (topic, payload) => this._onMessage(topic, payload));
      this._mq.on('connect', () => this._onConnect());
      this._mq.on('close', () => {
        if (!this._closed && this.status.state === 'playing') this._setStatus('playing', 'Reconnecting');
      });
      globalThis.addEventListener?.('pagehide', this._onPageHide);
      this._timer = setInterval(() => this._housekeeping(), 500);
      this._awaitSnap = { since: mono(), lastHello: -1e9, lastProgress: -1e9, initial: true };
      this._setStatus('loading', 'Joining world');
      this._onConnect();
    });
  }

  _onConnect() {
    if (this._closed) return;
    const first = !this._connectedOnce;
    this._connectedOnce = true;
    const topics = [this._t('down'), this._t('to/' + this.localPid), this._t('p'), this._t('chat')];
    // Subscribe BEFORE talking to the host so no frame or snapshot chunk is missed.
    this._mq.subscribe(topics, { qos: 0 }, (err) => {
      if (err || this._closed) return;
      if (this._awaitSnap) this._sendHello(null);
      else if (!first && this.game) this._markGap(true); // reconnect: ask for replay/snapshot
    });
  }

  _sendHello(from) {
    const m = { k: 'hello', pid: this.localPid, name: this.name, color: this.color, v: 1 };
    if (from != null) m.from = from;
    if (this._awaitSnap) this._awaitSnap.lastHello = mono();
    this._pub(this._t('up'), JSON.stringify(m));
  }

  submit(cmd) {
    const s = this._localCmd(cmd);
    if (s && this._outCmds.length < 200) this._outCmds.push(JSON.parse(s, reviver));
  }

  _flushCmds(now = mono()) {
    if (!this._outCmds.length || !this._mq || !this._mq.connected) return; // kept (capped) until back online
    if (now - this._cmdFlushAt < this._profile.cmdFlushMs) return; // batch to respect the broker's publish budget
    this._cmdFlushAt = now;
    while (this._outCmds.length) {
      const cs = this._outCmds.splice(0, 20);
      this._pub(this._t('up'), JSON.stringify({ k: 'c', pid: this.localPid, cs }));
    }
  }

  // ---- incoming

  _onMessage(topic, payload) {
    if (this._closed) return;
    if (topic === this._t('down')) {
      const m = parseMsg(payload, MAX_DOWN_BYTES);
      if (!m) return;
      if (m.k === 'f') {
        const f = readFrame(m);
        if (!f || !this._followHost(hostOf(m))) return;
        // Heartbeat acks and the player list ride along in live frames.
        const ack = m.a && typeof m.a === 'object' ? m.a[this.localPid] : undefined;
        if (Number.isFinite(ack)) {
          const ping = Math.round(Date.now() - ack);
          if (ping >= 0 && ping < 60000) {
            this.status = { ...this.status, ping };
            this._emit('status', this.status);
          }
        }
        if (m.pl !== undefined) {
          const l = readPlayers(m.pl);
          if (l) this._setPlayers(l);
        }
        this._span = Math.max(f.t - f.p, this._span - 0.05);
        this._ingestFrame(f, true);
      } else if (m.k === 'end') {
        if (this._host && m.hp !== undefined && m.hp !== this._host.hp) return; // a host we do not follow
        this._hostEnded = true;
        this._setStatus('disconnected', 'The host closed the world');
      }
    } else if (topic === this._t('to/' + this.localPid)) {
      this._onDirect(parseMsg(payload, MAX_TO_BYTES));
    } else {
      const m = parseMsg(payload, MAX_SMALL_BYTES);
      if (!m) return;
      if (topic === this._t('p') && m.k === 'p') this._onPresence(m);
      else if (topic === this._t('chat') && m.k === 'm') this._onChat(m);
    }
  }

  _onDirect(m) {
    if (!m) return;
    const now = mono();
    switch (m.k) {
      case 's': {
        if (!this._wantsSnapshot()) return;
        const { id, i, n, d } = m;
        if (typeof id !== 'string' || id.length > 16 || !isInt(n) || n < 1 || n > MAX_CHUNKS) return;
        if (!isInt(i) || i < 0 || i >= n || typeof d !== 'string' || d.length > CHUNK_B64 || !B64_RE.test(d)) return;
        let s = this._snaps.get(id);
        if (!s) {
          if (this._snaps.size >= 2) this._snaps.delete(this._snaps.keys().next().value);
          s = { n, parts: new Array(n), got: 0, t: null };
          this._snaps.set(id, s);
        }
        if (s.n !== n || s.parts[i] !== undefined) return;
        s.parts[i] = d;
        s.got++;
        if (this._awaitSnap) this._awaitSnap.lastProgress = now;
        if (this._awaitSnap?.initial) this._setStatus('loading', `Downloading world ${s.got}/${n}`);
        return this._maybeLoad(id);
      }
      case 'se': {
        const s = this._snaps.get(m.id);
        if (!s || !isInt(m.t) || m.t < 0) return;
        const h = hostOf(m);
        if (h && this._host && h.hp !== this._host.hp) return; // from a host we do not follow
        if (h && !this._host) this._host = h;
        s.t = m.t;
        return this._maybeLoad(m.id);
      }
      case 'fr': {
        if (!Array.isArray(m.fs) || m.fs.length > 200) return;
        for (const raw of m.fs) {
          const f = raw && typeof raw === 'object' && raw.k === 'f' ? readFrame(raw) : null;
          if (f) this._ingestFrame(f, false);
        }
        return;
      }
      case 'rejoin':
        return this._requestSnapshot(true);
      case 'err': {
        const table = { full: 'The world is full', version: 'Version mismatch with host', pid: 'Same player id as the host' };
        const msg = typeof m.e === 'string' && Object.hasOwn(table, m.e) ? table[m.e] : 'Host refused';
        this._fail(msg);
        return;
      }
    }
  }

  // Returns false for frames from a host other than ours. A better host (a takeover) replaces ours:
  // its timeline is unrelated, so everything received so far is dropped and a fresh snapshot is fetched.
  _followHost(h) {
    if (!h) return true; // an older host build without ids
    const cur = this._host;
    if (!cur) { this._host = h; return true; }
    if (cur.hp === h.hp) { cur.e = h.e; return true; }
    if (!beats(h.e, h.hp, cur.e, cur.hp)) return false;
    this._host = h;
    this._hostEnded = false;
    this._recent = [];
    this._ahead = [];
    this._cmds.clear();
    this._expected.clear();
    this._snaps.clear();
    this._gapSince = 0;
    if (this.game) this._recvTick = this.game.tick; // hold still until the new snapshot is in
    this._awaitSnap = null;
    this._requestSnapshot(true);
    return false;
  }

  _wantsSnapshot() {
    return !!this._awaitSnap || this._gapSince > 0;
  }

  _maybeLoad(id) {
    const s = this._snaps.get(id);
    if (!s || s.t == null || s.got !== s.n || this._loading) return;
    this._snaps.clear();
    let bytes;
    try {
      const raw = s.parts.map(fromB64);
      const total = raw.reduce((a, b) => a + b.length, 0);
      bytes = new Uint8Array(total);
      let off = 0;
      for (const r of raw) {
        bytes.set(r, off);
        off += r.length;
      }
    } catch {
      return; // corrupt chunk; hello retry will fetch another
    }
    this._loadSnapshot(bytes, s.t);
  }

  async _loadSnapshot(bytes, T) {
    this._loading = true;
    let g;
    try {
      g = await this._loadGame(bytes);
    } catch (e) {
      console.warn('[net] snapshot load failed', e);
      this._loading = false;
      return;
    }
    this._loading = false;
    if (this._closed) return;
    if (!g || !isInt(g.tick) || typeof g.step !== 'function') return;
    if (g.tick !== T) console.warn('[net] snapshot tick mismatch', g.tick, T);
    const wasInitial = !!this._awaitSnap?.initial;
    this.stats.snapshots++;
    this.game = g;
    this._awaitSnap = null;
    this._snapWanted = false;
    this._gapSince = 0;
    this._cmds.clear();
    this._expected.clear();
    this._recvTick = g.tick;
    const frames = this._recent.concat(this._ahead).filter((f) => f.t > g.tick).sort((a, b) => a.p - b.p);
    this._ahead = [];
    for (const f of frames) this._ingestFrame(f, false, true);
    this._lastFrameAt = mono();
    this._acc = 0;
    this._last = null;
    this._emit('game', g);
    if (!this._hostEnded) this._setStatus('playing', '');
    if (wasInitial && this._joinResolve) {
      this._joinResolve();
      this._joinResolve = this._joinReject = null;
    }
  }

  _ingestFrame(f, live, rebuilding = false) {
    if (live) {
      this._lastFrameAt = mono();
      this.stats.frames++;
    }
    if (!rebuilding) {
      this._recent.push(f);
      if (this._recent.length > CLIENT_RECENT + 100) this._recent.splice(0, this._recent.length - CLIENT_RECENT);
    }
    if (!this.game || this._loading) return; // kept in _recent until the snapshot is in
    if (live && this.status.state === 'disconnected' && !this._hostEnded) this._setStatus('playing', '');
    if (f.t <= this._recvTick) return; // duplicate
    if (f.p > this._recvTick) {
      if (!this._gapSince) this.stats.gaps++;
      if (this._ahead.length < CLIENT_RECENT) this._ahead.push(f);
      this._markGap(false);
      return;
    }
    this._acceptFrame(f);
    // Drain frames that became contiguous.
    let progressed = true;
    while (progressed && this._ahead.length) {
      progressed = false;
      this._ahead = this._ahead.filter((a) => a.t > this._recvTick);
      for (const a of this._ahead) {
        if (a.p <= this._recvTick && a.t > this._recvTick) {
          this._acceptFrame(a);
          progressed = true;
        }
      }
    }
    if (!this._ahead.length) this._gapSince = 0;
  }

  _acceptFrame(f) {
    for (const [tick, cmd] of f.c) {
      if (tick <= this._recvTick) continue;
      const arr = this._cmds.get(tick);
      if (arr) arr.push(cmd);
      else this._cmds.set(tick, [cmd]);
    }
    if (f.h != null && f.ht > this.game.tick && f.ht > this._recvTick) this._expected.set(f.ht, f.h);
    this._recvTick = f.t;
  }

  // Missing frames (QoS 0 can drop, or we reconnected): ask the host to replay from our newest tick.
  _markGap(force) {
    const now = mono();
    if (!this._gapSince) this._gapSince = now;
    if (force || now - this._gapAsked > 1500) {
      this._gapAsked = now;
      this._sendHello(this._recvTick);
    }
  }

  _requestSnapshot(force) {
    if (this._awaitSnap || this._closed) return;
    const now = mono();
    if (!force && now - this._lastSnapReq < RESYNC_MIN_MS) {
      this._snapWanted = true;
      return;
    }
    this._snapWanted = false;
    this._lastSnapReq = now;
    this._awaitSnap = { since: now, lastHello: -1e9, lastProgress: -1e9, initial: false };
    this._setStatus(this.status.state, 'Resyncing');
    this._sendHello(null);
  }

  // ---- simulation

  update(nowMs = mono()) {
    if (this._closed) return 0;
    this._flushCmds();
    this._flushPresence();
    if (!this.game || this._loading) {
      this._last = nowMs;
      return 0;
    }
    const behind = this._recvTick - this.game.tick;
    if (behind > RESNAP_BEHIND) this._requestSnapshot(false);
    // Stay a little behind the newest received tick to absorb jitter (more when frames are longer).
    const lag = Math.max(CLIENT_LAG, Math.ceil(this._span) + 3);
    const rate = behind > lag + 3 ? 1.2 : behind < lag - 3 ? 0.8 : 1;
    if (this._last == null || !Number.isFinite(nowMs)) {
      this._last = nowMs;
      return 0;
    }
    const dt = Math.max(0, nowMs - this._last);
    this._last = nowMs;
    this._acc = Math.min(this._acc + dt * rate, MAX_CATCHUP * TICK_MS + 0.01);
    let n = Math.floor(this._acc / TICK_MS);
    this._acc -= n * TICK_MS;
    if (behind > lag + FAR_BEHIND - CLIENT_LAG) n = Math.max(n, Math.min(MAX_CATCHUP, behind - lag));
    n = Math.min(n, behind, MAX_CATCHUP);
    if (n <= 0) {
      if (behind <= 0) this._acc = 0;
      return 0;
    }
    for (let i = 0; i < n; i++) {
      const tick = this.game.tick + 1;
      const cmds = this._cmds.get(tick) || [];
      this._cmds.delete(tick);
      this.game.step(cmds);
      const expect = this._expected.get(this.game.tick);
      if (expect !== undefined) {
        this._expected.delete(this.game.tick);
        const mine = this.game.hash() >>> 0;
        if (mine !== expect && !this._awaitSnap && !this._snapWanted) {
          this.stats.desyncs++;
          this._emit('desync', { tick: this.game.tick, expected: expect, actual: mine });
          this._requestSnapshot(false);
        }
      }
    }
    if (this._expected.size > 64) {
      for (const t of this._expected.keys()) if (t <= this.game.tick) this._expected.delete(t);
    }
    return n;
  }

  _housekeeping() {
    if (this._closed) return;
    const now = mono();
    const a = this._awaitSnap;
    if (a) {
      if (a.initial && now - a.since > this._joinGiveupMs) return this._fail('Could not join: the host did not answer');
      if (!a.initial && now - a.since > JOIN_GIVEUP_MS) {
        this._awaitSnap = null;
        this._snapWanted = true; // retried after the resync cooldown
      } else if (now - Math.max(a.lastHello, a.lastProgress) > HELLO_RETRY_MS && !this._loading && this._mq.connected) {
        this._sendHello(null);
      }
    } else if (this._snapWanted && now - this._lastSnapReq >= RESYNC_MIN_MS) {
      this._requestSnapshot(true);
    }
    if (this._gapSince && !this._awaitSnap) {
      if (now - this._gapSince > 6000) {
        this._gapSince = 0;
        this._requestSnapshot(false);
      } else {
        this._markGap(false);
      }
    }
    if (this.game && !this._hostEnded && this.status.state === 'playing' && now - this._lastFrameAt > NO_FRAME_MS) {
      this._setStatus('disconnected', 'The host is not responding');
    }
    if (now - this._lastHb > HB_MS && this._mq.connected) {
      this._lastHb = now;
      const hb = { k: 'hb', pid: this.localPid, ts: Date.now() };
      if (isInt(this.status.ping)) hb.ping = this.status.ping;
      this._pub(this._t('up'), JSON.stringify(hb), null, PRIO_LOW, 'hb');
    }
    this._flushCmds();
    this._prunePresence();
    this._flushPresence(now);
  }

  _fail(message) {
    this._setStatus('error', message);
    if (this._joinReject) {
      this._joinReject(new Error(message));
      this._joinResolve = this._joinReject = null;
    }
    this._awaitSnap = null;
  }

  _sayBye() {
    this._pub(this._t('up'), JSON.stringify({ k: 'bye', pid: this.localPid }), null, PRIO_FRAME);
  }

  /** Returns a promise that resolves once 'bye' is flushed and the socket is closed. */
  close() {
    if (this._closed) return this._closing || Promise.resolve();
    this._closed = true;
    clearInterval(this._timer);
    globalThis.removeEventListener?.('pagehide', this._onPageHide);
    if (this.status.state !== 'error') this._setStatus('disconnected', 'Closed');
    if (this._joinReject) {
      this._joinReject(new Error('Closed'));
      this._joinResolve = this._joinReject = null;
    }
    if (!this._mq) return Promise.resolve();
    this._sayBye();
    return (this._closing = this._endTransport());
  }
}

// ---------------------------------------------------------------- open world probe

/** Reads what an open room has on its broker: is someone hosting it right now (live frames, or else a
 *  fresh retained lobby entry), and the newest complete retained world copy.
 *  Returns {host: {hp, e} | null, live: bool, world: {bytes, tick, epoch} | null}. */
export async function probeOpenWorld(room = OPEN_ROOM, listenMs = 2000) {
  if (!isOpenRoom(room)) throw new Error('Not an open room');
  const mq = await connectBroker(OPEN_BROKER, CLIENT_CONNECT_MS, { reconnectPeriod: 0 });
  const lobbyTopic = PREFIX + 'lobby/' + room;
  const downTopic = PREFIX + room + '/down';
  const base = PREFIX + room + '/save/';
  const chunkRe = /^([01])\/(\d{1,2})$/;
  let lobby = null;
  let live = null; // host seen sending frames during the probe
  const slots = [new Map(), new Map()];
  mq.on('message', (topic, payload) => {
    if (topic === downTopic) {
      const m = parseMsg(payload, MAX_DOWN_BYTES);
      const h = m && m.k === 'f' && hostOf(m);
      if (h && (!live || beats(h.e, h.hp, live.e, live.hp))) live = h;
      return;
    }
    if (topic === lobbyTopic) {
      const m = parseMsg(payload, MAX_SMALL_BYTES);
      const h = m && hostOf(m);
      if (h && m.v === 1 && Number.isFinite(m.ts) && Math.abs(Date.now() - m.ts) < LOBBY_MAX_AGE_MS) {
        lobby = { ...h, players: isInt(m.players) && m.players >= 0 && m.players <= 64 ? m.players : 0 };
      } else lobby = null;
      return;
    }
    const tm = topic.startsWith(base) && chunkRe.exec(topic.slice(base.length));
    if (!tm) return;
    const m = parseMsg(payload, MAX_TO_BYTES);
    const i = Number(tm[2]);
    if (!m || m.k !== 'w' || m.i !== i || typeof m.id !== 'string' || m.id.length > 16) return;
    if (!isInt(m.n) || m.n < 1 || m.n > MAX_WORLD_CHUNKS || i >= m.n || !isInt(m.t) || m.t < 0 || !isInt(m.e) || m.e < 0) return;
    if (typeof m.d !== 'string' || m.d.length > CHUNK_B64 || !B64_RE.test(m.d)) return;
    slots[Number(tm[1])].set(i, m);
  });
  await new Promise((resolve) => {
    const t = setTimeout(resolve, CLIENT_CONNECT_MS);
    mq.subscribe([lobbyTopic, downTopic, base + '+/+'], { qos: 0 }, () => { clearTimeout(t); resolve(); });
  });
  await new Promise((r) => setTimeout(r, listenMs)); // retained messages arrive right after subscribing
  try { mq.end(true); } catch {}
  let world = null;
  for (const parts of slots) {
    const first = parts.get(0);
    if (!first) continue;
    const list = [];
    for (let i = 0; i < first.n; i++) {
      const c = parts.get(i);
      if (!c || c.id !== first.id || c.n !== first.n) break;
      list.push(fromB64(c.d));
    }
    if (list.length !== first.n) continue; // incomplete or mixed copy
    if (world && !newerCopy(first.e, first.t, world.epoch, world.tick)) continue;
    const bytes = new Uint8Array(list.reduce((a, b) => a + b.length, 0));
    let off = 0;
    for (const r of list) { bytes.set(r, off); off += r.length; }
    world = { bytes, tick: first.t, epoch: first.e };
  }
  return { host: live || lobby, live: !!live, world };
}

// ---------------------------------------------------------------- lobby discovery

/** Collects retained lobby entries from all brokers: each broker connects (up to 10 s), then listens for timeoutMs. */
export async function listLobbies(timeoutMs = 2500) {
  const found = new Map();
  const topicRe = /^ironfield\/v1\/lobby\/([A-Z2-9]{6})$/;
  await Promise.all(
    BROKERS.map(
      (url, bi) =>
        new Promise((resolve) => {
          let client;
          let timer;
          const finish = () => {
            clearTimeout(timer);
            try { client.end(true); } catch {}
            resolve();
          };
          try {
            client = mqttLib().connect(url, mqttOptions(CLIENT_CONNECT_MS, { reconnectPeriod: 0 }));
          } catch {
            resolve();
            return;
          }
          client.on('error', () => {});
          // Connecting may take a few seconds; the collection window starts once subscribed.
          timer = setTimeout(finish, CLIENT_CONNECT_MS); // HiveMQ sometimes needs ~7 s
          client.on('connect', () =>
            client.subscribe(PREFIX + 'lobby/+', { qos: 0 }, () => {
              clearTimeout(timer);
              timer = setTimeout(finish, timeoutMs);
            }),
          );
          client.on('message', (topic, payload) => {
            if (found.size >= 200) return;
            const tm = topicRe.exec(topic);
            const m = tm && parseMsg(payload, MAX_SMALL_BYTES);
            if (!m || m.v !== 1 || m.room !== tm[1] || !ROOM_RE.test(m.room)) return;
            const now = Date.now();
            if (!Number.isFinite(m.ts) || now - m.ts > LOBBY_MAX_AGE_MS || m.ts - now > LOBBY_MAX_AGE_MS) return;
            const prev = found.get(m.room);
            if (prev && prev.ts >= m.ts) return;
            found.set(m.room, {
              room: m.room,
              broker: bi, // the broker we actually heard it on
              world: cleanText(m.world, 32) || 'Ironfield',
              host: cleanName(m.host),
              players: isInt(m.players) && m.players >= 0 && m.players <= 64 ? m.players : 0,
              tick: isInt(m.tick) && m.tick >= 0 ? m.tick : 0,
              ts: m.ts,
            });
          });
        }),
    ),
  );
  return [...found.values()].sort((a, b) => b.ts - a.ts).map(({ ts, ...r }) => r);
}
