import { layoutText } from "@openeffects/engine";
import {
  formatColor,
  resolveEase,
  isKeyframed,
  sample,
  validateProject,
  type Animatable,
  type Composition,
  type Effect,
  type Fill,
  type Keyframe,
  type Layer,
  type Marker,
  type Project,
  type Stroke,
  type Vec2,
} from "@openeffects/schema";
import { ellipsePath, lottieToSvg, rectPath, starPath, type LottieBezier, type Pt } from "./path.ts";
import type { LAsset, LKeyframe, LLayer, LottieAnimation, LProp, LShape, LSplitPosition, LTransform } from "./types.ts";

/*
 * Lottie JSON (from After Effects/bodymovin, LottieFiles, Figma plugins, Rive exports…) →
 * an editable OpenEffects project.
 *
 * Shape layers become one layer per filled/stroked shape group (rect and ellipse stay
 * rect and ellipse layers; everything else becomes an SVG path), parented to nulls that
 * carry the layer and group transforms. Keyframes keep their bezier easing. The first mask
 * of a layer becomes a track matte. Anything without an equivalent (expressions, path
 * morphing, repeaters, 3D, luma mattes…) is approximated and reported as a warning.
 */

export interface ImportOptions {
  /** Id for the main composition. Default "main". */
  compId?: string;
  /** Measures text for exact placement of left/right aligned text. */
  ctx?: CanvasRenderingContext2D;
  /** Stores an embedded image and returns its project-relative src (e.g. assets/image_0.png). */
  saveImage?: (name: string, data: Uint8Array, ext: string) => string;
  /** Resolves an external image reference (asset `u` + `p`) to a project-relative src. */
  resolveImage?: (dir: string, file: string) => string | null;
}

export interface ImportResult {
  project: Project;
  warnings: string[];
}

const BLEND: Record<number, Layer["blend"]> = { 1: "multiply", 2: "screen", 3: "overlay", 4: "darken", 5: "lighten", 10: "difference", 16: "add" };
const r3 = (n: number) => Math.round(n * 1000) / 1000;

interface Ctx {
  fr: number;
  /** Frame that maps to time 0 of the composition being imported. */
  ip: number;
  warnings: Set<string>;
  opts: ImportOptions;
  anim: LottieAnimation;
  comps: Composition[];
  ids: Set<string>;
  /** Layer start time (frames): Lottie layer keyframes are relative to it. */
  st: number;
  precomps: Map<string, string>;
  /**
   * Where Lottie's layer-space origin sits in our layer space, per layer id. Lottie content
   * starts top-left (solids, images, precomps) or on the text baseline; ours is centered.
   * Children of such layers are positioned relative to that origin.
   */
  offsets: Map<string, Vec2>;
  styleCache: Map<LShape, Fill | Stroke | undefined>;
}

// ---------------------------------------------------------------- values

const arr = (v: unknown): number[] => (Array.isArray(v) ? (v as number[]) : [v as number]);
const first = (v: number | number[] | undefined, d: number) => (v === undefined ? d : Array.isArray(v) ? (v[0] ?? d) : v);

function easeOf(kf: LKeyframe): Keyframe<unknown>["ease"] {
  if (kf.h === 1) return "hold";
  if (!kf.o || !kf.i) return "linear";
  const e: [number, number, number, number] = [r3(first(kf.o.x, 0)), r3(first(kf.o.y, 0)), r3(first(kf.i.x, 1)), r3(first(kf.i.y, 1))];
  const lin = Math.abs(e[0] - e[1]) < 0.01 && Math.abs(e[2] - e[3]) < 0.01;
  if (lin) return "linear";
  e[0] = Math.min(1, Math.max(0, e[0]));
  e[2] = Math.min(1, Math.max(0, e[2]));
  return e;
}

/** Lottie property → animatable value (seconds, our easing). */
function read<T>(c: Ctx, p: LProp | undefined, conv: (v: number[]) => T): Animatable<T> | undefined {
  if (!p) return undefined;
  if (p.x) c.warnings.add("Expressions aren't supported: their keyframed or static values were used");
  const k = p.k;
  const isKfs = Array.isArray(k) && k.length > 0 && typeof k[0] === "object" && k[0] !== null && "t" in (k[0] as object);
  if (!isKfs) return conv(arr(k));
  const kfs = k as LKeyframe[];
  const out: Keyframe<T>[] = [];
  kfs.forEach((kf, i) => {
    const s = kf.s ?? kfs[i - 1]?.e;
    if (s === undefined) return;
    const t = (kf.t + c.st - c.ip) / c.fr;
    const v = conv(arr(s));
    const ease = i < kfs.length - 1 ? easeOf(kf) : undefined;
    out.push({ t: r3(t), v, ...(ease && ease !== "easeInOut" ? { ease } : {}) } as Keyframe<T>);
  });
  // Our times start at 0: fold keyframes before 0 into one at 0.
  while (out.length > 1 && out[1].t <= 0) out.shift();
  if (out.length && out[0].t < 0) {
    const next = out[1];
    if (next && typeof out[0].v === "number" && typeof next.v === "number") {
      const p0 = -out[0].t / (next.t - out[0].t);
      out[0] = { ...out[0], v: ((out[0].v as number) + ((next.v as number) - (out[0].v as number)) * p0) as T };
    }
    out[0] = { ...out[0], t: 0 };
  }
  const dedup = out.filter((kf, i) => i === out.length - 1 || out[i + 1].t > kf.t);
  if (dedup.length === 0) return undefined;
  if (dedup.length === 1 || dedup.every((kf) => JSON.stringify(kf.v) === JSON.stringify(dedup[0].v))) return dedup[0].v;
  return { keyframes: dedup };
}

const curved = (kf: LKeyframe) => !!((kf.to && kf.to.some((x) => Math.abs(x) > 0.01)) || (kf.ti && kf.ti.some((x) => Math.abs(x) > 0.01)));

