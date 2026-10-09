import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createCanvas, ImageData, type Canvas } from "@napi-rs/canvas";
import { isActive } from "@openeffects/engine";
import { getComp, isMediaLayer, mediaSourceTime, sample, type Composition, type Project } from "@openeffects/schema";
import { ffmpegPath } from "./render.ts";

/*
 * Media support via the user's ffmpeg/ffprobe: probing, video frame decoding for renders,
 * audio decoding/mixing for exports, waveform peaks and beat detection.
 */

export const ffprobePath = () => process.env.OE_FFPROBE || "ffprobe";

export interface ProbeInfo {
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

const cacheKey = (file: string) => {
  const st = fs.statSync(file);
  return `${file}|${st.mtimeMs}|${st.size}`;
};
const probeCache = new Map<string, ProbeInfo>();

export function probeMedia(file: string): Promise<ProbeInfo> {
  const key = cacheKey(file);
  const cached = probeCache.get(key);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath(),
      ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate,duration", "-of", "json", file],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`Cannot read media ${path.basename(file)}: ${(err as Error).message}`));
        const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number; r_frame_rate?: string; duration?: string }[] };
        const streams = data.streams ?? [];
        const v = streams.find((s) => s.codec_type === "video");
        const [num, den] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
        const info: ProbeInfo = {
          duration: Number(data.format?.duration ?? v?.duration ?? 0) || 0,
          width: v?.width,
          height: v?.height,
          fps: den ? num / den : undefined,
          hasVideo: !!v,
          hasAudio: streams.some((s) => s.codec_type === "audio"),
        };
        probeCache.set(key, info);
        resolve(info);
      },
    );
  });
}

/** Decode audio to interleaved float32 PCM. */
export function decodePcm(file: string, opts: { start?: number; duration?: number; rate?: number; channels?: number; tempo?: number } = {}): Promise<Float32Array> {
  const rate = opts.rate ?? 48000;
  const channels = opts.channels ?? 2;
  const args = ["-v", "error"];
  if (opts.start) args.push("-ss", String(opts.start));
  if (opts.duration !== undefined) args.push("-t", String(opts.duration));
  args.push("-i", file, "-vn");
  if (opts.tempo && Math.abs(opts.tempo - 1) > 1e-3) args.push("-af", atempoChain(opts.tempo));
  args.push("-f", "f32le", "-ac", String(channels), "-ar", String(rate), "-");
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    ff.stdout.on("data", (d: Buffer) => chunks.push(d));
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not decode ${path.basename(file)}: ${err.trim().split("\n").pop()}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
    });
  });
}

/** ffmpeg's atempo accepts 0.5–2 per stage; chain stages for other speeds. */
function atempoChain(speed: number): string {
  const parts: string[] = [];
  let s = speed;
  while (s > 2) {
    parts.push("atempo=2");
    s /= 2;
  }
  while (s < 0.5) {
    parts.push("atempo=0.5");
    s /= 0.5;
  }
  parts.push(`atempo=${s.toFixed(5)}`);
  return parts.join(",");
}

// ---------- waveform & beats ----------

const waveCache = new Map<string, { duration: number; perSecond: number; peaks: number[] }>();

/** Peak amplitude per 1/perSecond seconds, normalized to 0–1 (for timeline waveforms). */
export async function waveform(file: string, perSecond = 50): Promise<{ duration: number; perSecond: number; peaks: number[] }> {
  const key = `${cacheKey(file)}|${perSecond}`;
  const cached = waveCache.get(key);
  if (cached) return cached;
  const rate = 8000;
  const pcm = await decodePcm(file, { rate, channels: 1 });
  const bucket = Math.max(1, Math.round(rate / perSecond));
  const peaks: number[] = [];
  let max = 1e-6;
  for (let i = 0; i < pcm.length; i += bucket) {
    let p = 0;
    for (let j = i; j < Math.min(pcm.length, i + bucket); j++) p = Math.max(p, Math.abs(pcm[j]));
    peaks.push(p);
    max = Math.max(max, p);
  }
  const result = { duration: pcm.length / rate, perSecond, peaks: peaks.map((p) => Math.round((p / max) * 1000) / 1000) };
  waveCache.set(key, result);
  return result;
}

/**
 * One video frame as a JPEG, for previews in browsers that cannot decode the file
 * (e.g. ProRes, or H.264 in builds without proprietary codecs).
 */
export function videoFrameJpeg(file: string, time: number, maxWidth = 1280): Promise<Buffer> {
  const args = ["-v", "error", "-ss", String(Math.max(0, time)), "-i", file, "-frames:v", "1", "-vf", `scale='min(${maxWidth},iw)':-2`, "-q:v", "4", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"];
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err || !stdout.length) reject(new Error(`Could not read a frame of ${path.basename(file)}: ${String(stderr || err?.message || "no frame").trim()}`));
      else resolve(stdout);
    });
  });
}

