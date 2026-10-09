import { animatorStates, layoutText, type TextLayout } from "@openeffects/engine";
import {
  applyBehaviors,
  easeToBezier,
  getComp,
  getIn,
  isKeyframed,
  parseColor,
  sample,
  setIn,
  type Animatable,
  type Composition,
  type Effect,
  type Fill,
  type Gradient,
  type Keyframe,
  type Layer,
  type Project,
  type Stroke,
  type Vec2,
} from "@openeffects/schema";
import { ellipsePath, rectPath, svgToLottie } from "./path.ts";
import type { LAsset, LFont, LKeyframe, LLayer, LProp, LShape, LottieAnimation, LTextDocument } from "./types.ts";

/*
 * OpenEffects project → Lottie JSON (bodymovin 5.x), playable by lottie-web, dotLottie,
 * ThorVG, the iOS/Android Lottie libraries and LottieFiles.
 *
 * Mapping notes:
 * - Transforms are the same model (translate · rotate · scale · −anchor), so they map 1:1.
 *   Our content is centered on the layer origin where Lottie's starts top-left (solids,
 *   images, precomps): the anchor absorbs the difference.
 * - Bezier-representable easings become Lottie bezier keyframes; elastic and bounce
 *   segments are baked into per-frame keyframes. Behaviors and text animators are baked
 *   too, and redundant baked keyframes are dropped.
 * - Video and audio have no Lottie equivalent: they become empty (null) layers so
 *   parenting keeps working, and are reported as warnings. So are glow and color adjust.
 */

export interface ExportOptions {
  compId?: string;
  /** A 2D context with the project's fonts loaded: exact text placement and per-letter animators. */
  ctx?: CanvasRenderingContext2D;
  /** Embeds images: returns a data: URL and the natural size, or null when missing. */
  readImage?: (src: string) => { dataUrl: string; width: number; height: number } | null;
}

export interface ExportResult {
  lottie: LottieAnimation;
  warnings: string[];
}

const BLEND: Record<string, number> = { normal: 0, multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5, difference: 10, add: 16 };

const r3 = (n: number) => Math.round(n * 1000) / 1000;

interface Ctx {
  project: Project;
  fps: number;
  warnings: Set<string>;
  assets: LAsset[];
  fonts: Map<string, LFont>;
  opts: ExportOptions;
  /** Frames subtracted from keyframe times of the layer being converted (its `st`). */
  shift: number;
  /** Lottie layer-space origin relative to ours, per layer index (see `anchorOffset`). */
  offsets: Map<number, Vec2>;
}

// ---------------------------------------------------------------- properties

function rgba(color: string): [number, number, number, number] {
  const c = parseColor(color) ?? [255, 255, 255, 1];
  return [r3(c[0] / 255), r3(c[1] / 255), r3(c[2] / 255), c[3]];
}

/** Converts an animatable value to a Lottie property, keeping easing where Lottie can express it. */
function prop<T>(c: Ctx, value: Animatable<T> | undefined, fallback: T, conv: (v: T) => number[]): LProp {
  const flat = (v: number[]): number | number[] => (v.length === 1 ? v[0] : v);
  if (!isKeyframed(value as Animatable<unknown>)) return { a: 0, k: flat(conv(sample(value, 0, fallback)).map(r3)) };
  const kfs = [...(value as { keyframes: Keyframe<T>[] }).keyframes].sort((a, b) => a.t - b.t);
  if (kfs.length === 1) return { a: 0, k: flat(conv(kfs[0].v).map(r3)) };
  const frame = (t: number) => r3(t * c.fps - c.shift);
  const out: LKeyframe[] = [];
  const dims = conv(kfs[0].v).length;
  const rep = (n: number) => Array(dims).fill(r3(n));
  const linear = { o: { x: rep(0), y: rep(0) }, i: { x: rep(1), y: rep(1) } };
  kfs.forEach((kf, i) => {
    const s = conv(kf.v).map(r3);
    if (i === kfs.length - 1) return out.push({ t: frame(kf.t), s });
    if (kf.ease === "hold") return out.push({ t: frame(kf.t), s, h: 1 });
    const bez = easeToBezier(kf.ease);
    if (bez) return out.push({ t: frame(kf.t), s, o: { x: rep(bez[0]), y: rep(bez[1]) }, i: { x: rep(bez[2]), y: rep(bez[3]) } });
    // Elastic / bounce: bake the segment frame by frame.
    const next = kfs[i + 1].t;
    for (let t = kf.t; t < next - 1e-6; t += 1 / c.fps) out.push({ t: frame(t), s: conv(sample(value, t, fallback)).map(r3), ...linear });
  });
  return { a: 1, k: out };
}