/**
 * Position with curved motion paths (spatial bezier tangents): curved segments are baked
 * into per-frame keyframes that follow the curve at Lottie's eased, arc-length speed.
 */
function readPosition(c: Ctx, p: LProp | undefined): Animatable<Vec2> | undefined {
  const conv = (v: number[]) => [r3(v[0] ?? 0), r3(v[1] ?? 0)] as Vec2;
  const isKfs = p && Array.isArray(p.k) && typeof (p.k as unknown[])[0] === "object";
  if (!p || !isKfs || !(p.k as LKeyframe[]).some(curved)) return read(c, p, conv);
  const kfs = p.k as LKeyframe[];
  const out: Keyframe<Vec2>[] = [];
  const time = (f: number) => (f + c.st - c.ip) / c.fr;
  kfs.forEach((kf, i) => {
    const s0 = kf.s ?? kfs[i - 1]?.e;
    if (!s0) return;
    const next = kfs[i + 1];
    const e0 = kf.e ?? next?.s;
    if (!next || !e0 || kf.h === 1 || !curved(kf)) {
      const ease = next ? easeOf(kf) : undefined;
      out.push({ t: r3(time(kf.t)), v: conv(s0), ...(ease && ease !== "easeInOut" ? { ease } : {}) });
      return;
    }
    const P0 = s0;
    const P1 = [s0[0] + (kf.to?.[0] ?? 0), s0[1] + (kf.to?.[1] ?? 0)];
    const P3 = e0;
    const P2 = [e0[0] + (kf.ti?.[0] ?? 0), e0[1] + (kf.ti?.[1] ?? 0)];
    const at = (u: number) => {
      const m = 1 - u;
      return [0, 1].map((d) => m * m * m * P0[d] + 3 * m * m * u * P1[d] + 3 * m * u * u * P2[d] + u * u * u * P3[d]);
    };
    const N = 64;
    const lut = [0];
    let prev = at(0);
    for (let k = 1; k <= N; k++) {
      const q = at(k / N);
      lut.push(lut[k - 1] + Math.hypot(q[0] - prev[0], q[1] - prev[1]));
      prev = q;
    }
    const total = lut[N] || 1;
    const pointAt = (frac: number) => {
      const target = frac * total;
      let k = 1;
      while (k < N && lut[k] < target) k++;
      const seg = lut[k] - lut[k - 1] || 1;
      return at((k - 1 + (target - lut[k - 1]) / seg) / N);
    };
    const ease = easeOf(kf);
    const fn = resolveEase(ease === "hold" ? "linear" : ease);
    for (let f = kf.t; f < next.t - 1e-6; f += 1) {
      const u = (f - kf.t) / (next.t - kf.t);
      out.push({ t: r3(time(f)), v: conv(pointAt(Math.min(1, Math.max(0, fn(u))))), ease: "linear" });
    }
  });
  const kept = out.filter((k, i) => i === out.length - 1 || out[i + 1].t > k.t).filter((k, i, a) => k.t >= 0 || a[i + 1]?.t > 0);
  if (kept.length && kept[0].t < 0) kept[0] = { ...kept[0], t: 0 };
  return kept.length === 1 ? kept[0].v : kept.length ? { keyframes: kept } : undefined;
}

/** Combines two animatable values sampled at the union of their keyframe times. */
function combine<A, B, T>(a: Animatable<A> | undefined, fa: A, b: Animatable<B> | undefined, fb: B, f: (a: A, b: B) => T): Animatable<T> {
  const ka = isKeyframed(a as Animatable<unknown>) ? (a as { keyframes: Keyframe<A>[] }).keyframes : null;
  const kb = isKeyframed(b as Animatable<unknown>) ? (b as { keyframes: Keyframe<B>[] }).keyframes : null;
  if (!ka && !kb) return f(sample(a, 0, fa), sample(b, 0, fb));
  const times = [...new Set([...(ka ?? []).map((k) => k.t), ...(kb ?? []).map((k) => k.t)])].sort((x, y) => x - y);
  const keyframes = times.map((t, i) => {
    const ease = ka?.find((k) => k.t === t)?.ease ?? kb?.find((k) => k.t === t)?.ease;
    return { t, v: f(sample(a, t, fa), sample(b, t, fb)), ...(ease && i < times.length - 1 ? { ease } : {}) } as Keyframe<T>;
  });
  return keyframes.length === 1 ? keyframes[0].v : { keyframes };
}

function mapAnim<A, T>(a: Animatable<A>, f: (v: A) => T): Animatable<T> {
  if (!isKeyframed(a as Animatable<unknown>)) return f(a as A);
  return { keyframes: (a as { keyframes: Keyframe<A>[] }).keyframes.map((k) => ({ ...k, v: f(k.v) })) };
}

const isStatic = <T>(a: Animatable<T> | undefined): a is T => a !== undefined && !isKeyframed(a as Animatable<unknown>);

/** Lottie colors are 0–1 (some old files use 0–255). */
function color(v: number[], alpha = 1): string {
  const big = v.slice(0, 3).some((x) => x > 1);
  const c = v.slice(0, 3).map((x) => Math.round((big ? x : x * 255) * 1)) as [number, number, number];
  const a = Math.min(1, Math.max(0, alpha));
  if (a >= 0.999) return `#${c.map((x) => Math.min(255, Math.max(0, x)).toString(16).padStart(2, "0")).join("")}`;
  return formatColor([c[0], c[1], c[2], a]).replace(/(\.\d*?)0+\)$/, "$1)").replace(/\.\)$/, ")");
}

function colorWithOpacity(c: Ctx, cp: LProp | undefined, op: LProp | undefined): Animatable<string> {
  const col = read(c, cp, (v) => v) ?? [1, 1, 1];
  const opa = read(c, op, (v) => v[0]) ?? 100;
  return combine(col, [1, 1, 1], opa, 100, (cv, o) => color(cv, o / 100));
}

