// Fallback art used only if sprites.js fails to load: flat coloured shapes.
export const TILE = 64;
export function registerSprites(add) {
  add('fx:light', 256, 256, (c) => { const g = c.createRadialGradient(128, 128, 0, 128, 128, 128); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(0, 0, 256, 256); });
}
export function drawIcon(ctx, key, size) {
  let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  ctx.fillStyle = `hsl(${h % 360},45%,55%)`;
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size * 0.36, 0, Math.PI * 2); ctx.fill();
}
export const WIRE_ANCHORS = {};
export const SMOKE_POINTS = {};
