import { isKeyframed, sample } from "./animate.ts";
import { EditError, getComp } from "./ops.ts";
import type { Animatable, Easing, Keyframe, Layer, Project } from "./schema.ts";

/*
 * Property-level editing used by the visual editor (inspector, viewport, timeline).
 * Paths are dotted and may index arrays: "transform.position", "font.size", "effects.0.radius".
 * Everything is immutable: functions return new objects.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function getIn(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (isObj(cur)) cur = cur[key];
    else return undefined;
  }
  return cur;
}

/** Immutable set; `undefined` removes the key (and empty parent objects). */
export function setIn<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const rec = (node: unknown, i: number): unknown => {
    const key = keys[i];
    const last = i === keys.length - 1;
    if (Array.isArray(node)) {
      const copy = [...node];
      const idx = Number(key);
      if (last) {
        if (value === undefined) copy.splice(idx, 1);
        else copy[idx] = value;
      } else copy[idx] = rec(copy[idx], i + 1);
      return copy;
    }
    const base: Obj = isObj(node) ? { ...node } : {};
    if (last) {
      if (value === undefined) delete base[key];
      else base[key] = value;
    } else {
      const child = rec(base[key], i + 1);
      if (isObj(child) && Object.keys(child).length === 0) delete base[key];
      else base[key] = child;
    }
    return base;
  };
  return rec(obj, 0) as T;
}

const sameTime = (a: number, b: number, fps: number) => Math.abs(a - b) < 0.5 / fps;

export function keyframeIndexAt(prop: unknown, t: number, fps: number): number {
  if (!isKeyframed(prop as Animatable<unknown>)) return -1;
  return (prop as { keyframes: Keyframe<unknown>[] }).keyframes.findIndex((k) => sameTime(k.t, t, fps));
}

/**
 * Set a property's value at time t. Keyframed properties get a keyframe there (added or
 * updated); static properties simply change.
 */
export function setValueAtTime<T>(layer: T, path: string, t: number, value: unknown, fps = 30): T {
  const prop = getIn(layer, path);
  if (!isKeyframed(prop as Animatable<unknown>)) return setIn(layer, path, value);
  const kfs = [...(prop as { keyframes: Keyframe<unknown>[] }).keyframes];
  const i = kfs.findIndex((k) => sameTime(k.t, t, fps));
  if (i >= 0) kfs[i] = { ...kfs[i], v: value };
  else {
    // A new keyframe inherits the easing of the keyframe before it.
    const before = [...kfs].reverse().find((k) => k.t < t);
    kfs.push({ t: round(t), v: value, ...(before?.ease !== undefined ? { ease: before.ease } : {}) });
    kfs.sort((a, b) => a.t - b.t);
  }
  return setIn(layer, path, { keyframes: kfs });
}

/** Stopwatch toggle: static → one keyframe at t; keyframed → static value at t. */
export function toggleAnimated<T>(layer: T, path: string, t: number, fallback: unknown): T {
  const prop = getIn(layer, path) as Animatable<unknown> | undefined;
  if (isKeyframed(prop)) return setIn(layer, path, sample(prop, t, fallback));
  return setIn(layer, path, { keyframes: [{ t: round(t), v: prop ?? fallback }] });
}

function editKeyframes<T>(layer: T, path: string, fn: (kfs: Keyframe<unknown>[]) => Keyframe<unknown>[]): T {
  const prop = getIn(layer, path);
  if (!isKeyframed(prop as Animatable<unknown>)) throw new EditError(`${path} is not animated`);
  const old = (prop as { keyframes: Keyframe<unknown>[] }).keyframes;
  const kfs = fn([...old]).sort((a, b) => a.t - b.t);
  // Removing the last keyframe turns the property back into a static value.
  if (kfs.length === 0) return setIn(layer, path, old[0]?.v);
  return setIn(layer, path, { keyframes: kfs });
}

export const removeKeyframe = <T>(layer: T, path: string, index: number) => editKeyframes(layer, path, (k) => k.filter((_, i) => i !== index));

export const moveKeyframe = <T>(layer: T, path: string, index: number, t: number) =>
  editKeyframes(layer, path, (k) => k.map((kf, i) => (i === index ? { ...kf, t: round(Math.max(0, t)) } : kf)));

