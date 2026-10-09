import { svgPathProperties } from "svg-path-properties";
import {
  applyBehaviors,
  getComp,
  mediaSourceTime,
  sample,
  type Composition,
  type Effect,
  type Fill,
  type Layer,
  type Project,
  type Stroke,
  type Vec2,
} from "@openeffects/schema";
import { SurfacePool, resetContext, type RenderEnv, type Surface } from "./env.ts";
import { IDENTITY, mul, rotate, scale, scaleFactor, translate, type Mat } from "./matrix.ts";
import { animatorStates, layoutText } from "./text.ts";
import type { LayerOf, PathLayer, TextLayer } from "./types.ts";

export interface RenderOptions {
  compId?: string;
  /** Composition time in seconds. */
  time: number;
  /** Output pixels per composition pixel. Default 1. */
  scale?: number;
}

interface Frame {
  project: Project;
  env: RenderEnv;
  pool: SurfacePool;
  depth: number;
}

const BLEND: Record<string, GlobalCompositeOperation> = {
  normal: "source-over",
  add: "lighter",
  screen: "screen",
  multiply: "multiply",
  overlay: "overlay",
  lighten: "lighten",
  darken: "darken",
  difference: "difference",
};

const pools = new WeakMap<RenderEnv, SurfacePool>();

/**
 * Render one frame of a composition into `ctx`. The canvas should be
 * comp.width*scale × comp.height*scale pixels. Deterministic: the same input always
 * produces the same pixels (given the same fonts and images).
 */
export function renderFrame(ctx: CanvasRenderingContext2D, project: Project, opts: RenderOptions, env: RenderEnv): void {
  const comp = getComp(project, opts.compId);
  const s = opts.scale ?? 1;
  let pool = pools.get(env);
  if (!pool) pools.set(env, (pool = new SurfacePool(env)));
  const frame: Frame = { project, env, pool, depth: 0 };
  const w = Math.round(comp.width * s);
  const h = Math.round(comp.height * s);
  resetContext(ctx);
  ctx.clearRect(0, 0, w, h);
  renderComp(ctx, frame, comp, opts.time, scale(s, s), w, h);
}

/** Draws a composition. `base` maps composition coordinates to pixels of `ctx`, which is viewW×viewH. */
function renderComp(ctx: CanvasRenderingContext2D, frame: Frame, comp: Composition, t: number, base: Mat, viewW: number, viewH: number): void {
  if (frame.depth > 8) return; // guards against precomp cycles
  if (comp.background) {
    ctx.save();
    ctx.setTransform(...base);
    ctx.fillStyle = sample(comp.background, t, "transparent");
    ctx.fillRect(0, 0, comp.width, comp.height);
    ctx.restore();
  }
  const layers = resolveLayers(comp, t);
  const byId = new Map(layers.map((l) => [l.id, l]));
  const matrices = new Map<string, Mat>();
  const worldMatrix = (layer: Layer): Mat => {
    const cached = matrices.get(layer.id);
    if (cached) return cached;
    const parent = layer.parent ? byId.get(layer.parent) : undefined;
    const m = mul(parent ? worldMatrix(parent) : IDENTITY, localMatrix(layer, comp, t));
    matrices.set(layer.id, m);
    return m;
  };
  const scene: Scene = { comp, t, base, byId, worldMatrix, viewW, viewH };
  for (const layer of layers) {
    if (layer.visible === false || !isActive(layer, comp, t)) continue;
    compositeLayer(ctx, frame, scene, layer);
  }
}

/** The composition's layers at time t with behaviors evaluated (follow reads the raw leaders). */
export function resolveLayers(comp: Composition, t: number): Layer[] {
  if (!comp.layers.some((l) => l.behaviors?.length)) return comp.layers;
  const raw = new Map(comp.layers.map((l) => [l.id, l]));
  return comp.layers.map((l) => (l.behaviors?.length ? applyBehaviors(l, t, comp, (id) => raw.get(id)) : l));
}

