import { describe, expect, it } from "vitest";
import { lerpPath, sample, validateProject, type Layer, type Project } from "@openeffects/schema";
import { addAsPrecomp, exportLottie, importLottie, lottieToSvg, svgToLottie, type LLayer, type LottieAnimation, type LProp } from "../src/index.ts";

const project = (layers: Layer[], extra: Partial<Project["compositions"][0]> = {}): Project => ({
  version: 1,
  compositions: [{ id: "main", width: 400, height: 300, fps: 30, duration: 2, layers, ...extra }],
});
const find = (l: LottieAnimation, nm: string) => l.layers.find((x) => x.nm === nm)!;

describe("svg path ⇄ lottie shapes", () => {
  it("converts lines, curves, arcs and closes paths", () => {
    const [s] = svgToLottie("M0 0 L100 0 L100 100 Z");
    expect(s.c).toBe(true);
    expect(s.v).toEqual([
      [0, 0],
      [100, 0],
      [100, 100],
    ]);
    const arc = svgToLottie("M0 50 A50 50 0 1 1 100 50 A50 50 0 1 1 0 50 Z")[0];
    expect(arc.v.length).toBeGreaterThanOrEqual(4);
    // Every arc vertex lies on the circle.
    for (const [x, y] of arc.v) expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(50, 1);
  });

  it("handles relative, smooth and quadratic commands", () => {
    const shapes = svgToLottie("m10 10 h20 v20 q10 10 20 0 t20 0 s10 10 20 0 c0 5 5 5 5 0 z M200 200 l5 5");
    expect(shapes).toHaveLength(2);
    expect(shapes[0].v[1]).toEqual([30, 10]);
    expect(shapes[0].v[2]).toEqual([30, 30]);
    expect(shapes[1].c).toBe(false);
  });

  it("round-trips through SVG data", () => {
    const d = "M0 0 C10 0 20 10 20 20 L0 20 Z";
    const back = lottieToSvg(svgToLottie(d));
    expect(svgToLottie(back)).toEqual(svgToLottie(d));
  });

  it("morphs paths with the same commands", () => {
    expect(lerpPath("M0 0 L10 0", "M0 10 L20 0", 0.5)).toBe("M0 5 L15 0");
    expect(lerpPath("M0 0 L10 0", "M0 0 L10 0 L5 5", 0.5)).toBeNull();
    const d = { keyframes: [{ t: 0, v: "M0 0 L10 0", ease: "linear" as const }, { t: 1, v: "M0 10 L20 0" }] };
    expect(sample(d, 0.5, "")).toBe("M0 5 L15 0");
  });
});

