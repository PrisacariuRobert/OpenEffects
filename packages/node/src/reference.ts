import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { registerFonts } from "./canvas.ts";
import { probeMedia } from "./media.ts";
import { ffmpegPath } from "./render.ts";

/*
 * References: an image or a short clip the user wants the agent to take after. Clips become
 * a contact sheet of evenly spaced, time-stamped frames, so any agent that can look at an
 * image (through oe_view_reference) can study pacing and transitions, not just one still.
 */

export interface ReferenceSheet {
  /** PNG to show the agent. */
  file: string;
  kind: "image" | "video";
  /** Clip length in seconds (videos). */
  duration?: number;
  /** Times of the frames on the sheet, left to right, top to bottom (videos). */
  times?: number[];
  width: number;
  height: number;
}

const VIDEO = /\.(mp4|mov|m4v|webm|gif|mkv)$/i;

function grab(file: string, t: number, out: string): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(ffmpegPath(), ["-v", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", out], (err) => (err ? reject(err) : resolve())),
  );
}

/** Builds the reference sheet for an image or a clip (6 frames by default). */
export async function referenceSheet(input: string, out: string, opts: { frames?: number } = {}): Promise<ReferenceSheet> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (!VIDEO.test(input)) {
    const img = await loadImage(fs.readFileSync(input));
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    fs.writeFileSync(out, c.toBuffer("image/png"));
    return { file: out, kind: "image", width: c.width, height: c.height };
  }
  const info = await probeMedia(input);
  const n = Math.max(2, Math.min(12, opts.frames ?? 6));
  const duration = info.duration || 1;
  const times = Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n) * duration * 100) / 100);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oe-ref-"));
  try {
    const frames = [];
    for (const [i, t] of times.entries()) {
      const f = path.join(tmp, `${i}.png`);
      await grab(input, t, f);
      frames.push(await loadImage(fs.readFileSync(f)));
    }
    registerFonts();
    const cols = n <= 4 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    const w = frames[0].width;
    const h = frames[0].height;
    const pad = 8;
    const c = createCanvas(cols * w + (cols + 1) * pad, rows * h + (rows + 1) * pad);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, c.width, c.height);
    frames.forEach((img, i) => {
      const x = pad + (i % cols) * (w + pad);
      const y = pad + Math.floor(i / cols) * (h + pad);
      ctx.drawImage(img, x, y, w, h);
      const label = `${i + 1} · ${times[i].toFixed(2)}s`;
      ctx.font = "600 18px Inter, sans-serif";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(x + 6, y + 6, tw + 14, 28);
      ctx.fillStyle = "#ffd60a";
      ctx.fillText(label, x + 13, y + 26);
    });
    fs.writeFileSync(out, c.toBuffer("image/png"));
    return { file: out, kind: "video", duration, times, width: c.width, height: c.height };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The instruction added in front of the user's prompt when a reference is attached. */
export function referencePrompt(relFile: string, sheet: Pick<ReferenceSheet, "kind" | "duration" | "times">, name: string): string {
  const what =
    sheet.kind === "video"
      ? `a contact sheet of ${sheet.times?.length} frames from the ${sheet.duration?.toFixed(1)}s clip "${name}" at ${sheet.times?.map((t) => `${t}s`).join(", ")} (left to right, top to bottom)`
      : `the image "${name}"`;
  return `[Reference: call oe_view_reference with file "${relFile}" to see ${what}. Take after its style${sheet.kind === "video" ? " and motion: pacing, transitions, how things enter and leave" : ""}: palette, typography, layout and mood. Don't copy its logos or text unless asked.]`;
}
