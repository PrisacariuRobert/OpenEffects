import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RunningTurn, TurnResult } from "./types.ts";

export interface JsonlProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, then stdin is closed. */
  stdin?: string;
  /** Called for every JSON line on stdout. */
  onMessage(msg: Record<string, any>): void;
  /** Builds the result once the process exits (stderr tail and exit code supplied). */
  finish(info: { code: number | null; stderr: string }): TurnResult;
  notFound: string;
}

/** Runs an agent CLI that streams JSON lines, with stop/kill handling shared by all adapters. */
export function runJsonlProcess(opts: JsonlProcessOptions): RunningTurn {
  const child = spawn(opts.bin, opts.args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  child.stdin.end(opts.stdin ?? "");
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
    if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    try {
      opts.onMessage(JSON.parse(trimmed));
    } catch {
      // ignore partial or non-JSON lines
    }
  });

  let stopped = false;
  const done = new Promise<TurnResult>((resolve) => {
    child.on("error", (e: NodeJS.ErrnoException) => resolve({ ok: false, error: e.code === "ENOENT" ? opts.notFound : e.message }));
    child.on("close", (code) => {
      const r = opts.finish({ code, stderr: stderr.trim() });
      resolve(stopped ? { ...r, ok: false, error: "Stopped" } : r);
    });
  });

  return {
    stop: () => {
      stopped = true;
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    },
    done,
  };
}

/** Last few lines of stderr, for error messages. */
export function stderrTail(stderr: string, lines = 4): string {
  return stderr
    .split("\n")
    .filter((l) => l.trim() && !/^\s*WARNING:/.test(l))
    .slice(-lines)
    .join("\n");
}

export function run(bin: string, args: string[], timeout = 10_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** Text summary of MCP tool result content (strings or content-block arrays). */
export function summarizeContent(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 400);
  if (Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string }) => (c?.type === "text" ? (c.text ?? "") : c?.type === "image" ? "[image]" : ""))
      .join(" ")
      .trim()
      .slice(0, 400);
  }
  if (content && typeof content === "object" && "content" in content) return summarizeContent((content as { content: unknown }).content);
  return "";
}