describe("export", () => {
  it("maps transforms, easing, shapes and fills", () => {
    const { lottie, warnings } = exportLottie(
      project(
        [
          {
            id: "box",
            type: "rect",
            size: [100, 50],
            radius: 8,
            fill: "#ff0000",
            stroke: { color: "rgba(0,0,255,0.5)", width: 3, cap: "round" },
            transform: {
              position: { keyframes: [{ t: 0, v: [0, 150], ease: "easeOutCubic" }, { t: 1, v: [400, 150] }] },
              rotation: { keyframes: [{ t: 0, v: 0, ease: "hold" }, { t: 1, v: 90 }] },
              scale: { keyframes: [{ t: 0, v: 0, ease: "easeOutBounce" }, { t: 0.5, v: 100 }] },
            },
          },
        ],
        { background: "#101010", markers: [{ t: 1, label: "hit" }] },
      ),
    );
    expect(warnings).toEqual([]);
    expect(lottie).toMatchObject({ fr: 30, ip: 0, op: 60, w: 400, h: 300 });
    const box = find(lottie, "box");
    const pos = box.ks.p as LProp;
    expect(pos.a).toBe(1);
    const k = pos.k as { t: number; s: number[]; o?: { x: number[] }; i?: { x: number[] } }[];
    expect(k[0]).toMatchObject({ t: 0, s: [0, 150, 0], o: { x: [0.33, 0.33, 0.33] }, i: { x: [0.68, 0.68, 0.68] } });
    expect(k[1]).toMatchObject({ t: 30, s: [400, 150, 0] });
    expect(((box.ks.r as LProp).k as { h?: number }[])[0].h).toBe(1);
    // Bounce can't be a bezier: baked frame by frame.
    expect(((box.ks.s as LProp).k as unknown[]).length).toBeGreaterThan(10);
    const group = box.shapes![0] as unknown as { it: { ty: string; o?: LProp; lc?: number }[] };
    expect(group.it.map((i) => i.ty)).toEqual(["rc", "st", "fl", "tr"]);
    expect(group.it[1].o).toEqual({ a: 0, k: 50 });
    expect(group.it[1].lc).toBe(2);
    expect(lottie.layers[lottie.layers.length - 1].nm).toBe("Background");
    expect(lottie.markers).toEqual([{ tm: 30, cm: "hit", dr: 0 }]);
  });

  it("puts the top layer first, parents by index and inserts matte copies", () => {
    const { lottie } = exportLottie(
      project([
        { id: "rig", type: "null", transform: { position: [200, 150] } },
        { id: "wipe", type: "rect", size: [400, 300], visible: false, parent: "rig" },
        { id: "logo", type: "ellipse", size: [80, 80], matte: { layer: "wipe", mode: "alphaInverted" }, parent: "rig" },
      ]),
    );
    expect(lottie.layers.map((l) => l.nm)).toEqual(["wipe (matte)", "logo", "wipe", "rig"]);
    const [matte, logo, wipe, rig] = lottie.layers;
    expect(matte.td).toBe(1);
    expect(logo.tt).toBe(2);
    expect(logo.tp).toBe(matte.ind);
    expect(wipe.hd).toBe(true);
    expect(logo.parent).toBe(rig.ind);
    expect(matte.parent).toBe(rig.ind);
  });

  it("offsets children of layers whose Lottie content starts top-left", () => {
    const p: Project = {
      version: 1,
      compositions: [
        { id: "main", width: 400, height: 300, fps: 30, duration: 2, layers: [{ id: "pc", type: "comp", comp: "inner" }, { id: "kid", type: "rect", size: [10, 10], parent: "pc", transform: { position: [0, 0] } }] },
        { id: "inner", width: 200, height: 100, fps: 30, duration: 2, layers: [] },
      ],
    };
    const { lottie } = exportLottie(p);
    expect((find(lottie, "pc").ks.a as LProp).k).toEqual([100, 50, 0]);
    expect((find(lottie, "kid").ks.p as LProp).k).toEqual([100, 50, 0]);
    expect(lottie.assets!.find((a) => a.id === "inner")).toBeTruthy();
  });

  it("bakes behaviors and exports path morphs and time remapping", () => {
    const p: Project = {
      version: 1,
      compositions: [
        {
          id: "main",
          width: 400,
          height: 300,
          fps: 30,
          duration: 2,
          layers: [
            { id: "wig", type: "ellipse", size: [20, 20], behaviors: [{ type: "wiggle", property: "transform.position", amount: 30 }] },
            { id: "blob", type: "path", d: { keyframes: [{ t: 0, v: "M0 0 L10 0 L10 10 Z" }, { t: 1, v: "M0 0 L40 0 L40 40 Z" }] }, fill: "#fff" },
            { id: "slow", type: "comp", comp: "inner", timeRemap: { keyframes: [{ t: 0, v: 0, ease: "linear" }, { t: 2, v: 1 }] } },
          ],
        },
        { id: "inner", width: 100, height: 100, fps: 30, duration: 2, layers: [] },
      ],
    };
    const { lottie } = exportLottie(p);
    expect(((find(lottie, "wig").ks.p as LProp).k as unknown[]).length).toBeGreaterThan(5);
    const sh = (find(lottie, "blob").shapes![0] as unknown as { it: { ty: string; ks?: LProp }[] }).it[0];
    expect(sh.ty).toBe("sh");
    expect(sh.ks!.a).toBe(1);
    expect((find(lottie, "slow") as LLayer).tm).toBeTruthy();
  });

  it("warns about what Lottie can't hold", () => {
    const { warnings } = exportLottie(
      project([
        { id: "v", type: "video", src: "a.mp4" },
        { id: "g", type: "rect", size: [10, 10], effects: [{ type: "glow" }] },
      ]),
    );
    expect(warnings.join(" ")).toMatch(/Video/);
    expect(warnings.join(" ")).toMatch(/glow/);
  });
});

