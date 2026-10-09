import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  ProjectValidationError,
  exportLottieFile,
  exportVideo,
  importLottieData,
  readProject,
  saveProject,
  writeAgentFiles,
  detectBeats,
  probeMedia,
  waveform,
  videoFrameJpeg,
  type ExportFormat,
  type McpLaunch,
} from "@openeffects/node";
import { getComp, mediaKind, type ServerMessage, type StateResponse } from "@openeffects/schema";
import { AgentError, AgentSession } from "./agents/session.ts";
import type { AgentProvider } from "./agents/types.ts";

export interface ServerOptions {
  projectFile: string;
  port?: number;
  host?: string;
  /** How agents should launch the OpenEffects MCP server for this project. */
  mcp: McpLaunch;
  /** Directory of the web app (source for Vite dev mode, or containing dist/). */
  webDir?: string;
  /** Override the agent providers (tests). */
  providers?: AgentProvider[];
  /** Folder of template projects (default: the repo's examples/). */
  templatesDir?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".woff2": "font/woff2",
  ".m4v": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
};

export async function startServer(opts: ServerOptions): Promise<{ url: string; close(): Promise<void> }> {
  const projectFile = path.resolve(opts.projectFile);
  const projectDir = path.dirname(projectFile);
  const webDir = opts.webDir ?? fileURLToPath(new URL("../../web", import.meta.url));
  /** Resolve a project-relative media path, refusing anything outside the project folder. */
  const projectPath = (rel: string) => {
    const file = path.resolve(projectDir, rel);
    if (!rel || !(file.startsWith(path.resolve(projectDir) + path.sep)) || !fs.existsSync(file)) throw new HttpError(404, "Media not found");
    return file;
  };

  // Refresh AGENTS.md/CLAUDE.md/.mcp.json so the folder also works with any agent started
  // from a terminal.
  writeAgentFiles(projectDir, opts.mcp);

  const clients = new Set<WebSocket>();
  let exporting: AbortController | undefined;
  let current = readProject(projectFile);
  let lastText = safeRead(projectFile);

  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };
  const projectMessage = (): Extract<ServerMessage, { type: "project" }> =>
    current.ok ? { type: "project", project: current.project, errors: [] } : { type: "project", project: null, errors: current.errors };

  const agent: AgentSession = new AgentSession({
    projectDir,
    mcp: opts.mcp,
    providers: opts.providers,
    onEvent: (event) => broadcast({ type: "agent", event }),
    onRunningChange: (running) => broadcast({ type: "agent-state", running }),
    onCheckpointsChange: () => void pushCheckpoints(),
  });
  const checkpoints = agent.checkpoints;
  const pushCheckpoints = async () => broadcast({ type: "checkpoints", checkpoints: await checkpoints.list() });

  // Hot reload: watch the project folder and push changes made by agents or editors.
  let debounce: NodeJS.Timeout | undefined;
  const watcher = fs.watch(projectDir, (_event, filename) => {
    if (filename && path.basename(filename.toString()) !== path.basename(projectFile)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const text = safeRead(projectFile);
      if (text === lastText) return;
      lastText = text;
      current = readProject(projectFile);
      broadcast(projectMessage());
    }, 40);
  });

  async function startExport(format: ExportFormat | "lottie", compId?: string): Promise<void> {
    if (exporting) throw new HttpError(409, "An export is already running");
    if (!current.ok) throw new HttpError(422, "Fix the project errors before exporting");
    const project = current.project;
    const comp = getComp(project, compId);
    if (format === "lottie") {
      // Instant: no frames to render. Warnings list what Lottie can't represent.
      const name = `${comp.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      exporting = new AbortController();
      exportLottieFile(project, projectDir, { compId, out: path.join(projectDir, "renders", name) })
        .then((r) => broadcast({ type: "export", state: "done", url: `/api/renders/${encodeURIComponent(name)}`, warnings: r.warnings }))
        .catch((e: Error) => broadcast({ type: "export", state: "error", error: e.message }))
        .finally(() => (exporting = undefined));
      return;
    }
    const name = `${comp.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`;
    const out = path.join(projectDir, "renders", name);
    const controller = (exporting = new AbortController());
    let lastPct = -1;
    exportVideo(project, projectDir, {
      out,
      format,
      compId,
      scale: format === "gif" ? 0.5 : 1,
      signal: controller.signal,
      onProgress: (f, total) => {
        const pct = Math.floor((f / total) * 100);
        if (pct !== lastPct) broadcast({ type: "export", state: "progress", progress: (lastPct = pct) });
      },
    })
      .then(() => broadcast({ type: "export", state: "done", url: `/api/renders/${encodeURIComponent(name)}` }))
      .catch((e: Error) => broadcast({ type: "export", state: "error", error: e.message }))
      .finally(() => (exporting = undefined));
  }

  // ---------- HTTP ----------
  let vite: import("vite").ViteDevServer | undefined;
  const distDir = path.join(webDir, "dist");
  const useDist = fs.existsSync(path.join(distDir, "index.html")) && !process.env.OE_DEV;
  if (!useDist) {
    const { createServer } = await import("vite");
    vite = await createServer({ root: webDir, server: { middlewareMode: true }, appType: "spa", logLevel: "warn" });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        checkRequestOrigin(req);
        return await api(req, res, url);
      }
      if (vite) return vite.middlewares(req, res);
      return serveStatic(res, distDir, url.pathname === "/" ? "index.html" : url.pathname, path.join(distDir, "index.html"));
    } catch (e) {
      const status = e instanceof HttpError || e instanceof AgentError ? e.status : 500;
      sendJson(res, status, { error: (e as Error).message, errors: e instanceof ProjectValidationError ? e.errors : undefined });
    }
  });

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/state") {
      const state: StateResponse = {
        file: projectFile,
        ...projectMessage(),
        providers: await agent.statuses(),
        checkpoints: await checkpoints.list(),
        history: agent.history,
        running: agent.isRunning,
      };
      return sendJson(res, 200, state);
    }
    if (route === "PUT /api/project") {
      const body = await readJson(req);
      const project = saveProject(projectFile, body);
      lastText = safeRead(projectFile);
      current = { ok: true, project };
      broadcast(projectMessage());
      return sendJson(res, 200, { ok: true });
    }
    if (route === "POST /api/agent/turn") {
      const body = (await readJson(req)) as { provider?: string; prompt?: string; model?: string };
      if (!body.prompt?.trim()) throw new HttpError(400, "Empty prompt");
      await agent.start(body.provider ?? "claude", body.prompt.trim(), body.model);
      return sendJson(res, 202, { ok: true });
    }
    if (route === "POST /api/agent/stop") {
      agent.stop();
      return sendJson(res, 200, { ok: true });
    }
    if (route === "POST /api/agent/new") {
      agent.reset();
      broadcast({ type: "agent-reset" });
      return sendJson(res, 200, { ok: true });
    }
    if (route === "POST /api/checkpoints/restore") {
      if (agent.isRunning) throw new HttpError(409, "Stop the agent before restoring");
      const { id } = (await readJson(req)) as { id: string };
      await checkpoints.restore(id);
      await pushCheckpoints();
      return sendJson(res, 200, { ok: true });
    }
    if (route === "POST /api/export") {
      const { format = "mp4", compId } = (await readJson(req)) as { format?: ExportFormat | "lottie"; compId?: string };
      if (!["mp4", "webm", "gif", "mov", "lottie"].includes(format)) throw new HttpError(400, "Unsupported format");
      await startExport(format, compId);
      return sendJson(res, 202, { ok: true });
    }
    if (route === "POST /api/import/lottie") {
      // Converts a Lottie file and stores its images in assets/. The editor merges the result
      // into the project itself, so the import is one undoable step.
      const name = (url.searchParams.get("name") ?? "lottie").replace(/\.[^.]+$/, "");
      const json = await readJson(req);
      try {
        const { project, warnings } = importLottieData(json, projectDir, { name });
        return sendJson(res, 200, { project, warnings });
      } catch (e) {
        throw new HttpError(422, (e as Error).message);
      }
    }
    if (route === "POST /api/assets") {
      // Raw file upload (the editor's drag & drop), streamed to assets/ under a safe name.
      const original = url.searchParams.get("name") ?? "upload";
      const ext = path.extname(original).toLowerCase();
      const kind = mediaKind(original);
      if (!kind) throw new HttpError(415, "Supported files: images (PNG, JPG, WebP, GIF, SVG), video (MP4, WebM, MOV) and audio (MP3, WAV, M4A, AAC, OGG, FLAC)");
      const base = path.basename(original, path.extname(original)).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || kind;
      const dir = path.join(projectDir, "assets");
      fs.mkdirSync(dir, { recursive: true });
      let name = `${base}${ext}`;
      for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}${ext}`;
      await saveUpload(req, path.join(dir, name), kind === "image" ? 50 * 1024 * 1024 : 2 * 1024 * 1024 * 1024);
      return sendJson(res, 201, { src: `assets/${name}`, kind });
    }
    if (route === "GET /api/videoframe") {
      const file = projectPath(url.searchParams.get("src") ?? "");
      const jpeg = await videoFrameJpeg(file, Number(url.searchParams.get("t") ?? 0) || 0, Math.min(3840, Number(url.searchParams.get("w") ?? 1280) || 1280));
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" });
      res.end(jpeg);
      return;
    }
    if (route === "GET /api/media" || route === "GET /api/waveform" || route === "GET /api/beats") {
      const file = projectPath(url.searchParams.get("src") ?? "");
      if (route === "GET /api/media") return sendJson(res, 200, await probeMedia(file));
      if (route === "GET /api/waveform") return sendJson(res, 200, await waveform(file, 50));
      return sendJson(res, 200, await detectBeats(file));
    }
    if (route === "GET /api/templates") {
      // Starting points: the bundled examples (each a complete project).
      const dir = opts.templatesDir ?? fileURLToPath(new URL("../../../examples", import.meta.url));
      const templates = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
        .map((name) => ({ name, r: readProject(path.join(dir, name, "project.oe.json")) }))
        .filter((t) => t.r.ok && !/showreel/.test(t.name))
        .map((t) => ({ name: t.name, project: (t.r as { project: unknown }).project }));
      return sendJson(res, 200, { templates });
    }
    if (route === "GET /api/assets") {
      const dir = path.join(projectDir, "assets");
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => mediaKind(f)) : [];
      return sendJson(res, 200, { assets: files.map((f) => ({ src: `assets/${f}`, kind: mediaKind(f) })) });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/assets/")) {
      return serveStatic(res, projectDir, decodeURIComponent(url.pathname.slice("/api/assets/".length)), undefined, req);
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/renders/")) {
      return serveStatic(res, path.join(projectDir, "renders"), decodeURIComponent(url.pathname.slice("/api/renders/".length)), undefined, req);
    }
    throw new HttpError(404, "Not found");
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") return; // e.g. Vite HMR handles its own
    try {
      checkRequestOrigin(req);
    } catch {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
    });
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4310, host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    async close() {
      agent.stop();
      exporting?.abort();
      watcher.close();
      for (const ws of clients) ws.terminate();
      wss.close();
      await vite?.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * The server can drive a coding agent, so it must not be reachable from other websites:
 * reject foreign Origins (CSRF / cross-site WebSocket), non-local Host headers (DNS rebinding),
 * and non-JSON bodies (which would skip the CORS preflight).
 */
function checkRequestOrigin(req: http.IncomingMessage): void {
  const host = req.headers.host ?? "";
  const hostname = host.replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname) && process.env.OE_ALLOW_HOST !== hostname) {
    throw new HttpError(403, "Forbidden host");
  }
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) throw new HttpError(403, "Forbidden origin");
  // Both types force a CORS preflight, which this server never answers.
  const type = String(req.headers["content-type"] ?? "");
  if ((req.method === "POST" || req.method === "PUT") && !type.includes("application/json") && !type.includes("application/octet-stream")) {
    throw new HttpError(415, "Expected application/json");
  }
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const body = await readBody(req, 20 * 1024 * 1024);
  try {
    return JSON.parse(body.toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

/** Serves a file from `root`, refusing paths that escape it. Supports Range (needed to seek video/audio). */
function serveStatic(res: http.ServerResponse, root: string, rel: string, fallback?: string, req?: http.IncomingMessage): void {
  const file = path.resolve(root, "." + path.posix.normalize("/" + rel));
  const inside = file === root || file.startsWith(path.resolve(root) + path.sep);
  const target = inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : fallback;
  if (!target) throw new HttpError(404, "Not found");
  const size = fs.statSync(target).size;
  const type = MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req?.headers.range ?? ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    end = Math.min(end, size - 1);
    start = Math.min(start, end);
    res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1, "cache-control": "no-cache" });
    fs.createReadStream(target, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes", "cache-control": "no-cache" });
  fs.createReadStream(target).pipe(res);
}

/** Stream a request body to a file, enforcing a size limit. */
async function saveUpload(req: http.IncomingMessage, file: string, limit: number): Promise<void> {
  const out = fs.createWriteStream(file);
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, "File too large");
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw e;
  }
}