/** A property from per-frame samples (baked), with redundant keyframes dropped. */
function baked(c: Ctx, from: number, to: number, fn: (t: number) => number[]): LProp {
  const times: number[] = [];
  for (let f = Math.floor(from * c.fps); f <= Math.ceil(to * c.fps); f++) times.push(f / c.fps);
  const pts = times.map((t) => ({ t, v: fn(t).map(r3) }));
  const keep = simplify(pts);
  if (keep.length === 1) return { a: 0, k: keep[0].v.length === 1 ? keep[0].v[0] : keep[0].v };
  const dims = keep[0].v.length;
  const rep = (n: number) => Array(dims).fill(n);
  return {
    a: 1,
    k: keep.map((p, i) => (i === keep.length - 1 ? { t: r3(p.t * c.fps - c.shift), s: p.v } : { t: r3(p.t * c.fps - c.shift), s: p.v, o: { x: rep(0), y: rep(0) }, i: { x: rep(1), y: rep(1) } })),
  };
}

/** Drops samples that linear interpolation of their neighbours reproduces. */
function simplify(pts: { t: number; v: number[] }[], tol = 0.02): { t: number; v: number[] }[] {
  if (pts.length <= 2) {
    const same = pts.length === 2 && pts[0].v.every((x, i) => Math.abs(x - pts[1].v[i]) <= tol);
    return same ? [pts[0]] : pts;
  }
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i + 1];
    // Keep a point if dropping it would bend any sample in between beyond the tolerance.
    let needed = false;
    for (let j = pts.indexOf(a) + 1; j <= i && !needed; j++) {
      const q = (pts[j].t - a.t) / (b.t - a.t);
      needed = pts[j].v.some((x, d) => Math.abs(a.v[d] + (b.v[d] - a.v[d]) * q - x) > tol);
    }
    if (needed) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  if (out.every((p) => p.v.every((x, d) => Math.abs(x - out[0].v[d]) <= tol))) return [out[0]];
  return out;
}

const num = (v: number) => [v];
const vec3 = (v: Vec2) => [v[0], v[1], 0];
const scale3 = (v: number | Vec2) => (Array.isArray(v) ? [v[0], v[1], 100] : [v, v, 100]);

// ---------------------------------------------------------------- paint

function fillItems(c: Ctx, fill: Fill | undefined, w: number, h: number): LShape[] {
  if (fill === undefined) return [];
  if (typeof fill === "string" || "keyframes" in fill) {
    return [
      {
        ty: "fl",
        nm: "Fill",
        c: prop(c, fill, "#ffffff", (v) => rgba(v).slice(0, 3).concat(1)),
        o: prop(c, fill, "#ffffff", (v) => [rgba(v)[3] * 100]),
        r: 1,
        bm: 0,
      },
    ];
  }
  return [gradientItem(fill, w, h)];
}

function gradientItem(g: Gradient, w: number, h: number): LShape {
  const stops = [...g.stops].sort((a, b) => a[0] - b[0]);
  const colors = stops.flatMap(([o, col]) => [o, ...rgba(col).slice(0, 3)]);
  const alphas = stops.some(([, col]) => rgba(col)[3] < 1) ? stops.flatMap(([o, col]) => [o, rgba(col)[3]]) : [];
  let s: Vec2;
  let e: Vec2;
  if (g.type === "linear") {
    s = g.from ?? [-w / 2, 0];
    e = g.to ?? [w / 2, 0];
  } else {
    s = g.center ?? [0, 0];
    e = [s[0] + (g.radius ?? Math.max(Math.abs(w), Math.abs(h)) / 2), s[1]];
  }
  return {
    ty: "gf",
    nm: "Gradient Fill",
    o: { a: 0, k: 100 },
    r: 1,
    bm: 0,
    g: { p: stops.length, k: { a: 0, k: [...colors, ...alphas].map(r3) } },
    s: { a: 0, k: s.map(r3) },
    e: { a: 0, k: e.map(r3) },
    t: g.type === "linear" ? 1 : 2,
    h: { a: 0, k: 0 },
    a: { a: 0, k: 0 },
  };
}