// ---------------------------------------------------------------- ids

function uniqueId(c: Ctx, base: string | undefined, fallback: string): string {
  let id = (base ?? "").trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || fallback;
  if (/^\d/.test(id)) id = `${fallback}-${id}`;
  let out = id;
  for (let n = 2; c.ids.has(out); n++) out = `${id}-${n}`;
  c.ids.add(out);
  return out;
}

// ---------------------------------------------------------------- transforms

function transform(c: Ctx, ks: LTransform | undefined, anchorShift: Vec2 = [0, 0]): NonNullable<Layer["transform"]> {
  if (!ks) return {};
  const tr: NonNullable<Layer["transform"]> = {};
  let pos: Animatable<Vec2> | undefined;
  if (ks.p && "s" in ks.p && (ks.p as LSplitPosition).s === true) {
    const sp = ks.p as LSplitPosition;
    pos = combine(read(c, sp.x, (v) => v[0]), 0, read(c, sp.y, (v) => v[0]), 0, (x, y) => [r3(x), r3(y)] as Vec2);
  } else pos = readPosition(c, ks.p as LProp | undefined);
  // Lottie's default position is the origin; ours is the composition center.
  tr.position = pos ?? [0, 0];
  const anchor = read(c, ks.a, (v) => [r3((v[0] ?? 0) - anchorShift[0]), r3((v[1] ?? 0) - anchorShift[1])] as Vec2);
  if (anchor !== undefined && !(isStatic(anchor) && anchor[0] === 0 && anchor[1] === 0)) tr.anchor = anchor;
  const sc = read(c, ks.s, (v) => [r3(v[0] ?? 100), r3(v[1] ?? v[0] ?? 100)] as Vec2);
  if (sc !== undefined) {
    const uniform = isStatic(sc) ? sc[0] === sc[1] : (sc as { keyframes: Keyframe<Vec2>[] }).keyframes.every((k) => k.v[0] === k.v[1]);
    const s = uniform ? mapAnim(sc, (v) => v[0]) : sc;
    if (!(isStatic(s) && s === 100)) tr.scale = s as Animatable<number | Vec2>;
  }
  const rot = read(c, ks.r ?? ks.rz, (v) => r3(v[0]));
  if (rot !== undefined && !(isStatic(rot) && rot === 0)) tr.rotation = rot;
  const op = read(c, ks.o, (v) => r3(v[0]));
  if (op !== undefined && !(isStatic(op) && op === 100)) tr.opacity = op;
  if (ks.sk && read(c, ks.sk, (v) => v[0]) !== 0) c.warnings.add("Skew isn't supported and was dropped");
  return tr;
}

// ---------------------------------------------------------------- paint

function fillOf(c: Ctx, item: LShape): Fill | undefined {
  if (item.ty === "fl") return colorWithOpacity(c, item.c as LProp, item.o as LProp);
  if (item.ty === "gf") return gradient(c, item);
  return undefined;
}

function gradient(c: Ctx, item: LShape): Fill {
  const g = item.g as { p: number; k: LProp };
  const raw = arr(read(c, g.k, (v) => v) as number[] | undefined);
  if (isKeyframed(read(c, g.k, (v) => v))) c.warnings.add("Animated gradients were imported with their first colors");
  const vals = isKeyframed(read(c, g.k, (v) => v)) ? ((read(c, g.k, (v) => v) as { keyframes: Keyframe<number[]>[] }).keyframes[0].v) : raw;
  const n = g.p;
  const alphaPairs = vals.slice(n * 4);
  const alphaAt = (o: number) => {
    if (alphaPairs.length < 4) return alphaPairs.length === 2 ? alphaPairs[1] : 1;
    for (let i = 0; i + 3 < alphaPairs.length; i += 2) {
      const [o0, a0, o1, a1] = alphaPairs.slice(i, i + 4);
      if (o <= o0) return a0;
      if (o <= o1) return a0 + ((a1 - a0) * (o - o0)) / Math.max(1e-6, o1 - o0);
    }
    return alphaPairs[alphaPairs.length - 1];
  };
  const stops: [number, string][] = [];
  for (let i = 0; i < n; i++) {
    const [o, r, gg, b] = vals.slice(i * 4, i * 4 + 4);
    stops.push([Math.min(1, Math.max(0, r3(o))), color([r, gg, b], alphaAt(o))]);
  }
  if (stops.length < 2) stops.push([1, stops[0]?.[1] ?? "#ffffff"]);
  const s = sample(read(c, item.s as LProp, (v) => [r3(v[0]), r3(v[1])] as Vec2), 0, [0, 0] as Vec2);
  const e = sample(read(c, item.e as LProp, (v) => [r3(v[0]), r3(v[1])] as Vec2), 0, [100, 0] as Vec2);
  if (item.t === 2) return { type: "radial", stops, center: s, radius: Math.max(1, r3(Math.hypot(e[0] - s[0], e[1] - s[1]))) };
  return { type: "linear", stops, from: s, to: e };
}

function strokeOf(c: Ctx, item: LShape): Stroke {
  const s: Stroke = { color: item.ty === "gs" ? "#ffffff" : colorWithOpacity(c, item.c as LProp, item.o as LProp) };
  if (item.ty === "gs") {
    const g = gradient(c, item);
    s.color = typeof g === "object" && "stops" in g ? g.stops[0][1] : "#ffffff";
    c.warnings.add("Gradient strokes were imported as solid strokes");
  }
  const w = read(c, item.w as LProp, (v) => r3(v[0]));
  if (w !== undefined) s.width = w;
  const cap = ({ 1: "butt", 2: "round", 3: "square" } as const)[item.lc as 1 | 2 | 3];
  const join = ({ 1: "miter", 2: "round", 3: "bevel" } as const)[item.lj as 1 | 2 | 3];
  if (cap && cap !== "butt") s.cap = cap;
  if (join && join !== "miter") s.join = join;
  if (item.d) c.warnings.add("Dashed strokes were imported as solid strokes");
  return s;
}

