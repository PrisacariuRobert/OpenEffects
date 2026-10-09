import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AGENT_GUIDE,
  ANIMATION_PRESETS,
  beatMarkers,
  isMediaLayer,
  applyPreset,
  editLayer,
  EditError,
  addLayer,
  deleteLayer,
  getComp,
  moveLayer,
  setKeyframes,
  updateComposition,
  updateLayer,
  type Composition,
  type Keyframe,
  type Layer,
  type Project,
} from "@openeffects/schema";
import {
  ProjectValidationError,
  detectBeats,
  exportLottieFile,
  exportVideo,
  importLottieFile,
  loadProject,
  missingAssets,
  renderContactSheet,
  renderFramePng,
  saveProject,
  type ExportFormat,
} from "@openeffects/node";
import { addAsPrecomp } from "@openeffects/lottie";

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }], isError: true });
const image = (png: Buffer, caption: string): CallToolResult => ({
  content: [
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    { type: "text", text: caption },
  ],
});

function describeError(e: unknown): string {
  if (e instanceof ProjectValidationError) return `Edit rejected, the project would be invalid:\n- ${e.errors.join("\n- ")}`;
  if (e instanceof EditError) return e.message;
  return `Error: ${(e as Error).message ?? String(e)}`;
}

export function summarize(project: Project): string {
  return project.compositions
    .map((c) => `${c.id}: ${c.width}x${c.height} @${c.fps}fps, ${c.duration}s, ${c.layers.length} layers [${c.layers.map((l) => `${l.id}:${l.type}`).join(", ")}]`)
    .join("\n");
}

const compId = z.string().optional().describe("Composition id. Default: the main (first) composition");

/**
 * The OpenEffects MCP server. Every tool reads the project from disk, applies the edit,
 * validates and writes it back, so it composes safely with the app and with agents
 * that edit project.oe.json directly.
 */
