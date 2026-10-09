import { useEffect, useRef, useState } from "react";
import type { AgentEvent, CompDiff, ProviderStatus } from "@openeffects/schema";
import { IconArrowUp, IconAttach, IconChevronRight, IconClose, IconGrid, IconSparkles, IconStop } from "./Icons.tsx";
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
  /** Variations are being made (the agent is busy). */
  busy?: boolean;
  /** What the latest turn changed, for review. */
  review?: Review | null;
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
  { title: "Logo reveal", prompt: "Make a 5-second logo reveal for “Nebula” with a glowing ring that draws on" },
  { title: "Kinetic type", prompt: "Kinetic typography: “Ship faster. Sleep better.” word by word, bold and punchy" },
  { title: "Lower third", prompt: "A lower third for “Ana Ruiz, Product Designer” that slides in and out" },
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

/** Starts an agent turn with the provider and model last picked in the agent panel. */
export async function askAgent(prompt: string): Promise<void> {
  const provider = readPref("oe.provider") || "claude";
  let model: string | undefined;
  try {
    model = (JSON.parse(readPref("oe.models") || "{}") as Record<string, string>)[provider] || undefined;
  } catch {
    model = undefined;
  }
  await api("/api/agent/turn", { provider, prompt, model });
}

export interface Review {
  turnId: string;
  changes: CompDiff[];
  onRevert(compId: string, layerId: string): void;
  onDismiss(): void;
}

const PROP_NAMES: Record<string, string> = { "transform.position": "position", "transform.scale": "scale", "transform.rotation": "rotation", "transform.opacity": "opacity", "transform.anchor": "anchor" };

function ReviewCard({ review }: { review: Review }) {
  const total = review.changes.reduce((n, c) => n + c.layers.length + (c.settings.length ? 1 : 0), 0);
  if (!total) return null;
  return (
    <div className="review">
      <div className="review-head">
        <strong>Review changes</strong>
        <span className="muted small">{total} change{total === 1 ? "" : "s"}</span>
        <button className="ghost small" onClick={review.onDismiss}>
          Keep all
        </button>
      </div>
      {review.changes.map((c) => (
        <div key={c.compId}>
          {review.changes.length > 1 && <div className="muted small review-comp">{c.compId}</div>}
          {c.settings.length > 0 && <div className="review-row"><span className="review-kind changed">~</span><span className="grow">Composition: {c.settings.join(", ")}</span></div>}
          {c.layers.map((l) => (
            <div key={l.id} className="review-row">
              <span className={`review-kind ${l.kind}`}>{l.kind === "added" ? "+" : l.kind === "removed" ? "−" : "~"}</span>
              <span className="grow">
                <b>{l.id}</b>
                {l.props.length > 0 && <span className="muted"> · {l.props.map((p) => PROP_NAMES[p] ?? p).join(", ")}</span>}
              </span>
              <button className="ghost small" title={l.kind === "added" ? "Remove this layer" : "Put this layer back as it was"} onClick={() => review.onRevert(c.compId, l.id)}>
                Revert
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function AgentPanel({ events, running, providers, selection, busy = false, review = null, onError }: Props) {
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

  /** An attached image or clip to take after (prefixed to the next request). */
  const [reference, setReference] = useState<{ name: string; prompt: string; frames: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const withReference = (text: string) => (reference ? `${reference.prompt}\n\n${text}` : text);
  const attach = async (file: File) => {
    setUploading(true);
    try {
      const r = await fetch(`/api/reference?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
      const d = (await r.json()) as { prompt?: string; frames?: number; error?: string };
      if (!r.ok || !d.prompt) throw new Error(d.error ?? "Couldn't attach that file");
      setReference({ name: file.name, prompt: d.prompt, frames: d.frames ?? 1 });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const pickReference = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,video/*";
    input.onchange = () => input.files?.[0] && attach(input.files[0]);
    input.click();
  };

  const send = async (text = prompt) => {
    if (!text.trim() || running) return;
    try {
      await api("/api/agent/turn", { provider, prompt: withContext(withReference(text), sel), model: model || undefined });
      setPrompt("");
      setReference(null);
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
          <div className="agent-empty">
            <div className="agent-empty-icon">
              <IconSparkles size={22} />
            </div>
            <h3>What should we make?</h3>
            <p>Describe an animation. Your agent builds it here, and every change stays editable.</p>
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button key={ex.title} className="example" onClick={() => send(ex.prompt)} disabled={running || !status?.available} title={ex.prompt}>
                  <span className="example-title">{ex.title}</span>
                  <span className="example-prompt">{ex.prompt}</span>
                  <IconChevronRight size={14} />
                </button>
              ))}
            </div>
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
            ) : null}
            {turn.end && review && review.turnId === turn.end.turnId && <ReviewCard review={review} />}
            {!turn.end && (
              <div className="working">
                <span className="spinner" /> Working…
              </div>
            )}
          </div>
        ))}
      </div>

      <div className={`quick-asks ${turns.length === 0 && !sel ? "hidden" : ""}`}>
        {sel && (
          <span className="ctx-chip" title="Your request applies to this layer">
            ◎ {sel.label} · {sel.time.toFixed(2)}s
            <button className="tiny" onClick={() => setUseSelection(false)} title="Ask about the whole scene instead">
              ×
            </button>
          </span>
        )}
        {(sel ? LAYER_ASKS : SCENE_ASKS).slice(0, 3).map((q) => (
          <button key={q} className="quick" disabled={running || !status?.available} onClick={() => send(q)}>
            {q}
          </button>
        ))}
      </div>
      <div
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const f = [...e.dataTransfer.files].find((x) => /^(image|video)\//.test(x.type));
          if (f) {
            e.preventDefault();
            attach(f);
          }
        }}
      >
        {(reference || uploading) && (
          <div className="ref-chip">
            <IconAttach size={13} />
            <span>{uploading ? "Reading reference…" : `Reference: ${reference!.name}${reference!.frames > 1 ? ` · ${reference!.frames} frames` : ""}`}</span>
            {reference && (
              <button className="icon-only" aria-label="Remove reference" onClick={() => setReference(null)}>
                <IconClose size={12} />
              </button>
            )}
          </div>
        )}
        <div className="composer-box">
        <button className="icon-only" title="Attach a reference image or clip to take after" aria-label="Attach a reference" disabled={running || uploading} onClick={pickReference}>
          <IconAttach size={16} />
        </button>
        <textarea
          value={prompt}
          placeholder={running ? "The agent is working…" : sel ? `Change ${sel.label}…` : "Describe an animation or a change…"}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
        />
        {!running && (
          <button
            className="icon-only versions-btn"
            disabled={!prompt.trim() || !status?.available || busy}
            title="Make 4 versions with different creative directions, then pick one"
            aria-label="Make 4 versions"
            onClick={async () => {
              try {
                await api("/api/variations", { provider, prompt: withContext(withReference(prompt), sel), model: model || undefined, count: 4 });
                setPrompt("");
                setReference(null);
              } catch (e) {
                onError((e as Error).message);
              }
            }}
          >
            <IconGrid size={16} />
          </button>
        )}
        {running ? (
          <button className="send-btn stop" onClick={() => api("/api/agent/stop", {})} title="Stop" aria-label="Stop">
            <IconStop size={14} />
          </button>
        ) : (
          <button className="send-btn" onClick={() => send()} disabled={!prompt.trim() || !status?.available} title="Send (Enter)" aria-label="Send">
            <IconArrowUp size={16} />
          </button>
        )}
        </div>
      </div>
    </div>
  );
}
