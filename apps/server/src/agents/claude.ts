import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentProvider, ProviderStatus, RunningTurn, TurnRequest, TurnResult } from "./types.ts";

const SYSTEM_PROMPT = [
  "You are the AI motion designer inside OpenEffects, an open-source motion graphics app.",
  "The user watches a live preview of project.oe.json while you work, so every saved edit appears immediately.",
  "Edit the animation with the openeffects MCP tools (or by editing project.oe.json), then check it visually with",
  "mcp__openeffects__oe_render_contact_sheet / oe_render_frame and fix what looks wrong before you finish.",
  "Reply briefly: what you made or changed, in 1-3 sentences.",
].join(" ");

/** Summarise a tool_result content block for the UI. */
function summarizeResult(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 400);
  if (Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : c.type === "image" ? "[image]" : ""))
      .join(" ")
      .slice(0, 400);
  }
  return "";
}

/**
 * Claude Code adapter. Runs the user's own `claude` CLI in print mode with streaming JSON
 * output, the same approach T3 Code takes: the user logs in with `claude` themselves,
 * and OpenEffects only reads the event stream.
 */
export class ClaudeCodeProvider implements AgentProvider {
  id = "claude";
  label = "Claude Code";

  constructor(private bin = process.env.OE_CLAUDE_BIN || "claude") {}

  status(): Promise<ProviderStatus> {
    return new Promise((resolve) => {
      execFile(this.bin, ["--version"], { timeout: 10_000 }, (err, stdout) => {
        resolve(
          err
            ? { id: this.id, label: this.label, available: false, detail: "Not found. Install Claude Code and run `claude` once to log in." }
            : { id: this.id, label: this.label, available: true, detail: stdout.trim() },
        );
      });
    });
  }

  startTurn(req: TurnRequest): RunningTurn {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      req.mcpConfigPath,
      "--strict-mcp-config",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "mcp__openeffects",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "--append-system-prompt",
      SYSTEM_PROMPT,
    ];
    if (req.sessionId) args.push("--resume", req.sessionId);
    if (req.model) args.push("--model", req.model);

    const child = spawn(this.bin, args, { cwd: req.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(req.prompt);

    let stderr = "";
    let sessionId = req.sessionId;
    let result: TurnResult | undefined;
    child.stderr.on("data", (d) => (stderr += d));

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.session_id) sessionId = msg.session_id;
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") req.onEvent({ type: "status", text: `Connected to Claude Code${msg.model ? ` (${msg.model})` : ""}` });
          break;
        case "assistant":
          for (const block of msg.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) req.onEvent({ type: "text", text: block.text });
            if (block.type === "tool_use") req.onEvent({ type: "tool-call", id: block.id, name: block.name, input: block.input });
          }
          break;
        case "user":
          for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
            if (block.type === "tool_result")
              req.onEvent({ type: "tool-result", id: block.tool_use_id, ok: !block.is_error, summary: summarizeResult(block.content) });
          }
          break;
        case "result":
          result = {
            ok: !msg.is_error && msg.subtype === "success",
            error: msg.is_error || msg.subtype !== "success" ? String(msg.result ?? msg.subtype ?? "Claude Code reported an error") : undefined,
            sessionId,
            costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
            durationMs: typeof msg.duration_ms === "number" ? msg.duration_ms : undefined,
          };
          break;
      }
    });

    let stopped = false;
    const done = new Promise<TurnResult>((resolve) => {
      child.on("error", (e: NodeJS.ErrnoException) =>
        resolve({ ok: false, error: e.code === "ENOENT" ? "Claude Code CLI not found (`claude`)." : e.message, sessionId }),
      );
      child.on("close", (code) => {
        if (stopped) return resolve({ ok: false, error: "Stopped", sessionId });
        if (result) return resolve({ ...result, sessionId: result.sessionId ?? sessionId });
        resolve({ ok: false, error: stderr.trim().split("\n").slice(-5).join("\n") || `claude exited with code ${code}`, sessionId });
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
}