// A small After Effects–style file: solid parent, shape layer with groups, a text layer,
// track matte, mask, bezier easing, curved motion and legacy "e" keyframes.
const aeFile = {
  v: "5.7.4",
  fr: 25,
  ip: 0,
  op: 50,
  w: 500,
  h: 400,
  nm: "AE test",
  fonts: { list: [{ fName: "Inter-Bold", fFamily: "Inter", fStyle: "Bold", ascent: 72 }] },
  markers: [{ tm: 25, cm: '{"name":"middle"}', dr: 0 }],
  layers: [
    {
      ind: 1,
      ty: 5,
      nm: "Title",
      ks: { p: { a: 0, k: [250, 350, 0] }, a: { a: 0, k: [0, 0, 0] } },
      ip: 0,
      op: 50,
      st: 0,
      t: { d: { k: [{ t: 0, s: { s: 40, f: "Inter-Bold", t: "Hello\rWorld", j: 2, tr: 50, lh: 48, fc: [1, 0, 0] } }] } },
    },
    { ind: 2, ty: 4, nm: "Matte", td: 1, ks: { p: { a: 0, k: [250, 200] } }, ip: 0, op: 50, st: 0, shapes: [{ ty: "rc", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [200, 200] }, r: { a: 0, k: 0 } }, { ty: "fl", c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 } }] },
    {
      ind: 3,
      ty: 4,
      nm: "Shapes",
      tt: 1,
      parent: 4,
      ks: {
        o: { a: 1, k: [{ t: 0, s: [0], o: { x: [0.33], y: [0] }, i: { x: [0.67], y: [1] } }, { t: 10, s: [100] }] },
        p: { a: 1, k: [{ t: 0, s: [0, 0, 0], e: [100, 0, 0], to: [0, -30, 0], ti: [0, -30, 0], o: { x: 0.33, y: 0 }, i: { x: 0.67, y: 1 } }, { t: 25 }] },
      },
      ip: 0,
      op: 50,
      st: 0,
      shapes: [
        {
          ty: "gr",
          nm: "Dots",
          it: [
            { ty: "el", p: { a: 0, k: [-20, 0] }, s: { a: 0, k: [20, 20] } },
            { ty: "el", p: { a: 0, k: [20, 0] }, s: { a: 0, k: [20, 20] } },
            { ty: "fl", c: { a: 0, k: [0, 0.5, 1, 1] }, o: { a: 0, k: 50 } },
            { ty: "tr", p: { a: 0, k: [10, 10] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 45 }, o: { a: 0, k: 100 } },
          ],
        },
        {
          ty: "gr",
          nm: "Line",
          it: [
            { ty: "sh", ks: { a: 1, k: [{ t: 0, s: [{ c: false, v: [[0, 0], [10, 0]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]] }], o: { x: [0.4], y: [0] }, i: { x: [0.2], y: [1] } }, { t: 20, s: [{ c: false, v: [[0, 0], [50, 20]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]] }] }] } },
            { ty: "st", c: { a: 0, k: [1, 1, 1, 1] }, o: { a: 0, k: 100 }, w: { a: 0, k: 4 }, lc: 2, lj: 2 },
            { ty: "tm", s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: 0, s: [0], h: 1 }, { t: 5, s: [100] }] }, o: { a: 0, k: 0 } },
            { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
          ],
        },
      ],
    },
    {
      ind: 4,
      ty: 1,
      nm: "Holder",
      sc: "#223344",
      sw: 100,
      sh: 60,
      ks: { p: { a: 0, k: [250, 200] }, a: { a: 0, k: [50, 30] } },
      ip: 5,
      op: 50,
      st: 0,
      hasMask: true,
      masksProperties: [{ mode: "a", inv: false, pt: { a: 0, k: { c: true, v: [[0, 0], [100, 0], [100, 60]], i: [[0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0]] } } }],
    },
  ],
};

