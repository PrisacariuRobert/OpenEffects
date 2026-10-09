import { z } from "zod";
import { EASE_NAMES } from "./easing.ts";
import { isColor } from "./color.ts";

/*
 * The OpenEffects project format (v1).
 *
 * Design rules:
 * - Files stay minimal: defaults live in the engine, not in the file, so diffs stay small.
 * - Every object is strict, so typos ("colour") fail validation with a clear message
 *   instead of silently doing nothing. This matters most for AI agents.
 * - All times are in seconds of composition time.
 */

export const Vec2 = z.tuple([z.number(), z.number()]).describe("[x, y]");
export const Color = z
  .string()
  .refine(isColor, { message: "Expected a color like #ff3366, #ff336680, rgba(255,51,102,0.5) or a basic name" })
  .describe("Color: #rgb, #rrggbb, #rrggbbaa, rgb()/rgba() or a basic name");

export const Easing = z
  .union([z.enum(EASE_NAMES), z.tuple([z.number(), z.number(), z.number(), z.number()])])
  .describe("Named easing (e.g. easeOutCubic, easeOutBack, linear, hold) or cubic-bezier [x1, y1, x2, y2]");

/** A property that is either a static value or keyframed. */
export function anim<T extends z.ZodType>(value: T) {
  const keyframe = z.strictObject({
    t: z.number().min(0).describe("Time in seconds (composition time)"),
    v: value,
    ease: Easing.optional().describe("Easing used from this keyframe to the next. Default easeInOut"),
  });
  return z.union([
    value,
    z.strictObject({
      keyframes: z.array(keyframe).min(1).describe("Keyframes, sorted by t"),
    }),
  ]);
}

export const Num = anim(z.number());
export const AnimVec2 = anim(Vec2);
export const AnimColor = anim(Color);
export const AnimScale = anim(z.union([z.number(), Vec2])).describe("Percent. Number = uniform, [x, y] = per-axis");

export const Transform = z.strictObject({
  position: AnimVec2.optional().describe("Pixels in the parent's (or composition's) space. Default: composition center ([0,0] for path layers)"),
  anchor: AnimVec2.optional().describe("Offset of the layer's pivot from its content origin. Default [0,0]"),
  scale: AnimScale.optional().describe("Percent. Default 100"),
  rotation: Num.optional().describe("Degrees, clockwise. Default 0"),
  opacity: Num.optional().describe("0-100. Default 100"),
});

export const GradientStop = z.tuple([z.number().min(0).max(1), Color]);
export const Gradient = z.strictObject({
  type: z.enum(["linear", "radial"]),
  stops: z.array(GradientStop).min(2),
  from: Vec2.optional().describe("linear: start point in layer space"),
  to: Vec2.optional().describe("linear: end point in layer space"),
  center: Vec2.optional().describe("radial: center in layer space. Default [0,0]"),
  radius: z.number().positive().optional().describe("radial: radius in px"),
});
export const Fill = z.union([AnimColor, Gradient]);

export const Stroke = z.strictObject({
  color: AnimColor,
  width: Num.optional().describe("Default 4"),
  cap: z.enum(["butt", "round", "square"]).optional(),
  join: z.enum(["miter", "round", "bevel"]).optional(),
});

export const Trim = z.strictObject({
  start: Num.optional().describe("0-100 percent of path length. Default 0"),
  end: Num.optional().describe("0-100 percent of path length. Default 100"),
});

// ---------- effects ----------
export const BlurEffect = z.strictObject({ type: z.literal("blur"), radius: Num });
export const GlowEffect = z.strictObject({
  type: z.literal("glow"),
  radius: Num.optional().describe("Default 20"),
  intensity: Num.optional().describe("Default 1. 0-4 is a useful range"),
  color: AnimColor.optional().describe("Default: the layer's own colors"),
});
export const DropShadowEffect = z.strictObject({
  type: z.literal("dropShadow"),
  color: AnimColor.optional().describe("Default rgba(0,0,0,0.5)"),
  distance: Num.optional().describe("Default 10"),
  angle: Num.optional().describe("Degrees. Default 135 (down-right)"),
  softness: Num.optional().describe("Blur radius. Default 20"),
});
export const ColorAdjustEffect = z.strictObject({
  type: z.literal("colorAdjust"),
  brightness: Num.optional().describe("Percent. Default 100"),
  contrast: Num.optional().describe("Percent. Default 100"),
  saturation: Num.optional().describe("Percent. Default 100"),
  hue: Num.optional().describe("Degrees of hue rotation. Default 0"),
});
export const Effect = z.discriminatedUnion("type", [BlurEffect, GlowEffect, DropShadowEffect, ColorAdjustEffect]);

// ---------- behaviors ----------
/*
 * Procedural motion attached to a property (like Cavalry behaviours / AE expressions):
 * evaluated every frame on top of the property's static or keyframed value.
 */
