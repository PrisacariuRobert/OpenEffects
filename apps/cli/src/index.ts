import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  captionLayers,
  exportLottieFile,
  referencePrompt,
  referenceSheet,
  renderBatch,
  readTranscript,
  transcribe,
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
import { mcpLaunch, serverPaths } from "./mcp-launch.ts";
import { openAppWindow } from "./app-window.ts";
import { getComp, parseCsv, templateFields } from "@openeffects/schema";
import { addAsPrecomp } from "@openeffects/lottie";

const HELP = `OpenEffects: open-source motion graphics, driven by your AI agent

Usage: oe <command> [project] [options]
       npx openeffects app my-video    # no install needed

Commands:
  init [dir]                 Create a new project (project.oe.json, AGENTS.md, .mcp.json, git repo)
  app [dir]                  Open OpenEffects in its own window (creates the project if needed)
  dev [dir]                  Run the editor server only (open the printed URL)  --port 4310
  ask [dir] "<prompt>"       Let an agent edit the project from the terminal
                             --agent claude|codex|opencode  --model <id> (Claude default: claude-haiku-5-5)
                             --new (start a fresh conversation)
                             --ref image-or-clip (take after its style and motion)
                             --variations 4 (versions with different creative directions, saved
                             in <dir>/variations/; open one with oe dev)
  render [dir]               Export   --out file --format mp4|webm|gif|mov|png|lottie --comp id --scale 1
  batch [dir] --data rows.csv
                             One video per CSV row, filling {{column}} placeholders in the project
                             --format mp4|webm|gif|mov --name "{{name}}" --comp id --out folder
  captions [dir] --from f    Add animated captions from an .srt/.vtt file, or transcribe an audio/video
                             file with local whisper.cpp   --style pop|karaoke|minimal --comp id
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

/** A self-overwriting progress line in a terminal; in logs, at most one plain line per second. */
let progressAt = 0;
function progress(line: string): void {
  if (process.stderr.isTTY) return void process.stderr.write(`\r${line}`);
  if (Date.now() - progressAt < 1000) return;
  progressAt = Date.now();
  process.stderr.write(`${line.trimEnd()}\n`);
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
      variations: { type: "string" },
      ref: { type: "string" },
      from: { type: "string" },
      data: { type: "string" },
      style: { type: "string" },
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
    case "dev":
    case "app": {
      // `oe app` is `oe dev` in its own window, creating the project first if needed.
      if (command === "app" && !fs.existsSync(resolveProjectFile(target ?? "."))) {
        const dir = path.resolve(target ?? ".");
        initProject(dir, { name: values.name, mcp: mcpLaunch(dir) });
        console.log(`Created a new project in ${path.relative(process.cwd(), dir) || "."}`);
      }
      const { file, dir } = load(target);
      const { startServer } = await import("@openeffects/server");
      const server = await startServer({
        projectFile: file,
        port: values.port ? Number(values.port) : 4310,
        host: values.host,
        mcp: mcpLaunch(dir),
        findFreePort: !values.port,
        ...serverPaths(),
      });
      const stop = async () => {
        await server.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      if (command === "dev") {
        console.log(`OpenEffects editor running at ${server.url}\nProject: ${file}\nPress Ctrl+C to stop.`);
        return;
      }
      const window = openAppWindow(server.url);
      if (window.kind === "app") {
        console.log(`OpenEffects is open (${window.browser}). Closing the window quits.\nProject: ${file}`);
        window.closed.then(stop);
      } else {
        console.log(`OpenEffects is open in your browser at ${server.url}\nProject: ${file}\nPress Ctrl+C to stop.`);
      }
      return;
    }
    case "ask": {
      // `oe ask "prompt"` (current folder) or `oe ask dir "prompt"`.
      const [dirArg, ...words] = positionals.length > 1 ? positionals : [".", ...positionals];
      let prompt = words.join(" ").trim();
      if (!prompt) fail('Usage: oe ask [dir] "<prompt>"');
      const { dir } = load(dirArg);
      if (values.ref) {
        const src = path.resolve(values.ref);
        if (!fs.existsSync(src)) fail(`No file at ${values.ref}`);
        const base = path.basename(src, path.extname(src)).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "reference";
        const sheet = await referenceSheet(src, path.join(dir, ".openeffects", "references", `${base}-sheet.png`));
        const rel = path.relative(dir, sheet.file).split(path.sep).join("/");
        prompt = `${referencePrompt(rel, sheet, path.basename(src))}\n\n${prompt}`;
        process.stderr.write(`· reference: ${rel}${sheet.times ? ` (${sheet.times.length} frames)` : ""}\n`);
      }
      if (values.variations) {
        const { runVariations, defaultProviders } = await import("@openeffects/server");
        const provider = defaultProviders().find((p) => p.id === (values.agent ?? "claude"));
        if (!provider) fail(`Unknown agent "${values.agent}"`);
        const status = await provider.status();
        if (!status.available) fail(`${status.label}: ${status.detail}`);
        const root = path.join(dir, "variations", new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"));
        const started = Date.now();
        let last = "";
        const { done } = runVariations({
          projectDir: dir,
          provider,
          model: values.model ?? (status.defaultModel || undefined),
          prompt,
          count: Number(values.variations),
          mcp: (d) => mcpLaunch(d),
          root,
          onUpdate: (run) => {
            const line = run.items.map((i) => `v${i.index + 1} ${i.state === "working" ? (i.status ?? "…").slice(0, 28) : i.state}`).join(" | ");
            if (line !== last) progress((last = line).padEnd(120).slice(0, 160));
          },
        });
        const run = await done;
        process.stderr.write("\n");
        for (const i of run.items)
          console.log(`v${i.index + 1} ${i.state === "done" ? "✓" : "✗"} ${i.direction.split(":")[0]}${i.costUsd ? ` · $${i.costUsd.toFixed(3)}` : ""}${i.durationMs ? ` · ${Math.round(i.durationMs / 1000)}s` : ""}${i.error ? ` · ${i.error}` : ""}\n   ${path.relative(process.cwd(), path.join(root, `v${i.index + 1}`))}`);
        console.log(`Done in ${((Date.now() - started) / 1000).toFixed(0)}s. Open one with: oe dev <folder>`);
        process.exit(run.items.some((i) => i.state === "done") ? 0 : 1);
      }
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
        onProgress: (f, total) => progress(`Rendering frame ${f}/${total}`),
      });
      process.stderr.write("\n");
      console.log(`Wrote ${r.file} (${r.frames} frames in ${((Date.now() - started) / 1000).toFixed(1)}s)`);
      return;
    }
    case "batch": {
      const { dir, project } = load(target);
      if (!values.data) fail('Usage: oe batch [dir] --data rows.csv [--format mp4] [--name "{{name}}"]');
      const rows = parseCsv(fs.readFileSync(path.resolve(values.data), "utf8"));
      if (!rows.length) fail("The CSV has no data rows (the first line must be the column names)");
      const fields = templateFields(project);
      const missing = fields.filter((f) => !(f in rows[0]));
      if (!fields.length) fail("The project has no {{placeholders}} to fill. Put {{column}} in a text (or color, or image path) where a CSV value should go.");
      if (missing.length) console.warn(`  note: no CSV column for ${missing.map((m) => `{{${m}}}`).join(", ")}; those stay as written`);
      const format = (values.format ?? "mp4") as ExportFormat;
      const started = Date.now();
      const r = await renderBatch(project, dir, rows, {
        format,
        compId: values.comp,
        name: values.name,
        outDir: values.out ? path.resolve(values.out) : undefined,
        onProgress: (row, f, total) => progress(`Row ${row + 1}/${rows.length} · frame ${f}/${total}   `),
      });
      process.stderr.write("\n");
      for (const e of r.errors) console.warn(`  skipped: ${e}`);
      console.log(`Wrote ${r.files.length} videos in ${((Date.now() - started) / 1000).toFixed(1)}s:\n${r.files.map((f) => `  ${path.relative(process.cwd(), f)}`).join("\n")}`);
      return;
    }
    case "captions": {
      const { file, dir, project } = load(target);
      if (!values.from) fail("Usage: oe captions [dir] --from subtitles.srt|audio.mp3 [--style pop|karaoke|minimal]");
      const src = path.resolve(values.from);
      const words = /\.(srt|vtt|json)$/i.test(src) ? readTranscript(src) : await transcribe(src);
      const comp = getComp(project, values.comp);
      const style = (values.style ?? "pop") as "pop" | "karaoke" | "minimal";
      const layers = captionLayers(words, comp, { style });
      const next = { ...project, compositions: project.compositions.map((c) => (c === comp ? { ...c, layers: [...c.layers.filter((l) => !l.id.startsWith("cap-")), ...layers] } : c)) };
      saveProject(file, next);
      console.log(`Added ${words.length} words of ${style} captions to "${comp.id}" in ${path.relative(process.cwd(), dir) || "."}`);
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
