import { run, runJsonlProcess, stderrTail } from "./process.ts";
import { AGENT_INSTRUCTIONS, type AdapterEvent, type AgentProvider, type ModelOption, type ProviderStatus, type RunningTurn, type TurnRequest } from "./types.ts";

/** Translates `opencode run --format json` events into adapter events. */
export function createOpenCodeParser(emit: (e: AdapterEvent) => void) {
  const state: { sessionId?: string; error?: string; costUsd: number; tokens: { input: number; output: number }; steps: number } = {
    costUsd: 0,
    tokens: { input: 0, output: 0 },
    steps: 0,
  };
  return {
    state,
    onMessage(msg: Record<string, any>) {
      if (typeof msg.sessionID === "string" && !state.sessionId) {
        state.sessionId = msg.sessionID;
        emit({ type: "status", text: "Connected to OpenCode" });
      }
      const part = msg.part ?? {};
      switch (msg.type) {
        case "text":
          if (part.text?.trim()) emit({ type: "text", text: part.text });
          break;
        case "tool_use": {
          // OpenCode names MCP tools <server>_<tool>.
          const name = String(part.tool ?? "tool").replace(/^openeffects_/, "mcp__openeffects__");
          const id = String(part.callID ?? part.id);
          const st = part.state ?? {};
          emit({ type: "tool-call", id, name, input: st.input });
          emit({ type: "tool-result", id, ok: st.status === "completed", summary: String(st.status === "completed" ? (st.output ?? "") : (st.error ?? "")).slice(0, 400) });
          break;
        }
        case "step_finish":
          state.steps++;
          if (typeof part.cost === "number") state.costUsd += part.cost;
          if (part.tokens) {
            state.tokens.input += (part.tokens.input ?? 0) + (part.tokens.cache?.read ?? 0);
            state.tokens.output += part.tokens.output ?? 0;
          }
          break;
        case "error":
          state.error = msg.error?.data?.message ?? msg.error?.message ?? msg.error?.name ?? "OpenCode error";
          break;
      }
    },
  };
}

/**
 * OpenCode adapter. Works with any provider configured in the user's OpenCode, including
 * free models and local ones (Ollama, LM Studio). The MCP server is injected through
 * OPENCODE_CONFIG_CONTENT, which OpenCode merges over the user's own config.
 */
export class OpenCodeProvider implements AgentProvider {
  id = "opencode";
  label = "OpenCode (any model, incl. local)";
  private modelCache?: ModelOption[];

  constructor(private bin = process.env.OE_OPENCODE_BIN || "opencode") {}

  async status(): Promise<ProviderStatus> {
    const version = await run(this.bin, ["--version"]);
    if (!version.ok) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        detail: "Not found. Install OpenCode (npm i -g opencode-ai) and run `opencode auth login`.",
        models: [],
        defaultModel: "",
      };
    }
    if (!this.modelCache) {
      const list = await run(this.bin, ["models"], 20_000);
      const ids = list.ok ? list.stdout.split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)) : [];
      // Free and local models first: they're why people pick OpenCode.
      const rank = (id: string) => (/free|ollama|lmstudio/i.test(id) ? 0 : 1);
      this.modelCache = ids.sort((a, b) => rank(a) - rank(b)).slice(0, 200).map((id) => ({ id, label: id }));
    }
    return { id: this.id, label: this.label, available: true, detail: `opencode ${version.stdout.trim()}`, models: this.modelCache, defaultModel: "" };
  }

  startTurn(req: TurnRequest): RunningTurn {
    const config = {
      $schema: "https://opencode.ai/config.json",
      mcp: { openeffects: { type: "local", command: [req.mcp.command, ...req.mcp.args], enabled: true, timeout: 300_000 } },
      permission: { edit: "allow", bash: "deny", webfetch: "deny" },
    };
    const args = ["run", "--format", "json", "--dir", req.cwd];
    if (req.model) args.push("-m", req.model);
    if (req.sessionId) args.push("--session", req.sessionId);
    // Instructions once per session; a leading space stops a prompt like "-fix" parsing as a flag.
    const message = req.sessionId ? req.prompt : `${AGENT_INSTRUCTIONS}\n\n${req.prompt}`;
    args.push(message.startsWith("-") ? ` ${message}` : message);

    const parser = createOpenCodeParser(req.onEvent);
    const started = Date.now();
    return runJsonlProcess({
      bin: this.bin,
      args,
      cwd: req.cwd,
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      onMessage: parser.onMessage,
      notFound: "OpenCode CLI not found (`opencode`).",
      finish: ({ code, stderr }) => {
        const ok = code === 0 && !parser.state.error && parser.state.steps > 0;
        return {
          ok,
          error: ok ? undefined : parser.state.error || stderrTail(stderr) || `opencode exited with code ${code}`,
          sessionId: parser.state.sessionId,
          durationMs: Date.now() - started,
          costUsd: parser.state.costUsd || undefined,
          tokens: parser.state.tokens,
        };
      },
    });
  }
}
