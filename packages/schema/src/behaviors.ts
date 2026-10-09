import { isKeyframed, sample } from "./animate.ts";
import { getIn, setIn } from "./keyframes.ts";
import type { Animatable, Behavior, Composition, Keyframe, Layer } from "./schema.ts";

/*
 * Behaviors: procedural motion evaluated per frame. `applyBehaviors` returns a copy of the
 * layer where every property driven by a behavior is replaced by its value at time t, so
 * the renderer (and anything else that samples properties) needs no special handling.
 * Everything is deterministic: the same time always gives the same value.
 */

type Value = number | number[];

/** The value a property has when it's absent from the file (matches the engine defaults). */
export function propertyFallback(layer: Layer, path: string, comp: Composition): Value {
  switch (path) {
    case "transform.position":
      return layer.type === "path" ? [0, 0] : [comp.width / 2, comp.height / 2];
    case "transform.anchor":
      return [0, 0];
    case "transform.scale":
    case "transform.opacity":
    case "trim.end":
      return 100;
    case "font.size":
      return 96;
    case "size":
      return layer.type === "solid" ? [comp.width, comp.height] : [100, 100];
    default:
      return 0;
  }
}

// ---- deterministic smooth noise ----
function hash(n: number, seed: number): number {
  let h = Math.imul(n ^ Math.imul(seed, 0x9e3779b1), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1; // [-1, 1]
}

/** 1D value noise in [-1, 1], smooth (quintic interpolation between random lattice values). */
export function noise1(x: number, seed = 1): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return hash(i, seed) * (1 - u) + hash(i + 1, seed) * u;
}

function fbm(x: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise1(x * 2 ** o, seed + o * 7919) * amp;
    norm += amp;
    amp /= 2;
  }
  return sum / norm;
}

function wave(kind: string | undefined, cycles: number): number {
  const phase = cycles - Math.floor(cycles);
  switch (kind) {
    case "triangle":
      return 4 * Math.abs(phase - 0.5) - 1; // 1 → -1 → 1
    case "square":
      return phase < 0.5 ? 1 : -1;
    case "saw":
      return phase * 2 - 1;
    default:
      return Math.sin(cycles * Math.PI * 2);
  }
}

const dims = (v: Value) => (Array.isArray(v) ? v.length : 1);
const comp_ = (amount: number | [number, number], d: number) => (Array.isArray(amount) ? (amount[d] ?? amount[0]) : amount);
const mapDims = (v: Value, fn: (x: number, d: number) => number): Value => (Array.isArray(v) ? v.map(fn) : fn(v, 0));
const isValue = (v: unknown): v is Value => typeof v === "number" || (Array.isArray(v) && v.every((n) => typeof n === "number"));
const smooth = (x: number) => x * x * (3 - 2 * x);

/** Value of a (possibly keyframed) property at time t. */
function baseValue(layer: Layer, path: string, t: number, comp: Composition): Value | null {
  const v = sample(getIn(layer, path) as Animatable<unknown>, t, propertyFallback(layer, path, comp));
  return isValue(v) ? v : null;
}

export function applyBehaviors(layer: Layer, t: number, comp: Composition, getLayer: (id: string) => Layer | undefined = () => undefined): Layer {
  const list = layer.behaviors;
  if (!list?.length) return layer;
  const values = new Map<string, Value>();
  for (const b of list) {
    if (b.enabled === false) continue;
    const current = values.get(b.property) ?? baseValue(layer, b.property, t, comp);
    if (current === null) continue; // not a numeric property
    const start = b.start ?? layer.in ?? 0;
    const end = b.end ?? Infinity;
    const inWindow = t >= start && t <= end;
    const weight = b.fadeIn ? smooth(Math.min(1, Math.max(0, (t - start) / b.fadeIn))) : 1;
    values.set(b.property, evaluate(b, current, { layer, t, start, end, inWindow, weight, comp, getLayer }));
  }
  let out = layer;
  for (const [path, v] of values) out = setIn(out, path, v);
  return out;
}

interface EvalCtx {
  layer: Layer;
  t: number;
  start: number;
  end: number;
  inWindow: boolean;
  weight: number;
  comp: Composition;
  getLayer(id: string): Layer | undefined;
}

function evaluate(b: Behavior, current: Value, c: EvalCtx): Value {
  switch (b.type) {
    case "wiggle": {
      if (!c.inWindow) return current;
      const f = b.frequency ?? 2;
      const seed = b.seed ?? 1;
      return mapDims(current, (x, d) => x + comp_(b.amount, d) * c.weight * fbm((c.t - c.start) * f, seed * 131 + d * 1013, b.octaves ?? 1));
    }
    case "oscillate": {
      if (!c.inWindow) return current;
      const cycles = (c.t - c.start) * (b.frequency ?? 1) + (b.phase ?? 0) / 360;
      const w = wave(b.wave, cycles);
      return mapDims(current, (x, d) => x + comp_(b.amplitude, d) * c.weight * w);
    }
    case "drift": {
      if (c.t < c.start) return current;
      // Keeps the distance travelled after `end` instead of snapping back.
      const elapsed = Math.min(c.t, c.end) - c.start;
      return mapDims(current, (x, d) => x + comp_(b.speed, d) * elapsed * c.weight);
    }
    case "loop": {
      const prop = getIn(c.layer, b.property);
      if (!isKeyframed(prop as Animatable<unknown>)) return current;
      const kfs = (prop as { keyframes: Keyframe<unknown>[] }).keyframes;
      if (kfs.length < 2 || c.t <= kfs[kfs.length - 1].t || c.t > c.end) return current;
      const t0 = kfs[0].t;
      const span = kfs[kfs.length - 1].t - t0;
      if (span <= 0) return current;
      const n = Math.floor((c.t - t0) / span);
      const r = (c.t - t0) - n * span;
      const tt = b.mode === "pingpong" && n % 2 === 1 ? t0 + span - r : t0 + r;
      return baseValue(c.layer, b.property, tt, c.comp) ?? current;
    }
    case "follow": {
      if (!c.inWindow) return current;
      const leader = c.getLayer(b.layer);
      if (!leader) return current;
      const v = baseValue(leader, b.property, Math.max(0, c.t - (b.delay ?? 0.1)), c.comp);
      if (v === null || dims(v) !== dims(current)) return current;
      const offset = b.offset ?? 0;
      return mapDims(v, (x, d) => x + comp_(offset, d));
    }
  }
}

/** Properties a behavior can drive, per layer type (for pickers). */
export function behaviorTargets(layer: Layer): { path: string; label: string }[] {
  const t = [
    { path: "transform.position", label: "Position" },
    { path: "transform.scale", label: "Scale" },
    { path: "transform.rotation", label: "Rotation" },
    { path: "transform.opacity", label: "Opacity" },
  ];
  if (layer.type === "text") t.push({ path: "font.size", label: "Font size" }, { path: "letterSpacing", label: "Tracking" });
  if (layer.type === "rect") t.push({ path: "radius", label: "Corner radius" });
  if (layer.type === "rect" || layer.type === "ellipse") t.push({ path: "size", label: "Size" });
  if (layer.type === "path") t.push({ path: "trim.start", label: "Trim start" }, { path: "trim.end", label: "Trim end" });
  (layer.effects ?? []).forEach((fx, i) => {
    const params: Record<string, string[]> = { blur: ["radius"], glow: ["radius", "intensity"], dropShadow: ["distance", "angle", "softness"], colorAdjust: ["brightness", "hue"] };
    for (const p of params[fx.type] ?? []) t.push({ path: `effects.${i}.${p}`, label: `${fx.type} ${p}` });
  });
  return t;
}
