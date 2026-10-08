import { useCallback, useEffect, useRef, useState } from "react";
import { deleteLayer, duplicateLayer, editLayer, getComp, removeKeyframe } from "@openeffects/schema";
import { api, useServer } from "./api.ts";
import { useEditor } from "./editor.ts";
import { Viewport } from "./components/Viewport.tsx";
import { Timeline, type KeyframeRef } from "./components/Timeline.tsx";
import { AgentPanel } from "./components/AgentPanel.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { History } from "./components/History.tsx";
import { Templates } from "./components/Templates.tsx";

type Tab = "agent" | "inspector" | "history";

const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"],
  ["← / →", "Previous / next frame (Shift: 10 frames)"],
  ["Home", "Go to start"],
  ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo (includes the agent's edits)"],
  ["Del", "Delete the selected keyframe, or the selected layer"],
  ["Ctrl+D", "Duplicate the selected layer"],
  ["Esc", "Deselect"],
  ["Drag in viewer", "Move · corners scale · top handle rotates · Shift constrains/snaps · Alt disables center snapping"],
  ["Drag number labels", "Scrub values (Shift ×10, Alt ×0.1)"],
  ["◷ / ◆", "Animate a property / add or remove a keyframe at the playhead"],
  ["Drop images", "Onto the viewer to add them as layers"],
];

