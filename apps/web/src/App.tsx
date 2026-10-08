import { useCallback, useEffect, useRef, useState } from "react";
import { getComp } from "@openeffects/schema";
import { api, useServer } from "./api.ts";
import { Viewport } from "./components/Viewport.tsx";
import { Timeline } from "./components/Timeline.tsx";
import { AgentPanel } from "./components/AgentPanel.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { History } from "./components/History.tsx";

type Tab = "agent" | "inspector" | "history";

export function App() {
  const [state] = useServer();
  const [compId, setCompId] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("agent");
  const [toast, setToast] = useState<string | null>(null);
  const project = state.project;
  const comp = project ? (project.compositions.find((c) => c.id === compId) ?? getComp(project)) : null;

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

  // Keyboard shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT" || !comp) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "Home") setTime(0);
      else if (e.key === "ArrowRight") setTime((t) => Math.min(comp.duration - 1 / comp.fps, t + (e.shiftKey ? 10 : 1) / comp.fps));
      else if (e.key === "ArrowLeft") setTime((t) => Math.max(0, t - (e.shiftKey ? 10 : 1) / comp.fps));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [comp]);

  const exportAs = async (format: string) => {
    try {
      await api("/api/export", { format, compId: comp?.id });
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const ex = state.exportState;
  const fileName = state.file.split(/[\\/]/).slice(-2).join("/");

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
              <Viewport project={project} comp={comp} time={time} errors={state.errors} />
              <Timeline
                comp={comp}
                time={time}
                playing={playing}
                selected={selected}
                onSeek={(t) => setTime(t)}
                onTogglePlay={() => setPlaying((p) => !p)}
                onSelect={(id) => {
                  setSelected(id);
                  if (id) setTab("inspector");
                }}
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
                {t === "agent" ? `Agent${state.running ? " •" : ""}` : t === "inspector" ? "Inspector" : "History"}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === "agent" && <AgentPanel events={state.events} running={state.running} providers={state.providers} onError={showToast} />}
            {tab === "inspector" && project && comp && <Inspector project={project} compId={comp.id} selected={selected} />}
            {tab === "history" && <History checkpoints={state.checkpoints} running={state.running} onError={showToast} />}
          </div>
        </aside>
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
