import { useEffect, useRef, useState } from "react";
import type { AgentEvent, ProviderStatus } from "@openeffects/schema";
import { api } from "../api.ts";
import { Markdown } from "./Markdown.tsx";

interface Props {
  events: AgentEvent[];
  running: boolean;
  providers: ProviderStatus[];
  onError(message: string): void;
}

const EXAMPLES = [
  "Make a 5-second logo reveal for “Nebula” with a glowing ring that draws on",
  "Kinetic typography: “Ship faster. Sleep better.” word by word, bold and punchy",
  "A lower third for “Ana Ruiz, Product Designer” that slides in and out",
  "Make the background a slow-moving purple-to-blue gradient",
];

function toolLabel(name: string): string {
  const short = name.replace(/^mcp__openeffects__/, "").replace(/^oe_/, "");
  return short.replace(/_/g, " ");
}

function toolDetail(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const layer = o.layer as Record<string, unknown> | undefined;
  const parts = [layer?.id ?? o.id ?? o.layerId, o.property, o.time !== undefined ? `t=${o.time}s` : undefined, o.file_path];
  return parts.filter(Boolean).map(String).join(" · ");
}

type Turn = { start?: Extract<AgentEvent, { type: "turn-start" }>; items: AgentEvent[]; end?: Extract<AgentEvent, { type: "turn-end" }> };

function groupTurns(events: AgentEvent[]): Turn[] {
  const turns = new Map<string, Turn>();
  for (const e of events) {
    const t = turns.get(e.turnId) ?? { items: [] };
    if (e.type === "turn-start") t.start = e;
    else if (e.type === "turn-end") t.end = e;
    else t.items.push(e);
    turns.set(e.turnId, t);
  }
  return [...turns.values()];
}

export function AgentPanel({ events, running, providers, onError }: Props) {
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState("claude");
  const listRef = useRef<HTMLDivElement>(null);
  const status = providers.find((p) => p.id === provider);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  const send = async (text = prompt) => {
    if (!text.trim() || running) return;
    try {
      await api("/api/agent/turn", { provider, prompt: text });
      setPrompt("");
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const undo = async (checkpoint?: string) => {
    if (!checkpoint) return;
    try {
      await api("/api/checkpoints/restore", { id: checkpoint });
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const results = new Map<string, Extract<AgentEvent, { type: "tool-result" }>>();
  for (const e of events) if (e.type === "tool-result") results.set(e.id, e);
  const turns = groupTurns(events);

  return (
    <div className="agent">
      <div className="agent-head">
        <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={running}>
          {providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.available}>
              {p.label}
            </option>
          ))}
          <option disabled>Codex (coming soon)</option>
          <option disabled>OpenCode (coming soon)</option>
        </select>
        <span className={`dot ${status?.available ? "ok" : "bad"}`} title={status?.detail} />
        <span className="muted small grow">{status ? (status.available ? status.detail : "not installed") : "…"}</span>
        <button className="ghost small" disabled={running || events.length === 0} onClick={() => api("/api/agent/new", {}).catch((e) => onError(e.message))}>
          New chat
        </button>
      </div>

      <div className="agent-log" ref={listRef}>
        {turns.length === 0 && (
          <div className="empty">
            <p>Describe the animation you want. Your agent edits the project and you watch it update live.</p>
            {EXAMPLES.map((ex) => (
              <button key={ex} className="example" onClick={() => send(ex)} disabled={running || !status?.available}>
                {ex}
              </button>
            ))}
            {status && !status.available && <p className="warn">{status.detail}</p>}
          </div>
        )}
        {turns.map((turn, i) => (
          <div className="turn" key={turn.start?.turnId ?? i}>
            {turn.start && <div className="msg user">{turn.start.prompt}</div>}
            {turn.items.map((e, j) => {
              if (e.type === "text")
                return (
                  <div key={j} className="msg assistant">
                    <Markdown text={e.text} />
                  </div>
                );
              if (e.type === "status") return <div key={j} className="status-line">{e.text}</div>;
              if (e.type === "tool-call") {
                const r = results.get(e.id);
                return (
                  <div key={j} className={`tool ${r ? (r.ok ? "ok" : "err") : "pending"}`} title={r?.summary}>
                    <span className="tool-name">{toolLabel(e.name)}</span>
                    <span className="tool-detail">{toolDetail(e.input)}</span>
                    {r && !r.ok && <div className="tool-error">{r.summary}</div>}
                  </div>
                );
              }
              return null;
            })}
            {turn.end ? (
              <div className={`turn-end ${turn.end.ok ? "" : "failed"}`}>
                <span>
                  {turn.end.ok ? "Done" : turn.end.error === "Stopped" ? "Stopped" : `Failed: ${turn.end.error}`}
                  {turn.end.durationMs ? ` · ${(turn.end.durationMs / 1000).toFixed(0)}s` : ""}
                  {turn.end.costUsd ? ` · $${turn.end.costUsd.toFixed(3)}` : ""}
                </span>
                {turn.end.checkpointBefore && (
                  <button className="ghost small" onClick={() => undo(turn.end?.checkpointBefore)} disabled={running} title="Restore the project to how it was before this turn">
                    ↶ Undo turn
                  </button>
                )}
              </div>
            ) : (
              <div className="working">
                <span className="spinner" /> Working…
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="composer">
        <textarea
          value={prompt}
          placeholder={running ? "The agent is working…" : "Ask for an animation or a change… (Enter to send)"}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={3}
        />
        {running ? (
          <button className="danger" onClick={() => api("/api/agent/stop", {})}>
            Stop
          </button>
        ) : (
          <button className="primary" onClick={() => send()} disabled={!prompt.trim() || !status?.available}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
