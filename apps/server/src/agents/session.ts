import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { McpLaunch } from "@openeffects/node";
import { Checkpoints } from "../checkpoints.ts";
import { ClaudeCodeProvider } from "./claude.ts";
import { CodexProvider } from "./codex.ts";
import { OpenCodeProvider } from "./opencode.ts";
import type { AgentEvent, AgentProvider, ProviderStatus, RunningTurn, TurnResult } from "./types.ts";

export function defaultProviders(): AgentProvider[] {
  return [new ClaudeCodeProvider(), new CodexProvider(), new OpenCodeProvider()];
}

export class AgentError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AgentSessionOptions {
  projectDir: string;
  mcp: McpLaunch;
  providers?: AgentProvider[];
  checkpoints?: Checkpoints;
  onEvent?(e: AgentEvent): void;
  onRunningChange?(running: boolean): void;
  onCheckpointsChange?(): void;
}

interface Saved {
  sessionId?: string;
  provider?: string;
  history: AgentEvent[];
}

/**
 * One conversation with an agent about one project: runs turns, takes a checkpoint before
 * and after each, and persists the conversation to .openeffects/session.json so it
 * survives restarts (and is shared by the editor and `oe ask`).
 */
export class AgentSession {
  readonly providers: AgentProvider[];
  readonly checkpoints: Checkpoints;
  history: AgentEvent[];
  private sessionId?: string;
  private sessionProvider?: string;
  private running?: { turn: RunningTurn; turnId: string };
  private statusCache?: { at: number; list: ProviderStatus[] };
  private file: string;

  constructor(private opts: AgentSessionOptions) {
    this.providers = opts.providers ?? defaultProviders();
    this.checkpoints = opts.checkpoints ?? new Checkpoints(opts.projectDir);
    this.file = path.join(opts.projectDir, ".openeffects", "session.json");
    const saved = this.load();
    this.history = saved.history;
    this.sessionId = saved.sessionId;
    this.sessionProvider = saved.provider;
    // Close turns cut off by a crash or restart, so clients don't spin forever.
    const open = new Set<string>();
    for (const e of this.history) {
      if (e.type === "turn-start") open.add(e.turnId);
      if (e.type === "turn-end") open.delete(e.turnId);
    }
    for (const turnId of open) this.history.push({ type: "turn-end", turnId, ok: false, error: "Interrupted" });
  }

  get isRunning(): boolean {
    return !!this.running;
  }

  async statuses(maxAgeMs = 30_000): Promise<ProviderStatus[]> {
    if (this.statusCache && Date.now() - this.statusCache.at < maxAgeMs) return this.statusCache.list;
    const list = await Promise.all(this.providers.map((p) => p.status()));
    this.statusCache = { at: Date.now(), list };
    return list;
  }

  /** Starts a turn. Resolves once it has started; `done` settles when the agent finishes. */
  async start(providerId: string, prompt: string, model?: string): Promise<{ turnId: string; done: Promise<TurnResult> }> {
    const provider = this.providers.find((p) => p.id === providerId);
    if (!provider) throw new AgentError(400, `Unknown provider "${providerId}"`);
    if (this.running) throw new AgentError(409, "The agent is already working");
    const status = (await this.statuses()).find((s) => s.id === providerId);
    if (status && !status.available) throw new AgentError(412, `${status.label}: ${status.detail}`);
    const chosenModel = model?.trim() || status?.defaultModel || undefined;

    // Provider sessions don't transfer: switching providers starts a fresh conversation.
    if (this.sessionProvider !== providerId) this.sessionId = undefined;
    const turnId = randomUUID();
    const before = await this.checkpoints.create(`Before: ${prompt}`);
    this.emit({ type: "turn-start", turnId, provider: provider.id, model: chosenModel, prompt, checkpointBefore: before?.id });

    const turn = provider.startTurn({
      prompt,
      cwd: this.opts.projectDir,
      mcp: this.opts.mcp,
      sessionId: this.sessionId,
      model: chosenModel,
      onEvent: (e) => this.emit({ ...e, turnId } as AgentEvent),
    });
    this.running = { turn, turnId };
    this.opts.onRunningChange?.(true);

    const done = turn.done.then(async (r) => {
      if (r.sessionId) {
        this.sessionId = r.sessionId;
        this.sessionProvider = providerId;
      }
      const after = await this.checkpoints.create(`After: ${prompt}`);
      this.running = undefined;
      this.emit({
        type: "turn-end",
        turnId,
        ok: r.ok,
        error: r.error,
        costUsd: r.costUsd,
        durationMs: r.durationMs,
        tokens: r.tokens,
        checkpointBefore: before?.id,
        checkpointAfter: after?.id,
      });
      this.save();
      this.opts.onRunningChange?.(false);
      this.opts.onCheckpointsChange?.();
      return r;
    });
    return { turnId, done };
  }

  stop(): void {
    this.running?.turn.stop();
  }

  reset(): void {
    if (this.running) throw new AgentError(409, "Stop the running turn first");
    this.sessionId = undefined;
    this.sessionProvider = undefined;
    this.history.length = 0;
    this.save();
  }

  private emit(e: AgentEvent): void {
    this.history.push(e);
    if (this.history.length > 2000) this.history.splice(0, this.history.length - 2000);
    this.opts.onEvent?.(e);
  }

  private load(): Saved {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
        provider: typeof data.provider === "string" ? data.provider : data.sessionId ? "claude" : undefined,
        history: Array.isArray(data.history) ? data.history : [],
      };
    } catch {
      return { history: [] };
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ sessionId: this.sessionId, provider: this.sessionProvider, history: this.history }));
    } catch {
      // best effort
    }
  }
}