export interface BeatInfo {
  duration: number;
  /** Estimated tempo, or null when the audio has no clear pulse. */
  bpm: number | null;
  /** A regular beat grid at the estimated tempo, aligned to the strongest hits (seconds into the file). */
  beats: number[];
  /** Individual detected hits/onsets (seconds into the file). */
  onsets: number[];
}

const beatCache = new Map<string, BeatInfo>();

/**
 * Energy-based onset detection, tempo by autocorrelation of the onset strength, and a beat
 * grid phase-aligned to the onsets. Good for music with a clear pulse; deterministic.
 */
export async function detectBeats(file: string): Promise<BeatInfo> {
  const key = cacheKey(file);
  const cached = beatCache.get(key);
  if (cached) return cached;
  const rate = 22050;
  const pcm = await decodePcm(file, { rate, channels: 1 });
  const result = analyzeBeats(pcm, rate);
  beatCache.set(key, result);
  return result;
}

/**
 * Exact start of a hit detected in the analysis frame starting at sample `at`: the first
 * millisecond where the short-time loudness climbs a third of the way from the level just
 * before the hit to the hit's peak. Frame-level detection alone is late by up to a window.
 */
function refineOnset(pcm: Float32Array, rate: number, at: number, win: number, hop: number): number {
  const block = Math.max(1, Math.round(rate / 1000));
  const r0 = Math.max(0, at - hop);
  const r1 = Math.min(pcm.length, at + win + hop);
  const rms = (a: number) => {
    let e = 0;
    const b = Math.min(pcm.length, a + block);
    for (let j = a; j < b; j++) e += pcm[j] * pcm[j];
    return Math.sqrt(e / Math.max(1, b - a));
  };
  const env: number[] = [];
  for (let a = r0; a < r1; a += block) env.push(rms(a));
  if (!env.length) return at / rate;
  let peak = 0;
  let peakAt = 0;
  env.forEach((v, k) => {
    if (v > peak) {
      peak = v;
      peakAt = k;
    }
  });
  // Level before the hit: the quietest stretch leading up to the peak.
  let base = Infinity;
  for (let k = 0; k <= peakAt; k++) base = Math.min(base, env[k]);
  const threshold = base + (peak - base) / 3;
  let k = peakAt;
  while (k > 0 && env[k - 1] >= threshold) k--;
  return (r0 + k * block) / rate;
}

export function analyzeBeats(pcm: Float32Array, rate: number): BeatInfo {
  const hop = 512;
  const win = 1024;
  const hopSec = hop / rate;
  const n = Math.max(0, Math.floor((pcm.length - win) / hop));
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (let j = i * hop; j < i * hop + win; j++) e += pcm[j] * pcm[j];
    energy[i] = Math.log1p(1000 * Math.sqrt(e / win));
  }
  // Onset strength: rise of energy above its recent average.
  const strength = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    let avg = 0;
    const k0 = Math.max(0, i - 8);
    for (let k = k0; k < i; k++) avg += energy[k];
    avg /= i - k0;
    strength[i] = Math.max(0, energy[i] - avg);
  }
  const maxS = Math.max(1e-9, ...strength);
  for (let i = 0; i < n; i++) strength[i] /= maxS;

  // Peak picking with an adaptive threshold and a minimum gap.
  const onsets: number[] = [];
  const minGap = Math.round(0.1 / hopSec);
  const span = Math.round(1 / hopSec);
  let last = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    if (strength[i] < strength[i - 1] || strength[i] < strength[i + 1]) continue;
    let mean = 0;
    const a = Math.max(0, i - span);
    const b = Math.min(n, i + span);
    for (let k = a; k < b; k++) mean += strength[k];
    mean /= b - a;
    if (strength[i] > mean * 1.5 + 0.08 && i - last >= minGap) {
      onsets.push(Math.round(refineOnset(pcm, rate, i * hop, win, hop) * 1000) / 1000);
      last = i;
    }
  }

  const duration = pcm.length / rate;
  if (onsets.length < 4) return { duration, bpm: null, beats: onsets, onsets };

  // Tempo: autocorrelation of onset strength over 70–180 BPM.
  let bestLag = 0;
  let best = -1;
  const minLag = Math.round(60 / 180 / hopSec);
  const maxLag = Math.round(60 / 70 / hopSec);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += strength[i] * strength[i + lag];
    sum /= n - lag;
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  // Refine with the onsets themselves. Anchor the grid on the onset most others agree with
  // (stray hits, e.g. a soft intro, must not set the phase), number every onset by its beat
  // index, and fit time = phase + index × period by least squares, rejecting outliers.
  const approx = bestLag * hopSec;
  const inliers = (phase: number, period: number, tol: number) =>
    onsets.map((t) => ({ t, k: Math.round((t - phase) / period) })).filter((p) => Math.abs(p.t - phase - p.k * period) < period * tol);
  // The autocorrelation lag is whole analysis frames (~23 ms), too coarse over many beats:
  // search periods within ±4% and anchors for the grid that the most onsets agree with.
  let period = approx;
  let phase = onsets[0];
  let agree = -1;
  for (let p = approx * 0.96; p <= approx * 1.04; p += 0.0005) {
    for (const anchor of onsets) {
      let score = 0;
      for (const t of onsets) {
        const r = (t - anchor) / p;
        const d = (r - Math.round(r)) * p; // seconds off the grid
        score += Math.exp(-((d / 0.02) ** 2));
      }
      if (score > agree) {
        agree = score;
        period = p;
        phase = anchor;
      }
    }
  }
  for (const tol of [0.2, 0.12]) {
    const pts = inliers(phase, period, tol);
    if (pts.length < 3) break;
    const mk = pts.reduce((a, p) => a + p.k, 0) / pts.length;
    const mt = pts.reduce((a, p) => a + p.t, 0) / pts.length;
    const cov = pts.reduce((a, p) => a + (p.k - mk) * (p.t - mt), 0);
    const vk = pts.reduce((a, p) => a + (p.k - mk) ** 2, 0);
    if (vk <= 0) break;
    period = cov / vk;
    phase = mt - period * mk;
  }
  const bpm = Math.round((60 / period) * 10) / 10;
  const beats: number[] = [];
  // First beat: the earliest grid point at or (within rounding) just before time 0.
  const first = phase - Math.floor(phase / period + 0.02) * period;
  for (let t = first; t < duration; t += period) beats.push(Math.max(0, Math.round(t * 1000) / 1000));
  return { duration, bpm, beats, onsets };
}