interface Scene {
  comp: Composition;
  t: number;
  /** Composition coordinates → pixels of the current target. */
  base: Mat;
  /** Pixel size of the current target. */
  viewW: number;
  viewH: number;
  byId: Map<string, Layer>;
  worldMatrix(layer: Layer): Mat;
}

export function isActive(layer: Layer, comp: Composition, t: number): boolean {
  return t >= (layer.in ?? 0) && t < (layer.out ?? comp.duration);
}

function defaultPosition(layer: Layer, comp: Composition): Vec2 {
  // Same default with or without a parent, so a "camera" null whose anchor equals its
  // position (the usual rig) leaves every child exactly where it was.
  if (layer.type === "path") return [0, 0];
  return [comp.width / 2, comp.height / 2];
}

export function localMatrix(layer: Layer, comp: Composition, t: number): Mat {
  const tr = layer.transform ?? {};
  const [px, py] = sample(tr.position, t, defaultPosition(layer, comp));
  const [ax, ay] = sample(tr.anchor, t, [0, 0]);
  const sc = sample<number | Vec2>(tr.scale, t, 100);
  const [sx, sy] = Array.isArray(sc) ? sc : [sc, sc];
  const rot = sample(tr.rotation, t, 0);
  return mul(mul(mul(translate(px, py), rotate(rot)), scale(sx / 100, sy / 100)), translate(-ax, -ay));
}

function needsIsolation(layer: Layer, opacity: number): boolean {
  if (layer.effects?.length || layer.matte) return true;
  const complex =
    layer.type === "comp" ||
    layer.type === "text" ||
    ("stroke" in layer && layer.stroke !== undefined && "fill" in layer && layer.fill !== undefined);
  return complex && (opacity < 1 || (layer.blend ?? "normal") !== "normal");
}

type Rect = { x0: number; y0: number; x1: number; y1: number };

/**
 * Pixel-space region a layer can touch, including effect spill. Isolated layers are
 * rendered only inside this region, which keeps blurs and glows cheap.
 */
function layerRegion(ctx: CanvasRenderingContext2D, frame: Frame, scene: Scene, layer: Layer, matrix: Mat): Rect | null {
  const local = contentBounds(ctx, frame, layer, scene.t);
  if (local === "empty") return null;
  let r: Rect;
  if (local === "unknown") {
    r = { x0: 0, y0: 0, x1: scene.viewW, y1: scene.viewH };
  } else {
    const pts = [
      [local.x0, local.y0],
      [local.x1, local.y0],
      [local.x0, local.y1],
      [local.x1, local.y1],
    ].map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]);
    r = {
      x0: Math.min(...pts.map((p) => p[0])),
      y0: Math.min(...pts.map((p) => p[1])),
      x1: Math.max(...pts.map((p) => p[0])),
      y1: Math.max(...pts.map((p) => p[1])),
    };
  }
  const px = scaleFactor(scene.base);
  let spill = 0;
  for (const fx of layer.effects ?? []) {
    if (fx.type === "blur") spill += Math.max(0, sample(fx.radius, scene.t, 0)) * 3 * px;
    if (fx.type === "glow") spill += Math.max(0, sample(fx.radius, scene.t, 20)) * 3 * px;
    if (fx.type === "dropShadow")
      spill += (Math.abs(sample(fx.distance, scene.t, 10)) + Math.max(0, sample(fx.softness, scene.t, 20)) * 3) * px;
  }
  const pad = spill + 2;
  const out = {
    x0: Math.max(0, Math.floor(r.x0 - pad)),
    y0: Math.max(0, Math.floor(r.y0 - pad)),
    x1: Math.min(scene.viewW, Math.ceil(r.x1 + pad)),
    y1: Math.min(scene.viewH, Math.ceil(r.y1 + pad)),
  };
  return out.x1 > out.x0 && out.y1 > out.y0 ? out : null;
}

