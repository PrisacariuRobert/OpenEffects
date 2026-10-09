import { sample } from "./animate.ts";
import { getIn, insertKeyframes, setIn } from "./keyframes.ts";
import type { Composition, Easing, Keyframe, Layer, Vec2 } from "./schema.ts";

/*
 * One-click animation presets (fade, slide, pop, …). Each writes ordinary keyframes or a
 * text animator, so the result stays fully editable in the timeline and graph editor.
 */

export type PresetKind = "in" | "out" | "loop";

export interface AnimationPreset {
  id: string;
  name: string;
  kind: PresetKind;
  /** Only for text layers. */
  textOnly?: boolean;
  description: string;
}

export const ANIMATION_PRESETS: AnimationPreset[] = [
  { id: "fade-in", name: "Fade in", kind: "in", description: "Opacity 0 → 100" },
  { id: "slide-up", name: "Slide up", kind: "in", description: "Rise from below while fading in" },
  { id: "slide-down", name: "Slide down", kind: "in", description: "Drop from above while fading in" },
  { id: "slide-left", name: "Slide in left", kind: "in", description: "Enter from the right" },
  { id: "slide-right", name: "Slide in right", kind: "in", description: "Enter from the left" },
  { id: "pop-in", name: "Pop", kind: "in", description: "Scale up with an overshoot" },
  { id: "zoom-in", name: "Zoom in", kind: "in", description: "Settle from 140% while fading in" },
  { id: "blur-in", name: "Blur in", kind: "in", description: "Come into focus" },
  { id: "spin-in", name: "Spin in", kind: "in", description: "Rotate and scale in" },
  { id: "typewriter", name: "Typewriter", kind: "in", textOnly: true, description: "Letters appear one by one" },
  { id: "words-up", name: "Words rise", kind: "in", textOnly: true, description: "Words rise and unblur in sequence" },
  { id: "letters-pop", name: "Letters pop", kind: "in", textOnly: true, description: "Letters pop in with overshoot" },
  { id: "fade-out", name: "Fade out", kind: "out", description: "Opacity → 0" },
  { id: "slide-out-down", name: "Slide out", kind: "out", description: "Sink and fade away" },
  { id: "pop-out", name: "Pop out", kind: "out", description: "Shrink with anticipation" },
  { id: "zoom-out", name: "Zoom out", kind: "out", description: "Grow and fade away" },
  { id: "pulse", name: "Pulse", kind: "loop", description: "Gentle scale pulse every second" },
  { id: "float", name: "Float", kind: "loop", description: "Bob up and down" },
  { id: "wiggle", name: "Wiggle", kind: "loop", description: "Nervous jitter" },
  { id: "spin", name: "Spin", kind: "loop", description: "Rotate continuously" },
];

