import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  exportLottieFile,
  exportVideo,
  importLottieFile,
  initProject,
  saveProject,
  readProject,
  renderContactSheet,
  renderFramePng,
  resolveProjectFile,
  type ExportFormat,
} from "@openeffects/node";
import { mcpLaunch } from "./mcp-launch.ts";
import { getComp } from "@openeffects/schema";
import { addAsPrecomp } from "@openeffects/lottie";

const HELP = `OpenEffects: open-source motion graphics, driven by your AI agent

Usage: oe <command> [project] [options]

Commands:
  init [dir]                 Create a new project (project.oe.json, AGENTS.md, .mcp.json, git repo)
  dev [dir]                  Open the editor (preview, timeline, agent panel)  --port 4310
  ask [dir] "<prompt>"       Let an agent edit the project from the terminal
                             --agent claude|codex|opencode  --model <id> (Claude default: claude-haiku-5-5)
                             --new (start a fresh conversation)
  render [dir]               Export   --out file --format mp4|webm|gif|mov|png|lottie --comp id --scale 1
  import <file.json> [dir]   Import a Lottie animation: a new project in [dir], or added as a
                             precomp layer to an existing one (--replace to overwrite it)
  frame [dir]                Render one frame to PNG   --time 1.5 --out frame.png --width 1920
  sheet [dir]                Render a contact sheet PNG   --count 8 --out sheet.png
  validate [dir]             Check the project file and print errors
  mcp [dir]                  Run the OpenEffects MCP server on stdio (for agents)

[dir] defaults to the current folder.`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function load(target: string | undefined) {
  const file = resolveProjectFile(target ?? ".");
  if (!fs.existsSync(file)) fail(`No project at ${file}. Create one with: oe init ${target ?? "."}`);
  const r = readProject(file);
  if (!r.ok) fail(`${path.basename(file)} has errors:\n- ${r.errors.join("\n- ")}`);
  return { file, dir: path.dirname(file), project: r.project };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      format: { type: "string", short: "f" },
      comp: { type: "string" },
      scale: { type: "string" },
      time: { type: "string", short: "t" },
      width: { type: "string" },
      count: { type: "string" },
      port: { type: "string", short: "p" },
      host: { type: "string" },
      name: { type: "string" },
      agent: { type: "string", short: "a" },
      model: { type: "string", short: "m" },
      new: { type: "boolean" },
      replace: { type: "boolean" },
    },
  });
  const target = positionals[0];

  switch (command) {
    case "init": {
      const dir = path.resolve(target ?? ".");
      const file = initProject(dir, { name: values.name, mcp: mcpLaunch(dir) });
      console.log(`Created ${path.relative(process.cwd(), file) || file}\n\nNext:\n  oe dev ${target ?? "."}        # open the editor\n  cd ${target ?? "."} && claude   # or talk to Claude Code directly; .mcp.json is ready`);
      return;
    }
    case "dev": {
      const { file, dir } = load(target);
      const { startServer } = await import("@openeffects/server");
      const server = await startServer({
        projectFile: file,
        port: values.port ? Number(values.port) : 4310,
        host: values.host,
        mcp: mcpLaunch(dir),
      });
      console.log(`OpenEffects editor running at ${server.url}\nProject: ${file}\nPress Ctrl+C to stop.`);
      const stop = async () => {
        await server.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "ask": {
      // `oe ask "prompt"` (current folder) or `oe ask dir "prompt"`.
      const [dirArg, ...words] = positionals.length > 1 ? positionals : [".", ...positionals];
      const prompt = words.join(" ").trim();
      if (!prompt) fail('Usage: oe ask [dir] "<prompt>"');
      const { dir } = load(dirArg);
      const { AgentSession } = await import("@openeffects/server");
      const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
      const session = new AgentSession({
        projectDir: dir,
        mcp: mcpLaunch(dir),
        onEvent: (e) => {
          if (e.type === "status") process.stderr.write(dim(`· ${e.text}\n`));
          if (e.type === "tool-call") process.stderr.write(dim(`→ ${e.name.replace(/^mcp__openeffects__/, "")}\n`));
          if (e.type === "tool-result" && !e.ok) process.stderr.write(`  ✗ ${e.summary.split("\n").slice(0, 3).join("\n    ")}\n`);
          if (e.type === "text") process.stdout.write(`${e.text.trim()}\n`);
        },
      });
      if (values.new) session.reset();
      const { done } = await session.start(values.agent ?? "claude", prompt, values.model);
      process.on("SIGINT", () => session.stop());
      const r = await done;
      const meta = [
        r.durationMs ? `${(r.durationMs / 1000).toFixed(0)}s` : "",
        r.costUsd ? `$${r.costUsd.toFixed(3)}` : "",
        r.tokens ? `${r.tokens.input + r.tokens.output} tokens` : "",
      ].filter(Boolean);
      process.stderr.write(`${r.ok ? "✓ done" : `✗ ${r.error}`}${meta.length ? ` (${meta.join(", ")})` : ""}\n`);
      process.exit(r.ok ? 0 : 1);
    }
    case "render": {
      const { dir, project } = load(target);
      const comp = getComp(project, values.comp);
      const requested = values.format ?? (values.out ? path.extname(values.out).slice(1) : "mp4");
      if (requested === "lottie" || requested === "json") {
        const r = await exportLottieFile(project, dir, { compId: comp.id, out: values.out ? path.resolve(values.out) : undefined });
        console.log(`Wrote ${r.out} (Lottie, ${(r.bytes / 1024).toFixed(1)} KB)`);
        for (const w of r.warnings) console.warn(`  note: ${w}`);
        return;
      }
      const format = requested as ExportFormat;
      if (!["mp4", "webm", "gif", "mov", "png"].includes(format)) fail(`Unknown format "${format}"`);
      const out = path.resolve(values.out ?? path.join(dir, "renders", format === "png" ? comp.id : `${comp.id}.${format}`));
      const started = Date.now();
      const r = await exportVideo(project, dir, {
        out,
        format,
        compId: comp.id,
        scale: values.scale ? Number(values.scale) : format === "gif" ? 0.5 : 1,
        onProgress: (f, total) => process.stderr.write(`\rRendering frame ${f}/${total}`),
      });
      process.stderr.write("\n");
      console.log(`Wrote ${r.file} (${r.frames} frames in ${((Date.now() - started) / 1000).toFixed(1)}s)`);
      return;
    }
    case "import": {
      const source = positionals[0];
      if (!source || !fs.existsSync(source)) fail("Usage: oe import <file.json> [dir]");
      const dir = path.resolve(positionals[1] ?? path.basename(source, path.extname(source)));
      fs.mkdirSync(dir, { recursive: true });
      const file = resolveProjectFile(dir);
      const { project: imported, warnings } = importLottieFile(path.resolve(source), dir);
      const exists = fs.existsSync(file);
      if (!exists) {
        initProject(dir, { project: imported });
        console.log(`Created ${file} from ${path.basename(source)}`);
      } else if (values.replace) {
        saveProject(file, imported);
        console.log(`Replaced ${file} with ${path.basename(source)}`);
      } else {
        const current = readProject(file);
        if (!current.ok) fail(`${path.basename(file)} has errors:\n- ${current.errors.join("\n- ")}`);
        const r = addAsPrecomp(current.project, imported, { compId: values.comp, name: path.basename(source, path.extname(source)) });
        saveProject(file, r.project);
        console.log(`Added ${path.basename(source)} to ${file} as layer "${r.layerId}" (composition "${r.compId}")`);
      }
      for (const w of warnings) console.warn(`  note: ${w}`);
      return;
    }
    case "frame": {
      const { dir, project } = load(target);
      const out = path.resolve(values.out ?? "frame.png");
      const png = await renderFramePng(project, dir, {
        time: Number(values.time ?? 0),
        compId: values.comp,
        width: values.width ? Number(values.width) : undefined,
      });
      fs.writeFileSync(out, png);
      console.log(`Wrote ${out}`);
      return;
    }
    case "sheet": {
      const { dir, project } = load(target);
      const out = path.resolve(values.out ?? "sheet.png");
      fs.writeFileSync(out, await renderContactSheet(project, dir, { compId: values.comp, count: values.count ? Number(values.count) : 8 }));
      console.log(`Wrote ${out}`);
      return;
    }
    case "validate": {
      const file = resolveProjectFile(target ?? ".");
      const r = readProject(file);
      if (r.ok) console.log(`OK: ${file}`);
      else fail(`${file}\n- ${r.errors.join("\n- ")}`);
      return;
    }
    case "mcp": {
      const file = resolveProjectFile(target ?? ".");
      const { runStdioServer } = await import("@openeffects/mcp");
      await runStdioServer(file);
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      fail(`Unknown command "${command}"\n\n${HELP}`);
  }
}

main().catch((e) => fail((e as Error).message ?? String(e)));