export const setKeyframeEase = <T>(layer: T, path: string, index: number, ease: Easing | undefined) =>
  editKeyframes(layer, path, (k) =>
    k.map((kf, i) => {
      if (i !== index) return kf;
      const { ease: _old, ...rest } = kf;
      return ease === undefined ? rest : { ...rest, ease };
    }),
  );

/** Dotted paths of every keyframed property in a layer (for timeline rows). */
export function animatedPaths(node: unknown, prefix = ""): string[] {
  if (isKeyframed(node as Animatable<unknown>)) return [prefix];
  const out: string[] = [];
  if (Array.isArray(node)) node.forEach((v, i) => out.push(...animatedPaths(v, prefix ? `${prefix}.${i}` : String(i))));
  else if (isObj(node)) for (const [k, v] of Object.entries(node)) out.push(...animatedPaths(v, prefix ? `${prefix}.${k}` : k));
  return out;
}

/** Move a layer in time: its in/out points and all of its keyframes. */
export function shiftLayerTime(layer: Layer, dt: number): Layer {
  const shift = (node: unknown): unknown => {
    if (isKeyframed(node as Animatable<unknown>)) {
      return { keyframes: (node as { keyframes: Keyframe<unknown>[] }).keyframes.map((k) => ({ ...k, t: round(Math.max(0, k.t + dt)) })) };
    }
    if (Array.isArray(node)) return node.map(shift);
    if (isObj(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, shift(v)]));
    return node;
  };
  const out = shift(layer) as Layer;
  const start = Math.max(0, (layer.in ?? 0) + dt);
  if (start > 0) out.in = round(start);
  else delete out.in;
  if (layer.out !== undefined) out.out = round(Math.max(start + 0.01, layer.out + dt));
  return out;
}

export function editLayer(project: Project, layerId: string, fn: (layer: Layer) => Layer, opts: { compId?: string } = {}): Project {
  const target = getComp(project, opts.compId);
  if (!target.layers.some((l) => l.id === layerId)) throw new EditError(`Layer "${layerId}" not found`);
  return {
    ...project,
    compositions: project.compositions.map((c) => (c === target ? { ...c, layers: c.layers.map((l) => (l.id === layerId ? fn(l) : l)) } : c)),
  };
}

export function uniqueLayerId(project: Project, base: string, compId?: string): string {
  const ids = new Set(getComp(project, compId).layers.map((l) => l.id));
  const clean = base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "layer";
  if (!ids.has(clean)) return clean;
  let n = 2;
  while (ids.has(`${clean}-${n}`)) n++;
  return `${clean}-${n}`;
}

/** Duplicate a layer directly above the original; returns the new project and id. */
export function duplicateLayer(project: Project, layerId: string, opts: { compId?: string } = {}): { project: Project; id: string } {
  const comp = getComp(project, opts.compId);
  const index = comp.layers.findIndex((l) => l.id === layerId);
  if (index < 0) throw new EditError(`Layer "${layerId}" not found`);
  const id = uniqueLayerId(project, `${layerId}-copy`, opts.compId);
  const copy = { ...structuredClone(comp.layers[index]), id, name: comp.layers[index].name ? `${comp.layers[index].name} copy` : undefined };
  if (copy.name === undefined) delete copy.name;
  const layers = [...comp.layers];
  layers.splice(index + 1, 0, copy);
  return { id, project: { ...project, compositions: project.compositions.map((c) => (c === comp ? { ...c, layers } : c)) } };
}

const round = (t: number) => Math.round(t * 1000) / 1000;

/**
 * Write keyframes into a property, turning a static value into an animation if needed.
 * Existing keyframes strictly inside the new keyframes' time span are replaced.
 */
export function insertKeyframes<T>(layer: T, path: string, kfs: Keyframe<unknown>[], fps = 30): T {
  if (kfs.length === 0) return layer;
  const sorted = [...kfs].sort((a, b) => a.t - b.t).map((k) => ({ ...k, t: round(k.t) }));
  const first = sorted[0].t;
  const last = sorted[sorted.length - 1].t;
  const prop = getIn(layer, path);
  const existing = isKeyframed(prop as Animatable<unknown>) ? (prop as { keyframes: Keyframe<unknown>[] }).keyframes : [];
  const kept = existing.filter((k) => k.t < first - 0.5 / fps || k.t > last + 0.5 / fps);
  return setIn(layer, path, { keyframes: [...kept, ...sorted].sort((a, b) => a.t - b.t) });
}