// ---------------------------------------------------------------- shapes

interface Prim {
  item: LShape;
}

/** A Lottie shape property (static or morphing) as path data. */
function shapeData(c: Ctx, ks: LProp): Animatable<string> | undefined {
  const animated = Array.isArray(ks.k) && typeof (ks.k as unknown[])[0] === "object" && "t" in ((ks.k as unknown[])[0] as object);
  return read(c, ks, (v) => {
    const b = (v as unknown as LottieBezier[])[0];
    return b?.v ? lottieToSvg([b], [0, 0], animated) : "M0 0";
  });
}

/** Joins the paths of shapes painted together; keyframes at the union of their times. */
function joinPaths(list: Animatable<string>[]): Animatable<string> {
  if (list.every((d) => isStatic(d))) return (list as string[]).join(" ");
  const times = [...new Set(list.flatMap((d) => (isKeyframed(d) ? d.keyframes.map((k) => k.t) : [])))].sort((a, b) => a - b);
  const keyframes = times.map((t, i) => {
    const ease = list.map((d) => (isKeyframed(d) ? d.keyframes.find((k) => k.t === t)?.ease : undefined)).find((e) => e !== undefined);
    return { t, v: list.map((d) => sample(d, t, "")).join(" "), ...(ease && i < times.length - 1 ? { ease } : {}) };
  });
  return keyframes.length === 1 ? keyframes[0].v : { keyframes };
}

function primPath(c: Ctx, p: LShape): Animatable<string> {
  if (p.ty === "sh") return shapeData(c, p.ks as LProp) ?? "";
  return primPathStatic(c, p);
}

function primPathStatic(c: Ctx, p: LShape): string {
  const v2 = (prop: unknown, d: Vec2) => sample(read(c, prop as LProp, (v) => [v[0] ?? 0, v[1] ?? 0] as Vec2), 0, d);
  const v1 = (prop: unknown, d: number) => sample(read(c, prop as LProp, (v) => v[0] ?? 0), 0, d);
  switch (p.ty) {
    case "rc": {
      const [x, y] = v2(p.p, [0, 0]);
      const [w, h] = v2(p.s, [100, 100]);
      return rectPath(x, y, w, h, v1(p.r, 0));
    }
    case "el": {
      const [x, y] = v2(p.p, [0, 0]);
      const [w, h] = v2(p.s, [100, 100]);
      return ellipsePath(x, y, w, h);
    }
    case "sr": {
      const [x, y] = v2(p.p, [0, 0]);
      const star = p.sy === 1;
      return starPath(x, y, v1(p.pt, 5), v1(p.or, 100), star ? v1(p.ir, 50) : null, v1(p.r, 0));
    }
  }
  return "";
}

/** One output layer for a set of shapes painted together, in the group's space. */
function primLayer(c: Ctx, prims: Prim[], fill: Fill | undefined, stroke: Stroke | undefined, trim: LShape | undefined, opacity: Animatable<number>, name: string): Layer | null {
  if (!prims.length || (fill === undefined && stroke === undefined)) return null;
  const id = uniqueId(c, name, "shape");
  const transformOf = (extra: NonNullable<Layer["transform"]> = {}) => {
    const t = { ...extra };
    if (!(isStatic(opacity) && opacity >= 99.999)) t.opacity = opacity;
    return Object.keys(t).length ? { transform: t } : {};
  };
  const only = prims.length === 1 ? prims[0].item : null;
  const pos = (p: unknown) => read(c, p as LProp, (v) => [r3(v[0] ?? 0), r3(v[1] ?? 0)] as Vec2) ?? ([0, 0] as Vec2);
  const size = (s: unknown) => read(c, s as LProp, (v) => [r3(v[0] ?? 0), r3(v[1] ?? 0)] as Vec2) ?? ([100, 100] as Vec2);
  if (only && !trim && (only.ty === "rc" || only.ty === "el")) {
    const base = { id, name, ...transformOf({ position: pos(only.p) }), size: size(only.s), ...(fill !== undefined ? { fill } : {}), ...(stroke ? { stroke } : {}) };
    if (only.ty === "rc") {
      const r = read(c, only.r as LProp, (v) => r3(v[0]));
      return { ...base, type: "rect", ...(r !== undefined && !(isStatic(r) && r === 0) ? { radius: r } : {}) } as Layer;
    }
    return { ...base, type: "ellipse" } as Layer;
  }
  const parts = prims.map((p) => primPath(c, p.item)).filter((d) => d !== "");
  if (!parts.length) return null;
  const d = joinPaths(parts);
  const layer: Layer = { id, name, type: "path", d, ...transformOf(), ...(fill !== undefined ? { fill } : {}), ...(stroke ? { stroke } : {}) } as Layer;
  // Our path layers draw a white stroke when they have neither: make fill-only explicit.
  if (trim && layer.type === "path") {
    const s = read(c, trim.s as LProp, (v) => r3(v[0]));
    const e = read(c, trim.e as LProp, (v) => r3(v[0]));
    layer.trim = { ...(s !== undefined && !(isStatic(s) && s === 0) ? { start: s } : {}), ...(e !== undefined && !(isStatic(e) && e === 100) ? { end: e } : {}) };
    if (read(c, trim.o as LProp, (v) => v[0]) !== 0 && trim.o) c.warnings.add("Trim path offset isn't supported and was dropped");
    if (fill !== undefined) c.warnings.add("Trim paths only shorten strokes in OpenEffects; fills stay complete");
  }
  return layer;
}

const UNSUPPORTED: Record<string, string> = {
  rp: "Repeaters",
  rd: "Rounded corners",
  mm: "Merge paths",
  op: "Offset paths",
  pb: "Pucker & bloat",
  tw: "Twist",
  zz: "Zig zag",
};