const NumOrVec2 = z.union([z.number(), Vec2]).describe("A number (all dimensions) or [x, y]");
const behaviorBase = {
  property: z.string().min(1).describe('Dotted property path, e.g. "transform.position", "transform.rotation", "effects.0.radius"'),
  start: z.number().min(0).optional().describe("Seconds when the behavior starts. Default: layer in point"),
  end: z.number().min(0).optional().describe("Seconds when it stops. Default: layer end"),
  fadeIn: z.number().min(0).optional().describe("Seconds to ramp the behavior in from its start. Default 0"),
  enabled: z.boolean().optional().describe("false switches the behavior off without deleting it"),
};
export const WiggleBehavior = z.strictObject({
  ...behaviorBase,
  type: z.literal("wiggle"),
  amount: NumOrVec2.describe("Maximum offset in the property's units (px, degrees, percent…)"),
  frequency: z.number().positive().optional().describe("Wiggles per second. Default 2"),
  seed: z.number().int().optional().describe("Change for a different random pattern. Default 1"),
  octaves: z.number().int().min(1).max(4).optional().describe("Detail layers of noise. Default 1"),
});
export const OscillateBehavior = z.strictObject({
  ...behaviorBase,
  type: z.literal("oscillate"),
  amplitude: NumOrVec2.describe("Peak offset in the property's units"),
  frequency: z.number().positive().optional().describe("Cycles per second. Default 1"),
  phase: z.number().optional().describe("Degrees. Default 0"),
  wave: z.enum(["sine", "triangle", "square", "saw"]).optional().describe("Default sine"),
});
export const DriftBehavior = z.strictObject({
  ...behaviorBase,
  type: z.literal("drift"),
  speed: NumOrVec2.describe("Units per second added continuously (e.g. 90 on rotation = a quarter turn per second)"),
});
export const LoopBehavior = z.strictObject({
  ...behaviorBase,
  type: z.literal("loop"),
  mode: z.enum(["cycle", "pingpong"]).optional().describe("Repeat the keyframes after the last one. Default cycle"),
});
export const FollowBehavior = z.strictObject({
  ...behaviorBase,
  type: z.literal("follow"),
  layer: z.string().describe("Id of the layer to follow (its same property)"),
  delay: z.number().min(0).optional().describe("Seconds behind the leader. Default 0.1"),
  offset: NumOrVec2.optional().describe("Added to the followed value. Default 0"),
});
export const Behavior = z.discriminatedUnion("type", [WiggleBehavior, OscillateBehavior, DriftBehavior, LoopBehavior, FollowBehavior]);

// ---------- layers ----------
const LayerId = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "Layer ids may only contain letters, digits, _ and -")
  .describe("Unique id within the composition");

const layerBase = {
  id: LayerId,
  name: z.string().optional(),
  in: z.number().min(0).optional().describe("Seconds when the layer appears. Default 0"),
  out: z.number().min(0).optional().describe("Seconds when the layer disappears. Default: composition end"),
  visible: z.boolean().optional().describe("false hides the layer (it can still be used as a matte or parent)"),
  parent: z.string().optional().describe("Id of a layer whose transform this layer inherits"),
  transform: Transform.optional(),
  effects: z.array(Effect).optional(),
  behaviors: z.array(Behavior).optional().describe("Procedural motion: wiggle, oscillate, drift, loop, follow"),
  blend: z
    .enum(["normal", "add", "screen", "multiply", "overlay", "lighten", "darken", "difference"])
    .optional(),
  matte: z
    .strictObject({
      layer: z.string().describe("Id of the matte layer (usually with visible: false)"),
      mode: z.enum(["alpha", "alphaInverted"]).optional(),
    })
    .optional()
    .describe("Track matte: only show this layer where the matte layer is opaque"),
};

export const SolidLayer = z.strictObject({
  ...layerBase,
  type: z.literal("solid"),
  color: Fill.describe("A color or a gradient"),
  size: AnimVec2.optional().describe("Default: composition size"),
});
export const RectLayer = z.strictObject({
  ...layerBase,
  type: z.literal("rect"),
  size: AnimVec2,
  radius: Num.optional(),
  fill: Fill.optional(),
  stroke: Stroke.optional(),
});
export const EllipseLayer = z.strictObject({
  ...layerBase,
  type: z.literal("ellipse"),
  size: AnimVec2,
  fill: Fill.optional(),
  stroke: Stroke.optional(),
});
export const PathLayer = z.strictObject({
  ...layerBase,
  type: z.literal("path"),
  d: z.string().min(1).describe("SVG path data, in layer coordinates"),
  fill: Fill.optional(),
  stroke: Stroke.optional(),
  trim: Trim.optional().describe("Animate end 0→100 to draw a line on"),
});