// ---------- video frames ----------

interface Frame {
  canvas: Canvas;
  width: number;
  height: number;
}

/**
 * Streams decoded frames from one video at a fixed rate. Sequential requests (exports) reuse
 * the running decoder; jumps restart it at the requested time.
 */
export class VideoReader {
  private proc?: ChildProcessByStdio<null, Readable, null>;
  private start = 0;
  private next = 0; // index of the next frame the decoder will deliver
  private pending: Buffer = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private ended = false;
  private last?: Frame;
  readonly width: number;
  readonly height: number;

  constructor(
    private file: string,
    info: ProbeInfo,
    private rate: number,
    maxSize = 1920,
  ) {
    const w = info.width ?? 640;
    const h = info.height ?? 360;
    const s = Math.min(1, maxSize / Math.max(w, h));
    this.width = Math.max(2, Math.round((w * s) / 2) * 2);
    this.height = Math.max(2, Math.round((h * s) / 2) * 2);
  }

  private spawnAt(t: number) {
    this.proc?.kill("SIGKILL");
    this.start = t;
    this.next = 0;
    this.pending = Buffer.alloc(0);
    this.ended = false;
    const args = ["-v", "error", "-ss", String(t), "-i", this.file, "-an", "-vf", `fps=${this.rate},scale=${this.width}:${this.height}`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"];
    const proc = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "ignore"] });
    proc.stdout.on("data", (d: Buffer) => {
      this.pending = this.pending.length ? Buffer.concat([this.pending, d]) : d;
      this.wake();
    });
    proc.on("close", () => {
      this.ended = true;
      this.wake();
    });
    proc.on("error", () => {
      this.ended = true;
      this.wake();
    });
    this.proc = proc;
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private async readOne(): Promise<Buffer | null> {
    const size = this.width * this.height * 4;
    while (this.pending.length < size) {
      if (this.ended) return null;
      await new Promise<void>((r) => this.waiters.push(r));
    }
    const out = Buffer.from(this.pending.subarray(0, size));
    this.pending = this.pending.subarray(size);
    this.next++;
    return out;
  }

  async frameAt(t: number): Promise<Frame | undefined> {
    const target = Math.round((t - this.start) * this.rate);
    if (!this.proc || target < this.next - 1 || target - this.next > this.rate * 2) {
      this.spawnAt(Math.max(0, t));
      return this.frameAt(t);
    }
    if (target === this.next - 1 && this.last) return this.last;
    let data: Buffer | null = null;
    while (this.next <= target) {
      data = await this.readOne();
      if (!data) break;
    }
    if (data) {
      const canvas = this.last?.canvas ?? createCanvas(this.width, this.height);
      canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), this.width, this.height), 0, 0);
      this.last = { canvas, width: this.width, height: this.height };
    }
    return this.last;
  }

  dispose() {
    this.proc?.kill("SIGKILL");
    this.proc = undefined;
  }
}

