import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initProject, readProject } from "@openeffects/node";
import type { AgentProvider, TurnRequest } from "../src/agents/types.ts";
import { runVariations } from "../src/variations.ts";

/** A stand-in agent: writes a project whose title is the creative direction it was given. */
class FakeProvider implements AgentProvider {
  id = "fake";
  label = "Fake";
  prompts: string[] = [];
  async status() {
    return { id: "fake", label: "Fake", available: true, detail: "", models: [], defaultModel: "" };
  }
  startTurn(req: TurnRequest) {
    this.prompts.push(req.prompt);
    const direction = /Creative direction for this version: (\w+)/.exec(req.prompt)?.[1] ?? "?";
    const done = (async () => {
      req.onEvent({ type: "tool-call", id: "1", name: "mcp__openeffects__oe_add_layer", input: {} });
      const file = path.join(req.cwd, "project.oe.json");
      const p = JSON.parse(fs.readFileSync(file, "utf8"));
      p.compositions[0].layers = [{ id: "title", type: "text", text: direction }];
      fs.writeFileSync(file, JSON.stringify(p));
      if (direction === "Playful") return { ok: false, error: "boom" };
      return { ok: true, costUsd: 0.01, durationMs: 10 };
    })();
    return { stop() {}, done };
  }
}

describe("variations", () => {
  it("runs one isolated turn per direction and never touches the real project", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oe-var-"));
    initProject(dir);
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "assets", "logo.svg"), "<svg/>");
    const before = fs.readFileSync(path.join(dir, "project.oe.json"), "utf8");
    const provider = new FakeProvider();
    const updates: number[] = [];
    const { run, done } = runVariations({ projectDir: dir, provider, prompt: "A logo reveal", count: 3, mcp: (d) => ({ command: "node", args: ["mcp", d] }), onUpdate: (r) => updates.push(r.items.filter((i) => i.state !== "working").length) });
    expect(run.items).toHaveLength(3);
    const result = await done;
    expect(result.running).toBe(false);
    expect(result.items.map((i) => i.state)).toEqual(["done", "done", "failed"]);
    expect(result.items[0].project?.compositions[0].layers[0]).toMatchObject({ text: "Bold" });
    expect(result.items[1].project?.compositions[0].layers[0]).toMatchObject({ text: "Calm" });
    expect(result.items[2].error).toBe("boom");
    // Each version had its own folder, linked assets, and a distinct prompt.
    expect(new Set(provider.prompts).size).toBe(3);
    const vdir = path.join(dir, ".openeffects", "variations", run.id, "v1");
    expect(fs.readFileSync(path.join(vdir, "assets", "logo.svg"), "utf8")).toBe("<svg/>");
    expect(readProject(path.join(vdir, "project.oe.json")).ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "project.oe.json"), "utf8")).toBe(before);
    expect(updates.at(-1)).toBe(3);
  });
});
