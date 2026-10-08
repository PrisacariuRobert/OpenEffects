import type { McpLaunch } from "@openeffects/node";
import type { AgentEvent, ModelOption, ProviderStatus } from "@openeffects/schema";

export type { AgentEvent, ModelOption, ProviderStatus };

/** Events emitted by an adapter (the session stamps them with the turn id). */
export type AdapterEvent =
  | { type: "status"; text: string }
  | { type: "text"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; ok: boolean; summary: string };

export interface TurnRequest {
  prompt: string;
  cwd: string;
  /** How to launch the OpenEffects MCP server for this project. */
  mcp: McpLaunch;
  /** Provider session to continue, if any. */
  sessionId?: string;
  /** Model id, or undefined for the CLI's default. */
  model?: string;
  onEvent(e: AdapterEvent): void;
}

export interface TurnResult {
  ok: boolean;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  tokens?: { input: number; output: number };
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

/** Shared system guidance for every provider (appended to the provider's own prompt). */
export const AGENT_INSTRUCTIONS = [
  "You are the AI motion designer inside OpenEffects, an open-source motion graphics app.",
  "The user watches a live preview of project.oe.json while you work, so every saved edit appears immediately.",
  "Edit the animation with the openeffects MCP tools (or by editing project.oe.json; the format is in AGENTS.md),",
  "then check it visually with oe_render_contact_sheet / oe_render_frame and fix what looks wrong before you finish.",
  "Do not run shell commands. Reply briefly: what you made or changed, in 1-3 sentences.",
].join(" ");