/** Bounds of a layer's content in its own coordinate space. */
function contentBounds(ctx: CanvasRenderingContext2D, frame: Frame, layer: Layer, t: number): Rect | "empty" | "unknown" {
  const box = (w: number, h: number, m = 0): Rect => ({ x0: -Math.abs(w) / 2 - m, y0: -Math.abs(h) / 2 - m, x1: Math.abs(w) / 2 + m, y1: Math.abs(h) / 2 + m });
  const strokeMargin = (stroke?: Stroke) => (stroke ? Math.max(0, sample(stroke.width, t, 4)) : 0);
  switch (layer.type) {
    case "null":
      return "empty";
    case "solid": {
      const [w, h] = sample(layer.size, t, [1e5, 1e5] as Vec2);
      return layer.size ? box(w, h) : "unknown";
    }
    case "rect":
    case "ellipse": {
      const [w, h] = sample(layer.size, t, [100, 100] as Vec2);
      return box(w, h, strokeMargin(layer.stroke));
    }
    case "image": {
      const img = frame.env.images.get(layer.src);
      if (!img) return "empty";
      const [w, h] = sample(layer.size, t, [img.width, img.height] as Vec2);
      return box(w, h);
    }
    case "video": {
      const info = frame.env.video?.info(layer.src);
      const natural: Vec2 = info?.width && info.height ? [info.width, info.height] : [0, 0];
      const [w, h] = sample(layer.size, t, natural);
      return w > 0 && h > 0 ? box(w, h) : "unknown";
    }
    case "audio":
      return "empty";
    case "comp": {
      const inner = frame.project.compositions.find((c) => c.id === layer.comp);
      return inner ? box(inner.width, inner.height) : "empty";
    }
    case "path": {
      const b = pathBounds(layer.d);
      if (!b) return "unknown";
      const m = strokeMargin(layer.stroke ?? (layer.fill === undefined ? { color: "#fff" } : undefined)) * 2;
      return { x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m };
    }
    case "text": {
      const layout = layoutText(ctx, layer, t);
      const size = layout.height / Math.max(1, layout.lines.length);
      let m = size * 0.6 + strokeMargin(layer.stroke);
      const from = layer.animator?.from;
      if (from) {
        m += Math.max(Math.abs(from.offset?.[0] ?? 0), Math.abs(from.offset?.[1] ?? 0)) + (from.blur ?? 0) * 3;
        if ((from.scale ?? 100) > 100 || from.rotation) return "unknown";
      }
      return { x0: -layout.width / 2 - m, y0: -layout.height / 2 - m, x1: layout.width / 2 + m, y1: layout.height / 2 + m };
    }
  }
}

const pathBoundsCache = new Map<string, Rect | null>();
function pathBounds(d: string): Rect | null {
  let b = pathBoundsCache.get(d);
  if (b === undefined) {
    try {
      const props = new svgPathProperties(d);
      const len = props.getTotalLength();
      const n = Math.min(400, Math.max(16, Math.ceil(len / 4)));
      b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (let i = 0; i <= n; i++) {
        const p = props.getPointAtLength((i / n) * len);
        b.x0 = Math.min(b.x0, p.x);
        b.y0 = Math.min(b.y0, p.y);
        b.x1 = Math.max(b.x1, p.x);
        b.y1 = Math.max(b.y1, p.y);
      }
      if (!Number.isFinite(b.x0)) b = null;
    } catch {
      b = null;
    }
    if (pathBoundsCache.size > 1000) pathBoundsCache.clear();
    pathBoundsCache.set(d, b);
  }
  return b;
}

