import type { Checkpoint } from "@openeffects/schema";
import { api } from "../api.ts";

interface Props {
  checkpoints: Checkpoint[];
  running: boolean;
  onError(message: string): void;
}

/** Per-turn snapshots stored as hidden git refs; restoring is itself undoable. */
export function History({ checkpoints, running, onError }: Props) {
  if (checkpoints.length === 0) {
    return <div className="empty muted">Checkpoints appear here before and after every agent turn.</div>;
  }
  return (
    <ul className="history">
      {checkpoints.map((c) => (
        <li key={c.id}>
          <div className="grow">
            <div className="history-label">{c.label}</div>
            <div className="muted small">{new Date(c.createdAt).toLocaleString()}</div>
          </div>
          <button
            className="ghost small"
            disabled={running}
            onClick={() => api("/api/checkpoints/restore", { id: c.id }).catch((e) => onError(e.message))}
          >
            Restore
          </button>
        </li>
      ))}
    </ul>
  );
}