export const TextAnimator = z
  .strictObject({
    by: z.enum(["character", "word", "line"]).optional().describe("Default character"),
    order: z.enum(["forward", "reverse", "center", "random"]).optional().describe("Default forward"),
    delay: z.number().optional().describe("Seconds after the layer's in point. Default 0"),
    stagger: z.number().min(0).optional().describe("Seconds between units. Default 0.04"),
    duration: z.number().positive().optional().describe("Seconds each unit takes. Default 0.6"),
    ease: Easing.optional().describe("Default easeOutCubic"),
    from: z
      .strictObject({
        opacity: z.number().optional(),
        offset: Vec2.optional().describe("Pixels each unit starts away from its rest position"),
        scale: z.number().optional().describe("Percent"),
        rotation: z.number().optional().describe("Degrees"),
        blur: z.number().optional().describe("px"),
      })
      .describe("Start state of each unit; units animate to their normal state"),
  })
  .describe("Build-in animation applied per character/word/line");

export const TextLayer = z.strictObject({
  ...layerBase,
  type: z.literal("text"),
  text: z.string().describe("Use \\n for line breaks"),
  font: z
    .strictObject({
      family: z.string().optional().describe("Default Inter"),
      weight: z.number().optional().describe("100-900. Default 700"),
      style: z.enum(["normal", "italic"]).optional(),
      size: Num.optional().describe("px. Default 96"),
    })
    .optional(),
  fill: Fill.optional().describe("Default white"),
  stroke: Stroke.optional(),
  align: z.enum(["left", "center", "right"]).optional().describe("Default center"),
  letterSpacing: Num.optional().describe("px. Default 0"),
  lineHeight: z.number().positive().optional().describe("Multiple of font size. Default 1.2"),
  animator: TextAnimator.optional(),
});
export const ImageLayer = z.strictObject({
  ...layerBase,
  type: z.literal("image"),
  src: z.string().describe("Path relative to the project folder, e.g. assets/logo.png"),
  size: AnimVec2.optional().describe("Default: natural image size"),
});
const mediaTiming = {
  trimStart: z.number().min(0).optional().describe("Seconds into the media file where the layer starts playing. Default 0"),
  speed: z.number().positive().max(16).optional().describe("Playback speed. Default 1"),
  volume: Num.optional().describe("0-100 (animatable, e.g. for fades). Default 100"),
  muted: z.boolean().optional(),
};
export const VideoLayer = z.strictObject({
  ...layerBase,
  type: z.literal("video"),
  src: z.string().describe("Path relative to the project folder, e.g. assets/clip.mp4"),
  size: AnimVec2.optional().describe("Default: the video's own size"),
  loop: z.boolean().optional().describe("Loop the clip when it reaches its end"),
  ...mediaTiming,
});
export const AudioLayer = z.strictObject({
  ...layerBase,
  type: z.literal("audio"),
  src: z.string().describe("Path relative to the project folder, e.g. assets/music.mp3"),
  ...mediaTiming,
});
export const NullLayer = z.strictObject({
  ...layerBase,
  type: z.literal("null"),
});
export const CompLayer = z.strictObject({
  ...layerBase,
  type: z.literal("comp"),
  comp: z.string().describe("Id of another composition to nest (precomp)"),
  timeOffset: z.number().optional().describe("Seconds. Nested time = time - in + timeOffset"),
});

export const Layer = z.discriminatedUnion("type", [
  SolidLayer,
  RectLayer,
  EllipseLayer,
  PathLayer,
  TextLayer,
  ImageLayer,
  VideoLayer,
  AudioLayer,
  NullLayer,
  CompLayer,
]);

export const Marker = z.strictObject({
  t: z.number().min(0).describe("Seconds"),
  label: z.string().optional(),
  color: Color.optional(),
});

export const Composition = z.strictObject({
  id: LayerId.describe("Composition id"),
  name: z.string().optional(),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
  fps: z.number().positive().max(240),
  duration: z.number().positive().describe("Seconds"),
  background: Color.optional().describe("Default: transparent (black in video exports)"),
  markers: z.array(Marker).optional().describe("Timeline markers (e.g. beats, cues) to time animation to"),
  layers: z.array(Layer).describe("Rendered in order: the LAST layer is drawn on top"),
});