function strokeItem(c: Ctx, stroke: Stroke): LShape {
  return {
    ty: "st",
    nm: "Stroke",
    c: prop(c, stroke.color, "#ffffff", (v) => rgba(v).slice(0, 3).concat(1)),
    o: prop(c, stroke.color, "#ffffff", (v) => [rgba(v)[3] * 100]),
    w: prop(c, stroke.width, 4, num),
    lc: { butt: 1, round: 2, square: 3 }[stroke.cap ?? "butt"],
    lj: { miter: 1, round: 2, bevel: 3 }[stroke.join ?? "miter"],
    ml: 4,
    bm: 0,
  };
}

const groupTransform = (): LShape => ({
  ty: "tr",
  p: { a: 0, k: [0, 0] },
  a: { a: 0, k: [0, 0] },
  s: { a: 0, k: [100, 100] },
  r: { a: 0, k: 0 },
  o: { a: 0, k: 100 },
  sk: { a: 0, k: 0 },
  sa: { a: 0, k: 0 },
});
const group = (nm: string, items: LShape[]): LShape => ({ ty: "gr", nm, it: [...items, groupTransform()], np: items.length, bm: 0 });

// ---------------------------------------------------------------- layers

function baseLayer(c: Ctx, layer: Layer, comp: Composition, ind: number, ty: number, anchorOffset: Vec2 = [0, 0]): LLayer {
  const tr = layer.transform ?? {};
  const defaultPos: Vec2 = layer.type === "path" ? [0, 0] : [comp.width / 2, comp.height / 2];
  const l: LLayer = {
    ddd: 0,
    ind,
    ty,
    nm: layer.name ?? layer.id,
    ln: layer.id,
    sr: 1,
    ks: {
      o: prop(c, tr.opacity, 100, num),
      r: prop(c, tr.rotation, 0, num),
      p: prop(c, tr.position, defaultPos, vec3),
      a: prop(c, tr.anchor, [0, 0] as Vec2, (v) => vec3([v[0] + anchorOffset[0], v[1] + anchorOffset[1]])),
      s: prop(c, tr.scale, 100 as number | Vec2, scale3),
    },
    ao: 0,
    ip: r3((layer.in ?? 0) * c.fps),
    op: r3((layer.out ?? comp.duration) * c.fps),
    st: 0,
    bm: BLEND[layer.blend ?? "normal"] ?? 0,
  };
  if (layer.blend && !(layer.blend in BLEND)) c.warnings.add(`Blend mode "${layer.blend}" exported as normal`);
  if (layer.visible === false) l.hd = true;
  const ef = effects(c, layer.effects ?? []);
  if (ef.length) l.ef = ef;
  if (anchorOffset[0] || anchorOffset[1]) c.offsets.set(ind, anchorOffset);
  return l;
}

/** Adds an offset to a position property (static or keyframed). */
function shiftPosition(p: LProp, dx: number, dy: number): LProp {
  const add = (v: number[]) => [r3(v[0] + dx), r3(v[1] + dy), ...v.slice(2)];
  if (p.a === 0 || !Array.isArray(p.k) || typeof p.k[0] === "number") return { ...p, k: add(p.k as number[]) };
  return { ...p, k: (p.k as LKeyframe[]).map((kf) => ({ ...kf, ...(kf.s ? { s: add(kf.s) } : {}) })) };
}

