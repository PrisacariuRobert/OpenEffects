import { resolveEase, sample, type TextAnimator } from "@openeffects/schema";
import type { TextLayer } from "./types.ts";

export interface Glyph {
  ch: string;
  x: number; // left edge, layer space
  y: number; // baseline, layer space
  width: number;
  line: number;
  word: number;
}

export interface TextLayout {
  glyphs: Glyph[];
  lines: { text: string; x: number; y: number; width: number }[];
  width: number;
  height: number;
  font: string;
}

const layoutCache = new Map<string, TextLayout>();

export function fontString(layer: TextLayer, t: number): { font: string; size: number } {
  const f = layer.font ?? {};
  const size = Math.max(1, sample(f.size, t, 96));
  const family = f.family ?? "Inter";
  return { font: `${f.style ?? "normal"} ${f.weight ?? 700} ${size}px "${family}", sans-serif`, size };
}

/** Lays out text centered on the layer origin. Positions are cached per font/text/spacing. */
export function layoutText(ctx: CanvasRenderingContext2D, layer: TextLayer, t: number): TextLayout {
  const { font, size } = fontString(layer, t);
  const ls = sample(layer.letterSpacing, t, 0);
  const align = layer.align ?? "center";
  const lh = size * (layer.lineHeight ?? 1.2);
  const key = `${font}|${ls}|${align}|${lh}|${layer.text}`;
  const cached = layoutCache.get(key);
  if (cached) return cached;

  ctx.save();
  ctx.font = font;
  if ("letterSpacing" in ctx) (ctx as { letterSpacing: string }).letterSpacing = "0px";
  const capHeight = ctx.measureText("H").actualBoundingBoxAscent || size * 0.7;
  const rawLines = layer.text.split("\n");
  const measured = rawLines.map((line) => {
    const chars = [...line];
    const xs: number[] = [];
    let prefix = "";
    for (let i = 0; i < chars.length; i++) {
      xs.push(ctx.measureText(prefix).width + i * ls);
      prefix += chars[i];
    }
    const width = chars.length ? ctx.measureText(line).width + (chars.length - 1) * ls : 0;
    const widths = chars.map((c) => ctx.measureText(c).width);
    return { line, chars, xs, widths, width };
  });
  ctx.restore();

  const maxWidth = Math.max(0, ...measured.map((m) => m.width));
  const height = rawLines.length * lh;
  const glyphs: Glyph[] = [];
  const lines: TextLayout["lines"] = [];
  let word = 0;
  measured.forEach((m, li) => {
    const x0 = align === "left" ? -maxWidth / 2 : align === "right" ? maxWidth / 2 - m.width : -m.width / 2;
    const centerY = -height / 2 + lh * (li + 0.5);
    const baseline = centerY + capHeight / 2;
    lines.push({ text: m.line, x: x0, y: baseline, width: m.width });
    let inWord = false;
    m.chars.forEach((ch, i) => {
      const space = /\s/.test(ch);
      if (!space && !inWord) word++;
      inWord = !space;
      glyphs.push({ ch, x: x0 + m.xs[i], y: baseline, width: m.widths[i], line: li, word: space ? -1 : word - 1 });
    });
    inWord = false;
  });

  const layout = { glyphs, lines, width: maxWidth, height, font };
  if (layoutCache.size > 500) layoutCache.clear();
  layoutCache.set(key, layout);
  return layout;
}

export interface UnitState {
  opacity: number; // 0..1
  dx: number;
  dy: number;
  scale: number; // factor
  rotation: number; // degrees
  blur: number;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rankUnits(count: number, order: TextAnimator["order"], seed: string): number[] {
  const idx = [...Array(count).keys()];
  switch (order) {
    case "reverse":
      return idx.map((i) => count - 1 - i);
    case "center": {
      const mid = (count - 1) / 2;
      return idx.map((i) => Math.abs(i - mid));
    }
    case "random": {
      let s = hash(seed) || 1;
      const rand = () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967296;
      const shuffled = [...idx];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const rank: number[] = [];
      shuffled.forEach((unit, r) => (rank[unit] = r));
      return rank;
    }
    default:
      return idx;
  }
}

/** Per-unit animator state at time t. Unit index -1 (whitespace) is always at rest. */
export function animatorStates(layer: TextLayer, unitCount: number, t: number): UnitState[] {
  const a = layer.animator!;
  const from = a.from ?? {};
  const ease = resolveEase(a.ease ?? "easeOutCubic");
  const stagger = a.stagger ?? 0.04;
  const duration = a.duration ?? 0.6;
  const start0 = (layer.in ?? 0) + (a.delay ?? 0);
  const ranks = rankUnits(unitCount, a.order, layer.id);
  return ranks.map((rank) => {
    const p = Math.min(1, Math.max(0, (t - (start0 + rank * stagger)) / duration));
    const e = ease(p);
    const lerp = (f: number | undefined, rest: number) => (f === undefined ? rest : f + (rest - f) * e);
    return {
      opacity: Math.min(1, Math.max(0, lerp(from.opacity, 100) / 100)),
      dx: from.offset ? from.offset[0] * (1 - e) : 0,
      dy: from.offset ? from.offset[1] * (1 - e) : 0,
      scale: lerp(from.scale, 100) / 100,
      rotation: lerp(from.rotation, 0),
      blur: Math.max(0, lerp(from.blur, 0)),
    };
  });
}