function compositeLayer(ctx: CanvasRenderingContext2D, frame: Frame, scene: Scene, layer: Layer): void {
  const t = scene.t;
  const opacity = Math.min(1, Math.max(0, sample(layer.transform?.opacity, t, 100) / 100));
  if (opacity <= 0) return;
  const matrix = mul(scene.base, scene.worldMatrix(layer));
  const blend = BLEND[layer.blend ?? "normal"] ?? "source-over";

  if (!needsIsolation(layer, opacity)) {
    ctx.save();
    ctx.globalAlpha *= opacity;
    ctx.globalCompositeOperation = blend;
    drawContent(ctx, frame, scene, layer, matrix, scene.viewW, scene.viewH);
    ctx.restore();
    return;
  }

  const region = layerRegion(ctx, frame, scene, layer, matrix);
  if (!region) return;
  const w = region.x1 - region.x0;
  const h = region.y1 - region.y0;
  const shift = translate(-region.x0, -region.y0);
  const { pool } = frame;
  let surf = pool.acquire(w, h);
  drawContent(surf.ctx, frame, scene, layer, mul(shift, matrix), w, h);
  const px = scaleFactor(scene.base); // effect sizes are in composition pixels
  for (const fx of layer.effects ?? []) surf = applyEffect(frame, surf, fx, t, px);

  if (layer.matte) {
    const matteLayer = scene.byId.get(layer.matte.layer);
    const inverted = layer.matte.mode === "alphaInverted";
    const m = pool.acquire(w, h);
    if (matteLayer && isActive(matteLayer, scene.comp, t)) {
      const shifted: Scene = { ...scene, base: mul(shift, scene.base), viewW: w, viewH: h };
      compositeLayer(m.ctx, frame, shifted, { ...matteLayer, visible: true, matte: undefined });
    }
    surf.ctx.save();
    resetContext(surf.ctx);
    surf.ctx.globalCompositeOperation = inverted ? "destination-out" : "destination-in";
    surf.ctx.drawImage(m.canvas, 0, 0);
    surf.ctx.restore();
    pool.release(m);
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= opacity;
  ctx.globalCompositeOperation = blend;
  ctx.drawImage(surf.canvas, 0, 0, w, h, region.x0, region.y0, w, h);
  ctx.restore();
  pool.release(surf);
}

/** Returns a (possibly new) surface with the effect applied; releases the input if replaced. */
function applyEffect(frame: Frame, src: Surface, fx: Effect, t: number, px: number): Surface {
  const { pool } = frame;
  const filtered = (filter: string): Surface => {
    const out = pool.acquire(src.canvas.width, src.canvas.height);
    out.ctx.filter = filter;
    out.ctx.drawImage(src.canvas, 0, 0);
    out.ctx.filter = "none";
    return out;
  };
  switch (fx.type) {
    case "blur": {
      const r = Math.max(0, sample(fx.radius, t, 0)) * px;
      if (r < 0.01) return src;
      const out = filtered(`blur(${r}px)`);
      pool.release(src);
      return out;
    }
    case "colorAdjust": {
      const b = sample(fx.brightness, t, 100);
      const c = sample(fx.contrast, t, 100);
      const s = sample(fx.saturation, t, 100);
      const h = sample(fx.hue, t, 0);
      const out = filtered(`brightness(${b}%) contrast(${c}%) saturate(${s}%) hue-rotate(${h}deg)`);
      pool.release(src);
      return out;
    }
    case "glow": {
      const r = Math.max(0, sample(fx.radius, t, 20)) * px;
      const intensity = Math.max(0, sample(fx.intensity, t, 1));
      if (intensity <= 0) return src;
      const glow = filtered(`blur(${Math.max(0.5, r)}px)`);
      if (fx.color !== undefined) {
        glow.ctx.globalCompositeOperation = "source-in";
        glow.ctx.fillStyle = sample(fx.color, t, "#ffffff");
        glow.ctx.fillRect(0, 0, glow.canvas.width, glow.canvas.height);
        glow.ctx.globalCompositeOperation = "source-over";
      }
      const out = pool.acquire(src.canvas.width, src.canvas.height);
      out.ctx.drawImage(src.canvas, 0, 0);
      out.ctx.globalCompositeOperation = "lighter";
      for (let left = Math.min(intensity, 4); left > 0; left -= 1) {
        out.ctx.globalAlpha = Math.min(1, left);
        out.ctx.drawImage(glow.canvas, 0, 0);
      }
      pool.release(src, glow);
      return out;
    }
    case "dropShadow": {
      const dist = sample(fx.distance, t, 10) * px;
      const angle = (sample(fx.angle, t, 135) * Math.PI) / 180;
      const out = pool.acquire(src.canvas.width, src.canvas.height);
      out.ctx.shadowColor = sample(fx.color, t, "rgba(0,0,0,0.5)");
      out.ctx.shadowBlur = Math.max(0, sample(fx.softness, t, 20)) * px;
      // 135° = down-right, matching the usual "light from top-left" convention.
      out.ctx.shadowOffsetX = -Math.cos(angle) * dist;
      out.ctx.shadowOffsetY = Math.sin(angle) * dist;
      out.ctx.drawImage(src.canvas, 0, 0);
      pool.release(src);
      return out;
    }
  }
}

function drawContent(ctx: CanvasRenderingContext2D, frame: Frame, scene: Scene, layer: Layer, matrix: Mat, viewW: number, viewH: number): void {
  const t = scene.t;
  ctx.save();
  ctx.setTransform(...matrix);
  switch (layer.type) {
    case "solid": {
      const [w, h] = sample(layer.size, t, [scene.comp.width, scene.comp.height] as Vec2);
      ctx.fillStyle = fillStyle(ctx, layer.color, t, w, h);
      ctx.fillRect(-w / 2, -h / 2, w, h);
      break;
    }
    case "rect": {
      const [w, h] = sample(layer.size, t, [100, 100] as Vec2);
      const r = Math.max(0, Math.min(sample(layer.radius, t, 0), Math.abs(w) / 2, Math.abs(h) / 2));
      ctx.beginPath();
      roundRect(ctx, -w / 2, -h / 2, w, h, r);
      paint(ctx, layer.fill, layer.stroke, t, w, h, () => ctx.fill(), () => ctx.stroke());
      break;
    }
    case "ellipse": {
      const [w, h] = sample(layer.size, t, [100, 100] as Vec2);
      ctx.beginPath();
      ctx.ellipse(0, 0, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, Math.PI * 2);
      paint(ctx, layer.fill, layer.stroke, t, w, h, () => ctx.fill(), () => ctx.stroke());
      break;
    }
    case "path":
      drawPath(ctx, frame, layer, t);
      break;
    case "text":
      drawText(ctx, frame, layer, t, scaleFactor(matrix));
      break;
    case "image": {
      const img = frame.env.images.get(layer.src);
      if (!img) break;
      const [w, h] = sample(layer.size, t, [img.width, img.height] as Vec2);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      break;
    }
    case "comp": {
      const inner = frame.project.compositions.find((c) => c.id === layer.comp);
      if (!inner) break;
      const m = mul(matrix, translate(-inner.width / 2, -inner.height / 2));
      ctx.setTransform(...m);
      ctx.beginPath();
      ctx.rect(0, 0, inner.width, inner.height);
      ctx.clip();
      frame.depth++;
      renderComp(ctx, frame, inner, t - (layer.in ?? 0) + (layer.timeOffset ?? 0), m, viewW, viewH);
      frame.depth--;
      break;
    }
    case "video": {
      const info = frame.env.video?.info(layer.src);
      const img = frame.env.video?.frame(layer.src, mediaSourceTime(layer, t, info?.duration));
      if (!img) break;
      const natural: Vec2 = info?.width && info.height ? [info.width, info.height] : [img.width, img.height];
      const [w, h] = sample(layer.size, t, natural);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      break;
    }
    case "audio":
    case "null":
      break;
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fillStyle(ctx: CanvasRenderingContext2D, fill: Fill, t: number, w: number, h: number): string | CanvasGradient {
  if (typeof fill === "string" || "keyframes" in fill) return sample(fill, t, "#ffffff");
  let g: CanvasGradient;
  if (fill.type === "linear") {
    const [x0, y0] = fill.from ?? [-w / 2, 0];
    const [x1, y1] = fill.to ?? [w / 2, 0];
    g = ctx.createLinearGradient(x0, y0, x1, y1);
  } else {
    const [cx, cy] = fill.center ?? [0, 0];
    g = ctx.createRadialGradient(cx, cy, 0, cx, cy, fill.radius ?? Math.max(Math.abs(w), Math.abs(h)) / 2);
  }
  for (const [offset, color] of fill.stops) g.addColorStop(offset, color);
  return g;
}

function applyStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, t: number): void {
  ctx.strokeStyle = sample(stroke.color, t, "#ffffff");
  ctx.lineWidth = Math.max(0, sample(stroke.width, t, 4));
  ctx.lineCap = stroke.cap ?? "butt";
  ctx.lineJoin = stroke.join ?? "miter";
}

function paint(
  ctx: CanvasRenderingContext2D,
  fill: Fill | undefined,
  stroke: Stroke | undefined,
  t: number,
  w: number,
  h: number,
  doFill: () => void,
  doStroke: () => void,
): void {
  if (fill === undefined && stroke === undefined) fill = "#ffffff";
  if (fill !== undefined) {
    ctx.fillStyle = fillStyle(ctx, fill, t, w, h);
    doFill();
  }
  if (stroke !== undefined) {
    applyStroke(ctx, stroke, t);
    if (ctx.lineWidth > 0) doStroke();
  }
}

const pathLengths = new Map<string, number>();
function pathLength(d: string): number {
  let len = pathLengths.get(d);
  if (len === undefined) {
    try {
      len = new svgPathProperties(d).getTotalLength();
    } catch {
      len = 0;
    }
    if (pathLengths.size > 1000) pathLengths.clear();
    pathLengths.set(d, len);
  }
  return len;
}

function drawPath(ctx: CanvasRenderingContext2D, frame: Frame, layer: PathLayer, t: number): void {
  const path = frame.env.createPath(layer.d);
  const fill = layer.fill;
  if (fill !== undefined) {
    ctx.fillStyle = fillStyle(ctx, fill, t, 200, 200);
    ctx.fill(path);
  }
  const stroke = layer.stroke ?? (fill === undefined ? { color: "#ffffff" } : undefined);
  if (!stroke) return;
  applyStroke(ctx, stroke, t);
  if (ctx.lineWidth <= 0) return;
  const start = Math.min(100, Math.max(0, sample(layer.trim?.start, t, 0)));
  const end = Math.min(100, Math.max(0, sample(layer.trim?.end, t, 100)));
  if (end <= start) return;
  if (start > 0 || end < 100) {
    const total = pathLength(layer.d);
    if (total <= 0) return;
    const visible = ((end - start) / 100) * total;
    ctx.setLineDash([visible, total * 2]);
    ctx.lineDashOffset = -(start / 100) * total;
  }
  ctx.stroke(path);
  ctx.setLineDash([]);
}

function drawText(ctx: CanvasRenderingContext2D, frame: Frame, layer: TextLayer, t: number, pixelScale: number): void {
  const layout = layoutText(ctx, layer, t);
  const fill = layer.fill ?? "#ffffff";
  const fs = fillStyle(ctx, fill, t, layout.width, layout.height);
  const stroke = layer.stroke;
  const ls = sample(layer.letterSpacing, t, 0);
  const prepare = (c: CanvasRenderingContext2D) => {
    c.font = layout.font;
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    if ("letterSpacing" in c) (c as { letterSpacing: string }).letterSpacing = "0px";
  };
  const drawRun = (c: CanvasRenderingContext2D, text: string, x: number, y: number) => {
    if (stroke) {
      applyStroke(c, stroke, t);
      if (c.lineWidth > 0) c.strokeText(text, x, y);
    }
    c.fillStyle = fs;
    c.fillText(text, x, y);
  };
  prepare(ctx);

  if (!layer.animator) {
    if (ls === 0) {
      for (const line of layout.lines) drawRun(ctx, line.text, line.x, line.y);
    } else {
      for (const g of layout.glyphs) if (g.ch.trim()) drawRun(ctx, g.ch, g.x, g.y);
    }
    return;
  }

  // Group glyphs into animation units.
  const by = layer.animator.by ?? "character";
  const unitOf = (g: (typeof layout.glyphs)[number], i: number) => (by === "line" ? g.line : by === "word" ? g.word : i);
  const units = new Map<number, typeof layout.glyphs>();
  let charIndex = 0;
  for (const g of layout.glyphs) {
    if (!g.ch.trim()) continue;
    const u = unitOf(g, charIndex++);
    const list = units.get(u) ?? [];
    list.push(g);
    units.set(u, list);
  }
  const keys = [...units.keys()].sort((a, b) => a - b);
  const states = animatorStates(layer, keys.length, t);
  const baseAlpha = ctx.globalAlpha;
  const base = ctx.getTransform();
  const lineH = layout.lines.length ? layout.height / layout.lines.length : 0;
  const capHalf = lineH * 0.3;
  const strokeW = stroke ? Math.max(0, sample(stroke.width, t, 4)) : 0;

  keys.forEach((key, i) => {
    const s = states[i];
    if (s.opacity <= 0) return;
    const glyphs = units.get(key)!;
    const x0 = Math.min(...glyphs.map((g) => g.x));
    const x1 = Math.max(...glyphs.map((g) => g.x + g.width));
    const cx = (x0 + x1) / 2;
    const cy = glyphs.reduce((a, g) => a + g.y, 0) / glyphs.length - capHalf;
    ctx.setTransform(base.a, base.b, base.c, base.d, base.e, base.f);
    ctx.translate(cx + s.dx, cy + s.dy);
    ctx.rotate((s.rotation * Math.PI) / 180);
    ctx.scale(s.scale, s.scale);
    ctx.translate(-cx, -cy);
    const draw = (c: CanvasRenderingContext2D, dx = 0, dy = 0) => {
      if (by === "character" || ls !== 0) for (const g of glyphs) drawRun(c, g.ch, g.x + dx, g.y + dy);
      else drawRun(c, glyphs.map((g) => g.ch).join(""), x0 + dx, glyphs[0].y + dy);
    };
    const blurPx = s.blur * pixelScale;
    if (blurPx <= 0.05) {
      ctx.globalAlpha = baseAlpha * s.opacity;
      draw(ctx);
      return;
    }
    // Blur in a small offscreen surface: a canvas filter on the main target would be
    // applied to the whole canvas for every unit.
    const m = ctx.getTransform();
    const pad = s.blur * 3 + strokeW;
    const ly0 = Math.min(...glyphs.map((g) => g.y)) - lineH - pad;
    const ly1 = Math.max(...glyphs.map((g) => g.y)) + lineH * 0.5 + pad;
    const corners = [
      [x0 - pad, ly0],
      [x1 + pad, ly0],
      [x0 - pad, ly1],
      [x1 + pad, ly1],
    ].map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
    const rx = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[0]))));
    const ry = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[1]))));
    const rw = Math.min(ctx.canvas.width, Math.ceil(Math.max(...corners.map((p) => p[0])))) - rx;
    const rh = Math.min(ctx.canvas.height, Math.ceil(Math.max(...corners.map((p) => p[1])))) - ry;
    if (rw <= 0 || rh <= 0) return;
    const a = frame.pool.acquire(rw, rh);
    const b = frame.pool.acquire(rw, rh);
    a.ctx.setTransform(m.a, m.b, m.c, m.d, m.e - rx, m.f - ry);
    prepare(a.ctx);
    draw(a.ctx);
    b.ctx.filter = `blur(${blurPx}px)`;
    b.ctx.drawImage(a.canvas, 0, 0);
    b.ctx.filter = "none";
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = baseAlpha * s.opacity;
    ctx.drawImage(b.canvas, 0, 0, rw, rh, rx, ry, rw, rh);
    ctx.restore();
    frame.pool.release(a, b);
  });
  ctx.globalAlpha = baseAlpha;
}

