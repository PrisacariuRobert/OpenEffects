import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { layoutText } from "@openeffects/engine";
import type { Composition, Layer } from "@openeffects/schema";
import { registerFonts } from "./canvas.ts";
import { ffmpegPath } from "./render.ts";

/*
 * Captions: a transcript (words with times) becomes word-timed caption layers.
 *
 * Transcripts come from subtitle files (SRT / WebVTT, timed per cue: words inside a cue are
 * spread by length) or from a local whisper.cpp install (timed per word). Nothing is sent to
 * a server.
 */

export interface Word {
  text: string;
  start: number; // seconds
  end: number;
}

export type CaptionStyle = "pop" | "karaoke" | "minimal";

export interface CaptionOptions {
  style?: CaptionStyle;
  /** Max characters per caption line. Default 32 (about 5–7 words). */
  maxChars?: number;
  /** Max seconds one caption stays up. Default 3.2. */
  maxDuration?: number;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  color?: string;
  /** Color of the word being spoken (karaoke) or of popped words' accent. */
  highlight?: string;
  /** Center of the caption line, in composition pixels. Default: lower third, centered. */
  position?: [number, number];
  /** Draw a rounded backdrop behind each line. Default true. */
  backdrop?: boolean;
  /** Seconds added to every word time (when the audio layer starts later). Default 0. */
  offset?: number;
  /** Prefix for layer ids. Default "cap". */
  idPrefix?: string;
}

// ---------------------------------------------------------------- parsing

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
function parseTime(s: string): number {
  const m = TIME.exec(s);
  if (!m) return NaN;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000);
}

/** Splits a cue's text into words timed by their share of the characters. */
function spreadCue(text: string, start: number, end: number): Word[] {
  const words = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const total = words.reduce((a, w) => a + w.length + 1, 0);
  const out: Word[] = [];
  let t = start;
  for (const w of words) {
    const d = ((end - start) * (w.length + 1)) / total;
    out.push({ text: w, start: round(t), end: round(t + d) });
    t += d;
  }
  return out;
}

/** SRT or WebVTT → words. */
export function parseSubtitles(src: string): Word[] {
  const words: Word[] = [];
  const blocks = src.replace(/\r/g, "").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->");
    const start = parseTime(a);
    const end = parseTime(b);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    words.push(...spreadCue(lines.slice(i + 1).join(" "), start, end));
  }
  return words;
}

/** whisper.cpp JSON output (`-oj`, with `--max-len 1 --split-on-word` for one word per segment). */
export function parseWhisperJson(json: unknown): Word[] {
  const segs = (json as { transcription?: { text: string; offsets: { from: number; to: number } }[] }).transcription ?? [];
  const words: Word[] = [];
  for (const s of segs) {
    const text = s.text.trim();
    if (!text) continue;
    const start = s.offsets.from / 1000;
    const end = s.offsets.to / 1000;
    if (text.includes(" ")) words.push(...spreadCue(text, start, end));
    else words.push({ text, start: round(start), end: round(end) });
  }
  return words;
}

/** Plain JSON transcript: [{ text|word, start, end }]. */
export function parseWordsJson(json: unknown): Word[] {
  if (!Array.isArray(json)) throw new Error("Expected an array of { text, start, end }");
  return json.map((w: { text?: string; word?: string; start: number; end: number }) => ({ text: String(w.text ?? w.word ?? "").trim(), start: Number(w.start), end: Number(w.end) })).filter((w) => w.text && w.end > w.start);
}

/** Reads a transcript file by its extension (.srt, .vtt, .json). */
export function readTranscript(file: string): Word[] {
  const raw = fs.readFileSync(file, "utf8");
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") {
    const json = JSON.parse(raw);
    return Array.isArray(json) ? parseWordsJson(json) : parseWhisperJson(json);
  }
  return parseSubtitles(raw);
}

// ---------------------------------------------------------------- transcription

export const whisperPath = () => process.env.OE_WHISPER || "whisper-cli";

/**
 * Transcribes an audio/video file with a local whisper.cpp (`whisper-cli`) and a ggml model
 * (OE_WHISPER_MODEL, or ~/.cache/openeffects/ggml-base.en.bin). Word-level timing.
 */
