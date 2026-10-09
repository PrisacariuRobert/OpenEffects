import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readProject, type McpLaunch } from "@openeffects/node";
import type { Variation, VariationsRun } from "@openeffects/schema";
import type { AgentProvider } from "./agents/types.ts";

/** Creative directions given to each version, so the versions really differ. */
export const DIRECTIONS = [
  "Bold and kinetic: big type, fast snappy easing (easeOutExpo / easeOutBack), strong contrast.",
  "Calm and elegant: generous spacing, slow smooth easing, a refined restrained palette.",
  "Playful: bouncy overshoot, rounded shapes, bright saturated colors, a little wiggle.",
  "Cinematic: dark and atmospheric, glow and depth, slow dramatic reveals and parallax.",
  "Minimal and editorial: one accent color, precise grid alignment, clean typographic motion.",
  "Retro and graphic: chunky shapes, bold outlines, stepped (hold) timing and punchy color blocks.",
];

const COPY = ["project.oe.json", "AGENTS.md", "CLAUDE.md", "brand.json"];
const LINK = ["assets", "fonts"];

/**
 * Prepares an isolated copy of the project for one version: the project file and agent
 * guides are copied, assets and fonts are linked (read-only use), and the copy has no git
 * history, so versions never touch the real project.
 */
export function prepareVariationDir(projectDir: string, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of COPY) if (fs.existsSync(path.join(projectDir, f))) fs.copyFileSync(path.join(projectDir, f), path.join(dir, f));
  for (const d of LINK) {
    const src = path.join(projectDir, d);
    const dst = path.join(dir, d);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    try {
      fs.symlinkSync(src, dst, "dir");
    } catch {
      fs.cpSync(src, dst, { recursive: true });
    }
  }
}

export interface VariationsOptions {
  projectDir: string;
  provider: AgentProvider;
  model?: string;
  prompt: string;
  count: number;
  /** How to launch the MCP server for a given project folder. */
  mcp(dir: string): McpLaunch;
  onUpdate(run: VariationsRun): void;
  /** Where versions are kept. Default <project>/.openeffects/variations/<id>. */
  root?: string;
}

/** Runs `count` agent turns in parallel, one per creative direction. */
export function runVariations(opts: VariationsOptions): { run: VariationsRun; stop(): void; done: Promise<VariationsRun> } {
  const count = Math.max(2, Math.min(DIRECTIONS.length, Math.round(opts.count)));
  const id = randomUUID().slice(0, 8);
  const root = opts.root ?? path.join(opts.projectDir, ".openeffects", "variations", id);
  const run: VariationsRun = {
    id,
    prompt: opts.prompt,
    provider: opts.provider.id,
    model: opts.model,
    running: true,
    items: DIRECTIONS.slice(0, count).map((direction, index) => ({ index, direction, state: "working", status: "Starting…" })),
  };
  const update = (i: number, patch: Partial<Variation>) => {
    run.items[i] = { ...run.items[i], ...patch };
    opts.onUpdate({ ...run, items: [...run.items] });
  };
  const stops: (() => void)[] = [];
  const turns = run.items.map((item, i) => {
    const dir = path.join(root, `v${i + 1}`);
    prepareVariationDir(opts.projectDir, dir);
    let tools = 0;
    const turn = opts.provider.startTurn({
      prompt: `${opts.prompt}\n\nThis is version ${i + 1} of ${count} the user will compare side by side. Creative direction for this version: ${item.direction} Commit to it so this version looks clearly different from the others.`,
      cwd: dir,
      mcp: opts.mcp(dir),
      model: opts.model,
      onEvent: (e) => {
        if (e.type === "tool-call") update(i, { status: `${++tools} edits · ${e.name.replace(/^mcp__openeffects__/, "").replace(/^oe_/, "").replace(/_/g, " ")}` });
        else if (e.type === "status") update(i, { status: e.text });
      },
    });
    stops.push(() => turn.stop());
    return turn.done.then((r) => {
      const read = readProject(path.join(dir, "project.oe.json"));
      if (r.ok && read.ok) update(i, { state: "done", status: undefined, project: read.project, costUsd: r.costUsd, durationMs: r.durationMs });
      else update(i, { state: "failed", status: undefined, error: r.error ?? (read.ok ? "Failed" : read.errors[0]), costUsd: r.costUsd });
    });
  });
  const done = Promise.all(turns).then(() => {
    run.running = false;
    opts.onUpdate({ ...run, items: [...run.items] });
    return run;
  });
  return { run, stop: () => stops.forEach((s) => s()), done };
}
