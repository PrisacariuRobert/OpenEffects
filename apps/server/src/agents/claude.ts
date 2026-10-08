import { run, runJsonlProcess, stderrTail, summarizeContent } from "./process.ts";
import { AGENT_INSTRUCTIONS, type AdapterEvent, type AgentProvider, type ProviderStatus, type RunningTurn, type TurnRequest, type TurnResult } from "./types.ts";

export const CLAUDE_MODELS = [
  { id: "claude-haiku-5-5", label: "Haiku 5.5 (fastest, cheapest)" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5 (balanced)" },
  { id: "claude-opus-5-5", label: "Opus 5.5 (most capable)" },
];

/** Translates Claude Code `--output-format stream-json` messages into adapter events. */
export function createClaudeParser(emit: (e: AdapterEvent) => void) {
  const state: { sessionId?: string; result?: TurnResult } = {};
  return {
    state,
    onMessage(msg: Record<string, any>) {
      if (typeof msg.session_id === "string") state.sessionId = msg.session_id;
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") emit({ type: "status", text: `Connected to Claude Code${msg.model ? ` (${msg.model})` : ""}` });
          break;
        case "assistant":
          for (const block of msg.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) emit({ type: "text", text: block.text });
            if (block.type === "tool_use") emit({ type: "tool-call", id: block.id, name: block.name, input: block.input });
          }
          break;
        case "user":
          for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
            if (block.type === "tool_result") emit({ type: "tool-result", id: block.tool_use_id, ok: !block.is_error, summary: summarizeContent(block.content) });
          }
          break;
        case "result": {
          const failed = msg.is_error || msg.subtype !== "success";
          state.result = {
            ok: !failed,
            error: failed ? String(msg.result || msg.subtype || "Claude Code reported an error") : undefined,
            costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
            durationMs: typeof msg.duration_ms === "number" ? msg.duration_ms : undefined,
            tokens: msg.usage ? { input: (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0), output: msg.usage.output_tokens ?? 0 } : undefined,
          };
          break;
        }
      }
    },
  };
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

  async status(): Promise<ProviderStatus> {
    const r = await run(this.bin, ["--version"]);
    return {
      id: this.id,
      label: this.label,
      available: r.ok,
      detail: r.ok ? r.stdout.trim() : "Not found. Install Claude Code and run `claude` once to log in.",
      models: CLAUDE_MODELS,
      defaultModel: "claude-haiku-5-5",
    };
  }

  startTurn(req: TurnRequest): RunningTurn {
    const mcpConfig = JSON.stringify({ mcpServers: { openeffects: { command: req.mcp.command, args: req.mcp.args } } });
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      mcpConfig,
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
      AGENT_INSTRUCTIONS,
    ];
    if (req.sessionId) args.push("--resume", req.sessionId);
    if (req.model) args.push("--model", req.model);

    const parser = createClaudeParser(req.onEvent);
    return runJsonlProcess({
      bin: this.bin,
      args,
      cwd: req.cwd,
      stdin: req.prompt,
      onMessage: parser.onMessage,
      notFound: "Claude Code CLI not found (`claude`).",
      finish: ({ code, stderr }) =>
        parser.state.result
          ? { ...parser.state.result, sessionId: parser.state.sessionId }
          : { ok: false, sessionId: parser.state.sessionId, error: stderrTail(stderr) || `claude exited with code ${code}` },
    });
  }
}