/** Video frames for the Node renderer: call `prepare(t)` before rendering frame t. */
export class NodeVideoSource {
  private info = new Map<string, ProbeInfo>();
  private readers = new Map<string, VideoReader>();
  private frames = new Map<string, Canvas>();

  constructor(
    private project: Project,
    private projectDir: string,
  ) {}

  async init(): Promise<void> {
    const srcs = new Set<string>();
    for (const c of this.project.compositions) for (const l of c.layers) if (l.type === "video") srcs.add(l.src);
    for (const src of srcs) {
      try {
        this.info.set(src, await probeMedia(path.resolve(this.projectDir, src)));
      } catch {
        // missing or unreadable: the layer renders as nothing
      }
    }
  }

  static key = (src: string, t: number) => `${src}@${t.toFixed(4)}`;

  /** Decode the frames every active video layer needs at composition time t (recursing into precomps). */
  async prepare(t: number, compId?: string, depth = 0): Promise<void> {
    if (depth === 0) this.frames.clear();
    if (depth > 8) return;
    const comp: Composition = getComp(this.project, compId);
    for (const l of comp.layers) {
      if (!isActive(l, comp, t)) continue;
      if (l.type === "comp") await this.prepare(l.timeRemap !== undefined ? sample(l.timeRemap, t, 0) : t - (l.in ?? 0) + (l.timeOffset ?? 0), l.comp, depth + 1);
      if (l.type !== "video") continue;
      const info = this.info.get(l.src);
      if (!info?.hasVideo) continue;
      const st = mediaSourceTime(l, t, info.duration);
      const rate = Math.min(120, comp.fps * (l.speed ?? 1));
      const rkey = `${l.src}|${rate}`;
      let reader = this.readers.get(rkey);
      if (!reader) this.readers.set(rkey, (reader = new VideoReader(path.resolve(this.projectDir, l.src), info, rate)));
      const f = await reader.frameAt(st);
      if (f) this.frames.set(NodeVideoSource.key(l.src, st), f.canvas);
    }
  }

  frame = (src: string, sourceTime: number) => this.frames.get(NodeVideoSource.key(src, sourceTime)) as never;

  infoOf = (src: string) => {
    const i = this.info.get(src);
    return i ? { width: i.width, height: i.height, duration: i.duration } : undefined;
  };

  dispose(): void {
    for (const r of this.readers.values()) r.dispose();
    this.readers.clear();
  }
}

// ---------- audio mix for exports ----------

/**
 * Mixes every audible audio/video layer of a composition into a 48 kHz stereo WAV covering
 * [start, end). Applies trim, speed and (keyframed) volume. Returns null when nothing is audible.
 */
export async function mixAudio(project: Project, projectDir: string, opts: { compId?: string; start?: number; end?: number } = {}): Promise<string | null> {
  const comp = getComp(project, opts.compId);
  const rate = 48000;
  const start = opts.start ?? 0;
  const end = opts.end ?? comp.duration;
  const total = Math.max(1, Math.round((end - start) * rate));
  const mix = new Float32Array(total * 2);
  let audible = false;

  for (const l of comp.layers) {
    if (!isMediaLayer(l) || l.muted) continue;
    const file = path.resolve(projectDir, l.src);
    let info: ProbeInfo;
    try {
      info = await probeMedia(file);
    } catch {
      continue;
    }
    if (!info.hasAudio) continue;
    const a = Math.max(start, l.in ?? 0);
    const b = Math.min(end, l.out ?? comp.duration);
    if (b <= a) continue;
    const speed = l.speed ?? 1;
    const src0 = mediaSourceTime(l, a);
    if (src0 >= info.duration) continue;
    const pcm = await decodePcm(file, { start: src0, duration: Math.min(info.duration - src0, (b - a) * speed), rate, channels: 2, tempo: speed });
    const offset = Math.round((a - start) * rate);
    const frames = Math.min(pcm.length / 2, total - offset);
    const block = 256;
    for (let i = 0; i < frames; i += block) {
      const vol = Math.max(0, Math.min(2, sample(l.volume, a + i / rate, 100) / 100));
      if (vol === 0) continue;
      const lim = Math.min(frames, i + block);
      for (let j = i; j < lim; j++) {
        mix[(offset + j) * 2] += pcm[j * 2] * vol;
        mix[(offset + j) * 2 + 1] += pcm[j * 2 + 1] * vol;
      }
    }
    audible = true;
  }
  if (!audible) return null;

  const out = path.join(os.tmpdir(), `openeffects-mix-${process.pid}-${Date.now()}.wav`);
  const data = Buffer.alloc(total * 4);
  for (let i = 0; i < total * 2; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix[i])) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(out, Buffer.concat([header, data]));
  return out;
}
