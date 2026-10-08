import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import type { Layer, Project } from "@openeffects/schema";
import { exportVideo, renderContactSheet, renderFramePng } from "../src/index.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oe-render-"));

function project(layers: Layer[], extra: Partial<Project["compositions"][0]> = {}): Project {
  return { version: 1, compositions: [{ id: "main", width: 100, height: 100, fps: 10, duration: 1, background: "#000000", layers, ...extra }] };
}

async function pixels(p: Project, time = 0) {
  const img = await loadImage(await renderFramePng(p, dir, { time }));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
}

describe("renderFrame (node)", () => {
  it("draws layers centered on their position with keyframed transforms", async () => {
    const px = await pixels(
      project([
        {
          id: "box",
          type: "rect",
          size: [20, 20],
          fill: "#ff0000",
          transform: { position: { keyframes: [{ t: 0, v: [20, 50], ease: "linear" }, { t: 1, v: [80, 50] }] } },
        },
      ]),
      0.5,
    );
    expect(px(50, 50)).toEqual([255, 0, 0, 255]); // moved halfway
    expect(px(20, 50)).toEqual([0, 0, 0, 255]);
  });

  it("respects in/out points, visibility and stacking order", async () => {
    const px = await pixels(
      project([
        { id: "a", type: "solid", color: "#ff0000" },
        { id: "b", type: "solid", color: "#00ff00", in: 0.5 },
        { id: "c", type: "solid", color: "#0000ff", visible: false },
      ]),
      0.2,
    );
    expect(px(50, 50)).toEqual([255, 0, 0, 255]);
  });

  it("keeps children in place under a camera null (anchor = position)", async () => {
    const px = await pixels(
      project([
        { id: "cam", type: "null", transform: { position: [50, 50], anchor: [50, 50], scale: 100 } },
        { id: "bg", type: "solid", color: "#00ff00", parent: "cam" },
        { id: "dot", type: "rect", size: [10, 10], fill: "#ff0000", parent: "cam", transform: { position: [80, 20] } },
      ]),
    );
    expect(px(5, 95)).toEqual([0, 255, 0, 255]); // solid still covers the whole frame
    expect(px(80, 20)).toEqual([255, 0, 0, 255]);
  });

  it("applies track mattes", async () => {
    const layers: Layer[] = [
      { id: "m", type: "rect", size: [50, 100], fill: "#fff", visible: false, transform: { position: [25, 50] } },
      { id: "red", type: "solid", color: "#ff0000", matte: { layer: "m" } },
    ];
    const px = await pixels(project(layers));
    expect(px(10, 50)).toEqual([255, 0, 0, 255]); // inside the matte
    expect(px(90, 50)).toEqual([0, 0, 0, 255]); // outside
    const inv = await pixels(project([layers[0], { ...layers[1], matte: { layer: "m", mode: "alphaInverted" } }]));
    expect(inv(10, 50)).toEqual([0, 0, 0, 255]);
    expect(inv(90, 50)).toEqual([255, 0, 0, 255]);
  });

  it("trims paths", async () => {
    const line = (end: number): Layer => ({ id: "l", type: "path", d: "M 0 50 L 100 50", stroke: { color: "#fff", width: 10 }, trim: { end } });
    const px = await pixels(project([line(50)]));
    expect(px(25, 50)[0]).toBe(255);
    expect(px(75, 50)[0]).toBe(0);
  });

  it("renders a contact sheet PNG", async () => {
    const png = await renderContactSheet(project([{ id: "a", type: "solid", color: "#123456" }]), dir, { count: 4, cellWidth: 80 });
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });
});

let hasFfmpeg = true;
try {
  execFileSync(process.env.OE_FFMPEG || "ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

describe.skipIf(!hasFfmpeg)("exportVideo", () => {
  it("encodes an mp4 with the right frame count", async () => {
    const out = path.join(dir, "out.mp4");
    const r = await exportVideo(project([{ id: "a", type: "solid", color: "#ff0000" }]), dir, { out, format: "mp4" });
    expect(r.frames).toBe(10);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });
});
