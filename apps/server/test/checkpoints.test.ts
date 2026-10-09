import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Checkpoints } from "../src/checkpoints.ts";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

describe("Checkpoints", () => {
  it("snapshots and restores project files without touching the user's index or branch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oe-ckpt-"));
    git(dir, "init", "-q");
    fs.writeFileSync(path.join(dir, "project.oe.json"), "v1");
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    const head = git(dir, "rev-parse", "HEAD");

    const cp = new Checkpoints(dir);
    fs.writeFileSync(path.join(dir, "project.oe.json"), "v2");
    const c = await cp.create("Before: test turn");
    expect(c).not.toBeNull();
    fs.writeFileSync(path.join(dir, "project.oe.json"), "v3 by the agent");

    const list = await cp.list();
    expect(list.map((x) => x.label)).toContain("Before: test turn");

    await cp.restore(c!.id);
    expect(fs.readFileSync(path.join(dir, "project.oe.json"), "utf8")).toBe("v2");
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "diff", "--cached", "--name-only")).toBe("");
    // Restoring created a safety checkpoint holding "v3 by the agent".
    expect((await cp.list()).some((x) => x.label.startsWith("Before restoring"))).toBe(true);
    // Any checkpoint's project can be read back (the editor's "review changes").
    expect(await cp.read(c!.id, "project.oe.json")).toBe("v2");
    expect(await cp.read(c!.id, "missing.json")).toBeNull();
    expect(await cp.read("../etc", "project.oe.json")).toBeNull();
  });
});
