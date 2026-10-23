// Small deterministic helpers shared by the simulation.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x, y, seed) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// FNV-1a style running hash over 32-bit ints
export class Hasher {
  constructor() { this.h = 2166136261 >>> 0; }
  n(v) {
    v = v | 0;
    this.h = Math.imul(this.h ^ (v & 0xff), 16777619);
    this.h = Math.imul(this.h ^ ((v >>> 8) & 0xff), 16777619);
    this.h = Math.imul(this.h ^ ((v >>> 16) & 0xff), 16777619);
    this.h = Math.imul(this.h ^ (v >>> 24), 16777619);
    return this;
  }
  s(str) {
    for (let i = 0; i < str.length; i++) this.h = Math.imul(this.h ^ str.charCodeAt(i), 16777619);
    return this;
  }
  get value() { return this.h >>> 0; }
}

export function bytesToB64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function streamBytes(stream) {
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}
// 1-byte header: 1 = gzip, 0 = raw (for browsers without CompressionStream)
export async function compress(bytes) {
  if (typeof CompressionStream === 'undefined') {
    const out = new Uint8Array(bytes.length + 1); out[0] = 0; out.set(bytes, 1); return out;
  }
  const z = await streamBytes(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')));
  const out = new Uint8Array(z.length + 1); out[0] = 1; out.set(z, 1); return out;
}
export async function decompress(bytes) {
  if (bytes[0] === 0) return bytes.subarray(1);
  return streamBytes(new Blob([bytes.subarray(1)]).stream().pipeThrough(new DecompressionStream('gzip')));
}
