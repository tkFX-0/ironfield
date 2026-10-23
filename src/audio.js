// Ironfield audio: everything is synthesized with the Web Audio API (no files, no deps).
// Every public call fails silently when Web Audio is unavailable.

const Ctx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;

const MAX_VOICES = 12;      // one-shot SFX
const MAX_AMB_SHOTS = 10;   // inserter ticks, birds, crickets
const DEFAULT_GAP = 0.04;   // min seconds between identical sounds
const MIN_GAP = {
  'craft-start': 0.06, 'craft-done': 0.06, 'mine-hit': 0.06, 'mine-wood': 0.06,
  open: 0.06, close: 0.06, chat: 0.08, error: 0.15, join: 0.3,
  'research-done': 0.5, alert: 0.6, 'rocket-launch': 2.5,
};
// random pitch spread so repeated sounds (belt dragging, mining) don't machine-gun
const JITTER = { place: 0.05, remove: 0.04, rotate: 0.03, click: 0.03, pickup: 0.04, 'mine-hit': 0.07, 'mine-wood': 0.06 };
const MACHINES = ['belts', 'drills', 'furnaces', 'assemblers', 'engines', 'inserters', 'pumps', 'labs'];
const TAU = 0.5; // ambience smoothing time constant (s)

let ctx = null, master = null, sfxBus = null, ambBus = null, natureBus = null, comp = null;
let bufs = null;
let unlocked = false, muted = false, volume = 1, daylight = 1;
let levels = {};
let dirty = true, norm = 1, quiet = 1;
let liveNodes = 0, suspendTimer = 0, placeAlt = 0, resumeAt = -1e9;
let nextIns = 0, nextBird = 0;
const nextCricket = [0, 0];
const lastPlayed = Object.create(null);
const sfx = { set: new Set(), cap: MAX_VOICES };
const amb = { set: new Set(), cap: MAX_AMB_SHOTS };
let analyser = null, meterData = null;

const R = Math.random;
const noop = () => {};
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const num = (x, d) => (Number.isFinite(+x) && x !== null && x !== '' ? +x : d);
const hidden = () => typeof document !== 'undefined' && document.hidden;
const wantRunning = () => unlocked && !muted && !hidden();

// ------------------------------------------------------------------ buffers

// Generates len+fade samples and crossfades the tail into the head so the loop point is seamless.
function loopable(gen, len, fade) {
  const raw = gen(len + fade);
  const out = raw.slice(0, len);
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    out[i] = raw[i] * Math.sqrt(w) + raw[len + i] * Math.sqrt(1 - w);
  }
  return out;
}

function normalize(d, peak) {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / m;
  return d;
}

const whiteGen = (n) => { const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = R() * 2 - 1; return d; };
function pinkGen(n) {
  const d = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = R() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
  }
  return d;
}
function brownGen(n) {
  const d = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) { last = (last + 0.02 * (R() * 2 - 1)) / 1.02; d[i] = last; }
  return d;
}

// Adds a decaying hit (damped sine + noise) into d, wrapping around so the buffer loops cleanly.
function addHit(d, sr, t, { f = 0, dec = 0.03, amp = 0.5, noise = 0.5, nDec = 0.004, att = 0 }) {
  const start = Math.floor(t * sr), n = Math.floor(dec * 7 * sr), len = d.length;
  for (let i = 0; i < n; i++) {
    const tt = i / sr;
    const e = (att ? 1 - Math.exp(-tt / att) : 1) * Math.exp(-tt / dec);
    let s = f ? Math.sin(6.283185 * f * tt) * (1 - noise) : 0;
    s += (R() * 2 - 1) * noise * (nDec ? Math.exp(-tt / nDec) : 1);
    d[(start + i) % len] += amp * e * s;
  }
}