function effects(c: Ctx, list: Effect[]): NonNullable<LLayer["ef"]> {
  const out: NonNullable<LLayer["ef"]> = [];
  for (const fx of list) {
    if (fx.type === "blur") {
      out.push({
        ty: 29,
        nm: "Gaussian Blur",
        mn: "ADBE Gaussian Blur 2",
        en: 1,
        ef: [
          // lottie-web uses blurriness × 0.3 as the SVG standard deviation; ours is a CSS blur radius.
          { ty: 0, nm: "Blurriness", v: prop(c, fx.radius, 0, (v) => [v / 0.3]) },
          { ty: 7, nm: "Blur Dimensions", v: { a: 0, k: 1 } },
          { ty: 7, nm: "Repeat Edge Pixels", v: { a: 0, k: 0 } },
        ],
      });
    } else if (fx.type === "dropShadow") {
      out.push({
        ty: 25,
        nm: "Drop Shadow",
        mn: "ADBE Drop Shadow",
        en: 1,
        ef: [
          { ty: 2, nm: "Shadow Color", v: prop(c, fx.color, "rgba(0,0,0,0.5)", (v) => rgba(v).slice(0, 3).concat(1)) },
          { ty: 0, nm: "Opacity", v: prop(c, fx.color, "rgba(0,0,0,0.5)", (v) => [rgba(v)[3] * 255]) },
          // Ours: 135° = down-right with (−cos, sin); After Effects: (cos, sin) of (angle − 90°).
          { ty: 1, nm: "Direction", v: prop(c, fx.angle, 135, (v) => [270 - v]) },
          { ty: 0, nm: "Distance", v: prop(c, fx.distance, 10, num) },
          { ty: 0, nm: "Softness", v: prop(c, fx.softness, 20, (v) => [v * 2]) },
        ],
      });
    } else c.warnings.add(`The ${fx.type === "glow" ? "glow" : "color adjust"} effect has no Lottie equivalent and was left out`);
  }
  return out;
}

function shapeLayer(c: Ctx, layer: Layer, comp: Composition, ind: number): LLayer {
  const l = baseLayer(c, layer, comp, ind, 4);
  const t0 = 0;
  let shapes: LShape[] = [];
  switch (layer.type) {
    case "solid": {
      const [w, h] = sample(layer.size, t0, [comp.width, comp.height] as Vec2);
      shapes = [group("Solid", [{ ty: "rc", nm: "Rect", p: { a: 0, k: [0, 0] }, s: prop(c, layer.size, [comp.width, comp.height] as Vec2, (v) => v), r: { a: 0, k: 0 } }, ...fillItems(c, layer.color, w, h)])];
      break;
    }
    case "rect":
    case "ellipse": {
      const [w, h] = sample(layer.size, t0, [100, 100] as Vec2);
      const fill = layer.fill === undefined && layer.stroke === undefined ? "#ffffff" : layer.fill;
      const geo: LShape =
        layer.type === "rect"
          ? { ty: "rc", nm: "Rect", p: { a: 0, k: [0, 0] }, s: prop(c, layer.size, [100, 100] as Vec2, (v) => v), r: prop(c, layer.radius, 0, num) }
          : { ty: "el", nm: "Ellipse", p: { a: 0, k: [0, 0] }, s: prop(c, layer.size, [100, 100] as Vec2, (v) => v) };
      // Lottie draws the first item on top: stroke before fill (ours strokes over the fill).
      shapes = [group(layer.type === "rect" ? "Rectangle" : "Ellipse", [geo, ...(layer.stroke ? [strokeItem(c, layer.stroke)] : []), ...fillItems(c, fill, w, h)])];
      break;
    }
    case "path": {
      const paths = pathItems(c, layer.d);
      const stroke = layer.stroke ?? (layer.fill === undefined ? { color: "#ffffff" } : undefined);
      const trimmed = layer.trim && (isKeyframed(layer.trim.start) || isKeyframed(layer.trim.end) || sample(layer.trim.start, 0, 0) > 0 || sample(layer.trim.end, 0, 100) < 100);
      const fills = fillItems(c, layer.fill, 200, 200);
      if (trimmed && stroke) {
        // Trim paths only shorten the stroke in OpenEffects: trim a separate stroke group.
        const tm: LShape = { ty: "tm", nm: "Trim Paths", s: prop(c, layer.trim!.start, 0, num), e: prop(c, layer.trim!.end, 100, num), o: { a: 0, k: 0 }, m: 1 };
        shapes = [group("Stroke", [...paths, tm, strokeItem(c, stroke)]), ...(fills.length ? [group("Fill", [...paths, ...fills])] : [])];
      } else shapes = [group("Path", [...paths, ...(stroke ? [strokeItem(c, stroke)] : []), ...fills])];
      break;
    }
  }
  l.shapes = shapes;
  return l;
}