/**
 * Converts the items of a shape group into layers. `parentId` is the layer whose space the
 * shapes are in. Returns layers bottom → top.
 */
function groupLayers(c: Ctx, items: LShape[], parentId: string, inherited: { fill?: Fill; stroke?: Stroke; trim?: LShape }, opacity: Animatable<number>, name: string, timing: Partial<Layer>): Layer[] {
  const out: Layer[] = []; // top → bottom while collecting
  const visible = items.filter((i) => !i.hd);
  // Converted once per style item, so shapes sharing a style compare equal and get merged.
  const cached = <T extends Fill | Stroke>(it: LShape, f: () => T): T => {
    if (!c.styleCache.has(it)) c.styleCache.set(it, f());
    return c.styleCache.get(it) as T;
  };
  const styleAfter = (index: number) => {
    let fill: Fill | undefined;
    let stroke: Stroke | undefined;
    let trim: LShape | undefined;
    for (let j = index + 1; j < visible.length; j++) {
      const it = visible[j];
      if (fill === undefined && (it.ty === "fl" || it.ty === "gf")) fill = cached(it, () => fillOf(c, it)!);
      if (stroke === undefined && (it.ty === "st" || it.ty === "gs")) stroke = cached(it, () => strokeOf(c, it));
      if (trim === undefined && it.ty === "tm") trim = it;
    }
    return { fill: fill ?? inherited.fill, stroke: stroke ?? inherited.stroke, trim: trim ?? inherited.trim };
  };
  for (const it of visible) if (UNSUPPORTED[it.ty]) c.warnings.add(`${UNSUPPORTED[it.ty]} aren't supported and were ignored`);

  // Shapes painted with the same styles are merged into one compound path (keeps holes).
  let run: Prim[] = [];
  let runStyle: ReturnType<typeof styleAfter> | null = null;
  const flush = () => {
    if (run.length && runStyle) {
      const l = primLayer(c, run, runStyle.fill, runStyle.stroke, runStyle.trim, opacity, name);
      if (l) out.push({ ...l, parent: parentId, ...timing } as Layer);
    }
    run = [];
    runStyle = null;
  };
  visible.forEach((it, i) => {
    if (it.ty === "sh" || it.ty === "rc" || it.ty === "el" || it.ty === "sr") {
      const style = styleAfter(i);
      if (runStyle && (style.fill !== runStyle.fill || style.stroke !== runStyle.stroke || style.trim !== runStyle.trim)) flush();
      runStyle = style;
      run.push({ item: it });
    } else if (it.ty === "gr") {
      flush();
      const style = styleAfter(i);
      const sub = (it.it as LShape[]) ?? [];
      const tr = sub.find((x) => x.ty === "tr");
      const groupName = (it.nm as string) || name;
      const trProps = tr ? transform(c, { a: tr.a as LProp, p: tr.p as LProp, s: tr.s as LProp, r: tr.r as LProp, sk: tr.sk as LProp }) : {};
      // Opacity multiplies down groups (our layers don't inherit it): fold it into the shapes.
      const gOpacity = (tr ? read(c, tr.o as LProp, (v) => v[0]) : undefined) ?? 100;
      let space = parentId;
      const nested: Layer[] = [];
      const identity = Object.keys(trProps).every((k) => k === "position") && isStatic(trProps.position) && trProps.position[0] === 0 && trProps.position[1] === 0;
      if (!identity) {
        space = uniqueId(c, `${groupName}-group`, "group");
        nested.push({ id: space, type: "null", name: groupName, parent: parentId, transform: trProps, ...timing } as Layer);
      }
      const children = groupLayers(c, sub.filter((x) => x.ty !== "tr"), space, style, combine(opacity, 100, gOpacity, 100, (a, b) => r3((a * b) / 100)), groupName, timing);
      // Children bottom→top; nulls don't draw, so put them first.
      out.push(...[...children].reverse(), ...nested);
    }
  });
  flush();
  return out.reverse();
}

// ---------------------------------------------------------------- layers

function textLayer(c: Ctx, L: LLayer, id: string): { layer: Layer; offset: Vec2 } {
  const docs = L.t?.d?.k ?? [];
  if (docs.length > 1) c.warnings.add("Text that changes over time was imported with its first text");
  if (L.t?.a && (L.t.a as unknown[]).length) c.warnings.add("Lottie text animators aren't imported (use the Text animation panel)");
  const d = docs[0]?.s;
  const font = c.anim.fonts?.list.find((f) => f.fName === d?.f);
  const styleName = `${font?.fStyle ?? ""} ${d?.f ?? ""}`.toLowerCase();
  const weights: [RegExp, number][] = [
    [/thin|hairline/, 100],
    [/extra ?light|ultra ?light/, 200],
    [/light/, 300],
    [/semi ?bold|demi ?bold/, 600],
    [/extra ?bold|ultra ?bold|heavy/, 800],
    [/black/, 900],
    [/bold/, 700],
    [/medium/, 500],
  ];
  const weight = Number(font?.fWeight) || weights.find(([re]) => re.test(styleName))?.[1] || 400;
  const size = d?.s ?? 96;
  const text = (d?.t ?? "").replace(/\r\n?|\u0003/g, "\n");
  const layer: Extract<Layer, { type: "text" }> = {
    id,
    type: "text",
    text,
    font: { family: font?.fFamily ?? "Inter", weight, size: r3(size), ...(/italic|oblique/.test(styleName) ? { style: "italic" as const } : {}) },
    fill: d?.fc ? color(d.fc) : "#ffffff",
    align: d?.j === 0 ? "left" : d?.j === 1 ? "right" : "center",
  };
  if (d?.sc && d.sw) layer.stroke = { color: color(d.sc), width: r3(d.sw) };
  if (d?.tr) layer.letterSpacing = r3((d.tr * size) / 1000);
  if (d?.lh && Math.abs(d.lh / size - 1.2) > 0.01) layer.lineHeight = r3(d.lh / size);
  if (d?.sz) c.warnings.add("Paragraph (box) text was imported as point text: long lines won't wrap");
  // Lottie text starts at the layer origin on the first baseline; ours is centered.
  const lines = text.split("\n");
  const lh = size * (layer.lineHeight ?? 1.2);
  let width = Math.max(...lines.map((l) => l.length)) * size * 0.55;
  let baseline = -(lines.length * lh) / 2 + lh / 2 + size * 0.36;
  if (c.opts.ctx) {
    try {
      const layout = layoutText(c.opts.ctx, layer, 0);
      width = layout.width;
      baseline = layout.lines[0]?.y ?? baseline;
    } catch {
      // keep the estimate
    }
  }
  const dx = layer.align === "left" ? width / 2 : layer.align === "right" ? -width / 2 : 0;
  return { layer, offset: [dx, -baseline] };
}

