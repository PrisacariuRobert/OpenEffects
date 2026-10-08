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
  if (typeof a === "string" && typeof b === "string" && isColor(a) && isColor(b)) return lerpColor(a, b, p) as T;
  return p < 1 ? a : b;
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
