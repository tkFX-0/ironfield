// Builds one PNG sheet of item / fluid / status icons for the DOM UI (CSS background sprites).
import { ITEMS, FLUIDS } from '../data.js';

const SZ = 64;
let sheet = null;

export function buildIconSheet(drawIcon) {
  const keys = [
    ...Object.keys(ITEMS).map(k => 'item:' + k),
    ...Object.keys(FLUIDS).map(k => 'fluid:' + k),
    'icon:no-power', 'icon:no-fuel', 'icon:output-full', 'icon:no-recipe', 'icon:no-input', 'icon:warning',
  ];
  const cols = 12, rows = Math.ceil(keys.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * SZ; c.height = rows * SZ;
  const ctx = c.getContext('2d');
  const pos = new Map();
  keys.forEach((k, i) => {
    const x = (i % cols) * SZ, y = Math.floor(i / cols) * SZ;
    ctx.save(); ctx.translate(x, y);
    ctx.beginPath(); ctx.rect(0, 0, SZ, SZ); ctx.clip();
    try { drawIcon(ctx, k, SZ); } catch (e) { ctx.fillStyle = '#a0a'; ctx.fillRect(8, 8, 48, 48); }
    ctx.restore();
    pos.set(k, [x, y]);
  });
  const url = c.toDataURL('image/png');
  sheet = { url, pos, w: c.width, h: c.height };
  const style = document.createElement('style');
  style.textContent = `.ic{background-image:url(${url});background-repeat:no-repeat;display:inline-block;flex:none}`;
  document.head.appendChild(style);
  return sheet;
}

// returns an element showing icon `key` at `size` css px
export function icon(key, size = 32, cls = '') {
  const el = document.createElement('span');
  el.className = 'ic ' + cls;
  setIcon(el, key, size);
  return el;
}
export function setIcon(el, key, size = 32) {
  if (!sheet) return;
  const p = sheet.pos.get(key) || sheet.pos.get('icon:warning');
  const k = size / SZ;
  el.style.width = size + 'px'; el.style.height = size + 'px';
  el.style.backgroundSize = `${sheet.w * k}px ${sheet.h * k}px`;
  el.style.backgroundPosition = `${-p[0] * k}px ${-p[1] * k}px`;
}
export function iconHTML(key, size = 32) {
  if (!sheet) return '';
  const p = sheet.pos.get(key) || sheet.pos.get('icon:warning');
  const k = size / SZ;
  return `<span class="ic" style="width:${size}px;height:${size}px;background-size:${sheet.w * k}px ${sheet.h * k}px;background-position:${-p[0] * k}px ${-p[1] * k}px"></span>`;
}