function maskMatte(c: Ctx, L: LLayer, ownerId: string, timing: Partial<Layer>): Layer | null {
  const masks = (L.masksProperties ?? []) as { mode?: string; inv?: boolean; pt?: LProp; o?: LProp; f?: LProp; x?: LProp; nm?: string }[];
  const active = masks.filter((m) => m.mode !== "n");
  if (!active.length) return null;
  if (active.length > 1) c.warnings.add("Only the first mask of a layer is imported (as a track matte)");
  const m = active[0];
  if (m.mode === "i" || m.mode === "l" || m.mode === "d" || m.mode === "f") c.warnings.add(`Mask mode "${m.mode}" was imported as a plain mask`);
  if (m.f && sample(read(c, m.f, (v) => v[0]), 0, 0) > 0) c.warnings.add("Mask feather isn't supported");
  if (!m.pt) return null;
  const d = shapeData(c, m.pt);
  if (d === undefined) return null;
  return {
    id: uniqueId(c, `${ownerId}-mask`, "mask"),
    type: "path",
    name: m.nm ?? "Mask",
    d,
    fill: "#ffffff",
    visible: false,
    parent: ownerId,
    ...timing,
    ...(m.mode === "s" !== !!m.inv ? { _invert: true } : {}),
  } as Layer;
}

function effectsOf(c: Ctx, L: LLayer): Effect[] {
  const out: Effect[] = [];
  for (const fx of L.ef ?? []) {
    if (fx.en === 0) continue;
    const v = (i: number) => fx.ef[i]?.v;
    if (fx.ty === 29) {
      const radius = read(c, v(0), (x) => r3(x[0] * 0.3));
      if (radius !== undefined) out.push({ type: "blur", radius });
    } else if (fx.ty === 25) {
      const col = read(c, v(0), (x) => x) ?? [0, 0, 0];
      const opa = read(c, v(1), (x) => x[0]) ?? 128;
      const shadow: Effect = { type: "dropShadow", color: combine(col, [0, 0, 0], opa, 128, (cv, o) => color(cv, o / 255)) };
      const dir = read(c, v(2), (x) => r3(270 - x[0]));
      const dist = read(c, v(3), (x) => r3(x[0]));
      const soft = read(c, v(4), (x) => r3(x[0] / 2));
      if (dir !== undefined) shadow.angle = dir;
      if (dist !== undefined) shadow.distance = dist;
      if (soft !== undefined) shadow.softness = soft;
      out.push(shadow);
    } else c.warnings.add(`Effect "${fx.nm ?? fx.ty}" isn't supported and was ignored`);
  }
  return out;
}

function imageSrc(c: Ctx, asset: LAsset): string | null {
  const p = asset.p ?? "";
  const m = /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,(.*)$/s.exec(p);
  if (m && c.opts.saveImage) {
    const ext = m[1] === "jpeg" ? "jpg" : m[1] === "svg+xml" ? "svg" : m[1];
    const bin = typeof Buffer !== "undefined" ? Uint8Array.from(Buffer.from(m[2], "base64")) : Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
    return c.opts.saveImage(asset.id.replace(/[^A-Za-z0-9_-]+/g, "_"), bin, ext);
  }
  if (!m && p && c.opts.resolveImage) return c.opts.resolveImage(asset.u ?? "", p);
  return null;
}

