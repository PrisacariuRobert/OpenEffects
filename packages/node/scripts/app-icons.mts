// Draws the app icons in apps/web/public (the ring logo on a dark tile). Run: pnpm tsx packages/node/scripts/app-icons.mts
import fs from "node:fs";
import { createCanvas } from "@napi-rs/canvas";

const out = new URL("../../../apps/web/public/", import.meta.url);
const STOPS = ["#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f", "#ff9f0a", "#0a84ff"];

function icon(size: number, { maskable = false, tile = true } = {}): Buffer {
  const c = createCanvas(size, size);
  const ctx = c.getContext("2d");
  if (tile) {
    ctx.fillStyle = "#111113";
    if (maskable) ctx.fillRect(0, 0, size, size);
    else {
      ctx.beginPath();
      ctx.roundRect(0, 0, size, size, size * 0.225);
      ctx.fill();
    }
  }
  // Maskable icons keep the logo inside the central 80% safe zone.
  const r = size * (maskable ? 0.26 : tile ? 0.31 : 0.46);
  const g = ctx.createConicGradient((210 * Math.PI) / 180 - Math.PI / 2, size / 2, size / 2);
  STOPS.forEach((s, i) => g.addColorStop(i / (STOPS.length - 1), s));
  ctx.strokeStyle = g;
  ctx.lineWidth = r * 0.36;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, r - ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.stroke();
  return c.toBuffer("image/png");
}

fs.writeFileSync(new URL("icon-192.png", out), icon(192));
fs.writeFileSync(new URL("icon-512.png", out), icon(512));
fs.writeFileSync(new URL("icon-maskable-512.png", out), icon(512, { maskable: true }));
fs.writeFileSync(new URL("apple-touch-icon.png", out), icon(180, { maskable: true }));
fs.writeFileSync(new URL("favicon.png", out), icon(64, { tile: false }));
console.log("icons written");