function makeBuffers(c) {
  const sr = c.sampleRate;
  const mk = (d) => { const b = c.createBuffer(1, d.length, sr); b.getChannelData(0).set(d); return b; };
  const fade = Math.floor(sr * 0.05);
  const S = (s) => Math.floor(s * sr);

  // sparse pops for furnace crackle
  const crackle = new Float32Array(S(2));
  for (let t = 0; t < 2; t += -Math.log(1 - R()) / 30) {
    addHit(crackle, sr, t, { dec: 0.0015 + R() * 0.003, amp: 0.05 + R() ** 3 * 0.8, noise: 1, nDec: 0 });
  }
  for (let t = R() * 0.5; t < 2; t += 0.3 + R() * 0.7) addHit(crackle, sr, t, { dec: 0.006, amp: 0.7 + R() * 0.3, noise: 1, nDec: 0 });

  // assembler: one mechanical cycle (clunks, ticks, a slide)
  const clatter = new Float32Array(S(1.8));
  for (const [t, f, dec, amp, noise] of [
    [0, 310, 0.05, 0.9, 0.35], [0.32, 2100, 0.012, 0.45, 0.8], [0.46, 1750, 0.014, 0.4, 0.8],
    [0.9, 260, 0.045, 0.7, 0.35], [1.36, 2400, 0.01, 0.4, 0.8], [1.5, 900, 0.03, 0.35, 0.5],
  ]) addHit(clatter, sr, t, { f, dec, amp, noise });
  addHit(clatter, sr, 1.12, { dec: 0.06, amp: 0.22, noise: 1, nDec: 0, att: 0.015 });

  // steam engine: two chuffs per second with piston thumps and valve ticks
  const chuff = new Float32Array(S(1));
  addHit(chuff, sr, 0, { dec: 0.11, amp: 1, noise: 1, nDec: 0, att: 0.008 });
  addHit(chuff, sr, 0, { f: 70, dec: 0.07, amp: 0.8, noise: 0 });
  addHit(chuff, sr, 0.5, { dec: 0.09, amp: 0.7, noise: 1, nDec: 0, att: 0.008 });
  addHit(chuff, sr, 0.5, { f: 70, dec: 0.06, amp: 0.5, noise: 0 });
  addHit(chuff, sr, 0.25, { f: 1800, dec: 0.006, amp: 0.15, noise: 0.6 });
  addHit(chuff, sr, 0.75, { f: 1800, dec: 0.006, amp: 0.15, noise: 0.6 });

  return {
    white: mk(normalize(loopable(whiteGen, S(2), fade), 0.95)),
    pink: mk(normalize(loopable(pinkGen, S(3), fade), 0.95)),
    brown: mk(normalize(loopable(brownGen, S(3.5), fade), 0.95)),
    crackle: mk(normalize(crackle, 0.9)),
    clatter: mk(normalize(clatter, 0.9)),
    chuff: mk(normalize(chuff, 0.9)),
  };
}

// ------------------------------------------------------------------ one-shot voices

function mkPan(pan) {
  if (!pan || !ctx.createStereoPanner) return null;
  const p = ctx.createStereoPanner();
  p.pan.value = clamp(pan, -1, 1);
  return p;
}

function newVoice(group, vol, pan, bus) {
  if (group.set.size >= group.cap) return null;
  const out = ctx.createGain();
  out.gain.value = vol;
  const v = { group, out, nodes: [out], pending: 0 };
  const p = mkPan(pan);
  if (p) { out.connect(p); p.connect(bus); v.nodes.push(p); } else out.connect(bus);
  group.set.add(v);
  liveNodes += v.nodes.length;
  return v;
}

function reg(v, node) { v.nodes.push(node); liveNodes++; return node; }

// Starts a source; the voice's nodes are disconnected when its last source ends.
function run(v, s, t0, t1, offset) {
  v.pending++;
  s.onended = () => { if (--v.pending <= 0) killVoice(v); };
  if (offset != null) s.start(t0, offset); else s.start(t0);
  s.stop(t1);
}

function killVoice(v) {
  if (!v.group.set.delete(v)) return;
  for (const n of v.nodes) { try { n.disconnect(); } catch { /* already gone */ } }
  liveNodes -= v.nodes.length;
  v.nodes.length = 0;
}

function finishBuild(v) { if (v.pending === 0) killVoice(v); }

// Attack (linear) / hold / exponential release. Returns end time.
function env(param, t, a, d, peak, hold = 0) {
  param.setValueAtTime(0.0001, t);
  param.linearRampToValueAtTime(peak, t + a);
  if (hold) param.setValueAtTime(peak, t + a + hold);
  param.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
  return t + a + hold + d;
}

function wire(...ns) { for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1]); return ns[ns.length - 1]; }

function bsrc(v, buf, rate = 1) {
  const s = reg(v, ctx.createBufferSource());
  s.buffer = bufs[buf]; s.loop = true; s.playbackRate.value = rate;
  return s;
}
function flt(v, type, f, q) {
  const n = reg(v, ctx.createBiquadFilter());
  n.type = type; n.frequency.value = f; n.Q.value = q ?? (type === 'bandpass' ? 1 : 0);
  return n;
}

// Filtered noise burst.
function nz(v, t, o) {
  const { buf = 'white', type = 'bandpass', f = 1000, f2 = 0, q, a = 0.002, d = 0.08, g = 1, hold = 0, rate = 1, dest = v.out } = o;
  const s = bsrc(v, buf, rate);
  const fl = flt(v, type, f, q);
  fl.frequency.setValueAtTime(f, t);
  if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + (o.sw || a + hold + d));
  const e = reg(v, ctx.createGain());
  const end = env(e.gain, t, a, d, g, hold);
  wire(s, fl, e, dest);
  run(v, s, t, end + 0.03, R() * (s.buffer.duration - 0.1));
}