/** Path items; a keyframed `d` becomes animated Lottie shapes (path morphing). */
function pathItems(c: Ctx, d: Animatable<string>): LShape[] {
  if (!isKeyframed(d)) return svgToLottie(d).map((b, i) => ({ ty: "sh", nm: `Path ${i + 1}`, ks: { a: 0, k: b } }));
  const kfs = [...d.keyframes].sort((a, b) => a.t - b.t);
  const shapes = kfs.map((k) => svgToLottie(k.v));
  const same = shapes.every((s) => s.length === shapes[0].length && s.every((b, j) => b.v.length === shapes[0][j].v.length && b.c === shapes[0][j].c));
  if (!same) {
    c.warnings.add("A path morph whose keyframes have different points exports as its first shape");
    return pathItems(c, kfs[0].v);
  }
  const frame = (t: number) => r3(t * c.fps - c.shift);
  const linear = { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } };
  return shapes[0].map((_, j) => {
    const k: unknown[] = [];
    kfs.forEach((kf, i) => {
      const s = [shapes[i][j]];
      if (i === kfs.length - 1) return k.push({ t: frame(kf.t), s });
      if (kf.ease === "hold") return k.push({ t: frame(kf.t), s, h: 1 });
      const bez = easeToBezier(kf.ease);
      if (bez) return k.push({ t: frame(kf.t), s, o: { x: [bez[0]], y: [bez[1]] }, i: { x: [bez[2]], y: [bez[3]] } });
      for (let t = kf.t; t < kfs[i + 1].t - 1e-6; t += 1 / c.fps) k.push({ t: frame(t), s: [svgToLottie(sample(d, t, kf.v))[j]], ...linear });
    });
    return { ty: "sh", nm: `Path ${j + 1}`, ks: { a: 1, k } };
  });
}

const STYLE_NAMES: [number, string][] = [
  [200, "Thin"],
  [350, "Light"],
  [450, "Regular"],
  [550, "Medium"],
  [800, "Bold"],
  [1000, "Black"],
];

function fontFor(c: Ctx, layer: Extract<Layer, { type: "text" }>): string {
  const family = layer.font?.family ?? "Inter";
  const weight = layer.font?.weight ?? 700;
  const italic = layer.font?.style === "italic";
  const style = (STYLE_NAMES.find(([w]) => weight <= w)?.[1] ?? "Bold") + (italic ? " Italic" : "");
  const fName = `${family.replace(/[^A-Za-z0-9]/g, "")}-${style.replace(/ /g, "")}`;
  if (!c.fonts.has(fName)) c.fonts.set(fName, { fName, fFamily: family, fStyle: style, fWeight: String(weight), ascent: 72, fOrigin: "n" });
  return fName;
}

function textDocument(c: Ctx, layer: Extract<Layer, { type: "text" }>, text: string, justify: number): LTextDocument {
  const size = sample(layer.font?.size, 0, 96);
  const fill = layer.fill ?? "#ffffff";
  let fc: number[];
  if (typeof fill === "string") fc = rgba(fill).slice(0, 3);
  else if ("keyframes" in fill) {
    fc = rgba(fill.keyframes[0].v).slice(0, 3);
    c.warnings.add("Animated text colors export as their first color");
  } else {
    fc = rgba(fill.stops[0][1]).slice(0, 3);
    c.warnings.add("Gradient text exports as a solid color (Lottie text has no gradient fill)");
  }
  if (isKeyframed(layer.font?.size)) c.warnings.add("Animated font size exports as its first value (animate scale instead)");
  const doc: LTextDocument = {
    s: r3(size),
    f: fontFor(c, layer),
    t: text.replace(/\n/g, "\r"),
    j: justify,
    tr: r3((sample(layer.letterSpacing, 0, 0) / size) * 1000),
    lh: r3(size * (layer.lineHeight ?? 1.2)),
    ls: 0,
    fc,
  };
  if (layer.stroke) {
    doc.sc = rgba(sample(layer.stroke.color, 0, "#ffffff")).slice(0, 3);
    doc.sw = r3(sample(layer.stroke.width, 0, 4));
    doc.of = true;
  }
  return doc;
}

function textLayout(c: Ctx, layer: Extract<Layer, { type: "text" }>): TextLayout | null {
  if (!c.opts.ctx) return null;
  try {
    return layoutText(c.opts.ctx, layer, 0);
  } catch {
    return null;
  }
}