/** Converts the layers of a Lottie composition (top-first) into our layers (bottom-first). */
function convertLayers(c: Ctx, layers: LLayer[], duration: number): Layer[] {
  const byInd = new Map<number, string>();
  const ids = new Map<LLayer, string>();
  for (const L of layers) {
    const id = uniqueId(c, L.ln && /^[A-Za-z0-9_-]+$/.test(L.ln) ? L.ln : L.nm, L.ty === 4 ? "shape" : L.ty === 5 ? "text" : "layer");
    ids.set(L, id);
    if (L.ind !== undefined) byInd.set(L.ind, id);
  }
  const groups: Layer[][] = []; // per Lottie layer, bottom → top
  const matteOf = new Map<LLayer, LLayer>();
  layers.forEach((L, i) => {
    if (L.tt) {
      const matte = L.tp !== undefined ? layers.find((x) => x.ind === L.tp) : layers[i - 1]?.td ? layers[i - 1] : undefined;
      if (matte) matteOf.set(L, matte);
      if (L.tt === 3 || L.tt === 4) c.warnings.add("Luma mattes were imported as alpha mattes");
    }
  });

  for (const L of layers) {
    const id = ids.get(L)!;
    if (L.ddd) c.warnings.add("3D layers were imported as 2D");
    if (L.sr !== undefined && L.sr !== 1) c.warnings.add("Time-stretched layers play at normal speed");
    const prevSt = c.st;
    c.st = L.st ?? 0;
    const inT = Math.max(0, r3((L.ip - c.ip) / c.fr));
    const outT = r3((L.op - c.ip) / c.fr);
    const timing: Partial<Layer> = {};
    if (inT > 0) timing.in = inT;
    if (outT < duration - 1e-3 && outT > inT) timing.out = outT;
    if (outT <= inT || outT <= 0 || inT >= duration) {
      c.st = prevSt;
      groups.push([]);
      continue;
    }
    const common: Partial<Layer> = { ...timing };
    if (L.nm && L.nm !== id) common.name = L.nm;
    if (L.hd || L.td) common.visible = false;
    if (L.parent !== undefined && byInd.has(L.parent)) common.parent = byInd.get(L.parent);
    if (L.bm && BLEND[L.bm]) common.blend = BLEND[L.bm];
    else if (L.bm) c.warnings.add("Some blend modes have no equivalent and were imported as normal");
    const fx = effectsOf(c, L);
    if (fx.length) common.effects = fx;

    let main: Layer;
    let offset: Vec2 = [0, 0];
    const extra: Layer[] = [];
    switch (L.ty) {
      case 1: {
        offset = [(L.sw ?? 0) / 2, (L.sh ?? 0) / 2];
        main = { id, type: "solid", color: L.sc ?? "#000000", size: [L.sw ?? 100, L.sh ?? 100], ...common, transform: transform(c, L.ks, offset) } as Layer;
        break;
      }
      case 2: {
        const asset = c.anim.assets?.find((a) => a.id === L.refId);
        const src = asset ? imageSrc(c, asset) : null;
        if (!asset || !src) {
          c.warnings.add("An image could not be imported (missing or external file)");
          main = { id, type: "null", ...common, transform: transform(c, L.ks) } as Layer;
          break;
        }
        offset = [(asset.w ?? 0) / 2, (asset.h ?? 0) / 2];
        main = { id, type: "image", src, size: [asset.w ?? 100, asset.h ?? 100], ...common, transform: transform(c, L.ks, offset) } as Layer;
        break;
      }
      case 0: {
        const asset = c.anim.assets?.find((a) => a.id === L.refId && a.layers);
        if (!asset) {
          main = { id, type: "null", ...common, transform: transform(c, L.ks) } as Layer;
          break;
        }
        const remap = L.tm ? read(c, L.tm, (v) => r3(v[0])) : undefined;
        const w = L.w ?? c.anim.w;
        const h = L.h ?? c.anim.h;
        const compId = precomp(c, asset, w, h);
        offset = [w / 2, h / 2];
        main = { id, type: "comp", comp: compId, ...common, transform: transform(c, L.ks, offset) } as Layer;
        // Ours: inner time = t − in + timeOffset. Lottie: inner frame = comp frame − st.
        const off = r3(inT + (c.ip - (L.st ?? 0)) / c.fr);
        if (remap !== undefined) (main as Extract<Layer, { type: "comp" }>).timeRemap = remap;
        else if (Math.abs(off) > 1e-3) (main as Extract<Layer, { type: "comp" }>).timeOffset = off;
        break;
      }
      case 3:
        main = { id, type: "null", ...common, transform: transform(c, L.ks) } as Layer;
        break;
      case 4: {
        // The shape layer becomes a null with its transform; shapes become child layers. When it
        // holds a single shape group, that shape takes the layer's place directly.
        const holder = { id, type: "null", ...common, transform: transform(c, L.ks) } as Layer;
        // Layer opacity goes to the shapes too: a null's opacity doesn't reach its children.
        const children = groupLayers(c, (L.shapes ?? []) as LShape[], id, {}, holder.transform?.opacity ?? 100, L.nm ?? id, timing);
        if (holder.transform) delete holder.transform.opacity;
        const merged = children.length === 1 ? mergeIntoHolder(holder, children[0]) : null;
        if (merged) {
          c.ids.delete(children[0].id);
          main = merged;
          const cp = children[0].transform?.position;
          if ((merged.type === "rect" || merged.type === "ellipse") && isStatic(cp)) offset = [-cp[0], -cp[1]];
        } else {
          main = holder;
          extra.push(...children);
        }
        break;
      }
      case 5: {
        const { layer, offset: o } = textLayer(c, L, id);
        offset = o;
        main = { ...layer, ...common, transform: transform(c, L.ks, o) } as Layer;
        break;
      }
      default:
        c.warnings.add(L.ty === 6 ? "Audio layers in Lottie files aren't imported" : L.ty === 13 ? "Cameras aren't supported (2D only)" : `Layer type ${L.ty} isn't supported`);
        main = { id, type: "null", ...common, transform: transform(c, L.ks) } as Layer;
    }
    if (main.type === "path" && main.transform && isStatic(main.transform.position) && !main.transform.position[0] && !main.transform.position[1]) delete main.transform.position;
    if (main.transform && !Object.keys(main.transform).length) delete main.transform;
    if (offset[0] || offset[1]) c.offsets.set(id, offset);
    const mask = maskMatte(c, L, id, timing);
    const list: Layer[] = [main, ...extra];
    if (mask) {
      const invert = (mask as { _invert?: boolean })._invert;
      delete (mask as { _invert?: boolean })._invert;
      // Masks clip the whole layer: apply the matte to every drawn part of it.
      for (const l of list) if (l.type !== "null") l.matte = { layer: mask.id, ...(invert ? { mode: "alphaInverted" as const } : {}) };
      list.unshift(mask);
    }
    groups.push(list);
    c.st = prevSt;
  }

  // Track mattes: the matted layer's drawn parts use the matte layer (or its first drawn part).
  layers.forEach((L, i) => {
    const matte = matteOf.get(L);
    if (!matte) return;
    const mGroup = groups[layers.indexOf(matte)];
    const target = mGroup.find((l) => l.type !== "null") ?? mGroup[0];
    if (!target) return;
    if (mGroup.filter((l) => l.type !== "null").length > 1) c.warnings.add("A matte made of several shapes uses only its first shape");
    for (const l of groups[i]) if (l.type !== "null" && !l.matte) l.matte = { layer: target.id, ...(L.tt === 2 || L.tt === 4 ? { mode: "alphaInverted" as const } : {}) };
    for (const l of mGroup) l.visible = false;
  });

  // Children of layers whose content origin differs: move them into our layer space.
  const all = groups.flat();
  for (const l of all) {
    const off = l.parent ? c.offsets.get(l.parent) : undefined;
    if (!off) continue;
    const pos = l.transform?.position ?? (l.type === "path" ? ([0, 0] as Vec2) : undefined);
    if (pos === undefined) continue;
    l.transform = { ...l.transform, position: mapAnim(pos, (v: Vec2) => [r3(v[0] - off[0]), r3(v[1] - off[1])] as Vec2) };
  }

  // Lottie lists top first; we draw the last layer on top.
  return groups.reverse().flat();
}