// Enveloped oscillator, optional exponential pitch sweep.
function tn(v, t, o) {
  const { type = 'sine', f = 440, f2 = 0, sw = 0, a = 0.003, d = 0.2, g = 0.2, hold = 0, dest = v.out } = o;
  const osc = reg(v, ctx.createOscillator());
  osc.type = type;
  osc.frequency.setValueAtTime(f, t);
  if (f2) osc.frequency.exponentialRampToValueAtTime(f2, t + (sw || a + hold + d));
  const e = reg(v, ctx.createGain());
  const end = env(e.gain, t, a, d, g, hold);
  wire(osc, e, dest);
  run(v, osc, t, end + 0.03);
}

const SOUNDS = {
  click(v, t, p) {
    nz(v, t, { f: 3800 * p, q: 2, a: 0.001, d: 0.018, g: 0.7 });
    tn(v, t, { f: 2200 * p, a: 0.001, d: 0.025, g: 0.03 });
  },
  place(v, t, p) {
    const k = (placeAlt ^= 1);
    tn(v, t, { f: 150 * p, f2: 55 * p, sw: 0.07, a: 0.002, d: 0.11, g: 0.35 });
    nz(v, t, { f: (k ? 1100 : 1350) * p, q: 1.8, a: 0.001, d: 0.05, g: 1.8 });
    nz(v, t, { buf: 'brown', type: 'lowpass', f: 700 * p, a: 0.002, d: 0.07, g: 0.7 });
    tn(v, t + 0.004, { type: 'triangle', f: (k ? 740 : 830) * p, a: 0.002, d: 0.08, g: 0.035 });
  },
  remove(v, t, p) {
    nz(v, t, { f: 2000 * p, q: 2, a: 0.001, d: 0.03, g: 1.5 });
    nz(v, t, { f: 900 * p, f2: 2400 * p, q: 1.2, a: 0.005, d: 0.08, g: 0.6 });
    tn(v, t + 0.04, { f: 120 * p, f2: 70 * p, a: 0.002, d: 0.09, g: 0.35 });
    nz(v, t + 0.04, { buf: 'brown', type: 'lowpass', f: 500 * p, a: 0.002, d: 0.06, g: 0.6 });
  },
  rotate(v, t, p) {
    tn(v, t, { f: 200 * p, f2: 130 * p, sw: 0.06, a: 0.002, d: 0.1, g: 0.3 });
    tn(v, t, { type: 'triangle', f: 520 * p, a: 0.002, d: 0.16, g: 0.05 });
    tn(v, t, { f: 1307 * p, a: 0.002, d: 0.09, g: 0.025 });
    nz(v, t, { f: 950 * p, q: 1.2, a: 0.001, d: 0.035, g: 1.2 });
  },
  open(v, t, p) {
    nz(v, t, { buf: 'pink', f: 500 * p, f2: 1800 * p, q: 1.4, a: 0.03, d: 0.1, g: 0.8 });
    tn(v, t, { f: 620 * p, f2: 930 * p, sw: 0.06, a: 0.005, d: 0.09, g: 0.06 });
    nz(v, t, { f: 3000 * p, q: 2, a: 0.001, d: 0.015, g: 0.4 });
  },
  close(v, t, p) {
    nz(v, t, { buf: 'pink', f: 1800 * p, f2: 500 * p, q: 1.4, a: 0.02, d: 0.1, g: 0.8 });
    tn(v, t, { f: 930 * p, f2: 620 * p, sw: 0.06, a: 0.005, d: 0.08, g: 0.06 });
    nz(v, t + 0.07, { f: 2600 * p, q: 2, a: 0.001, d: 0.015, g: 0.4 });
  },
  error(v, t, p) {
    for (const [dt, f] of [[0, 233], [0.11, 185]]) {
      tn(v, t + dt, { type: 'triangle', f: f * p, a: 0.004, d: 0.14, g: 0.16 });
      tn(v, t + dt, { type: 'square', f: f * p, a: 0.004, d: 0.1, g: 0.022 });
    }
  },
  'craft-start'(v, t, p) {
    nz(v, t, { buf: 'pink', f: 600 * p, f2: 1400 * p, q: 2, a: 0.02, d: 0.18, g: 1.0 });
    nz(v, t, { f: 2500 * p, q: 2, a: 0.001, d: 0.02, g: 0.8 });
    tn(v, t, { type: 'triangle', f: 330 * p, f2: 440 * p, sw: 0.15, a: 0.01, d: 0.16, g: 0.03 });
  },
  'craft-done'(v, t, p) {
    for (const [dt, f] of [[0, 1046.5], [0.085, 1568]]) {
      tn(v, t + dt, { f: f * p, a: 0.003, d: 0.55, g: 0.13 });
      tn(v, t + dt, { f: 2 * f * p, a: 0.003, d: 0.25, g: 0.03 });
    }
  },
  'research-done'(v, t, p) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tn(v, t + i * 0.075, { type: 'triangle', f: f * p, a: 0.005, d: 0.35, g: 0.125 });
      tn(v, t + i * 0.075, { f: 2 * f * p, a: 0.005, d: 0.3, g: 0.05 });
    });
    for (const f of [523.25, 783.99, 1046.5, 1318.5]) {
      tn(v, t + 0.3, { f: f * p, a: 0.02, hold: 0.25, d: 0.9, g: 0.075 });
    }
  },
  'mine-hit'(v, t, p) {
    nz(v, t, { type: 'highpass', f: 2500 * p, a: 0.0005, d: 0.03, g: 0.35 });
    tn(v, t, { f: 2900 * p, a: 0.001, d: 0.12, g: 0.05 });
    tn(v, t, { f: 4170 * p, a: 0.001, d: 0.07, g: 0.03 });
    tn(v, t, { f: 110 * p, f2: 70 * p, a: 0.002, d: 0.07, g: 0.3 });
    nz(v, t, { buf: 'brown', f: 700 * p, q: 0.8, a: 0.001, d: 0.09, g: 0.8 });
  },
  'mine-wood'(v, t, p) {
    nz(v, t, { f: 480 * p, q: 5, a: 0.001, d: 0.1, g: 3 });
    tn(v, t, { f: 210 * p, f2: 150 * p, sw: 0.05, a: 0.002, d: 0.09, g: 0.3 });
    nz(v, t, { f: 1600 * p, q: 2.5, a: 0.001, d: 0.035, g: 1.2 });
    nz(v, t, { buf: 'brown', type: 'lowpass', f: 400 * p, a: 0.002, d: 0.06, g: 0.5 });
  },
  pickup(v, t, p) {
    tn(v, t, { f: 380 * p, f2: 820 * p, sw: 0.06, a: 0.003, d: 0.1, g: 0.16 });
    tn(v, t, { type: 'triangle', f: 760 * p, f2: 1640 * p, sw: 0.06, a: 0.003, d: 0.1, g: 0.03 });
    nz(v, t, { f: 2500 * p, q: 2, a: 0.001, d: 0.012, g: 0.5 });
  },
  chat(v, t, p) {
    tn(v, t, { f: 988 * p, a: 0.004, d: 0.09, g: 0.125 });
    tn(v, t + 0.07, { f: 1319 * p, a: 0.004, d: 0.14, g: 0.11 });
  },
  join(v, t, p) {
    [587.3, 740, 880].forEach((f, i) => {
      tn(v, t + i * 0.09, { type: 'triangle', f: f * p, a: 0.006, d: 0.25, g: 0.11 });
      tn(v, t + i * 0.09, { f: 2 * f * p, a: 0.006, d: 0.2, g: 0.03 });
    });
  },
  alert(v, t, p) {
    for (const [dt, f] of [[0, 784], [0.17, 587.3]]) {
      tn(v, t + dt, { type: 'triangle', f: f * p, a: 0.01, d: 0.22, g: 0.2 });
      tn(v, t + dt, { f: 2 * f * p, a: 0.01, d: 0.15, g: 0.03 });
    }
  },
  'rocket-launch'(v, t, p) {
    const end = t + 5.3;
    const ahr = (param, t0, a, h, r, g) => {
      param.setValueAtTime(0.0001, t0);
      param.linearRampToValueAtTime(g, t0 + a);
      param.setValueAtTime(g, t0 + a + h);
      param.exponentialRampToValueAtTime(0.0001, t0 + a + h + r);
    };
    // roar: brown noise with an opening then closing lowpass
    let s = bsrc(v, 'brown', 0.9 * p), f = flt(v, 'lowpass', 150 * p), g = reg(v, ctx.createGain());
    f.frequency.setValueAtTime(150 * p, t);
    f.frequency.exponentialRampToValueAtTime(1100 * p, t + 1.6);
    f.frequency.exponentialRampToValueAtTime(500 * p, end);
    ahr(g.gain, t, 1.2, 2.0, 2.0, 0.6);
    wire(s, f, g, v.out); run(v, s, t, end + 0.05, R() * 3);
    // thrust hiss
    s = bsrc(v, 'white', p); f = flt(v, 'bandpass', 400 * p, 0.6); g = reg(v, ctx.createGain());
    f.frequency.setValueAtTime(400 * p, t);
    f.frequency.exponentialRampToValueAtTime(1500 * p, t + 1.5);
    f.frequency.exponentialRampToValueAtTime(800 * p, end);
    ahr(g.gain, t, 1.6, 2.0, 1.6, 0.55);
    wire(s, f, g, v.out); run(v, s, t, end + 0.05, R() * 1.8);
    // crackle
    s = bsrc(v, 'crackle', 0.8 * p); f = flt(v, 'highpass', 900 * p); g = reg(v, ctx.createGain());
    ahr(g.gain, t + 0.4, 0.8, 2.0, 2.0, 0.4);
    wire(s, f, g, v.out); run(v, s, t, end + 0.05, R() * 1.8);
    tn(v, t, { f: 38 * p, f2: 48 * p, sw: 3, a: 1, hold: 2, d: 2, g: 0.25 });
    nz(v, t, { buf: 'brown', type: 'lowpass', f: 300 * p, a: 0.005, d: 0.5, g: 0.6 });
  },
};

