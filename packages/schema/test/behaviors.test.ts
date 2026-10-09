import { describe, expect, it } from "vitest";
import { applyBehaviors, applyPreset, blankProject, noise1, validateProject, type Layer } from "../src/index.ts";

const comp = { ...blankProject().compositions[0], duration: 10 };
const at = (l: Layer, t: number, getLayer?: (id: string) => Layer | undefined) => applyBehaviors(l, t, comp, getLayer);
const rect = (extra: Partial<Layer> = {}): Layer => ({ id: "r", type: "rect", size: [10, 10], transform: { position: [100, 100] }, ...extra }) as Layer;

describe("noise", () => {
  it("is deterministic, bounded and smooth", () => {
    expect(noise1(3.3, 7)).toBe(noise1(3.3, 7));
    for (let x = 0; x < 20; x += 0.37) expect(Math.abs(noise1(x, 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(noise1(5.001, 3) - noise1(5, 3))).toBeLessThan(0.01);
    expect(noise1(5, 3)).not.toBe(noise1(5, 4));
  });
});

describe("applyBehaviors", () => {
  it("wiggle offsets within the amount, per axis, and stays deterministic", () => {
    const l = rect({ behaviors: [{ type: "wiggle", property: "transform.position", amount: [20, 0], frequency: 3 }] });
    let moved = false;
    for (let t = 0; t < 3; t += 0.1) {
      const p = at(l, t).transform!.position as number[];
      expect(Math.abs(p[0] - 100)).toBeLessThanOrEqual(20);
      expect(p[1]).toBe(100);
      if (Math.abs(p[0] - 100) > 1) moved = true;
    }
    expect(moved).toBe(true);
    expect(at(l, 1.23).transform!.position).toEqual(at(l, 1.23).transform!.position);
  });

  it("oscillate follows its waveform; drift accumulates and holds after end", () => {
    const osc = rect({ behaviors: [{ type: "oscillate", property: "transform.rotation", amplitude: 10, frequency: 1 }] });
    expect(at(osc, 0.25).transform!.rotation).toBeCloseTo(10);
    expect(at(osc, 0.75).transform!.rotation).toBeCloseTo(-10);
    const sq = rect({ behaviors: [{ type: "oscillate", property: "transform.opacity", amplitude: 50, wave: "square" }] });
    expect(at(sq, 0.1).transform!.opacity).toBe(150);
    const drift = rect({ behaviors: [{ type: "drift", property: "transform.rotation", speed: 90, start: 1, end: 3 }] });
    expect(at(drift, 0.5).transform!.rotation).toBe(0);
    expect(at(drift, 2).transform!.rotation).toBe(90);
    expect(at(drift, 5).transform!.rotation).toBe(180);
  });

  it("loop repeats keyframes (cycle and pingpong)", () => {
    const base = rect({ transform: { opacity: { keyframes: [{ t: 0, v: 0, ease: "linear" }, { t: 1, v: 100 }] } } });
    const cyc = { ...base, behaviors: [{ type: "loop" as const, property: "transform.opacity" }] };
    expect(at(cyc, 1.25).transform!.opacity).toBeCloseTo(25);
    const pp = { ...base, behaviors: [{ type: "loop" as const, property: "transform.opacity", mode: "pingpong" as const }] };
    expect(at(pp, 1.25).transform!.opacity).toBeCloseTo(75);
    expect(at(pp, 2.25).transform!.opacity).toBeCloseTo(25);
  });

  it("follow trails another layer with a delay and offset; fadeIn ramps in", () => {
    const leader = rect({ id: "lead", transform: { position: { keyframes: [{ t: 0, v: [0, 0], ease: "linear" }, { t: 1, v: [100, 0] }] } } } as Partial<Layer>);
    const f = rect({ id: "f", behaviors: [{ type: "follow", property: "transform.position", layer: "lead", delay: 0.5, offset: [0, 40] }] });
    expect(at(f, 1, () => leader).transform!.position).toEqual([50, 40]);
    const fade = rect({ behaviors: [{ type: "oscillate", property: "transform.rotation", amplitude: 10, frequency: 1, fadeIn: 1 }] });
    expect(Math.abs(at(fade, 0.25).transform!.rotation as number)).toBeLessThan(10);
  });

  it("disabled behaviors and window bounds are respected; unknown layers fail validation", () => {
    const off = rect({ behaviors: [{ type: "drift", property: "transform.rotation", speed: 90, enabled: false }] });
    expect(at(off, 2).transform!.rotation).toBeUndefined();
    const bad = { ...blankProject(), compositions: [{ ...comp, layers: [rect({ behaviors: [{ type: "follow", property: "transform.position", layer: "ghost" }] })] }] };
    const r = validateProject(bad);
    expect(!r.ok && r.errors.some((e) => e.includes('"ghost" does not exist'))).toBe(true);
  });

  it("loop presets now create behaviors instead of keyframes", () => {
    const l = applyPreset(rect(), "wiggle", { comp, time: 1 });
    expect(l.behaviors).toEqual([expect.objectContaining({ type: "wiggle", property: "transform.position", start: 1 })]);
    expect(l.transform?.position).toEqual([100, 100]);
  });
});