export function createMcpServer(projectFile: string): McpServer {
  const projectDir = path.dirname(projectFile);
  const server = new McpServer(
    { name: "openeffects", version: "0.1.0" },
    {
      instructions:
        "OpenEffects is a motion graphics editor. Use these tools to build and edit animations in project.oe.json. " +
        "Call oe_get_guide once if you have not read AGENTS.md, then oe_get_project. After editing, verify visually with oe_render_contact_sheet.",
    },
  );

  const edit = (fn: (p: Project) => Project, done: (p: Project) => string): CallToolResult => {
    try {
      const next = saveProject(projectFile, fn(loadProject(projectFile)));
      const missing = missingAssets(next, projectDir);
      return text(done(next) + (missing.length ? `\nWarning: missing image files: ${missing.join(", ")}` : ""));
    } catch (e) {
      return fail(describeError(e));
    }
  };

  server.registerTool(
    "oe_get_guide",
    { title: "Format guide", description: "The OpenEffects project format reference and motion design tips. Read before your first edit.", annotations: { readOnlyHint: true } },
    async () => text(AGENT_GUIDE),
  );

  server.registerTool(
    "oe_get_project",
    {
      title: "Read project",
      description: "Returns the full project JSON (or one composition) plus a short summary.",
      inputSchema: { compId },
      annotations: { readOnlyHint: true },
    },
    async ({ compId }) => {
      try {
        const project = loadProject(projectFile);
        const body = compId ? getComp(project, compId) : project;
        return text(`${summarize(project)}\n\n${JSON.stringify(body, null, 1)}`);
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  server.registerTool(
    "oe_write_project",
    {
      title: "Replace project",
      description: "Replace the whole project with new JSON. Best for building a new animation from scratch in one step.",
      inputSchema: { project: z.record(z.string(), z.unknown()).describe("A complete project object (version: 1, compositions: [...])") },
    },
    async ({ project }) => edit(() => project as unknown as Project, (p) => `Project saved.\n${summarize(p)}`),
  );

  server.registerTool(
    "oe_add_layer",
    {
      title: "Add layer",
      description: "Add a layer. Layers render in array order, so by default the new layer goes on top.",
      inputSchema: {
        layer: z.record(z.string(), z.unknown()).describe("Layer object with a unique id and a type (solid|rect|ellipse|path|text|image|null|comp)"),
        index: z.number().int().optional().describe("Insert position (0 = bottom). Default: top"),
        compId,
      },
    },
    async ({ layer, index, compId }) =>
      edit((p) => addLayer(p, layer as unknown as Layer, { compId, index }), () => `Added layer "${String(layer.id)}".`),
  );

  server.registerTool(
    "oe_update_layer",
    {
      title: "Update layer",
      description: "Deep-merge a patch into a layer. Nested objects merge, arrays and keyframed values are replaced, null deletes a key.",
      inputSchema: { id: z.string(), patch: z.record(z.string(), z.unknown()), compId },
    },
    async ({ id, patch, compId }) => edit((p) => updateLayer(p, id, patch, { compId }), () => `Updated layer "${id}".`),
  );

  server.registerTool(
    "oe_delete_layer",
    { title: "Delete layer", description: "Remove a layer.", inputSchema: { id: z.string(), compId }, annotations: { destructiveHint: true } },
    async ({ id, compId }) => edit((p) => deleteLayer(p, id, { compId }), () => `Deleted layer "${id}".`),
  );

  server.registerTool(
    "oe_move_layer",
    {
      title: "Reorder layer",
      description: "Move a layer to a new stacking index (0 = bottom, last = top).",
      inputSchema: { id: z.string(), index: z.number().int(), compId },
    },
    async ({ id, index, compId }) => edit((p) => moveLayer(p, id, index, { compId }), () => `Moved layer "${id}" to index ${index}.`),
  );

  server.registerTool(
    "oe_set_keyframes",
    {
      title: "Set keyframes",
      description:
        'Replace the keyframes of one property. property is a dotted path such as "transform.position", "transform.opacity", "font.size", "fill", "trim.end".',
      inputSchema: {
        layerId: z.string().optional().describe("Layer id (`id` is accepted too)"),
        id: z.string().optional().describe("Alias of layerId"),
        property: z.string(),
        keyframes: z
          .array(z.object({ t: z.number(), v: z.unknown(), ease: z.unknown().optional() }))
          .min(1)
          .describe("[{ t: seconds, v: value, ease?: easing toward the next keyframe }]"),
        compId,
      },
    },
    async ({ layerId, id, property, keyframes, compId }) => {
      const target = layerId ?? id;
      if (!target) return fail("Pass the layer id as layerId.");
      return edit(
        (p) => setKeyframes(p, target, property, keyframes as Keyframe<unknown>[], { compId }),
        () => `Set ${keyframes.length} keyframe(s) on ${target}.${property}.`,
      );
    },
  );

  server.registerTool(
    "oe_apply_preset",
    {
      title: "Apply animation preset",
      description:
        "Apply a ready-made animation to a layer, starting at `time` (loops run to the end). It writes normal keyframes you can still tweak. Presets: " +
        ANIMATION_PRESETS.map((p) => `${p.id} (${p.kind}${p.textOnly ? ", text only" : ""})`).join(", "),
      inputSchema: {
        layerId: z.string(),
        preset: z.enum(ANIMATION_PRESETS.map((p) => p.id) as [string, ...string[]]),
        time: z.number().min(0).describe("Seconds"),
        duration: z.number().positive().optional().describe("Seconds for in/out presets. Default 0.6"),
        compId,
      },
    },
    async ({ layerId, preset, time, duration, compId }) =>
      edit(
        (p) => editLayer(p, layerId, (l) => applyPreset(l, preset, { comp: getComp(p, compId), time, duration }), { compId }),
        () => `Applied "${preset}" to ${layerId} at ${time}s.`,
      ),
  );

  server.registerTool(
    "oe_add_behavior",
    {
      title: "Add behavior",
      description:
        "Attach procedural motion to a layer property instead of keyframing it. Types: " +
        "wiggle {amount, frequency?, seed?, octaves?} organic noise; oscillate {amplitude, frequency?, phase?, wave?: sine|triangle|square|saw}; " +
        "drift {speed} constant change per second (spin, pan); loop {mode?: cycle|pingpong} repeats the property's keyframes; " +
        "follow {layer, delay?, offset?} copies another layer's same property with a delay. " +
        "Common: property (e.g. transform.position), start?, end?, fadeIn?. Amounts are in the property's units; use [x, y] for per-axis values.",
      inputSchema: {
        layerId: z.string(),
        behavior: z.record(z.string(), z.unknown()).describe('e.g. { "type": "wiggle", "property": "transform.position", "amount": 8, "frequency": 3 }'),
        compId,
      },
    },
    async ({ layerId, behavior, compId }) =>
      edit(
        (p) => editLayer(p, layerId, (l) => ({ ...l, behaviors: [...(l.behaviors ?? []), behavior as never] }), { compId }),
        () => `Added ${String(behavior.type)} behavior to ${layerId}.${String(behavior.property)}.`,
      ),
  );

  server.registerTool(
    "oe_detect_beats",
    {
      title: "Detect beats → markers",
      description:
        "Analyze an audio or video layer's sound and add composition markers on every beat (mode 'beats', a regular grid at the detected tempo) or every hit (mode 'onsets'). Returns the tempo and marker times so you can keyframe to the music.",
      inputSchema: {
        layerId: z.string(),
        mode: z.enum(["beats", "onsets"]).optional().describe("Default beats"),
        replace: z.boolean().optional().describe("Remove existing markers first. Default true"),
        compId,
      },
    },
    async ({ layerId, mode, replace, compId }) => {
      try {
        const project = loadProject(projectFile);
        const comp = getComp(project, compId);
        const layer = comp.layers.find((l) => l.id === layerId);
        if (!layer || !isMediaLayer(layer)) return fail(`Layer "${layerId}" is not an audio or video layer.`);
        const info = await detectBeats(path.resolve(projectDir, layer.src));
        const times = mode === "onsets" ? info.onsets : info.beats;
        const markers = beatMarkers(layer, times, comp, mode === "onsets" ? "hit" : "beat");
        const kept = replace === false ? (comp.markers ?? []) : [];
        saveProject(projectFile, updateComposition(project, { markers: [...kept, ...markers].sort((a, b) => a.t - b.t) }, { compId }));
        return text(
          `${info.bpm ? `Tempo ≈ ${info.bpm} BPM. ` : "No steady tempo found; used individual hits. "}Added ${markers.length} markers at: ${markers.map((m) => m.t).join(", ")}`,
        );
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  server.registerTool(
    "oe_update_composition",
    {
      title: "Update composition",
      description: "Change composition settings (width, height, fps, duration, background, name).",
      inputSchema: { patch: z.record(z.string(), z.unknown()), compId },
    },
    async ({ patch, compId }) => edit((p) => updateComposition(p, patch, { compId }), (p) => `Composition updated.\n${summarize(p)}`),
  );

  server.registerTool(
    "oe_add_composition",
    {
      title: "Add composition",
      description: "Add a composition, e.g. to nest it into another one with a layer of type 'comp' (precomp).",
      inputSchema: { composition: z.record(z.string(), z.unknown()) },
    },
    async ({ composition }) =>
      edit(
        (p) => ({ ...p, compositions: [...p.compositions, composition as unknown as Composition] }),
        () => `Added composition "${String(composition.id)}".`,
      ),
  );

  server.registerTool(
    "oe_render_frame",
    {
      title: "Render frame",
      description: "Render one frame to an image so you can see the result. Use it to check details at key moments.",
      inputSchema: {
        time: z.number().min(0).describe("Seconds"),
        width: z.number().int().min(64).max(1920).optional().describe("Image width in px. Default 960"),
        compId,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ time, width, compId }) => {
      try {
        const project = loadProject(projectFile);
        const png = await renderFramePng(project, projectDir, { time, compId, width: width ?? 960 });
        return image(png, `Frame at t=${time}s`);
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  server.registerTool(
    "oe_render_contact_sheet",
    {
      title: "Render contact sheet",
      description: "Render a grid of frames spread across the timeline (or at the given times). The fastest way to review the whole animation.",
      inputSchema: {
        count: z.number().int().min(1).max(24).optional().describe("Number of evenly spaced frames. Default 8"),
        times: z.array(z.number().min(0)).max(24).optional().describe("Explicit times in seconds instead of count"),
        compId,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ count, times, compId }) => {
      try {
        const project = loadProject(projectFile);
        const png = await renderContactSheet(project, projectDir, { count, times, compId, cellWidth: 360 });
        return image(png, "Contact sheet (each cell is labelled with its time)");
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  server.registerTool(
    "oe_export",
    {
      title: "Export video or Lottie",
      description:
        "Render the composition to a file in renders/. Only export when the user asks for it. 'lottie' writes a Lottie JSON (for web/iOS/Android apps); its notes list anything Lottie can't represent.",
      inputSchema: {
        format: z.enum(["mp4", "webm", "gif", "mov", "lottie"]).optional().describe("Default mp4. webm/mov keep transparency. lottie = vector JSON for apps"),
        scale: z.number().min(0.1).max(2).optional().describe("Resolution multiplier. Default 1 (0.5 for gif)"),
        compId,
      },
    },
    async ({ format, scale, compId }) => {
      try {
        const project = loadProject(projectFile);
        const comp = getComp(project, compId);
        if (format === "lottie") {
          const out = path.join(projectDir, "renders", `${comp.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
          const r = await exportLottieFile(project, projectDir, { compId, out });
          return text(`Exported Lottie (${(r.bytes / 1024).toFixed(1)} KB) to ${path.relative(projectDir, r.out)}${r.warnings.length ? `\nNotes:\n- ${r.warnings.join("\n- ")}` : ""}`);
        }
        const fmt: ExportFormat = format ?? "mp4";
        const out = path.join(projectDir, "renders", `${comp.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.${fmt}`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const r = await exportVideo(project, projectDir, { out, format: fmt, compId, scale: scale ?? (fmt === "gif" ? 0.5 : 1) });
        return text(`Exported ${r.frames} frames to ${path.relative(projectDir, r.file)}`);
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  server.registerTool(
    "oe_import_lottie",
    {
      title: "Import Lottie",
      description:
        "Import a Lottie JSON file (path relative to the project, e.g. assets/loader.json) as an editable precomp layer: shapes, text, images, keyframes and easing become normal OpenEffects layers. Use replace to make it the whole project.",
      inputSchema: {
        file: z.string().describe("Path of the .json file, relative to the project folder"),
        replace: z.boolean().optional().describe("Replace the whole project instead of adding a precomp layer. Default false"),
        compId,
      },
    },
    async ({ file, replace, compId }) => {
      try {
        const src = path.resolve(projectDir, file);
        if (!src.startsWith(projectDir + path.sep)) return fail("The file must be inside the project folder.");
        if (!fs.existsSync(src)) return fail(`No file at ${file}`);
        const { project: imported, warnings } = importLottieFile(src, projectDir);
        const notes = warnings.length ? `\nNotes:\n- ${warnings.join("\n- ")}` : "";
        if (replace) return edit(() => imported, (p) => `Imported ${file} as the project.${notes}\n${summarize(p)}`);
        let added = "";
        return edit(
          (p) => {
            const r = addAsPrecomp(p, imported, { compId, name: path.basename(file, path.extname(file)) });
            added = `layer "${r.layerId}" (composition "${r.compId}")`;
            return r.project;
          },
          (p) => `Imported ${file} as ${added}.${notes}\n${summarize(p)}`,
        );
      } catch (e) {
        return fail(describeError(e));
      }
    },
  );

  server.registerTool(
    "oe_list_assets",
    { title: "List assets", description: "List files in the project's assets/ folder (usable as image layer src).", annotations: { readOnlyHint: true } },
    async () => {
      const dir = path.join(projectDir, "assets");
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith(".")) : [];
      return text(files.length ? files.map((f) => `assets/${f}`).join("\n") : "No assets yet. The user can drop images into the assets/ folder.");
    },
  );

  return server;
}

export async function runStdioServer(projectFile: string): Promise<void> {
  const server = createMcpServer(projectFile);
  await server.connect(new StdioServerTransport());
}
