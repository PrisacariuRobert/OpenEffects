import { resolveEase } from "./easing.ts";
import { isColor, lerpColor } from "./color.ts";
import type { Animatable, Keyframe } from "./schema.ts";

export function isKeyframed<T>(v: Animatable<T> | undefined): v is { keyframes: Keyframe<T>[] } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && "keyframes" in v;
}

function lerpValue<T>(a: T, b: T, p: number): T {
  if (typeof a === "number" && typeof b === "number") return (a + (b - a) * p) as T;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => lerpValue(x, b[i] ?? x, p)) as T;
  if (typeof a === "number" && Array.isArray(b)) return lerpValue(b.map(() => a) as T, b, p);
  if (Array.isArray(a) && typeof b === "number") return lerpValue(a, a.map(() => b) as T, p);
  if (typeof a === "string" && typeof b === "string") {
    if (isColor(a) && isColor(b)) return lerpColor(a, b, p) as T;
    const morph = lerpPath(a, b, p);
    if (morph !== null) return morph as T;
  }
  return p < 1 ? a : b;
}

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const pathCache = new Map<string, { shape: string; nums: number[] } | null>();

/** Splits path data into its command skeleton and numbers (null if it isn't path data). */
function parsePath(d: string): { shape: string; nums: number[] } | null {
  let r = pathCache.get(d);
  if (r !== undefined) return r;
  if (!/^\s*[Mm]/.test(d) || /[^MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]/.test(d)) r = null;
  else {
    const nums: number[] = [];
    const shape = d.replace(NUM, (m) => {
      nums.push(parseFloat(m));
      return "#";
    }).replace(/[\s,]+/g, " ").trim();
    r = { shape, nums };
  }
  if (pathCache.size > 2000) pathCache.clear();
  pathCache.set(d, r);
  return r;
}

/** Morphs between two SVG paths with the same commands; null when they don't match. */
export function lerpPath(a: string, b: string, p: number): string | null {
  const pa = parsePath(a);
  const pb = parsePath(b);
  if (!pa || !pb || pa.shape !== pb.shape || pa.nums.length !== pb.nums.length) return null;
  let i = 0;
  // Arc flags stay as they are: only coordinates and radii morph.
  return pa.shape.replace(/#/g, () => {
    const v = pa.nums[i] + (pb.nums[i] - pa.nums[i]) * p;
    i++;
    return String(Math.round(v * 1000) / 1000);
  });
}

/** Value of an animatable property at composition time `t`. */
export function sample<T>(prop: Animatable<T> | undefined, t: number, fallback: T): T {
  if (prop === undefined) return fallback;
  if (!isKeyframed(prop)) return prop;
  const kfs = prop.keyframes;
  if (kfs.length === 0) return fallback;
  if (t <= kfs[0].t) return kfs[0].v;
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.t && t < b.t) {
      if (a.ease === "hold") return a.v;
      const span = b.t - a.t;
      const p = span <= 0 ? 1 : resolveEase(a.ease)((t - a.t) / span);
      return lerpValue(a.v, b.v, p);
    }
  }
  return last.v;
}

/** Collect every keyframe time in an arbitrary object tree (for timeline display). */
export function collectKeyframeTimes(node: unknown, out: Set<number> = new Set()): Set<number> {
  if (Array.isArray(node)) {
    for (const n of node) collectKeyframeTimes(n, out);
  } else if (node && typeof node === "object") {
    if (isKeyframed(node as Animatable<unknown>)) {
      for (const k of (node as { keyframes: Keyframe<unknown>[] }).keyframes) out.add(k.t);
    } else {
      for (const v of Object.values(node)) collectKeyframeTimes(v, out);
    }
  }
  return out;
}