// ------------------------------------------------------------------ ambience loops

function curve(n) {
  n = num(n, 0);
  if (n <= 0) return 0;
  // 1 machine ~ -9 dB, 10 ~ -5 dB, 200 = 0 dB, capped just above
  return Math.min(1.2, 0.25 + 0.75 * Math.log(1 + n) / Math.log(201));
}

function add(L, n) { L.nodes.push(n); liveNodes++; return n; }
function lsrc(L, buf, rate = 1) {
  const s = add(L, ctx.createBufferSource());
  s.buffer = bufs[buf]; s.loop = true; s.playbackRate.value = rate;
  L.srcs.push([s, R() * s.buffer.duration]);
  return s;
}
function losc(L, type, f) {
  const o = add(L, ctx.createOscillator());
  o.type = type; o.frequency.value = f;
  L.srcs.push([o]);
  return o;
}
function lflt(L, type, f, q) {
  const n = add(L, ctx.createBiquadFilter());
  n.type = type; n.frequency.value = f; n.Q.value = q ?? (type === 'bandpass' ? 1 : 0);
  return n;
}
function lgain(L, g) { const n = add(L, ctx.createGain()); n.gain.value = g; return n; }
// sine LFO added onto an AudioParam (param keeps its own base value)
function lfo(L, rate, depth, param) { wire(losc(L, 'sine', rate), lgain(L, depth), param); }

