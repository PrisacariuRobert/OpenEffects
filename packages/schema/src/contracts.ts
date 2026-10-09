import type { Project } from "./schema.ts";

/*
 * Wire contracts between the OpenEffects server and its clients (web UI, future desktop
 * and mobile apps), in the spirit of T3 Code's packages/contracts.
 */

/** Provider-neutral agent events, the same idea as T3 Code's orchestration events. */
export type AgentEvent =
  | { type: "turn-start"; turnId: string; provider: string; model?: string; prompt: string; checkpointBefore?: string }
  | { type: "status"; turnId: string; text: string }
  | { type: "text"; turnId: string; text: string }
  | { type: "tool-call"; turnId: string; id: string; name: string; input: unknown }
  | { type: "tool-result"; turnId: string; id: string; ok: boolean; summary: string }
  | {
      type: "turn-end";
      turnId: string;
      ok: boolean;
      error?: string;
      costUsd?: number;
      durationMs?: number;
      tokens?: { input: number; output: number };
      checkpointBefore?: string;
      checkpointAfter?: string;
    };

export interface ModelOption {
  id: string;
  label: string;
}

export interface ProviderStatus {
  id: string;
  label: string;
  available: boolean;
  detail: string;
  /** Suggested models; users may also type any model id the CLI accepts. */
  models: ModelOption[];
  /** Model used when the user doesn't pick one ("" = the CLI's own default). */
  defaultModel: string;
}

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: number;
}

export type ExportState = { state: "progress" | "done" | "error"; progress?: number; url?: string; error?: string; warnings?: string[]; label?: string; files?: string[] };

/** One version in a variations run: the same prompt with its own creative direction. */
export interface Variation {
  index: number;
  direction: string;
  state: "working" | "done" | "failed";
  /** Latest progress line (tool being used…). */
  status?: string;
  error?: string;
  project?: Project;
  costUsd?: number;
  durationMs?: number;
}
export interface VariationsRun {
  id: string;
  prompt: string;
  provider: string;
  model?: string;
  items: Variation[];
  running: boolean;
}

/** Messages pushed to clients over the WebSocket at /ws. */
export type ServerMessage =
  | { type: "project"; project: Project | null; errors: string[] }
  | { type: "agent"; event: AgentEvent }
  | { type: "agent-state"; running: boolean; sessionId?: string }
  | { type: "agent-reset" }
  | { type: "checkpoints"; checkpoints: Checkpoint[] }
  | ({ type: "export" } & ExportState)
  | { type: "variations"; run: VariationsRun };

/** GET /api/state */
export interface StateResponse {
  file: string;
  project: Project | null;
  errors: string[];
  providers: ProviderStatus[];
  checkpoints: Checkpoint[];
  history: AgentEvent[];
  running: boolean;
  variations?: VariationsRun | null;
}