/**
 * A shape layer holding a single shape: give the shape the layer's own id and transform
 * instead of nesting it under a null. Only when the shape's own offset is static.
 */
function mergeIntoHolder(holder: Layer, child: Layer): Layer | null {
  if (child.type === "null") return null;
  const ct = child.transform ?? {};
  const keys = Object.keys(ct);
  if (keys.some((k) => k !== "position" && k !== "opacity")) return null;

  const ht = { ...(holder.transform ?? {}) };
  if (child.type === "rect" || child.type === "ellipse") {
    if (!isStatic(ct.position)) return null;
    const [px, py] = ct.position;
    if (px || py) ht.anchor = mapAnim(ht.anchor ?? ([0, 0] as Vec2), (a: Vec2) => [r3(a[0] - px), r3(a[1] - py)] as Vec2);
  } else if (ct.position !== undefined) return null;
  if (ct.opacity !== undefined) ht.opacity = ct.opacity;
  const { id, name, in: inT, out, visible, parent, blend, effects } = holder;
  const out2 = { ...child, id, ...(name ? { name } : {}), transform: ht } as Layer;
  delete (out2 as { parent?: string }).parent;
  return { ...out2, ...(inT !== undefined ? { in: inT } : {}), ...(out !== undefined ? { out } : {}), ...(visible === false ? { visible } : {}), ...(parent ? { parent } : {}), ...(blend ? { blend } : {}), ...(effects ? { effects } : {}) } as Layer;
}

function precomp(c: Ctx, asset: LAsset, w: number, h: number): string {
  const existing = c.precomps.get(asset.id);
  if (existing) return existing;
  const id = uniqueId(c, asset.nm ?? asset.id, "precomp");
  c.precomps.set(asset.id, id);
  const layers = asset.layers ?? [];
  const end = Math.max(1, ...layers.map((l) => l.op));
  const comp: Composition = { id, width: Math.round(w), height: Math.round(h), fps: c.fr, duration: r3(end / c.fr), layers: [] };
  c.comps.push(comp);
  const inner: Ctx = { ...c, ip: 0, st: 0 };
  comp.layers = convertLayers(inner, layers, comp.duration);
  if (asset.nm && asset.nm !== id) comp.name = asset.nm;
  return id;
}

function markersOf(anim: LottieAnimation): Marker[] {
  return (anim.markers ?? [])
    .map((m) => {
      let label = m.cm;
      try {
        const parsed = JSON.parse(m.cm);
        if (parsed && typeof parsed === "object" && typeof parsed.name === "string") label = parsed.name;
      } catch {
        // plain comment
      }
      return { t: r3((m.tm - anim.ip) / anim.fr), ...(label ? { label } : {}) };
    })
    .filter((m) => m.t >= 0)
    .sort((a, b) => a.t - b.t);
}

/** Converts a Lottie animation into an OpenEffects project. Throws if the file isn't Lottie. */
export function importLottie(input: unknown, opts: ImportOptions = {}): ImportResult {
  const anim = input as LottieAnimation;
  if (!anim || typeof anim !== "object" || !Array.isArray(anim.layers) || typeof anim.fr !== "number" || typeof anim.w !== "number") {
    throw new Error("Not a Lottie file: expected a JSON object with fr, w, h and layers");
  }
  const fr = anim.fr || 30;
  const duration = Math.max(1 / fr, r3((anim.op - anim.ip) / fr));
  const c: Ctx = { fr, ip: anim.ip ?? 0, warnings: new Set(), opts, anim, comps: [], ids: new Set(), st: 0, precomps: new Map(), styleCache: new Map(), offsets: new Map() };
  const mainId = opts.compId ?? "main";
  c.ids.add(mainId);
  let layers = anim.layers;
  let background: string | undefined;
  // Our own exports carry the background as the bottom layer: turn it back into the comp background.
  const bottom = layers[layers.length - 1];
  if ((anim.meta as { g?: string } | undefined)?.g === "OpenEffects" && bottom?.nm === "Background" && bottom.ty === 4) {
    const fl = ((bottom.shapes?.[0]?.it as LShape[] | undefined) ?? []).find((s) => s.ty === "fl");
    if (fl) {
      const col = read(c, fl.c as LProp, (v) => v);
      if (isStatic(col)) {
        background = color(col);
        layers = layers.slice(0, -1);
      }
    }
  }
  const main: Composition = {
    id: mainId,
    ...(anim.nm ? { name: anim.nm } : {}),
    width: Math.round(anim.w),
    height: Math.round(anim.h),
    fps: fr,
    duration,
    ...(background ? { background } : {}),
    layers: [],
  };
  const markers = markersOf(anim);
  if (markers.length) main.markers = markers;
  main.layers = convertLayers(c, layers, duration);
  if (anim.chars?.length) c.warnings.add("Embedded glyph shapes weren't used: text renders with the named fonts");
  const project: Project = { version: 1, ...(anim.nm ? { name: anim.nm } : {}), compositions: [main, ...c.comps] };
  const valid = validateProject(project);
  if (!valid.ok) throw new Error(`The converted project is invalid:\n${valid.errors.slice(0, 8).join("\n")}`);
  return { project, warnings: [...c.warnings] };
}

export type { Pt };