export const ProjectSchema = z
  .strictObject({
    $schema: z.string().optional(),
    version: z.literal(1),
    name: z.string().optional(),
    compositions: z.array(Composition).min(1).describe("The first composition is the main one"),
  })
  .superRefine((project, ctx) => {
    const compIds = new Set<string>();
    project.compositions.forEach((comp, ci) => {
      if (compIds.has(comp.id)) ctx.addIssue({ code: "custom", path: ["compositions", ci, "id"], message: `Duplicate composition id "${comp.id}"` });
      compIds.add(comp.id);
    });
    project.compositions.forEach((comp, ci) => {
      const ids = new Map<string, number>();
      comp.layers.forEach((layer, li) => {
        if (ids.has(layer.id)) ctx.addIssue({ code: "custom", path: ["compositions", ci, "layers", li, "id"], message: `Duplicate layer id "${layer.id}"` });
        ids.set(layer.id, li);
      });
      comp.layers.forEach((layer, li) => {
        const at = ["compositions", ci, "layers", li];
        if (layer.parent !== undefined) {
          if (!ids.has(layer.parent)) ctx.addIssue({ code: "custom", path: [...at, "parent"], message: `Parent "${layer.parent}" does not exist` });
          // cycle check
          const seen = new Set([layer.id]);
          let p: string | undefined = layer.parent;
          while (p !== undefined && ids.has(p)) {
            if (seen.has(p)) {
              ctx.addIssue({ code: "custom", path: [...at, "parent"], message: `Parent cycle through "${p}"` });
              break;
            }
            seen.add(p);
            p = comp.layers[ids.get(p)!].parent;
          }
        }
        layer.behaviors?.forEach((b, bi) => {
          if (b.type === "follow" && !ids.has(b.layer)) ctx.addIssue({ code: "custom", path: [...at, "behaviors", bi, "layer"], message: `Layer "${b.layer}" does not exist` });
          if (b.type === "follow" && b.layer === layer.id) ctx.addIssue({ code: "custom", path: [...at, "behaviors", bi, "layer"], message: "A layer cannot follow itself" });
        });
        if (layer.matte && !ids.has(layer.matte.layer)) ctx.addIssue({ code: "custom", path: [...at, "matte", "layer"], message: `Matte layer "${layer.matte.layer}" does not exist` });
        if (layer.matte?.layer === layer.id) ctx.addIssue({ code: "custom", path: [...at, "matte", "layer"], message: "A layer cannot be its own matte" });
        if (layer.type === "comp" && !compIds.has(layer.comp)) ctx.addIssue({ code: "custom", path: [...at, "comp"], message: `Composition "${layer.comp}" does not exist` });
        if (layer.type === "comp" && layer.comp === comp.id) ctx.addIssue({ code: "custom", path: [...at, "comp"], message: "A composition cannot contain itself" });
        if (layer.in !== undefined && layer.out !== undefined && layer.out <= layer.in) ctx.addIssue({ code: "custom", path: [...at, "out"], message: "out must be greater than in" });
      });
    });
  });

export type Vec2 = z.infer<typeof Vec2>;
export type Easing = z.infer<typeof Easing>;
export type Keyframe<T> = { t: number; v: T; ease?: Easing };
export type Animatable<T> = T | { keyframes: Keyframe<T>[] };
export type Transform = z.infer<typeof Transform>;
export type Gradient = z.infer<typeof Gradient>;
export type Fill = z.infer<typeof Fill>;
export type Stroke = z.infer<typeof Stroke>;
export type Effect = z.infer<typeof Effect>;
export type Behavior = z.infer<typeof Behavior>;
export type Marker = z.infer<typeof Marker>;
export type TextAnimator = z.infer<typeof TextAnimator>;
export type Layer = z.infer<typeof Layer>;
export type LayerType = Layer["type"];
export type Composition = z.infer<typeof Composition>;
export type Project = z.infer<typeof ProjectSchema>;

export type ValidationResult = { ok: true; project: Project } | { ok: false; errors: string[] };

export function validateProject(data: unknown): ValidationResult {
  const r = ProjectSchema.safeParse(data);
  if (r.success) return { ok: true, project: data as Project };
  return { ok: false, errors: formatIssues(r.error.issues) };
}

/** Compact, agent-friendly error lines like `compositions[0].layers[2].fill: Expected a color ...` */
export function formatIssues(issues: z.core.$ZodIssue[]): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    // For unions, surface the most specific nested error instead of "Invalid input".
    if (issue.code === "invalid_union" && "errors" in issue && issue.errors.length) {
      const best = issue.errors.reduce((a, b) => (deepest(b) > deepest(a) ? b : a));
      const nested = formatIssues(best.map((i) => ({ ...i, path: [...issue.path, ...i.path] })));
      if (nested.length) {
        out.push(...nested);
        continue;
      }
    }
    out.push(`${formatPath(issue.path)}: ${issue.message}`);
  }
  return [...new Set(out)];
}

function deepest(issues: z.core.$ZodIssue[]): number {
  return Math.max(0, ...issues.map((i) => i.path.length + (i.code === "invalid_union" ? 0 : 0.5)));
}

export function formatPath(path: PropertyKey[]): string {
  let s = "";
  for (const p of path) s += typeof p === "number" ? `[${p}]` : s ? `.${String(p)}` : String(p);
  return s || "(root)";
}