// gain: layer level at curve()=1 before normalization (tuned so 200 machines ~ -27 dBFS RMS, 1 machine ~ -36)
const LAYERS = {
  belts: { gain: 0.35, build(L, out) {
    wire(lsrc(L, 'brown'), lflt(L, 'lowpass', 260), lgain(L, 0.45), out);
    const am = lgain(L, 0.55);
    lfo(L, 14, 0.36, am.gain); lfo(L, 3.1, 0.12, am.gain);
    wire(lsrc(L, 'white', 0.97), lflt(L, 'bandpass', 2300, 1.4), am, out);
    wire(losc(L, 'triangle', 100), lgain(L, 0.03), out);
  } },
  drills: { gain: 0.25, build(L, out) {
    const bp = lflt(L, 'bandpass', 380, 0.9);
    lfo(L, 0.33, 90, bp.frequency);
    wire(lsrc(L, 'brown'), bp, lgain(L, 1.3), out);
    const am = lgain(L, 0.45);
    lfo(L, 8.5, 0.38, am.gain);
    wire(lsrc(L, 'white'), lflt(L, 'bandpass', 1700, 2.2), am, out);
    wire(losc(L, 'sawtooth', 52), lflt(L, 'lowpass', 400), lgain(L, 0.05), out);
  } },
  furnaces: { gain: 0.2, build(L, out) {
    const roar = lgain(L, 0.9);
    lfo(L, 0.6, 0.15, roar.gain);
    wire(lsrc(L, 'brown', 0.9), lflt(L, 'lowpass', 420), roar, out);
    wire(lsrc(L, 'pink'), lflt(L, 'bandpass', 1000, 0.7), lgain(L, 0.3), out);
    wire(lsrc(L, 'crackle'), lflt(L, 'highpass', 1200), lgain(L, 0.5), out);
  } },
  assemblers: { gain: 0.44, build(L, out) {
    wire(lsrc(L, 'clatter'), lgain(L, 0.8), out);
    L.extra = lgain(L, 0); // second, drifting cycle fades in with more machines
    wire(lsrc(L, 'clatter', 1.13), L.extra, out);
    wire(losc(L, 'triangle', 96), lgain(L, 0.035), out);
  } },
  engines: { gain: 0.42, build(L, out) {
    const bp = lflt(L, 'bandpass', 700, 0.8), lp = lflt(L, 'lowpass', 170);
    wire(bp, lgain(L, 1.0), out); wire(lp, lgain(L, 0.8), out);
    const a = lsrc(L, 'chuff'); a.connect(bp); a.connect(lp);
    L.extra = lgain(L, 0);
    wire(lsrc(L, 'chuff', 1.07), L.extra); L.extra.connect(bp); L.extra.connect(lp);
    wire(lsrc(L, 'white'), lflt(L, 'highpass', 5000), lgain(L, 0.05), out);
  } },
  inserters: { gain: 0.65, build(L, out) {
    const bp = lflt(L, 'bandpass', 1300, 4);
    lfo(L, 0.23, 450, bp.frequency);
    const am = lgain(L, 0.9);
    lfo(L, 0.55, 0.6, am.gain);
    wire(lsrc(L, 'pink'), bp, am, out);
  } },
  pumps: { gain: 0.28, build(L, out) {
    wire(losc(L, 'triangle', 98), lgain(L, 0.07), out);
    wire(losc(L, 'sine', 196.5), lgain(L, 0.025), out);
    const am = lgain(L, 0.5);
    lfo(L, 0.8, 0.3, am.gain);
    wire(lsrc(L, 'brown', 0.8), lflt(L, 'lowpass', 320), am, out);
  } },
  labs: { gain: 0.9, build(L, out) {
    const pad = lgain(L, 0.035);
    lfo(L, 0.12, 0.01, pad.gain);
    pad.connect(out);
    losc(L, 'sine', 220).connect(pad);
    losc(L, 'sine', 220.8).connect(pad);
    wire(losc(L, 'triangle', 330.4), lgain(L, 0.45), pad);
    const sh = lgain(L, 0.006);
    lfo(L, 0.31, 0.005, sh.gain);
    wire(losc(L, 'sine', 1320), sh, out);
  } },
  wind: { gain: 0.125, nature: true, build(L, out) {
    const lp = lflt(L, 'lowpass', 420);
    lfo(L, 0.06, 220, lp.frequency);
    const am = lgain(L, 0.6);
    lfo(L, 0.093, 0.3, am.gain); lfo(L, 0.037, 0.2, am.gain);
    wire(lsrc(L, 'pink', 0.8), lp, am, out);
  } },
};
for (const L of Object.values(LAYERS)) Object.assign(L, { built: false, out: null, nodes: [], srcs: [], target: 0, zeroAt: 0, extra: null, extraV: 0 });