/** Text layers: one Lottie text layer, or one per animated unit when the layer has an animator. */
function textLayers(c: Ctx, layer: Extract<Layer, { type: "text" }>, comp: Composition, nextInd: () => number): LLayer[] {
  const align = layer.align ?? "center";
  const justify = align === "left" ? 0 : align === "right" ? 1 : 2;
  const layout = textLayout(c, layer);
  const size = sample(layer.font?.size, 0, 96);
  const width = layout?.width ?? 0;
  const firstBaseline = layout?.lines[0]?.y ?? (-(layer.text.split("\n").length * size * (layer.lineHeight ?? 1.2)) / 2 + (size * (layer.lineHeight ?? 1.2)) / 2 + size * 0.36);
  if (!layout && align !== "center") c.warnings.add("Left/right aligned text may be offset: export from the editor or CLI for exact text placement");

  if (!layer.animator || !layout) {
    if (layer.animator) c.warnings.add("Text animators need the editor or CLI export (fonts); exported without the animation");
    const dx = justify === 0 ? width / 2 : justify === 1 ? -width / 2 : 0;
    const l = baseLayer(c, layer, comp, nextInd(), 5, [dx, -firstBaseline]);
    l.t = { d: { k: [{ s: textDocument(c, layer, layer.text, justify), t: 0 }] }, p: {}, m: { g: 1, a: { a: 0, k: [0, 0] } }, a: [] };
    return [l];
  }

  // Animated text: a null carries the layer transform; each unit is its own text layer.
  if (layer.animator.from?.blur) c.warnings.add("Per-letter blur in text animators has no Lottie equivalent and was left out");
  const holder = baseLayer(c, { ...layer, transform: { ...layer.transform, opacity: 100 }, effects: undefined }, comp, nextInd(), 3);
  holder.nm = `${layer.name ?? layer.id} (text)`;
  const by = layer.animator.by ?? "character";
  const units = new Map<number, TextLayout["glyphs"]>();
  let charIndex = 0;
  for (const g of layout.glyphs) {
    if (!g.ch.trim()) continue;
    const u = by === "line" ? g.line : by === "word" ? g.word : charIndex;
    charIndex++;
    units.set(u, [...(units.get(u) ?? []), g]);
  }
  const keys = [...units.keys()].sort((a, b) => a - b);
  const lineH = layout.lines.length ? layout.height / layout.lines.length : 0;
  const start = layer.in ?? 0;
  const end = layer.out ?? comp.duration;
  const out: LLayer[] = [holder];
  keys.forEach((key, i) => {
    const glyphs = units.get(key)!;
    const x0 = Math.min(...glyphs.map((g) => g.x));
    const x1 = Math.max(...glyphs.map((g) => g.x + g.width));
    const cx = (x0 + x1) / 2;
    const cy = glyphs.reduce((a, g) => a + g.y, 0) / glyphs.length - lineH * 0.3;
    const baseline = glyphs[0].y;
    const state = (t: number) => animatorStates(layer, keys.length, t)[i];
    const l: LLayer = {
      ddd: 0,
      ind: nextInd(),
      ty: 5,
      nm: glyphs.map((g) => g.ch).join(""),
      sr: 1,
      parent: holder.ind,
      ks: {
        o: baked(c, start, end, (t) => [state(t).opacity * sample(layer.transform?.opacity, t, 100)]),
        r: baked(c, start, end, (t) => [state(t).rotation]),
        p: baked(c, start, end, (t) => [cx + state(t).dx, cy + state(t).dy, 0]),
        a: { a: 0, k: [r3(cx - x0), r3(cy - baseline), 0] },
        s: baked(c, start, end, (t) => [state(t).scale * 100, state(t).scale * 100, 100]),
      },
      ao: 0,
      ip: r3(start * c.fps),
      op: r3(end * c.fps),
      st: 0,
      bm: BLEND[layer.blend ?? "normal"] ?? 0,
    };
    if (layer.visible === false) l.hd = true;
    const ef = effects(c, layer.effects ?? []);
    if (ef.length) l.ef = ef;
    const text = glyphs.map((g) => g.ch).join("");
    l.t = { d: { k: [{ s: textDocument(c, { ...layer, text }, text, 0), t: 0 }] }, p: {}, m: { g: 1, a: { a: 0, k: [0, 0] } }, a: [] };
    out.push(l);
  });
  return out;
}

