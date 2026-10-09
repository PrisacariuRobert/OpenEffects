import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { referencePrompt, referenceSheet } from "../src/index.ts";

let hasFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

describe("references", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oe-ref-"));

  it("turns an image into a PNG reference", async () => {
    const c = createCanvas(2400, 1200);
    c.getContext("2d").fillRect(0, 0, 10, 10);
    fs.writeFileSync(path.join(dir, "poster.png"), c.toBuffer("image/png"));
    const s = await referenceSheet(path.join(dir, "poster.png"), path.join(dir, "out", "poster-sheet.png"));
    expect(s).toMatchObject({ kind: "image", width: 1600, height: 800 });
    expect(referencePrompt("x.png", s, "poster.png")).toMatch(/oe_view_reference[\s\S]*the image "poster.png"/);
  });

  it.skipIf(!hasFfmpeg)("turns a clip into a time-stamped contact sheet", async () => {
    const clip = path.join(dir, "clip.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-pix_fmt", "yuv420p", clip]);
    const s = await referenceSheet(clip, path.join(dir, "out", "clip-sheet.png"));
    expect(s.kind).toBe("video");
    expect(s.times).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75]);
    expect(s.width).toBe(3 * 320 + 4 * 8);
    expect(s.height).toBe(2 * 180 + 3 * 8);
    expect(referencePrompt("clip-sheet.png", s, "clip.mp4")).toMatch(/6 frames from the 3\.0s clip[\s\S]*pacing, transitions/);
  });
});
