import { useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  Checkpoint,
  ExportState,
  Project,
  ProviderStatus,
  ServerMessage,
  StateResponse,
} from "@openeffects/schema";

export async function api<T = unknown>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data as { error?: string }).error ?? res.statusText) as Error & { errors?: string[] };
    err.errors = (data as { errors?: string[] }).errors;
    throw err;
  }
  return data as T;
}

export interface ServerState {
  connected: boolean;
  file: string;
  /** Last valid project (kept while the file on disk is temporarily invalid). */
  project: Project | null;
  errors: string[];
  providers: ProviderStatus[];
  checkpoints: Checkpoint[];
  events: AgentEvent[];
  running: boolean;
  exportState: ExportState | null;
}

const initial: ServerState = {
  connected: false,
  file: "",
  project: null,
  errors: [],
  providers: [],
  checkpoints: [],
  events: [],
  running: false,
  exportState: null,
};

/** Loads /api/state, then keeps it live through the /ws push channel (reconnecting). */
export function useServer(): [ServerState, (fn: (s: ServerState) => ServerState) => void] {
  const [state, setState] = useState(initial);
  const retry = useRef(0);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      try {
        const s = await api<StateResponse>("/api/state");
        setState((prev) => ({
          ...prev,
          file: s.file,
          project: s.project ?? prev.project,
          errors: s.errors,
          providers: s.providers,
          checkpoints: s.checkpoints,
          events: s.history,
          running: s.running,
        }));
      } catch {
        timer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry.current++));
        return;
      }
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.onopen = () => {
        retry.current = 0;
        setState((s) => ({ ...s, connected: true }));
      };
      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!closed) timer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry.current++));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        setState((s) => reduce(s, msg));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return [state, setState];
}

function reduce(s: ServerState, msg: ServerMessage): ServerState {
  switch (msg.type) {
    case "project":
      return { ...s, project: msg.project ?? s.project, errors: msg.errors };
    case "agent":
      return { ...s, events: [...s.events, msg.event] };
    case "agent-state":
      return { ...s, running: msg.running };
    case "agent-reset":
      return { ...s, events: [] };
    case "checkpoints":
      return { ...s, checkpoints: msg.checkpoints };
    case "export": {
      const { type: _type, ...rest } = msg;
      return { ...s, exportState: rest };
    }
  }
}