export interface LayerGeometry {
  /** Corners of the layer's content box in composition coordinates (clockwise from top-left). */
  quad: [number, number][];
  /** The layer's pivot (its position) in composition coordinates. */
  pivot: [number, number];
  /** Layer → composition matrix. */
  world: Mat;
  /** Parent space → composition matrix (identity without a parent). */
  parentWorld: Mat;
}

/** Where a layer is on screen at time t: used for selection, hit-testing and handles. */
export function layerGeometry(
  ctx: CanvasRenderingContext2D,
  project: Project,
  env: RenderEnv,
  opts: { compId?: string; time: number },
  layerId: string,
): LayerGeometry | null {
  const comp = getComp(project, opts.compId);
  const byId = new Map(resolveLayers(comp, opts.time).map((l) => [l.id, l]));
  const layer = byId.get(layerId);
  if (!layer) return null;
  const chain = (l: Layer | undefined, depth = 0): Mat =>
    !l || depth > 32 ? IDENTITY : mul(chain(l.parent ? byId.get(l.parent) : undefined, depth + 1), localMatrix(l, comp, opts.time));
  const parentWorld = chain(layer.parent ? byId.get(layer.parent) : undefined);
  const world = mul(parentWorld, localMatrix(layer, comp, opts.time));
  let pool = pools.get(env);
  if (!pool) pools.set(env, (pool = new SurfacePool(env)));
  const frame: Frame = { project, env, pool, depth: 0 };
  let b = contentBounds(ctx, frame, layer, opts.time);
  if (b === "unknown") b = layer.type === "solid" ? { x0: -comp.width / 2, y0: -comp.height / 2, x1: comp.width / 2, y1: comp.height / 2 } : { x0: -50, y0: -50, x1: 50, y1: 50 };
  if (b === "empty") b = { x0: -12, y0: -12, x1: 12, y1: 12 };
  if (layer.type === "text") {
    // contentBounds pads text generously for effects; tighten it for handles.
    const layout = layoutText(ctx, layer, opts.time);
    b = { x0: -layout.width / 2, y0: -layout.height / 2, x1: layout.width / 2, y1: layout.height / 2 };
  }
  const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const tr = layer.transform ?? {};
  const pos = sample(tr.position, opts.time, defaultPosition(layer, comp));
  return {
    quad: [apply(world, b.x0, b.y0), apply(world, b.x1, b.y0), apply(world, b.x1, b.y1), apply(world, b.x0, b.y1)],
    pivot: apply(parentWorld, pos[0], pos[1]),
    world,
    parentWorld,
  };
}