function buildLayer(L) {
  L.out = lgain(L, 0);
  L.out.connect(L.nature ? natureBus : ambBus);
  L.build(L, L.out);
  const t = ctx.currentTime;
  for (const [s, off] of L.srcs) { if (off != null) s.start(t, off); else s.start(t); }
  L.built = true;
  L.fresh = true;
}

function teardown(L) {
  for (const [s] of L.srcs) { try { s.stop(); } catch { /* not started */ } }
  for (const n of L.nodes) { try { n.disconnect(); } catch { /* gone */ } }
  liveNodes -= L.nodes.length;
  L.nodes = []; L.srcs = []; L.out = null; L.extra = null; L.extraV = 0; L.built = false;
}

function setLayer(L, target, now, count) {
  if (target < 0.0005) target = 0;
  if (target > 0 && !L.built) buildLayer(L);
  if (L.built) {
    // only touch automation on real changes so the event list stays short
    if (Math.abs(target - L.target) > 0.001 || L.fresh) L.out.gain.setTargetAtTime(target, now, TAU);
    L.fresh = false;
    if (L.extra) {
      const e = count >= 2 ? Math.min(1, (count - 1) / 3) : 0;
      if (e !== L.extraV) { L.extra.gain.setTargetAtTime(e, now, TAU); L.extraV = e; }
    }
  }
  if (target === 0 && L.target !== 0) L.zeroAt = now;
  L.target = target;
}

function applyAmbience() {
  dirty = false;
  const now = ctx.currentTime;
  let sum = 0, sq = 0;
  const cs = {};
  for (const k of MACHINES) { const c = curve(levels[k]); cs[k] = c; sum += c; sq += c * c; }
  // keep total power roughly bounded when many machine types are active at once
  norm = 1 / Math.sqrt(Math.max(1, sq / 2));
  quiet = clamp(1 - sum / 1.2, 0, 1);
  for (const k of MACHINES) setLayer(LAYERS[k], cs[k] * LAYERS[k].gain * norm, now, num(levels[k], 0));
  setLayer(LAYERS.wind, quiet * LAYERS.wind.gain, now);
}

// ------------------------------------------------------------------ scheduled ambient one-shots