function imageLayer(c: Ctx, layer: Extract<Layer, { type: "image" }>, comp: Composition, ind: number): LLayer {
  const img = c.opts.readImage?.(layer.src) ?? null;
  if (!img) {
    c.warnings.add(`Image ${layer.src} could not be embedded`);
    return baseLayer(c, layer, comp, ind, 3);
  }
  if (isKeyframed(layer.size)) c.warnings.add("Animated image sizes export as their first size (animate scale instead)");
  const [w, h] = sample(layer.size, 0, [img.width, img.height] as Vec2);
  const id = `image_${c.assets.filter((a) => a.id.startsWith("image_")).length}`;
  c.assets.push({ id, w: Math.round(w), h: Math.round(h), u: "", p: img.dataUrl, e: 1 });
  const l = baseLayer(c, layer, comp, ind, 2, [w / 2, h / 2]);
  l.refId = id;
  return l;
}

/** Bakes behaviors into keyframes so Lottie players get the same motion. */
function bakeBehaviors(c: Ctx, layer: Layer, comp: Composition): Layer {
  const list = (layer.behaviors ?? []).filter((b) => b.enabled !== false);
  if (!list.length) return layer.behaviors ? { ...layer, behaviors: undefined } : layer;
  const raw = new Map(comp.layers.map((l) => [l.id, l]));
  let out: Layer = { ...layer, behaviors: undefined };
  for (const path of new Set(list.map((b) => b.property))) {
    const pts: { t: number; v: number[] }[] = [];
    const start = layer.in ?? 0;
    const end = layer.out ?? comp.duration;
    for (let f = Math.floor(start * c.fps); f <= Math.ceil(end * c.fps); f++) {
      const t = f / c.fps;
      const v = getIn(applyBehaviors(layer, t, comp, (id) => raw.get(id)), path) as number | number[];
      pts.push({ t, v: Array.isArray(v) ? v.map(r3) : [r3(v)] });
    }
    const keep = simplify(pts);
    const scalar = !Array.isArray(getIn(applyBehaviors(layer, start, comp, (id) => raw.get(id)), path));
    out = setIn(out, path, { keyframes: keep.map((p) => ({ t: r3(p.t), v: scalar ? p.v[0] : p.v, ease: "linear" })) });
  }
  return out;
}