export function App() {
  const [state] = useServer();
  const editor = useEditor(state.project);
  const [compId, setCompId] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedKeyframe, setSelectedKeyframe] = useState<KeyframeRef | null>(null);
  const [tab, setTab] = useState<Tab>("agent");
  const [toast, setToast] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [assets, setAssets] = useState<string[]>([]);
  const project = editor.project;
  const comp = project ? (project.compositions.find((c) => c.id === compId) ?? getComp(project)) : null;

  // Drop selections that no longer exist (deleted by the agent, undo, …).
  useEffect(() => {
    if (selected && comp && !comp.layers.some((l) => l.id === selected)) setSelected(null);
  }, [comp, selected]);

  useEffect(() => {
    api<{ assets: string[] }>("/api/assets")
      .then((r) => setAssets(r.assets))
      .catch(() => {});
  }, [project]);

  // Playback loop.
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!playing || !comp) return;
    let raf = 0;
    const tick = (now: number) => {
      const dt = last.current === null ? 0 : (now - last.current) / 1000;
      last.current = now;
      setTime((t) => (t + dt) % comp.duration);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      last.current = null;
    };
  }, [playing, comp?.duration]);

  useEffect(() => {
    if (comp && time >= comp.duration) setTime(0);
  }, [comp?.duration]);

  const showToast = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => {
    if (editor.error) showToast(editor.error);
  }, [editor.error, showToast]);

  const select = (id: string | null) => {
    setSelected(id);
    if (!id || selectedKeyframe?.layerId !== id) setSelectedKeyframe(null);
  };

  // Keyboard shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        e.shiftKey ? editor.redo() : editor.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        editor.redo();
        return;
      }
      if (typing || !comp) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "Home") setTime(0);
      else if (e.key === "ArrowRight") setTime((t) => Math.min(comp.duration - 1 / comp.fps, t + (e.shiftKey ? 10 : 1) / comp.fps));
      else if (e.key === "ArrowLeft") setTime((t) => Math.max(0, t - (e.shiftKey ? 10 : 1) / comp.fps));
      else if (e.key === "Escape") {
        setSelected(null);
        setSelectedKeyframe(null);
        setShowHelp(false);
      } else if (e.key === "?") setShowHelp((v) => !v);
      else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedKeyframe) {
          const k = selectedKeyframe;
          editor.update((p) => editLayer(p, k.layerId, (l) => removeKeyframe(l, k.path, k.index), { compId: comp.id }));
          setSelectedKeyframe(null);
        } else if (selected) {
          editor.update((p) => deleteLayer(p, selected, { compId: comp.id }));
          setSelected(null);
        }
      } else if (mod && e.key.toLowerCase() === "d" && selected) {
        e.preventDefault();
        editor.update((p) => {
          const r = duplicateLayer(p, selected, { compId: comp.id });
          setTimeout(() => setSelected(r.id));
          return r.project;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [comp, editor, selected, selectedKeyframe]);

  const exportAs = async (format: string) => {
    try {
      await api("/api/export", { format, compId: comp?.id });
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const ex = state.exportState;
  const fileName = state.file.split(/[\\/]/).slice(-2).join("/");
  const selLayer = selected && comp ? comp.layers.find((l) => l.id === selected) : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" /> OpenEffects
        </div>
        <span className="muted small file" title={state.file}>
          {project?.name ?? fileName}
        </span>
        {project && project.compositions.length > 1 && (
          <select value={comp?.id} onChange={(e) => setCompId(e.target.value)}>
            {project.compositions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name ?? c.id}
              </option>
            ))}
          </select>
        )}
        <div className="seg">
          <button onClick={editor.undo} disabled={!editor.canUndo} title="Undo (Ctrl+Z)">
            ↶
          </button>
          <button onClick={editor.redo} disabled={!editor.canRedo} title="Redo (Ctrl+Shift+Z)">
            ↷
          </button>
        </div>
        <button className="ghost small" onClick={() => setShowTemplates(true)}>
          Templates
        </button>
        <button className="ghost small" onClick={() => setShowHelp(true)} title="Keyboard shortcuts (?)">
          ?
        </button>
        <div className="grow" />
        {!state.connected && <span className="pill warn">reconnecting…</span>}
        {ex?.state === "progress" && <span className="pill">Exporting {ex.progress ?? 0}%</span>}
        {ex?.state === "done" && ex.url && (
          <a className="pill ok" href={ex.url} target="_blank" rel="noreferrer">
            Export ready ↗
          </a>
        )}
        {ex?.state === "error" && <span className="pill bad" title={ex.error}>Export failed</span>}
        <div className="export">
          <span className="muted small">Export</span>
          {["mp4", "gif", "webm", "mov"].map((f) => (
            <button key={f} className="ghost small" disabled={!project || ex?.state === "progress"} onClick={() => exportAs(f)}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      <main className="main">
        <section className="stage-col">
          {project && comp ? (
            <>
              <Viewport
                editor={editor}
                project={project}
                comp={comp}
                time={time}
                errors={state.errors}
                selected={selected}
                onSelect={(id) => {
                  select(id);
                  if (id && tab === "history") setTab("inspector");
                }}
                onEditText={() => setTab("inspector")}
                onError={showToast}
              />
              <Timeline
                editor={editor}
                project={project}
                comp={comp}
                time={time}
                playing={playing}
                selected={selected}
                selectedKeyframe={selectedKeyframe}
                assets={assets}
                onSeek={(t) => setTime(t)}
                onTogglePlay={() => setPlaying((p) => !p)}
                onSelect={select}
                onSelectKeyframe={setSelectedKeyframe}
              />
            </>
          ) : (
            <div className="viewport">
              <div className="empty muted">
                {state.errors.length ? (
                  <>
                    <p>project.oe.json has errors:</p>
                    <ul>{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>
                  </>
                ) : (
                  "Loading project…"
                )}
              </div>
            </div>
          )}
        </section>

        <aside className="side">
          <nav className="tabs">
            {(["agent", "inspector", "history"] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                {t === "agent" ? `Agent${state.running ? " •" : ""}` : t === "inspector" ? "Properties" : "History"}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === "agent" && (
              <AgentPanel
                events={state.events}
                running={state.running}
                providers={state.providers}
                selection={selLayer && comp ? { layerId: selLayer.id, label: selLayer.name ?? selLayer.id, type: selLayer.type, compId: comp.id, time } : null}
                onError={showToast}
              />
            )}
            {tab === "inspector" && project && comp && (
              <Inspector editor={editor} project={project} compId={comp.id} selected={selected} time={time} onSeek={setTime} onSelect={select} />
            )}
            {tab === "history" && <History checkpoints={state.checkpoints} running={state.running} onError={showToast} />}
          </div>
        </aside>
      </main>

      {showTemplates && (
        <Templates
          onClose={() => setShowTemplates(false)}
          onUse={(tpl) => {
            editor.update(() => ({ ...tpl, name: project?.name ?? tpl.name }));
            setSelected(null);
            setTime(0);
            setShowTemplates(false);
          }}
        />
      )}
      {showHelp && (
        <div className="modal-backdrop" onClick={() => setShowHelp(false)}>
          <div className="modal narrow" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong className="grow">Shortcuts & tips</strong>
              <button className="ghost small" onClick={() => setShowHelp(false)}>
                ✕
              </button>
            </div>
            <table className="shortcuts">
              <tbody>
                {SHORTCUTS.map(([k, v]) => (
                  <tr key={k}>
                    <td>
                      <kbd>{k}</kbd>
                    </td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