function insTick(t) {
  const v = newVoice(amb, 0.55 * norm * (0.7 + 0.3 * R()), (R() * 2 - 1) * 0.7, ambBus);
  if (!v) return;
  nz(v, t, { f: 2200 + R() * 1400, q: 3, a: 0.001, d: 0.018, g: 1.6 });
  if (R() < 0.3) nz(v, t + 0.06, { f: 1600 + R() * 800, q: 3, a: 0.001, d: 0.015, g: 1.1 });
  finishBuild(v);
}

function bird(t, lvl) {
  const v = newVoice(amb, 1, (R() * 2 - 1) * 0.8, natureBus);
  if (!v) return;
  const osc = reg(v, ctx.createOscillator()), g = reg(v, ctx.createGain());
  const f0 = 2600 + R() * 1800, peak = 0.05 * lvl * (0.5 + R() * 0.5);
  let ts = t;
  g.gain.setValueAtTime(0.0001, t);
  for (let i = 2 + Math.floor(R() * 4); i > 0; i--) {
    const dur = 0.05 + R() * 0.06;
    osc.frequency.setValueAtTime(f0 * (0.9 + R() * 0.2), ts);
    osc.frequency.exponentialRampToValueAtTime(f0 * (R() < 0.5 ? 1.25 : 0.8), ts + dur);
    g.gain.setValueAtTime(0.0001, ts);
    g.gain.linearRampToValueAtTime(peak, ts + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, ts + dur);
    ts += dur + 0.03 + R() * 0.05;
  }
  wire(osc, g, v.out);
  run(v, osc, t, ts + 0.02);
}

function cricket(t, lvl, f, pan) {
  const v = newVoice(amb, 1, pan, natureBus);
  if (!v) return;
  const osc = reg(v, ctx.createOscillator()), g = reg(v, ctx.createGain());
  osc.frequency.value = f;
  const peak = 0.02 * lvl;
  g.gain.setValueAtTime(0.0001, t);
  let tp = t;
  for (let i = 3 + (R() < 0.5 ? 1 : 0); i > 0; i--, tp += 0.04) {
    g.gain.setValueAtTime(0.0001, tp);
    g.gain.linearRampToValueAtTime(peak, tp + 0.004);
    g.gain.linearRampToValueAtTime(0.0001, tp + 0.016);
  }
  wire(osc, g, v.out);
  run(v, osc, t, tp + 0.02);
}

function scheduleNature(now) {
  const horizon = now + 0.25;
  const n = num(levels.inserters, 0);
  if (n > 0) {
    const rate = Math.min(8, 1.4 * Math.log(1 + n)); // ticks per second
    if (nextIns < now) nextIns = now + 0.05 + R() / rate;
    while (nextIns < horizon) { insTick(nextIns); nextIns += (0.5 + R()) / rate; }
  }
  const birdLvl = clamp((daylight - 0.25) / 0.5, 0, 1) * quiet;
  if (birdLvl > 0.02) {
    if (nextBird < now) nextBird = now + 0.5 + R() * 3;
    while (nextBird < horizon) { bird(nextBird, birdLvl); nextBird += (1.5 + R() * 4) / Math.max(0.3, birdLvl); }
  }
  const crLvl = clamp((0.45 - daylight) / 0.35, 0, 1) * (0.5 + 0.5 * quiet);
  if (crLvl > 0.02) {
    for (let i = 0; i < 2; i++) {
      if (nextCricket[i] < now) nextCricket[i] = now + R();
      while (nextCricket[i] < horizon) {
        cricket(nextCricket[i], crLvl, i ? 4750 : 4300, i ? 0.6 : -0.5);
        nextCricket[i] += 0.55 + R() * 0.35;
      }
    }
  }
}

function tick() {
  try {
    if (!ctx || ctx.state !== 'running' || muted) return;
    const now = ctx.currentTime;
    if (dirty) applyAmbience();
    for (const L of Object.values(LAYERS)) {
      if (L.built && L.target === 0 && now - L.zeroAt > 4) teardown(L);
    }
    scheduleNature(now);
  } catch { /* never throw from the timer */ }
}

// ------------------------------------------------------------------ context lifecycle

function applyMaster() {
  if (!ctx) return;
  master.gain.setTargetAtTime(muted || hidden() ? 0 : volume, ctx.currentTime, 0.03);
}

// Resume when we should be audible; fade out then suspend when muted/hidden (saves battery).
function syncRun() {
  if (!ctx) return;
  clearTimeout(suspendTimer);
  applyMaster();
  if (wantRunning()) {
    if (ctx.state !== 'running') resume();
  } else if (ctx.state === 'running') {
    suspendTimer = setTimeout(() => { if (!wantRunning()) ctx.suspend().catch(noop); }, 200);
  }
}

// iOS can leave the context 'interrupted' (calls, Siri, other apps); retry on the next gesture.
function onGesture() {
  if (ctx && wantRunning() && ctx.state !== 'running') resume();
}