function compLayers(c: Ctx, comp: Composition): LLayer[] {
  // Indices: one per layer, plus extra ones for matte copies and text units.
  let ind = comp.layers.length;
  const nextInd = () => ++ind;
  const indOf = new Map(comp.layers.map((l, i) => [l.id, i + 1]));
  const converted = new Map<string, LLayer[]>();

  for (const original of comp.layers) {
    const layer = bakeBehaviors(c, original, comp);
    const i = indOf.get(layer.id)!;
    let out: LLayer[];
    switch (layer.type) {
      case "solid":
      case "rect":
      case "ellipse":
      case "path":
        out = [shapeLayer(c, layer, comp, i)];
        break;
      case "text": {
        // The first produced layer takes the layer's own index, so children and mattes still find it.
        let first = true;
        out = textLayers(c, layer, comp, () => (first ? ((first = false), i) : nextInd()));
        break;
      }
      case "image":
        out = [imageLayer(c, layer, comp, i)];
        break;
      case "null":
        out = [baseLayer(c, layer, comp, i, 3)];
        break;
      case "comp": {
        const inner = c.project.compositions.find((x) => x.id === layer.comp);
        if (!inner) {
          out = [baseLayer(c, layer, comp, i, 3)];
          break;
        }
        if (!c.assets.some((a) => a.id === inner.id)) {
          c.assets.push({ id: inner.id, nm: inner.name ?? inner.id, fr: c.fps, layers: [] });
          const asset = c.assets.find((a) => a.id === inner.id)!;
          asset.layers = compLayers({ ...c, shift: 0, offsets: new Map() }, inner);
        }
        // Layer keyframes in Lottie are relative to the layer's start time.
        const st = r3(((layer.in ?? 0) - (layer.timeOffset ?? 0)) * c.fps);
        const l = baseLayer({ ...c, shift: st }, layer, comp, i, 0, [inner.width / 2, inner.height / 2]);
        l.refId = inner.id;
        if (layer.timeRemap !== undefined) l.tm = prop({ ...c, shift: st }, layer.timeRemap, 0, num);
        l.w = inner.width;
        l.h = inner.height;
        l.st = st;
        out = [l];
        break;
      }
      case "video":
      case "audio":
        c.warnings.add(`${layer.type === "video" ? "Video" : "Audio"} layers can't be part of a Lottie file and were left out`);
        out = [{ ...baseLayer(c, layer, comp, i, 3), hd: true }];
        break;
    }
    if (layer.parent) for (const l of out) if (l.parent === undefined && l.ind === i) l.parent = indOf.get(layer.parent);
    converted.set(layer.id, out);
  }

  // Children of layers whose Lottie content starts elsewhere (top-left, baseline): Lottie
  // positions children relative to the parent's layer-space origin.
  for (const list of converted.values()) {
    for (const l of list) {
      const off = l.parent !== undefined ? c.offsets.get(l.parent) : undefined;
      if (off && l.ks.p) l.ks.p = shiftPosition(l.ks.p as LProp, off[0], off[1]);
    }
  }

  // Lottie lists the top layer first; ours draws the last layer on top.
  const result: LLayer[] = [];
  for (const layer of [...comp.layers].reverse()) {
    const own = converted.get(layer.id)!;
    if (layer.matte && converted.has(layer.matte.layer)) {
      // A Lottie matte must sit directly above its layer: insert a copy of the matte there.
      const src = converted.get(layer.matte.layer)!;
      const copies = src.map((l) => ({ ...structuredClone(l), ind: nextInd(), hd: false, td: 1, nm: `${l.nm} (matte)` }));
      const remap = new Map(src.map((l, k) => [l.ind, copies[k].ind]));
      for (const cp of copies) if (cp.parent !== undefined && remap.has(cp.parent)) cp.parent = remap.get(cp.parent);
      if (copies.length > 1) c.warnings.add("Animated text used as a matte: only its first part is used as the matte");
      result.push(copies.length > 1 ? copies[1] : copies[0]);
      for (const l of own) {
        l.tt = layer.matte.mode === "alphaInverted" ? 2 : 1;
        l.tp = (copies.length > 1 ? copies[1] : copies[0]).ind;
      }
      if (own.length > 1) c.warnings.add("A matte on animated text applies to its first letter group only");
      // Parent layers referenced by the copy must exist: the holder of animated text stays in place.
    }
    // Units after their holder so they're drawn in reading order; holder (null) first.
    result.push(...[...own].reverse().sort((a, b) => (a.ty === 3 ? -1 : b.ty === 3 ? 1 : 0)));
  }
  return result;
}

/** Converts a project's composition (and everything it nests) to a Lottie animation. */
export function exportLottie(project: Project, opts: ExportOptions = {}): ExportResult {
  const comp = getComp(project, opts.compId);
  const c: Ctx = { project, fps: comp.fps, warnings: new Set(), assets: [], fonts: new Map(), opts, shift: 0, offsets: new Map() };
  const layers = compLayers(c, comp);
  const lottie: LottieAnimation = {
    v: "5.12.1",
    fr: comp.fps,
    ip: 0,
    op: r3(comp.duration * comp.fps),
    w: comp.width,
    h: comp.height,
    nm: comp.name ?? project.name ?? comp.id,
    ddd: 0,
    assets: c.assets,
    layers,
    markers: (comp.markers ?? []).map((m) => ({ tm: r3(m.t * comp.fps), cm: m.label ?? "", dr: 0 })),
    meta: { g: "OpenEffects" },
  };
  if (c.fonts.size) lottie.fonts = { list: [...c.fonts.values()] };
  if (comp.background) {
    // Lottie has no background color: add a full-frame solid at the bottom.
    lottie.layers.push({
      ddd: 0,
      ind: 0,
      ty: 4,
      nm: "Background",
      sr: 1,
      ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [comp.width / 2, comp.height / 2, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
      ao: 0,
      ip: 0,
      op: lottie.op,
      st: 0,
      bm: 0,
      shapes: [group("Background", [{ ty: "rc", nm: "Rect", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [comp.width, comp.height] }, r: { a: 0, k: 0 } }, ...fillItems(c, comp.background, comp.width, comp.height)])],
    });
    lottie.layers[lottie.layers.length - 1].ind = Math.max(0, ...lottie.layers.map((l) => l.ind ?? 0)) + 1;
  }
  return { lottie, warnings: [...c.warnings] };
}
