import { run, runJsonlProcess, stderrTail, summarizeContent } from "./process.ts";
import { AGENT_INSTRUCTIONS, type AdapterEvent, type AgentProvider, type ProviderStatus, type RunningTurn, type TurnRequest, type TurnResult } from "./types.ts";

/** TOML literal for a `-c key=value` override (JSON strings are valid TOML basic strings). */
const toml = (v: string | string[]) => (Array.isArray(v) ? `[${v.map((s) => JSON.stringify(s)).join(", ")}]` : JSON.stringify(v));

/** Translates `codex exec --json` events into adapter events. */
export function createCodexParser(emit: (e: AdapterEvent) => void) {
  const state: { sessionId?: string; error?: string; completed: boolean; tokens?: { input: number; output: number } } = { completed: false };
  const toolName = (item: Record<string, any>) => (item.server ? `mcp__${item.server}__${item.tool}` : String(item.tool ?? "tool"));
  return {
    state,
    onMessage(msg: Record<string, any>) {
      switch (msg.type) {
        case "thread.started":
          state.sessionId = msg.thread_id;
          emit({ type: "status", text: "Connected to Codex" });
          break;
        case "item.started": {
          const item = msg.item ?? {};
          if (item.type === "mcp_tool_call") emit({ type: "tool-call", id: item.id, name: toolName(item), input: item.arguments });
          if (item.type === "command_execution") emit({ type: "tool-call", id: item.id, name: "shell", input: { command: item.command } });
          break;
        }
        case "item.completed": {
          const item = msg.item ?? {};
          if (item.type === "agent_message" && item.text?.trim()) emit({ type: "text", text: item.text });
          if (item.type === "mcp_tool_call") {
            const ok = item.status !== "failed" && !item.error && !item.result?.is_error;
            emit({ type: "tool-result", id: item.id, ok, summary: item.error?.message ?? summarizeContent(item.result?.content ?? item.result) });
          }
          if (item.type === "command_execution")
            emit({ type: "tool-result", id: item.id, ok: item.exit_code === 0, summary: String(item.aggregated_output ?? "").slice(0, 400) });
          if (item.type === "file_change") {
            const files = (item.changes ?? []).map((c: { path: string; kind: string }) => `${c.kind} ${c.path}`).join(", ");
            emit({ type: "tool-call", id: item.id, name: "edit_files", input: { file_path: files } });
            emit({ type: "tool-result", id: item.id, ok: item.status !== "failed", summary: files });
          }
          break;
        }
        case "turn.completed":
          state.completed = true;
          if (msg.usage) state.tokens = { input: msg.usage.input_tokens ?? 0, output: msg.usage.output_tokens ?? 0 };
          break;
        case "turn.failed":
          state.error = msg.error?.message ?? "Codex turn failed";
          break;
        case "error":
          // Reconnect notices are transient; keep the latest in case the turn fails.
          state.error = msg.message;
          if (typeof msg.message === "string" && !msg.message.startsWith("Reconnecting")) emit({ type: "status", text: msg.message });
          break;
      }
    },
  };
}

/**
 * Codex adapter. Runs the user's own `codex` CLI (`codex exec --json`), with the OpenEffects
 * MCP server injected through `-c mcp_servers.*` overrides, so their ~/.codex config and
 * login are used untouched.
 */
export class CodexProvider implements AgentProvider {
  id = "codex";
  label = "Codex";

  constructor(private bin = process.env.OE_CODEX_BIN || "codex") {}

  async status(): Promise<ProviderStatus> {
    const version = await run(this.bin, ["--version"]);
    const base = { id: this.id, label: this.label, models: [], defaultModel: "" };
    if (!version.ok) return { ...base, available: false, detail: "Not found. Install Codex (npm i -g @openai/codex) and run `codex login`." };
    const login = await run(this.bin, ["login", "status"]);
    const detail = version.stdout.trim();
    return login.ok
      ? { ...base, available: true, detail }
      : { ...base, available: false, detail: `${detail}: not logged in. Run \`codex login\` in a terminal.` };
  }

  startTurn(req: TurnRequest): RunningTurn {
    const overrides = [
      `mcp_servers.openeffects.command=${toml(req.mcp.command)}`,
      `mcp_servers.openeffects.args=${toml(req.mcp.args)}`,
      "mcp_servers.openeffects.startup_timeout_sec=60",
      "mcp_servers.openeffects.tool_timeout_sec=300",
      `sandbox_mode="workspace-write"`,
      `approval_policy="never"`,
      `developer_instructions=${toml(AGENT_INSTRUCTIONS)}`,
    ].flatMap((o) => ["-c", o]);
    const common = ["--json", "--skip-git-repo-check", ...overrides, ...(req.model ? ["-m", req.model] : [])];
    // `exec resume <id> -` continues the thread; `-` reads the prompt from stdin.
    const args = req.sessionId ? ["exec", "resume", ...common, req.sessionId, "-"] : ["exec", ...common, "-"];

    const parser = createCodexParser(req.onEvent);
    const started = Date.now();
    return runJsonlProcess({
      bin: this.bin,
      args,
      cwd: req.cwd,
      stdin: req.prompt,
      onMessage: parser.onMessage,
      notFound: "Codex CLI not found (`codex`).",
      finish: ({ code, stderr }) => ({
        ok: parser.state.completed && code === 0,
        error: parser.state.completed && code === 0 ? undefined : parser.state.error || stderrTail(stderr) || `codex exited with code ${code}`,
        sessionId: parser.state.sessionId,
        durationMs: Date.now() - started,
        tokens: parser.state.tokens,
      }),
    });
  }
}
