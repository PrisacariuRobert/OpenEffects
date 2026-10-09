import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { exportLottieFile, importLottieFile, readProject, renderFramePng } from "../src/index.ts";

const examples = path.resolve(import.meta.dirname, "../../../examples");

async function diff(a: Buffer, b: Buffer): Promise<number> {
  const [ia, ib] = await Promise.all([loadImage(a), loadImage(b)]);
  const ca = createCanvas(ia.width, ia.height).getContext("2d");
  ca.drawImage(ia, 0, 0);
  const cb = createCanvas(ia.width, ia.height).getContext("2d");
  cb.drawImage(ib, 0, 0, ia.width, ia.height);
  const da = ca.getImageData(0, 0, ia.width, ia.height).data;
  const db = cb.getImageData(0, 0, ia.width, ia.height).data;
  let sum = 0;
  for (let i = 0; i < da.length; i++) sum += Math.abs(da[i] - db[i]);
  return sum / da.length;
}

describe("Lottie round trip", () => {
  // Export → import renders the same frames (glow has no Lottie equivalent: loader is skipped).
  for (const name of ["kinetic-type", "lower-third", "bar-chart", "summer-sale"]) {
    it(`${name} survives export and import`, async () => {
      const dir = path.join(examples, name);
      const r = readProject(path.join(dir, "project.oe.json"));
      if (!r.ok) throw new Error(r.errors.join("\n"));
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "oe-lottie-"));
      const out = path.join(work, `${name}.json`);
      const { warnings } = await exportLottieFile(r.project, dir, { out });
      expect(warnings).toEqual([]);
      const back = importLottieFile(out, work);
      const comp = r.project.compositions[0];
      for (const p of [0.3, 0.8]) {
        const time = Math.round(p * comp.duration * comp.fps) / comp.fps;
        const a = await renderFramePng(r.project, dir, { time, width: 480 });
        const b = await renderFramePng(back.project, work, { time, width: 480 });
        expect(await diff(a, b)).toBeLessThan(1);
      }
    });
  }
});