export async function transcribe(file: string, opts: { model?: string; language?: string } = {}): Promise<Word[]> {
  const model = opts.model ?? process.env.OE_WHISPER_MODEL ?? path.join(os.homedir(), ".cache", "openeffects", "ggml-base.en.bin");
  if (!fs.existsSync(model)) {
    throw new Error(
      `No speech model at ${model}. Install whisper.cpp (https://github.com/ggml-org/whisper.cpp) and download a model, e.g. ggml-base.en.bin, then set OE_WHISPER_MODEL. Or import an .srt/.vtt subtitle file instead.`,
    );
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oe-asr-"));
  try {
    const wav = path.join(tmp, "audio.wav");
    await run(ffmpegPath(), ["-v", "error", "-y", "-i", file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    const base = path.join(tmp, "out");
    await run(whisperPath(), ["-m", model, "-f", wav, "-oj", "-of", base, "--max-len", "1", "--split-on-word", "-l", opts.language ?? "auto", "-np"]).catch((e: Error) => {
      if (/ENOENT/.test(e.message)) throw new Error(`whisper.cpp is not installed (${whisperPath()} not found). Install it, or import an .srt/.vtt subtitle file instead.`);
      throw e;
    });
    return parseWhisperJson(JSON.parse(fs.readFileSync(`${base}.json`, "utf8")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, _out, stderr) => (err ? reject(new Error(`${err.message}${stderr ? `\n${String(stderr).slice(-400)}` : ""}`)) : resolve())),
  );
}

// ---------------------------------------------------------------- layout

/** Groups words into caption lines: by length, duration and pauses. */
export function groupWords(words: Word[], maxChars = 32, maxDuration = 3.2): Word[][] {
  const groups: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const len = cur.reduce((a, x) => a + x.text.length + 1, 0) + w.text.length;
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    const dur = cur.length ? w.end - cur[0].start : 0;
    const sentenceEnd = cur.length > 0 && /[.!?]$/.test(cur[cur.length - 1].text);
    if (cur.length && (len > maxChars || dur > maxDuration || gap > 0.6 || sentenceEnd)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
let measureCtx: CanvasRenderingContext2D | null = null;
function measurer(): CanvasRenderingContext2D {
  if (!measureCtx) {
    registerFonts();
    measureCtx = createCanvas(8, 8).getContext("2d") as unknown as CanvasRenderingContext2D;
  }
  return measureCtx;
}

/**
 * Caption layers for a composition: one null ("captions") to move them all, and per line a
 * backdrop plus one text layer per word, placed with measured glyph positions so words can
 * appear or light up exactly when they're spoken.
 */
export function captionLayers(words: Word[], comp: Pick<Composition, "width" | "height" | "duration">, opts: CaptionOptions = {}): Layer[] {
  const style = opts.style ?? "pop";
  const size = opts.fontSize ?? Math.round(Math.min(comp.width, comp.height) * 0.06);
  const family = opts.fontFamily ?? "Inter";
  const weight = opts.fontWeight ?? 800;
  const color = opts.color ?? "#ffffff";
  const highlight = opts.highlight ?? "#ffd60a";
  const [cx, cy] = opts.position ?? [comp.width / 2, comp.height * (comp.height > comp.width ? 0.7 : 0.82)];
  const prefix = opts.idPrefix ?? "cap";
  const offset = opts.offset ?? 0;
  const ctx = measurer();
  const layers: Layer[] = [{ id: `${prefix}-captions`, type: "null", name: "Captions", transform: { position: [cx, cy] } }];
  const font = { family, weight, size };

  groupWords(words, opts.maxChars ?? (comp.height > comp.width ? 22 : 32), opts.maxDuration ?? 3.2).forEach((group, gi) => {
    const start = Math.max(0, round(group[0].start + offset - 0.05));
    const next = group[group.length - 1].end + offset;
    const end = Math.min(comp.duration, round(next + 0.25));
    if (end <= start) return;
    const lineText = group.map((w) => w.text).join(" ");
    const layout = layoutText(ctx, { id: "m", type: "text", text: lineText, font } as never, 0);
    const timing = { ...(start > 0 ? { in: start } : {}), ...(end < comp.duration ? { out: end } : {}) };
    const enter = (t: number) => ({ keyframes: [{ t, v: 0, ease: "easeOutCubic" as const }, { t: round(t + 0.15), v: 100 }] });

    if (opts.backdrop !== false) {
      layers.push({
        id: `${prefix}-${gi}-bg`,
        type: "rect",
        parent: `${prefix}-captions`,
        size: [Math.round(layout.width + size * 0.9), Math.round(size * 1.55)],
        radius: Math.round(size * 0.35),
        fill: "rgba(0,0,0,0.55)",
        ...timing,
        transform: { position: [0, 0], opacity: enter(start) },
      } as Layer);
    }
    if (style === "minimal") {
      layers.push({ id: `${prefix}-${gi}`, type: "text", text: lineText, font, fill: color, parent: `${prefix}-captions`, ...timing, transform: { position: [0, 0], opacity: enter(start) } } as Layer);
      return;
    }
    // One layer per word, centered on its glyphs in the line's layout.
    let gIndex = 0;
    group.forEach((w, wi) => {
      const glyphs = layout.glyphs.slice(gIndex, gIndex + [...w.text].length);
      gIndex += [...w.text].length + 1; // the space
      if (!glyphs.length) return;
      const x0 = glyphs[0].x;
      const x1 = glyphs[glyphs.length - 1].x + glyphs[glyphs.length - 1].width;
      const ws = Math.max(start, round(w.start + offset));
      const pos: [number, number] = [round((x0 + x1) / 2), round(glyphs[0].y - layout.lines[0].y)];
      const base = { id: `${prefix}-${gi}-${wi}`, type: "text", text: w.text, font, parent: `${prefix}-captions`, ...timing } as const;
      if (style === "pop") {
        layers.push({
          ...base,
          fill: wi === group.length - 1 && /[!?]$/.test(w.text) ? highlight : color,
          transform: {
            position: pos,
            scale: { keyframes: [{ t: ws, v: 60, ease: "easeOutBack" }, { t: round(ws + 0.18), v: 100 }] },
            opacity: { keyframes: [{ t: ws, v: 0, ease: "easeOutCubic" }, { t: round(ws + 0.08), v: 100 }] },
          },
        } as Layer);
      } else {
        const we = Math.max(ws + 0.05, round(w.end + offset));
        layers.push({
          ...base,
          fill: { keyframes: [{ t: start, v: color, ease: "hold" }, { t: ws, v: highlight, ease: "hold" }, { t: we, v: color }] },
          transform: {
            position: pos,
            opacity: enter(start),
            scale: { keyframes: [{ t: ws, v: 100, ease: "easeOutBack" }, { t: round(ws + 0.12), v: 108, ease: "easeOutCubic" }, { t: we, v: 100 }] },
          },
        } as Layer);
      }
    });
  });
  // Text y is centered per layer; the line's own baseline offset cancels out.
  return layers;
}