function resume() {
  resumeAt = performance.now();
  ctx.resume().catch(noop);
}

function init() {
  try { ctx = new Ctx({ latencyHint: 'interactive' }); } catch { try { ctx = new Ctx(); } catch { ctx = null; return; } }
  try {
    // iOS 17+: mix with the user's music and respect the silent switch, like native games
    if (navigator.audioSession) navigator.audioSession.type = 'ambient';
  } catch { /* unsupported */ }
  try {
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 3;
    comp.attack.value = 0.004; comp.release.value = 0.2;
    master = ctx.createGain(); master.gain.value = muted ? 0 : volume;
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.6;
    ambBus = ctx.createGain(); ambBus.gain.value = 0.7;
    natureBus = ctx.createGain(); natureBus.gain.value = 0.5;
    sfxBus.connect(master); ambBus.connect(master); natureBus.connect(master);
    master.connect(comp); comp.connect(ctx.destination);
    bufs = makeBuffers(ctx);
    ctx.onstatechange = () => { if (wantRunning() && ctx.state !== 'running' && !hidden()) ctx.resume().catch(noop); };
    for (const ev of ['touchend', 'click', 'keydown', 'pointerup']) window.addEventListener(ev, onGesture, { capture: true, passive: true });
    document.addEventListener('visibilitychange', syncRun);
    window.addEventListener('pageshow', syncRun);
    setInterval(tick, 100);
  } catch {
    try { ctx.close(); } catch { /* ignore */ }
    ctx = null;
  }
}

export const audio = {
  unlock() {
    try {
      if (!Ctx) return;
      if (!ctx) init();
      if (!ctx) return;
      if (!unlocked) {
        unlocked = true;
        // older iOS needs a sound started inside the gesture
        const s = ctx.createBufferSource();
        s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        s.connect(ctx.destination);
        s.onended = () => s.disconnect();
        s.start(0);
      }
      syncRun();
      dirty = true;
    } catch { /* silent */ }
  },

  play(name, opts) {
    try {
      if (!ctx || !wantRunning()) return false;
      // allow sounds queued in the same gesture that resumed the context; drop stale ones otherwise
      if (ctx.state !== 'running' && !(ctx.state === 'suspended' && performance.now() - resumeAt < 300)) return false;
      const fn = SOUNDS[name];
      if (!fn) return false;
      const now = ctx.currentTime;
      if (now - (lastPlayed[name] ?? -1e9) < (MIN_GAP[name] ?? DEFAULT_GAP)) return false;
      const o = opts || {};
      let vol = clamp(num(o.volume, 1), 0, 2);
      let pitch = clamp(num(o.pitch, 1), 0.25, 4);
      const j = JITTER[name];
      if (j) { pitch *= 1 + (R() * 2 - 1) * j; vol *= 1 - R() * 0.12; }
      if (vol <= 0) return false;
      const v = newVoice(sfx, vol, clamp(num(o.pan, 0), -1, 1), sfxBus);
      if (!v) return false; // voice cap reached: drop
      lastPlayed[name] = now;
      try { fn(v, now + 0.005, pitch); } catch { /* partial voice still cleans up */ }
      finishBuild(v);
      return true;
    } catch { return false; }
  },

  setAmbience(lv) {
    try {
      levels = { ...(lv || {}) };
      dirty = true;
    } catch { /* silent */ }
  },

  setMasterVolume(v) {
    try { volume = clamp(num(v, volume), 0, 1); applyMaster(); } catch { /* silent */ }
  },

  setMuted(b) {
    try { muted = !!b; syncRun(); } catch { /* silent */ }
  },

  get muted() { return muted; },

  setDaylight(d) {
    try { daylight = clamp(num(d, daylight), 0, 1); dirty = true; } catch { /* silent */ }
  },

  // Diagnostics for tools/audio-test.html.
  debugStats() {
    const layers = Object.keys(LAYERS).filter((k) => LAYERS[k].built);
    return {
      state: ctx ? ctx.state : 'none', voices: sfx.set.size, ambShots: amb.set.size,
      liveNodes, layers, norm, quiet, sampleRate: ctx ? ctx.sampleRate : 0,
    };
  },
  debugMeter() {
    try {
      if (!ctx) return null;
      if (!analyser) {
        analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
        comp.connect(analyser);
        meterData = new Float32Array(analyser.fftSize);
      }
      analyser.getFloatTimeDomainData(meterData);
      let s = 0, pk = 0;
      for (let i = 0; i < meterData.length; i++) { const x = meterData[i]; s += x * x; pk = Math.max(pk, Math.abs(x)); }
      return { rms: Math.sqrt(s / meterData.length), peak: pk };
    } catch { return null; }
  },
};
