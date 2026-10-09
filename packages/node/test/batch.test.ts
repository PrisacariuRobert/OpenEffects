import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Project } from "@openeffects/schema";
import { readBrand, renderBatch, saveBrand } from "../src/index.ts";

let hasFfmpeg = true;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  hasFfmpeg = false;
}

describe("batch and brand files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oe-batch-"));

  it("saves and reads brand.json, rejecting invalid kits", () => {
    expect(readBrand(dir)).toBeNull();
    saveBrand(dir, { name: "Acme", colors: { primary: "#0a84ff" } });
    expect(readBrand(dir)).toEqual({ name: "Acme", colors: { primary: "#0a84ff" } });
    expect(() => saveBrand(dir, { colors: { primary: "nope" } })).toThrow(/Invalid brand kit/);
  });

  it.skipIf(!hasFfmpeg)("renders one video per row with unique names", async () => {
    const project: Project = { version: 1, compositions: [{ id: "main", width: 160, height: 90, fps: 10, duration: 0.5, background: "#000000", layers: [{ id: "t", type: "text", text: "Hi {{name}}", font: { size: 20 } }] }] };
    const rows = [{ name: "Ana" }, { name: "Bo" }, { name: "Ana" }];
    const done: number[] = [];
    const r = await renderBatch(project, dir, rows, { format: "gif", onRow: (i) => done.push(i) });
    expect(r.errors).toEqual([]);
    expect(r.files.map((f) => path.basename(f))).toEqual(["ana.gif", "bo.gif", "ana-2.gif"]);
    for (const f of r.files) expect(fs.statSync(f).size).toBeGreaterThan(100);
    expect(done).toEqual([0, 1, 2]);
  });
});