/** Point-in-convex-quad test. */
export function pointInQuad(quad: [number, number][], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < quad.length; i++) {
    const [ax, ay] = quad[i];
    const [bx, by] = quad[(i + 1) % quad.length];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross !== 0) {
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) return false;
    }
  }
  return true;
}

/** Inverse of an affine matrix. */
export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** Image sources referenced anywhere in the project (for preloading). */
export function collectImages(project: Project): string[] {
  const srcs = new Set<string>();
  for (const c of project.compositions) for (const l of c.layers) if (l.type === "image") srcs.add(l.src);
  return [...srcs];
}

/** Video and audio sources referenced anywhere in the project. */
export function collectMedia(project: Project): { src: string; type: "video" | "audio" }[] {
  const seen = new Map<string, "video" | "audio">();
  for (const c of project.compositions) for (const l of c.layers) if (l.type === "video" || l.type === "audio") if (!seen.has(l.src) || l.type === "video") seen.set(l.src, l.type);
  return [...seen].map(([src, type]) => ({ src, type }));
}

/** Fonts referenced by text layers (for preloading in the browser). */
export function collectFonts(project: Project): { family: string; weight: number; style: string }[] {
  const seen = new Map<string, { family: string; weight: number; style: string }>();
  for (const c of project.compositions)
    for (const l of c.layers)
      if (l.type === "text") {
        const f = { family: l.font?.family ?? "Inter", weight: l.font?.weight ?? 700, style: l.font?.style ?? "normal" };
        seen.set(`${f.family}|${f.weight}|${f.style}`, f);
      }
  return [...seen.values()];
}

export type { LayerOf };
