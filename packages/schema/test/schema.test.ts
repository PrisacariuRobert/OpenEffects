import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EditError,
  addLayer,
  blankProject,
  cubicBezier,
  deleteLayer,
  sample,
  setKeyframes,
  updateLayer,
  validateProject,
  type Project,
} from "../src/index.ts";

const examplesDir = path.resolve(import.meta.dirname, "../../../examples");

describe("validateProject", () => {
  it("accepts the blank template and every example project", () => {
    expect(validateProject(blankProject()).ok).toBe(true);
    for (const dir of fs.readdirSync(examplesDir)) {
      const file = path.join(examplesDir, dir, "project.oe.json");
      if (!fs.existsSync(file)) continue;
      const r = validateProject(JSON.parse(fs.readFileSync(file, "utf8")));
      expect(r.ok ? [] : r.errors, dir).toEqual([]);
    }
  });

  it("reports typos with a precise path", () => {
    const p = blankProject() as unknown as { compositions: { layers: Record<string, unknown>[] }[] };
    p.compositions[0].layers[0].colour = "#fff";
    const r = validateProject(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/compositions\[0\]\.layers\[0\].*colour/);
  });

  it("rejects bad colors, duplicate ids, missing parents and parent cycles", () => {
    const base = blankProject();
    const withLayers = (layers: unknown[]) => ({ ...base, compositions: [{ ...base.compositions[0], layers }] });
    const bad = validateProject(withLayers([{ id: "a", type: "solid", color: "not-a-color" }]));
    expect(bad.ok).toBe(false);
    const dup = validateProject(withLayers([{ id: "a", type: "null" }, { id: "a", type: "null" }]));
    expect(!dup.ok && dup.errors.some((e) => e.includes("Duplicate layer id"))).toBe(true);
    const orphan = validateProject(withLayers([{ id: "a", type: "null", parent: "ghost" }]));
    expect(!orphan.ok && orphan.errors.some((e) => e.includes('"ghost" does not exist'))).toBe(true);
    const cycle = validateProject(withLayers([{ id: "a", type: "null", parent: "b" }, { id: "b", type: "null", parent: "a" }]));
    expect(!cycle.ok && cycle.errors.some((e) => e.includes("cycle"))).toBe(true);
  });

  it("accepts gradients on solid layers", () => {
    const base = blankProject();
    const r = validateProject({
      ...base,
      compositions: [{ ...base.compositions[0], layers: [{ id: "bg", type: "solid", color: { type: "radial", stops: [[0, "#fff"], [1, "#000"]] } }] }],
    });
    expect(r.ok).toBe(true);
  });
});

describe("sample", () => {
  const linear = (a: number, b: number) => ({ keyframes: [{ t: 0, v: a, ease: "linear" }, { t: 1, v: b }] });

  it("returns static values and fallbacks", () => {
    expect(sample(5, 10, 0)).toBe(5);
    expect(sample(undefined, 10, 7)).toBe(7);
  });

  it("interpolates numbers, vectors and colors, and clamps outside the keyframes", () => {
    expect(sample(linear(0, 100), 0.25, 0)).toBeCloseTo(25);
    expect(sample(linear(0, 100), -1, 0)).toBe(0);
    expect(sample(linear(0, 100), 5, 0)).toBe(100);
    const vec = { keyframes: [{ t: 0, v: [0, 10] as [number, number], ease: "linear" }, { t: 2, v: [100, 30] as [number, number] }] };
    expect(sample(vec, 1, [0, 0])).toEqual([50, 20]);
    const color = { keyframes: [{ t: 0, v: "#000000", ease: "linear" }, { t: 1, v: "#ffffff" }] };
    expect(sample(color, 0.5, "")).toBe("rgba(128, 128, 128, 1.0000)");
  });

  it("supports hold keyframes and easing", () => {
    const hold = { keyframes: [{ t: 0, v: 1, ease: "hold" }, { t: 1, v: 2 }] };
    expect(sample(hold, 0.99, 0)).toBe(1);
    expect(sample(hold, 1, 0)).toBe(2);
    const eased = { keyframes: [{ t: 0, v: 0, ease: "easeInCubic" }, { t: 1, v: 1 }] };
    expect(sample(eased, 0.5, 0)).toBeCloseTo(0.125);
  });

  it("solves cubic-bezier like CSS", () => {
    const ease = cubicBezier(0.25, 0.1, 0.25, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.8024, 3);
  });
});

describe("ops", () => {
  const project = (): Project => blankProject();

  it("adds, updates (deep merge, null deletes) and deletes layers without mutating input", () => {
    const p0 = project();
    const p1 = addLayer(p0, { id: "box", type: "rect", size: [10, 10], fill: "#f00", transform: { rotation: 45, opacity: 50 } });
    expect(p0.compositions[0].layers.map((l) => l.id)).toEqual(["hello"]);
    expect(p1.compositions[0].layers.map((l) => l.id)).toEqual(["hello", "box"]);
    const p2 = updateLayer(p1, "box", { transform: { opacity: null, scale: 50 } });
    expect(p2.compositions[0].layers[1].transform).toEqual({ rotation: 45, scale: 50 });
    expect(deleteLayer(p2, "box").compositions[0].layers).toHaveLength(1);
    expect(() => addLayer(p2, { id: "box", type: "null" })).toThrow(EditError);
    expect(() => updateLayer(p2, "nope", {})).toThrow(/not found/);
  });

  it("sets keyframes on a dotted path, sorted by time", () => {
    const p = setKeyframes(project(), "hello", "transform.position", [
      { t: 1, v: [100, 100] },
      { t: 0, v: [0, 0], ease: "easeOutBack" },
    ]);
    const pos = p.compositions[0].layers[0].transform?.position as { keyframes: { t: number }[] };
    expect(pos.keyframes.map((k) => k.t)).toEqual([0, 1]);
    expect(validateProject(p).ok).toBe(true);
  });
});

describe("generated JSON Schema", () => {
  it("is up to date (run `pnpm schema:json` after changing the schema)", async () => {
    const { z } = await import("zod");
    const { ProjectSchema } = await import("../src/schema.ts");
    const expected = { title: "OpenEffects project", ...z.toJSONSchema(ProjectSchema, { unrepresentable: "any", io: "input", reused: "ref" }) };
    const file = path.resolve(import.meta.dirname, "../../../schema/project.schema.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(JSON.parse(JSON.stringify(expected)));
  });
});

describe("media timing", async () => {
  const { mediaSourceTime, compTimeOfSource, beatMarkers } = await import("../src/index.ts");
  it("maps composition time to file time and back", () => {
    const v = { id: "v", type: "video" as const, src: "a.mp4", in: 2, trimStart: 1, speed: 2 };
    expect(mediaSourceTime(v, 3)).toBe(3); // (3-2)*2+1
    expect(compTimeOfSource(v, 3)).toBe(3);
    expect(mediaSourceTime({ ...v, loop: true }, 4, 3)).toBe(1); // 5 → loops within [1, 3)
    const markers = beatMarkers({ id: "a", type: "audio", src: "m.mp3", in: 1, out: 3 }, [0, 0.5, 1, 1.5, 2, 2.5], { duration: 10 });
    expect(markers.map((m) => m.t)).toEqual([1, 1.5, 2, 2.5, 3]);
  });
});
