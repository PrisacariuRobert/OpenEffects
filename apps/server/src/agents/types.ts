import type { AgentEvent, ProviderStatus } from "@openeffects/schema";

export type { AgentEvent, ProviderStatus };

/** Events emitted by an adapter (the server stamps them with the turn id). */
export type AdapterEvent =
  | { type: "status"; text: string }
  | { type: "text"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; ok: boolean; summary: string };

export interface TurnRequest {
  prompt: string;
  cwd: string;
  /** Path to an MCP config JSON that registers the OpenEffects server. */
  mcpConfigPath: string;
  /** Provider session to continue, if any. */
  sessionId?: string;
  model?: string;
  onEvent(e: AdapterEvent): void;
}

export interface TurnResult {
  ok: boolean;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
}

export interface RunningTurn {
  stop(): void;
  done: Promise<TurnResult>;
}

/**
 * An agent provider wraps a CLI the user already has installed and logged in to.
 * OpenEffects never handles the user's credentials.
 */
export interface AgentProvider {
  id: string;
  label: string;
  status(): Promise<ProviderStatus>;
  startTurn(req: TurnRequest): RunningTurn;
}
