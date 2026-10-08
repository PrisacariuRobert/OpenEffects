import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { renderFrame } from "@openeffects/engine";
import { getComp, type Project } from "@openeffects/schema";
import { createNodeEnv } from "./canvas.ts";

export interface FrameOptions {
  time: number;
  compId?: string;
  /** Output width in pixels (height follows the aspect ratio). Default: composition width. */
  width?: number;
  /** Fill transparent areas with this color (e.g. "#000"). Default: keep transparency. */
  matte?: string;
}

export async function renderFramePng(project: Project, projectDir: string, opts: FrameOptions): Promise<Buffer> {
  const comp = getComp(project, opts.compId);
  const scale = opts.width ? opts.width / comp.width : 1;
  const env = await createNodeEnv(project, projectDir);
  const w = Math.max(1, Math.round(comp.width * scale));
  const h = Math.max(1, Math.round(comp.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  renderFrame(ctx, project, { compId: comp.id, time: clampTime(opts.time, comp.duration), scale }, env);
  if (opts.matte) {
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = opts.matte;
    ctx.fillRect(0, 0, w, h);
  }
  return canvas.encode("png");
}

function clampTime(t: number, duration: number): number {
  return Math.max(0, Math.min(t, duration - 1e-6));
}

export interface ContactSheetOptions {
  compId?: string;
  count?: number;
  columns?: number;
  cellWidth?: number;
  times?: number[];
}

/** A grid of frames spread across the timeline, labelled with their times. */
export async function renderContactSheet(project: Project, projectDir: string, opts: ContactSheetOptions = {}): Promise<Buffer> {
  const comp = getComp(project, opts.compId);
  const count = opts.times?.length ?? Math.max(1, Math.min(24, opts.count ?? 8));
  const times =
    opts.times ?? Array.from({ length: count }, (_, i) => (count === 1 ? 0 : (i / (count - 1)) * (comp.duration - 1 / comp.fps)));
  const columns = Math.max(1, Math.min(opts.columns ?? 4, times.length));
  const rows = Math.ceil(times.length / columns);
  const cellW = opts.cellWidth ?? 400;
  const scale = cellW / comp.width;
  const cellH = Math.round(comp.height * scale);
  const label = 22;
  const gap = 6;
  const sheet = createCanvas(columns * (cellW + gap) + gap, rows * (cellH + label + gap) + gap);
  const sctx = sheet.getContext("2d");
  sctx.fillStyle = "#1b1d24";
  sctx.fillRect(0, 0, sheet.width, sheet.height);

  const env = await createNodeEnv(project, projectDir);
  const cell = createCanvas(cellW, cellH);
  const cctx = cell.getContext("2d") as unknown as CanvasRenderingContext2D;
  times.forEach((t, i) => {
    renderFrame(cctx, project, { compId: comp.id, time: clampTime(t, comp.duration), scale }, env);
    const x = gap + (i % columns) * (cellW + gap);
    const y = gap + Math.floor(i / columns) * (cellH + label + gap);
    drawChecker(sctx as unknown as CanvasRenderingContext2D, x, y + label, cellW, cellH);
    sctx.drawImage(cell, x, y + label);
    sctx.fillStyle = "#c8ccd8";
    sctx.font = "600 14px Inter, sans-serif";
    sctx.fillText(`t = ${t.toFixed(2)}s`, x + 2, y + 16);
  });
  return sheet.encode("png");
}

function drawChecker(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const s = 10;
  ctx.fillStyle = "#2a2d36";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#33363f";
  for (let yy = 0; yy < h; yy += s)
    for (let xx = (yy / s) % 2 === 0 ? 0 : s; xx < w; xx += s * 2) ctx.fillRect(x + xx, y + yy, Math.min(s, w - xx), Math.min(s, h - yy));
}

export type ExportFormat = "mp4" | "webm" | "gif" | "mov" | "png";

export interface ExportOptions {
  out: string;
  format?: ExportFormat;
  compId?: string;
  scale?: number;
  /** Limit the exported range (seconds). */
  start?: number;
  end?: number;
  onProgress?: (frame: number, total: number) => void;
  signal?: AbortSignal;
}

export function ffmpegPath(): string {
  return process.env.OE_FFMPEG || "ffmpeg";
}

function ffmpegArgs(format: Exclude<ExportFormat, "png">, w: number, h: number, fps: number, out: string): string[] {
  const input = ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w}x${h}`, "-r", String(fps), "-i", "-"];
  const even = "pad=ceil(iw/2)*2:ceil(ih/2)*2";
  switch (format) {
    case "mp4":
      return [...input, "-vf", even, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "18", "-movflags", "+faststart", out];
    case "webm":
      return [...input, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "30", "-row-mt", "1", out];
    case "mov":
      return [...input, "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", out];
    case "gif": {
      // 24 fps + one global palette + ordered dithering keeps GIFs small enough to share.
      const gifFps = Math.min(fps, 24);
      const filter = `fps=${gifFps},split[a][b];[a]palettegen=reserve_transparent=0:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
      return [...input, "-filter_complex", filter, "-loop", "0", out];
    }
  }
}

