import { describe, expect, it } from "vitest";
import {
  animatedPaths,
  blankProject,
  duplicateLayer,
  getIn,
  keyframeIndexAt,
  moveKeyframe,
  removeKeyframe,
  setIn,
  setKeyframeEase,
  setValueAtTime,
  shiftLayerTime,
  toggleAnimated,
  validateProject,
  type Layer,
} from "../src/index.ts";

const rect = (): Layer => ({ id: "r", type: "rect", size: [10, 10], transform: { position: [100, 100] }, effects: [{ type: "blur", radius: 4 }] });

describe("getIn / setIn", () => {
  it("reads and writes nested objects and arrays immutably", () => {
    const l = rect();
    expect(getIn(l, "effects.0.radius")).toBe(4);
    const l2 = setIn(l, "effects.0.radius", 8);
    expect(getIn(l2, "effects.0.radius")).toBe(8);
    expect(getIn(l, "effects.0.radius")).toBe(4);
    const l3 = setIn(l, "transform.rotation", 45);
    expect(l3.transform).toEqual({ position: [100, 100], rotation: 45 });
    expect(setIn(l3, "transform.rotation", undefined).transform).toEqual({ position: [100, 100] });
  });
});

describe("keyframe editing", () => {
  it("stopwatch toggle creates and removes animation", () => {
    let l = toggleAnimated(rect(), "transform.position", 1, [0, 0]);
    expect(l.transform?.position).toEqual({ keyframes: [{ t: 1, v: [100, 100] }] });
    l = toggleAnimated(l, "transform.position", 1, [0, 0]);
    expect(l.transform?.position).toEqual([100, 100]);
  });

  it("setValueAtTime updates static values or adds/updates keyframes", () => {
    let l = setValueAtTime(rect(), "transform.position", 2, [5, 5]);
    expect(l.transform?.position).toEqual([5, 5]);
    l = toggleAnimated(l, "transform.position", 0, [0, 0]);
    l = setKeyframeEase(l, "transform.position", 0, "easeOutBack");
    l = setValueAtTime(l, "transform.position", 2, [50, 50], 30);
    l = setValueAtTime(l, "transform.position", 2.01, [60, 60], 30); // same frame → update
    const kfs = (l.transform?.position as { keyframes: { t: number; v: unknown; ease?: unknown }[] }).keyframes;
    expect(kfs).toEqual([
      { t: 0, v: [5, 5], ease: "easeOutBack" },
      { t: 2, v: [60, 60], ease: "easeOutBack" },
    ]);
    expect(keyframeIndexAt(l.transform?.position, 2, 30)).toBe(1);
  });

  it("moves, re-sorts and removes keyframes", () => {
    let l = setIn(rect(), "transform.opacity", { keyframes: [{ t: 0, v: 0 }, { t: 1, v: 100 }] });
    l = moveKeyframe(l, "transform.opacity", 0, 2);
    expect((l.transform?.opacity as { keyframes: { t: number }[] }).keyframes.map((k) => k.t)).toEqual([1, 2]);
    l = removeKeyframe(l, "transform.opacity", 0);
    l = removeKeyframe(l, "transform.opacity", 0);
    expect(l.transform?.opacity).toBe(0); // last keyframe removed → static value
  });

  it("lists animated paths and shifts layers in time with their keyframes", () => {
    let l = setIn(rect(), "transform.opacity", { keyframes: [{ t: 0.5, v: 0 }, { t: 1, v: 100 }] });
    l = setIn(l, "effects.0.radius", { keyframes: [{ t: 0.5, v: 10 }, { t: 1, v: 0 }] });
    expect(animatedPaths(l)).toEqual(["transform.opacity", "effects.0.radius"]);
    const moved = shiftLayerTime({ ...l, out: 3 }, 1);
    expect(moved.in).toBe(1);
    expect(moved.out).toBe(4);
    expect((moved.transform?.opacity as { keyframes: { t: number }[] }).keyframes.map((k) => k.t)).toEqual([1.5, 2]);
  });

  it("duplicates layers with unique ids", () => {
    const p = blankProject();
    const a = duplicateLayer(p, "hello");
    const b = duplicateLayer(a.project, "hello");
    expect([a.id, b.id]).toEqual(["hello-copy", "hello-copy-2"]);
    expect(b.project.compositions[0].layers.map((l) => l.id)).toEqual(["hello", "hello-copy-2", "hello-copy"]);
    expect(validateProject(b.project).ok).toBe(true);
  });
});

describe("easing helpers", async () => {
  const { easeToBezier, easeKind, cubicBezier, NAMED_EASES } = await import("../src/index.ts");
  it("bezier equivalents track the named curves", () => {
    for (const name of ["easeOutCubic", "easeInOutQuad", "easeOutExpo"]) {
      const b = easeToBezier(name)!;
      const f = cubicBezier(...b);
      for (const x of [0.2, 0.5, 0.8]) expect(Math.abs(f(x) - NAMED_EASES[name](x))).toBeLessThan(0.05);
    }
    expect(easeToBezier("easeOutElastic")).toBeNull();
    expect(easeKind("easeOutBack")).toBe("overshoot");
    expect(easeKind([0.2, 0, 0, 1])).toBe("eased");
  });
});

describe("animation presets", async () => {
  const { ANIMATION_PRESETS, applyPreset } = await import("../src/index.ts");
  const comp = blankProject().compositions[0];
  it("every preset produces a valid layer", () => {
    for (const preset of ANIMATION_PRESETS) {
      const base: Layer = preset.textOnly ? { id: "t", type: "text", text: "Hello world" } : { id: "r", type: "rect", size: [100, 100], fill: "#fff" };
      const layer = applyPreset(base, preset.id, { comp, time: 1 });
      const p = { ...blankProject(), compositions: [{ ...comp, layers: [layer] }] };
      const r = validateProject(p);
      expect(r.ok ? [] : r.errors, preset.id).toEqual([]);
      expect(layer, preset.id).not.toEqual(base);
    }
  });
  it("slide-up ends at the layer's current position and keeps earlier keyframes", () => {
    let l: Layer = { id: "r", type: "rect", size: [10, 10], transform: { position: { keyframes: [{ t: 0, v: [100, 100] }, { t: 0.5, v: [500, 500] }] } } };
    l = applyPreset(l, "slide-up", { comp, time: 2 });
    const kfs = (l.transform?.position as { keyframes: { t: number; v: number[] }[] }).keyframes;
    expect(kfs.map((k) => k.t)).toEqual([0, 0.5, 2, 2.6]);
    expect(kfs[3].v).toEqual([500, 500]);
    expect(kfs[2].v[1]).toBeGreaterThan(500);
  });
});
