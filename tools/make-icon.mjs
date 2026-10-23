// Generates icon-180.png / icon-512.png (a gear over a conveyor stripe) without dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; for (let x = 0; x < size; x++) { const [r, g, b] = px(x / size, y / size); const o = y * (size * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function px(u, v) {
  let col = mix([40, 37, 38], [22, 20, 21], v);
  // belt stripe
  if (v > 0.72 && v < 0.9) { col = [44, 42, 40]; if (((u * 10 + v * 3) % 1) < 0.18) col = [70, 66, 60]; if (v < 0.735 || v > 0.885) col = [214, 160, 60]; }
  const dx = u - 0.5, dy = v - 0.44, r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
  const teeth = 0.27 + 0.045 * (Math.cos(a * 9) > 0.2 ? 1 : 0);
  if (r < teeth) { const sh = 0.75 + 0.35 * (-dy - dx) / 0.5; col = mix([200, 130, 45], [255, 205, 120], Math.max(0, Math.min(1, sh))); }
  if (r < 0.1) col = [40, 37, 38];
  if (r < teeth && r > teeth - 0.012) col = mix(col, [60, 35, 10], 0.6);
  return col;
}
writeFileSync('icon-180.png', png(180, px));
writeFileSync('icon-512.png', png(512, px));
console.log('ok');
