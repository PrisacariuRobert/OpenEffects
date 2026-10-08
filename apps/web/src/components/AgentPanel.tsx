import { useEffect, useRef, useState } from "react";
import type { AgentEvent, ProviderStatus } from "@openeffects/schema";
import { api } from "../api.ts";
import { Markdown } from "./Markdown.tsx";

export interface Selection {
  layerId: string;
  label: string;
  type: string;
  compId: string;
  time: number;
}

interface Props {
  events: AgentEvent[];
  running: boolean;
  providers: ProviderStatus[];
  selection: Selection | null;
  onError(message: string): void;
}

const LAYER_ASKS = ["Make it bouncier", "Animate it in nicely", "Animate it out at the end", "Add a soft glow", "Make it pop more", "Try a different color"];
const SCENE_ASKS = ["Polish the timing and easing", "Improve the color palette", "Add a subtle animated background", "Make the ending stronger"];

/** Prompts carry editor context as a first line; the chat shows it as a chip instead. */
const CONTEXT_RE = /^\[Editor context: ([^\]]*)\]\n\n/;
function withContext(prompt: string, sel: Selection | null): string {
  if (!sel) return prompt;
  return `[Editor context: the user selected layer "${sel.layerId}" (${sel.type}) in composition "${sel.compId}"; the playhead is at ${sel.time.toFixed(2)}s. Apply the request to that layer unless they say otherwise.]\n\n${prompt}`;
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

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode etc.)
  }
}

const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

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

export function AgentPanel({ events, running, providers, selection, onError }: Props) {
  const [prompt, setPrompt] = useState("");
  const [useSelection, setUseSelection] = useState(true);
  const sel = useSelection ? selection : null;
  useEffect(() => setUseSelection(true), [selection?.layerId]);
  const [provider, setProviderState] = useState(() => readPref("oe.provider") || "claude");
  const [models, setModels] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(readPref("oe.models") || "{}");
    } catch {
      return {};
    }
  });
  const setProvider = (id: string) => {
    setProviderState(id);
    writePref("oe.provider", id);
  };
  const setModel = (value: string) => {
    const next = { ...models, [provider]: value };
    setModels(next);
    writePref("oe.models", JSON.stringify(next));
  };
  const listRef = useRef<HTMLDivElement>(null);
  const status = providers.find((p) => p.id === provider);
  const model = models[provider] ?? status?.defaultModel ?? "";

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  const send = async (text = prompt) => {
    if (!text.trim() || running) return;
    try {
      await api("/api/agent/turn", { provider, prompt: withContext(text, sel), model: model || undefined });
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
        <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={running} title={status?.detail}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.available ? "" : " (not set up)"}
            </option>
          ))}
        </select>
        <input
          className="model"
          list={`models-${provider}`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="default model"
          disabled={running}
          title="Model id. Pick a suggestion or type any model your CLI supports."
        />
        <datalist id={`models-${provider}`}>
          {status?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </datalist>
        <span className={`dot ${status?.available ? "ok" : "bad"}`} title={status?.detail} />
        <button className="ghost small" disabled={running || events.length === 0} onClick={() => api("/api/agent/new", {}).catch((e) => onError(e.message))}>
          New chat
        </button>
      </div>
      {status && !status.available && <div className="setup-hint">{status.detail}</div>}

      <div className="agent-log" ref={listRef}>
        {turns.length === 0 && (
          <div className="empty">
            <p>Describe the animation you want. Your agent edits the project and you watch it update live.</p>
            {EXAMPLES.map((ex) => (
              <button key={ex} className="example" onClick={() => send(ex)} disabled={running || !status?.available}>
                {ex}
              </button>
            ))}
          </div>
        )}
        {turns.map((turn, i) => (
          <div className="turn" key={turn.start?.turnId ?? i}>
            {turn.start && (
              <div className="msg user">
                {CONTEXT_RE.test(turn.start.prompt) && <div className="ctx-chip in-msg">◎ {/"([^"]+)"/.exec(turn.start.prompt)?.[1] ?? "selection"}</div>}
                {turn.start.prompt.replace(CONTEXT_RE, "")}
              </div>
            )}
            {turn.start && (
              <div className="status-line right">
                {providers.find((p) => p.id === turn.start?.provider)?.label ?? turn.start.provider}
                {turn.start.model ? ` · ${turn.start.model}` : ""}
              </div>
            )}
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
                  {!turn.end.costUsd && turn.end.tokens ? ` · ${formatTokens(turn.end.tokens.input + turn.end.tokens.output)} tokens` : ""}
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

      <div className="quick-asks">
        {sel && (
          <span className="ctx-chip" title="Your request applies to this layer">
            ◎ {sel.label} · {sel.time.toFixed(2)}s
            <button className="tiny" onClick={() => setUseSelection(false)} title="Ask about the whole scene instead">
              ×
            </button>
          </span>
        )}
        {(sel ? LAYER_ASKS : SCENE_ASKS).map((q) => (
          <button key={q} className="quick" disabled={running || !status?.available} onClick={() => send(q)}>
            {q}
          </button>
        ))}
      </div>
      <div className="composer">
        <textarea
          value={prompt}
          placeholder={running ? "The agent is working…" : sel ? `Change ${sel.label}… (Enter to send)` : "Ask for an animation or a change… (Enter to send)"}
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