export interface PresetOptions {
  comp: Composition;
  /** Playhead: "in" presets start here, "out" presets start here and loops run from here to the end. */
  time: number;
  /** Seconds. Default 0.6 (in/out). */
  duration?: number;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Apply a preset to a layer; returns the new layer. */
export function applyPreset(layer: Layer, presetId: string, opts: PresetOptions): Layer {
  const { comp } = opts;
  const fps = comp.fps;
  const t0 = round(Math.max(0, Math.min(opts.time, comp.duration)));
  const d = opts.duration ?? 0.6;
  const t1 = round(Math.min(comp.duration, t0 + d));
  const center: Vec2 = layer.type === "path" ? [0, 0] : [comp.width / 2, comp.height / 2];
  const at = <T>(path: string, fallback: T, t = t0): T => sample(getIn(layer, path) as never, t, fallback as never) as T;
  const pos = at<Vec2>("transform.position", center);
  const opacity = at("transform.opacity", 100);
  const scaleNow = at<number | Vec2>("transform.scale", 100);
  const scaled = (f: number): number | Vec2 => (Array.isArray(scaleNow) ? [scaleNow[0] * f, scaleNow[1] * f] : scaleNow * f);
  const rotation = at("transform.rotation", 0);
  const dist = Math.round(Math.min(comp.width, comp.height) * 0.08);
  const kf = (t: number, v: unknown, ease?: Easing): Keyframe<unknown> => (ease ? { t, v, ease } : { t, v });
  let l = layer;
  const anim = (path: string, kfs: Keyframe<unknown>[]) => (l = insertKeyframes(l, path, kfs, fps));
  const fadeIn = (dur = d * 0.7) => anim("transform.opacity", [kf(t0, 0, "easeOutCubic"), kf(round(Math.min(comp.duration, t0 + dur)), opacity || 100)]);
  const slideIn = (dx: number, dy: number) => {
    anim("transform.position", [kf(t0, [pos[0] + dx, pos[1] + dy], "easeOutCubic"), kf(t1, pos)]);
    fadeIn();
  };
  const textAnimator = (animator: Record<string, unknown>) => {
    if (layer.type !== "text") return;
    l = setIn(l, "animator", { delay: round(Math.max(0, t0 - (layer.in ?? 0))), ...animator });
  };

  switch (presetId) {
    case "fade-in":
      fadeIn(d);
      break;
    case "slide-up":
      slideIn(0, dist);
      break;
    case "slide-down":
      slideIn(0, -dist);
      break;
    case "slide-left":
      slideIn(dist * 2, 0);
      break;
    case "slide-right":
      slideIn(-dist * 2, 0);
      break;
    case "pop-in":
      anim("transform.scale", [kf(t0, scaled(0), "easeOutBack"), kf(t1, scaleNow)]);
      fadeIn(d * 0.3);
      break;
    case "zoom-in":
      anim("transform.scale", [kf(t0, scaled(1.4), "easeOutExpo"), kf(t1, scaleNow)]);
      fadeIn();
      break;
    case "blur-in": {
      const effects = l.effects ?? [];
      let index = effects.findIndex((e) => e.type === "blur");
      if (index < 0) {
        l = { ...l, effects: [...effects, { type: "blur", radius: 0 }] };
        index = effects.length;
      }
      anim(`effects.${index}.radius`, [kf(t0, 24, "easeOutCubic"), kf(t1, 0)]);
      fadeIn();
      break;
    }
    case "spin-in":
      anim("transform.rotation", [kf(t0, rotation - 120, "easeOutBack"), kf(t1, rotation)]);
      anim("transform.scale", [kf(t0, scaled(0.3), "easeOutBack"), kf(t1, scaleNow)]);
      fadeIn(d * 0.4);
      break;
    case "typewriter":
      textAnimator({ by: "character", stagger: 0.05, duration: 0.01, ease: "linear", from: { opacity: 0 } });
      break;
    case "words-up":
      textAnimator({ by: "word", stagger: 0.08, duration: 0.6, ease: "easeOutCubic", from: { opacity: 0, offset: [0, 40], blur: 8 } });
      break;
    case "letters-pop":
      textAnimator({ by: "character", stagger: 0.035, duration: 0.5, ease: "easeOutBack", from: { opacity: 0, scale: 30, offset: [0, 20] } });
      break;
    case "fade-out":
      anim("transform.opacity", [kf(t0, opacity, "easeInCubic"), kf(t1, 0)]);
      break;
    case "slide-out-down":
      anim("transform.position", [kf(t0, pos, "easeInCubic"), kf(t1, [pos[0], pos[1] + dist])]);
      anim("transform.opacity", [kf(t0, opacity, "easeInCubic"), kf(t1, 0)]);
      break;
    case "pop-out":
      anim("transform.scale", [kf(t0, scaleNow, "easeInBack"), kf(t1, scaled(0))]);
      break;
    case "zoom-out":
      anim("transform.scale", [kf(t0, scaleNow, "easeInCubic"), kf(t1, scaled(1.4))]);
      anim("transform.opacity", [kf(t0, opacity, "easeInCubic"), kf(t1, 0)]);
      break;
    case "pulse":
    case "float":
    case "wiggle":
    case "spin": {
      const end = comp.duration;
      const kfs: Keyframe<unknown>[] = [];
      if (presetId === "spin") {
        anim("transform.rotation", [kf(t0, rotation, "linear"), kf(round(end), round(rotation + ((end - t0) / 3) * 360))]);
        break;
      }
      const period = presetId === "wiggle" ? 1 / 8 : presetId === "pulse" ? 0.5 : 1;
      let seed = 12345;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
      for (let i = 0, t = t0; t <= end + 1e-6; i++, t = round(t0 + i * period)) {
        if (presetId === "pulse") kfs.push(kf(t, i % 2 === 0 ? scaleNow : scaled(1.08), "easeInOutSine"));
        if (presetId === "float") kfs.push(kf(t, [pos[0], pos[1] + (i % 2 === 0 ? 0 : -dist * 0.25)], "easeInOutSine"));
        if (presetId === "wiggle") kfs.push(kf(t, i === 0 ? pos : [round(pos[0] + rand() * dist * 0.08), round(pos[1] + rand() * dist * 0.08)], "easeInOutSine"));
      }
      anim(presetId === "pulse" ? "transform.scale" : "transform.position", kfs);
      break;
    }
    default:
      throw new Error(`Unknown preset "${presetId}"`);
  }
  return l;
}
