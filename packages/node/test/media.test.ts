import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it } from "vitest";
import type { Layer, Project } from "@openeffects/schema";
import { detectBeats, exportVideo, mixAudio, probeMedia, renderFramePng, waveform } from "../src/index.ts";

let hasFfmpeg = true;
try {
  execFileSync(process.env.OE_FFMPEG || "ffmpeg", ["-version"], { stdio: "ignore" });
  execFileSync(process.env.OE_FFPROBE || "ffprobe", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oe-media-"));
const ff = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);

function project(layers: Layer[], duration = 2): Project {
  return { version: 1, compositions: [{ id: "main", width: 64, height: 64, fps: 30, duration, background: "#000000", layers }] };
}

async function pixel(p: Project, t: number, x = 32, y = 32) {
  const img = await loadImage(await renderFramePng(p, dir, { time: t }));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data];
}
const isRed = (p: number[]) => p[0] > 200 && p[2] < 60;
const isBlue = (p: number[]) => p[2] > 200 && p[0] < 60;

describe.skipIf(!hasFfmpeg)("media", () => {
  beforeAll(() => {
    // 2 s video: 1 s red then 1 s blue.
    ff("-f", "lavfi", "-i", "color=c=red:s=64x64:d=1:r=30", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1:r=30", "-filter_complex", "concat=n=2:v=1:a=0", "-pix_fmt", "yuv420p", path.join(dir, "rb.mp4"));
    // 6 s click track at 120 BPM (a short 880 Hz burst every 0.5 s).
    ff("-f", "lavfi", "-i", "aevalsrc=if(lt(mod(t\\,0.5)\\,0.04)\\,0.9*sin(2*PI*880*t)*exp(-60*mod(t\\,0.5))\\,0):s=44100:d=6", "-c:a", "pcm_s16le", path.join(dir, "clicks.wav"));
  });

  it("probes media", async () => {
    const v = await probeMedia(path.join(dir, "rb.mp4"));
    expect(v).toMatchObject({ width: 64, height: 64, hasVideo: true, hasAudio: false });
    expect(v.duration).toBeCloseTo(2, 1);
    const a = await probeMedia(path.join(dir, "clicks.wav"));
    expect(a).toMatchObject({ hasVideo: false, hasAudio: true });
  });

  it("renders the right video frame for time, trim, speed and loop", async () => {
    const video = (extra: Partial<Extract<Layer, { type: "video" }>> = {}): Layer => ({ id: "v", type: "video", src: path.join(dir, "rb.mp4"), ...extra });
    expect(isRed(await pixel(project([video()]), 0.5))).toBe(true);
    expect(isBlue(await pixel(project([video()]), 1.5))).toBe(true);
    expect(isBlue(await pixel(project([video({ trimStart: 1 })]), 0.2))).toBe(true);
    expect(isBlue(await pixel(project([video({ speed: 2 })]), 0.6))).toBe(true); // source 1.2 s
    expect(isRed(await pixel(project([video({ loop: true })], 4), 2.4))).toBe(true); // looped back to 0.4 s
  });

  it("finds the tempo and beats of a click track", async () => {
    const b = await detectBeats(path.join(dir, "clicks.wav"));
    expect(b.bpm).toBeGreaterThan(115);
    expect(b.bpm).toBeLessThan(125);
    expect(b.onsets.length).toBeGreaterThanOrEqual(10);
    expect(b.beats[0]).toBe(0);
    const gaps = b.beats.slice(1).map((t, i) => t - b.beats[i]);
    for (const g of gaps) expect(g).toBeCloseTo(0.5, 1);
    for (const t of b.beats) expect(Math.min(t % 0.5, 0.5 - (t % 0.5))).toBeLessThan(0.005); // on the clicks
  });

  it("keeps the beat grid exact when the music starts late after a stray hit", async () => {
    // A lone hit at 0.2 s, silence, then 120 BPM clicks from 4 s (like a soft intro before the drop).
    const file = path.join(dir, "late-clicks.wav");
    ff("-f", "lavfi", "-i", "aevalsrc=if(lt(abs(t-0.2)\\,0.03)\\,0.5*sin(2*PI*300*t)\\,0)+if(gte(t\\,4)*lt(mod(t\\,0.5)\\,0.04)\\,0.9*sin(2*PI*880*t)*exp(-60*mod(t\\,0.5))\\,0):s=44100:d=12", "-c:a", "pcm_s16le", file);
    const b = await detectBeats(file);
    expect(b.bpm).toBeCloseTo(120, 0);
    for (const t of b.beats.filter((x) => x >= 4)) expect(Math.min(t % 0.5, 0.5 - (t % 0.5))).toBeLessThan(0.01);
  });

  it("computes waveform peaks", async () => {
    const w = await waveform(path.join(dir, "clicks.wav"), 50);
    expect(w.peaks.length).toBeGreaterThan(290);
    expect(Math.max(...w.peaks)).toBe(1);
  });

  it("mixes audio into exports, honoring mute", async () => {
    const audio: Layer = { id: "a", type: "audio", src: path.join(dir, "clicks.wav"), in: 0.5, volume: 80 };
    expect(await mixAudio(project([{ ...audio, muted: true }]), dir)).toBeNull();
    const wav = await mixAudio(project([audio]), dir);
    expect(wav && fs.statSync(wav).size).toBeGreaterThan(44 + 48000 * 4); // ~2 s stereo 16-bit
    const out = path.join(dir, "with-audio.mp4");
    await exportVideo(project([{ id: "v", type: "video", src: path.join(dir, "rb.mp4") }, audio]), dir, { out, format: "mp4" });
    const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", out]).toString().trim().split("\n");
    expect(streams.sort()).toEqual(["audio", "video"]);
  });
});