/** Renders a composition to a video file (via ffmpeg) or a PNG sequence. */
export async function exportVideo(project: Project, projectDir: string, opts: ExportOptions): Promise<{ file: string; frames: number }> {
  const comp = getComp(project, opts.compId);
  const format = opts.format ?? ((path.extname(opts.out).slice(1) || "mp4") as ExportFormat);
  const scale = opts.scale ?? 1;
  const w = Math.round(comp.width * scale);
  const h = Math.round(comp.height * scale);
  const start = Math.max(0, opts.start ?? 0);
  const end = Math.min(comp.duration, opts.end ?? comp.duration);
  const first = Math.round(start * comp.fps);
  const total = Math.max(1, Math.round(end * comp.fps) - first);
  const env = await createNodeEnv(project, projectDir);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  // Formats without alpha get composited onto black.
  const flatten = format === "mp4" || format === "gif";
  const flat = flatten ? createCanvas(w, h) : undefined;
  const fctx = flat?.getContext("2d");

  const frameAt = (i: number) => {
    renderFrame(ctx, project, { compId: comp.id, time: (first + i) / comp.fps, scale }, env);
    if (!fctx || !flat) return canvas;
    fctx.globalCompositeOperation = "source-over";
    fctx.fillStyle = "#000";
    fctx.fillRect(0, 0, w, h);
    fctx.drawImage(canvas, 0, 0);
    return flat;
  };

  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });

  if (format === "png") {
    fs.mkdirSync(opts.out, { recursive: true });
    for (let i = 0; i < total; i++) {
      if (opts.signal?.aborted) throw new Error("Export cancelled");
      fs.writeFileSync(path.join(opts.out, `frame_${String(i).padStart(5, "0")}.png`), await frameAt(i).encode("png"));
      opts.onProgress?.(i + 1, total);
    }
    return { file: opts.out, frames: total };
  }

  const ff = spawn(ffmpegPath(), ffmpegArgs(format, w, h, comp.fps, opts.out), { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  let closed = false;
  ff.stderr.on("data", (d) => (stderr += d));
  ff.stdin.on("error", () => {}); // EPIPE when ffmpeg dies; reported via the exit code below
  const exited = new Promise<number>((resolve, reject) => {
    ff.on("error", (e: NodeJS.ErrnoException) => {
      closed = true;
      reject(
        e.code === "ENOENT"
          ? new Error("ffmpeg not found. Install it (macOS: brew install ffmpeg, Windows: winget install ffmpeg, Linux: apt install ffmpeg) or set OE_FFMPEG.")
          : e,
      );
    });
    ff.on("close", (code) => {
      closed = true;
      resolve(code ?? 1);
    });
  });
  exited.catch(() => {});

  const write = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (closed) return reject(new Error(`ffmpeg exited early: ${stderr.trim()}`));
      if (ff.stdin.write(buf)) return resolve();
      const done = (err?: Error) => {
        ff.stdin.off("drain", onDrain);
        ff.off("close", onClose);
        ff.off("error", onClose);
        if (err) reject(err);
        else resolve();
      };
      const onDrain = () => done();
      const onClose = () => done(new Error(`ffmpeg exited early: ${stderr.trim()}`));
      ff.stdin.on("drain", onDrain);
      ff.on("close", onClose);
      ff.on("error", onClose);
    });

  try {
    for (let i = 0; i < total; i++) {
      if (opts.signal?.aborted) throw new Error("Export cancelled");
      // canvas.data() is premultiplied RGBA; exact for flattened (opaque) output, and
      // un-premultiplied below for formats that keep transparency.
      const data = Buffer.from(frameAt(i).data());
      if (!flatten) unpremultiply(data);
      await write(data);
      opts.onProgress?.(i + 1, total);
    }
  } catch (e) {
    ff.kill();
    // Prefer the spawn error (e.g. "ffmpeg not found") over the generic write failure.
    const spawnError = await exited.then(() => undefined, (err: Error) => err);
    throw spawnError ?? e;
  }
  ff.stdin.end();
  const code = await exited;
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr.trim()}`);
  return { file: opts.out, frames: total };
}

function unpremultiply(px: Buffer): void {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0 || a === 255) continue;
    const k = 255 / a;
    px[i] = Math.min(255, Math.round(px[i] * k));
    px[i + 1] = Math.min(255, Math.round(px[i + 1] * k));
    px[i + 2] = Math.min(255, Math.round(px[i + 2] * k));
  }
}
