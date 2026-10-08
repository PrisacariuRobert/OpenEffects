import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  ProjectValidationError,
  exportVideo,
  readProject,
  saveProject,
  writeAgentFiles,
  type ExportFormat,
  type McpLaunch,
} from "@openeffects/node";
import { getComp, type ServerMessage, type StateResponse } from "@openeffects/schema";
import { Checkpoints, type Checkpoint } from "./checkpoints.ts";
import { ClaudeCodeProvider } from "./agents/claude.ts";
import type { AgentEvent, AgentProvider, ProviderStatus, RunningTurn } from "./agents/types.ts";

export interface ServerOptions {
  projectFile: string;
  port?: number;
  host?: string;
  /** How agents should launch the OpenEffects MCP server for this project. */
  mcp: McpLaunch;
  /** Directory of the web app (source for Vite dev mode, or containing dist/). */
  webDir?: string;
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
};

export async function startServer(opts: ServerOptions): Promise<{ url: string; close(): Promise<void> }> {
  const projectFile = path.resolve(opts.projectFile);
  const projectDir = path.dirname(projectFile);
  const webDir = opts.webDir ?? fileURLToPath(new URL("../../web", import.meta.url));
  const stateDir = path.join(projectDir, ".openeffects");
  fs.mkdirSync(stateDir, { recursive: true });

  // MCP config handed to agents. Also refresh AGENTS.md/CLAUDE.md/.mcp.json so the
  // folder works with any agent started from a terminal.
  const mcpConfigPath = path.join(stateDir, "mcp.json");
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { openeffects: opts.mcp } }, null, 2));
  writeAgentFiles(projectDir, opts.mcp);

  const providers: AgentProvider[] = [new ClaudeCodeProvider()];
  const checkpoints = new Checkpoints(projectDir);
  const clients = new Set<WebSocket>();
  // The conversation survives restarts: provider session id + event history.
  const sessionFile = path.join(stateDir, "session.json");
  const saved = loadSession(sessionFile);
  const history: AgentEvent[] = saved.history;
  let sessionId: string | undefined = saved.sessionId;
  // Close turns that were cut off by a crash or restart, so the UI doesn't spin forever.
  const openTurns = new Set<string>();
  for (const e of history) {
    if (e.type === "turn-start") openTurns.add(e.turnId);
    if (e.type === "turn-end") openTurns.delete(e.turnId);
  }
  for (const turnId of openTurns) history.push({ type: "turn-end", turnId, ok: false, error: "Interrupted (server restarted)" });
  let running: { turn: RunningTurn; turnId: string } | undefined;
  const persistSession = () => {
    try {
      fs.writeFileSync(sessionFile, JSON.stringify({ sessionId, history }));
    } catch {
      // best effort
    }
  };
  let exporting: AbortController | undefined;

  let current = readProject(projectFile);
  let lastText = safeRead(projectFile);

  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };
  const projectMessage = (): Extract<ServerMessage, { type: "project" }> =>
    current.ok ? { type: "project", project: current.project, errors: [] } : { type: "project", project: null, errors: current.errors };
  const pushCheckpoints = async () => broadcast({ type: "checkpoints", checkpoints: await checkpoints.list() });
  const emit = (event: AgentEvent) => {
    history.push(event);
    if (history.length > 2000) history.splice(0, history.length - 2000);
    broadcast({ type: "agent", event });
  };

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

  const statuses = async (): Promise<ProviderStatus[]> => Promise.all(providers.map((p) => p.status()));

  async function runTurn(providerId: string, prompt: string, model?: string): Promise<void> {
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) throw new HttpError(400, `Unknown provider "${providerId}"`);
    if (running) throw new HttpError(409, "The agent is already working");
    const turnId = randomUUID();
    const before = await checkpoints.create(`Before: ${prompt}`);
    emit({ type: "turn-start", turnId, provider: provider.id, prompt, checkpointBefore: before?.id });
    const turn = provider.startTurn({
      prompt,
      cwd: projectDir,
      mcpConfigPath,
      sessionId,
      model,
      onEvent: (e) => emit({ ...e, turnId } as AgentEvent),
    });
    running = { turn, turnId };
    broadcast({ type: "agent-state", running: true, sessionId });
    turn.done.then(async (r) => {
      if (r.sessionId) sessionId = r.sessionId;
      const after = await checkpoints.create(`After: ${prompt}`);
      running = undefined;
      emit({
        type: "turn-end",
        turnId,
        ok: r.ok,
        error: r.error,
        costUsd: r.costUsd,
        durationMs: r.durationMs,
        checkpointBefore: before?.id,
        checkpointAfter: after?.id,
      });
      broadcast({ type: "agent-state", running: false, sessionId });
      persistSession();
      await pushCheckpoints();
    });
  }

  async function startExport(format: ExportFormat, compId?: string): Promise<void> {
    if (exporting) throw new HttpError(409, "An export is already running");
    if (!current.ok) throw new HttpError(422, "Fix the project errors before exporting");
    const project = current.project;
    const comp = getComp(project, compId);
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
      const status = e instanceof HttpError ? e.status : 500;
      sendJson(res, status, { error: (e as Error).message, errors: e instanceof ProjectValidationError ? e.errors : undefined });
    }
  });

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/state") {
      const state: StateResponse = {
        file: projectFile,
        ...projectMessage(),
        providers: await statuses(),
        checkpoints: await checkpoints.list(),
        history,
        running: !!running,
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
      await runTurn(body.provider ?? "claude", body.prompt.trim(), body.model);
      return sendJson(res, 202, { ok: true });
    }
    if (route === "POST /api/agent/stop") {
      running?.turn.stop();
      return sendJson(res, 200, { ok: true });
    }
    if (route === "POST /api/agent/new") {
      if (running) throw new HttpError(409, "Stop the running turn first");
      sessionId = undefined;
      history.length = 0;
      persistSession();
      broadcast({ type: "agent-reset" });
      return sendJson(res, 200, { ok: true });
    }
    if (route === "POST /api/checkpoints/restore") {
      if (running) throw new HttpError(409, "Stop the agent before restoring");
      const { id } = (await readJson(req)) as { id: string };
      await checkpoints.restore(id);
      await pushCheckpoints();
      return sendJson(res, 200, { ok: true });
    }
    if (route === "POST /api/export") {
      const { format = "mp4", compId } = (await readJson(req)) as { format?: ExportFormat; compId?: string };
      if (!["mp4", "webm", "gif", "mov"].includes(format)) throw new HttpError(400, "Unsupported format");
      await startExport(format, compId);
      return sendJson(res, 202, { ok: true });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/assets/")) {
      return serveStatic(res, projectDir, decodeURIComponent(url.pathname.slice("/api/assets/".length)));
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/renders/")) {
      return serveStatic(res, path.join(projectDir, "renders"), decodeURIComponent(url.pathname.slice("/api/renders/".length)));
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
      running?.turn.stop();
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
  if ((req.method === "POST" || req.method === "PUT") && !String(req.headers["content-type"] ?? "").includes("application/json")) {
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

function loadSession(file: string): { sessionId?: string; history: AgentEvent[] } {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined, history: Array.isArray(data.history) ? data.history : [] };
  } catch {
    return { history: [] };
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

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

/** Serves a file from `root`, refusing paths that escape it. */
function serveStatic(res: http.ServerResponse, root: string, rel: string, fallback?: string): void {
  const file = path.resolve(root, "." + path.posix.normalize("/" + rel));
  const inside = file === root || file.startsWith(path.resolve(root) + path.sep);
  let target = inside && fs.existsSync(file) && fs.statSync(file).isFile() ? file : fallback;
  if (!target) throw new HttpError(404, "Not found");
  res.writeHead(200, { "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(target).pipe(res);
}
