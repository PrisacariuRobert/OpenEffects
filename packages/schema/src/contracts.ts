import type { Project } from "./schema.ts";

/*
 * Wire contracts between the OpenEffects server and its clients (web UI, future desktop
 * and mobile apps), in the spirit of T3 Code's packages/contracts.
 */

/** Provider-neutral agent events, the same idea as T3 Code's orchestration events. */
export type AgentEvent =
  | { type: "turn-start"; turnId: string; provider: string; prompt: string; checkpointBefore?: string }
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
      checkpointBefore?: string;
      checkpointAfter?: string;
    };

export interface ProviderStatus {
  id: string;
  label: string;
  available: boolean;
  detail: string;
}

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: number;
}

export type ExportState = { state: "progress" | "done" | "error"; progress?: number; url?: string; error?: string };

/** Messages pushed to clients over the WebSocket at /ws. */
export type ServerMessage =
  | { type: "project"; project: Project | null; errors: string[] }
  | { type: "agent"; event: AgentEvent }
  | { type: "agent-state"; running: boolean; sessionId?: string }
  | { type: "agent-reset" }
  | { type: "checkpoints"; checkpoints: Checkpoint[] }
  | ({ type: "export" } & ExportState);

/** GET /api/state */
export interface StateResponse {
  file: string;
  project: Project | null;
  errors: string[];
  providers: ProviderStatus[];
  checkpoints: Checkpoint[];
  history: AgentEvent[];
  running: boolean;
}