describe("import", () => {
  const { project: p, warnings } = importLottie(structuredClone(aeFile));
  const main = p.compositions[0];
  const byId = (id: string) => main.layers.find((l) => l.id === id)!;

  it("produces a valid project in our layer order", () => {
    expect(validateProject(p).ok).toBe(true);
    expect(main).toMatchObject({ width: 500, height: 400, fps: 25, duration: 2, name: "AE test" });
    expect(main.markers).toEqual([{ t: 1, label: "middle" }]);
    expect(main.layers[main.layers.length - 1].type).toBe("text"); // Lottie's first layer is on top
    expect(warnings).toEqual([]);
  });

  it("converts solids, timing and parenting with content offsets", () => {
    const holder = byId("Holder");
    expect(holder).toMatchObject({ type: "solid", color: "#223344", size: [100, 60], in: 0.2 });
    // Lottie anchor [50,30] on a 100×60 solid = its center = our anchor [0,0].
    expect(holder.transform?.anchor).toBeUndefined();
    const shapes = byId("Shapes");
    expect(shapes.parent).toBe("Holder");
  });

  it("keeps easing, bakes curved motion and folds opacity into shapes", () => {
    const shapes = byId("Shapes");
    expect(shapes.type).toBe("null");
    const pos = shapes.transform!.position as { keyframes: { t: number; v: number[] }[] };
    // Curved path: per-frame keyframes that bulge upwards between the ends.
    expect(pos.keyframes.length).toBeGreaterThan(10);
    expect(Math.min(...pos.keyframes.map((k) => k.v[1]))).toBeLessThan(-35); // −30 parent offset −(arc)
    const dots = main.layers.find((l) => l.name === "Dots" && l.type === "path")!;
    expect(dots.type).toBe("path"); // two ellipses filled together → one compound path
    const op = dots.transform!.opacity as { keyframes: { t: number; v: number; ease?: unknown }[] };
    expect(op.keyframes[0]).toMatchObject({ t: 0, v: 0, ease: [0.33, 0, 0.67, 1] });
    expect(dots.type === "path" && dots.fill).toBe("rgba(0, 128, 255, 0.5)");
  });

  it("imports path morphs, trims and strokes", () => {
    const line = main.layers.find((l) => l.name === "Line" && l.type === "path")!;
    expect(line.type).toBe("path");
    if (line.type !== "path") return;
    expect(typeof line.d).toBe("object");
    expect(line.stroke).toMatchObject({ width: 4, cap: "round", join: "round" });
    expect((line.trim?.end as { keyframes: { ease?: unknown }[] }).keyframes[0].ease).toBe("hold");
  });

  it("turns td/tt into a matte and masks into a matte layer", () => {
    const matte = byId("Matte");
    expect(matte.visible).toBe(false);
    const dots = main.layers.find((l) => l.name === "Dots" && l.type === "path")!;
    expect(dots.matte).toEqual({ layer: "Matte" });
    expect(byId("Holder").matte?.layer).toBe("Holder-mask");
    expect(byId("Holder-mask")).toMatchObject({ type: "path", visible: false, parent: "Holder" });
  });

  it("imports text with font, alignment, spacing and color", () => {
    const t = byId("Title");
    expect(t).toMatchObject({ type: "text", text: "Hello\nWorld", font: { family: "Inter", weight: 700, size: 40 }, fill: "#ff0000", letterSpacing: 2, align: "center" });
  });

  it("rejects non-Lottie input", () => {
    expect(() => importLottie({ hello: 1 })).toThrow(/Not a Lottie/);
  });
});

describe("add as precomp", () => {
  it("adds compositions under unique ids and fits the layer", () => {
    const host = project([], { width: 250, height: 200 });
    const imported = importLottie(structuredClone(aeFile)).project;
    const r = addAsPrecomp(host, imported, { name: "ae test" });
    expect(validateProject(r.project).ok).toBe(true);
    const layer = r.project.compositions[0].layers[0];
    expect(layer).toMatchObject({ type: "comp", comp: "ae-test", transform: { position: [125, 100], scale: 50 } });
  });
});
