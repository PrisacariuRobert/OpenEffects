import { useCallback, useEffect, useRef, useState } from "react";
import { deleteLayer, duplicateLayer, editLayer, getComp, getIn, insertKeyframes, removeKeyframe, updateComposition, type Keyframe } from "@openeffects/schema";
import { api, useServer } from "./api.ts";
import { useEditor } from "./editor.ts";
import { Viewport } from "./components/Viewport.tsx";
import { Timeline, type KeyframeRef } from "./components/Timeline.tsx";
import { AgentPanel } from "./components/AgentPanel.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { History } from "./components/History.tsx";
import { Templates } from "./components/Templates.tsx";
import { Tour, Welcome, type TourStep } from "./components/Tour.tsx";
import { useMediaPlayback } from "./mediaPlayback.ts";
import { importLottie, pickLottieFile } from "./lottieImport.ts";
import { useDismiss } from "./useDismiss.ts";
import { IconChevronDown, IconClock, IconClose, IconExport, IconGrid, IconHelp, IconImport, IconRedo, IconSliders, IconSparkles, IconUndo } from "./components/Icons.tsx";

const EXPORTS: { format: string; label: string; hint: string }[] = [
  { format: "mp4", label: "MP4 video", hint: "H.264 + AAC · plays everywhere" },
  { format: "mov", label: "MOV (ProRes 4444)", hint: "Transparent · for editors" },
  { format: "webm", label: "WebM", hint: "Transparent · for the web" },
  { format: "gif", label: "GIF", hint: "For chats and docs" },
  { format: "lottie", label: "Lottie JSON", hint: "Vector · websites and apps" },
];

const WELCOMED_KEY = "oe.welcomed";
const readFlag = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return true; // storage blocked: don't nag on every load
  }
};
const writeFlag = (k: string) => {
  try {
    localStorage.setItem(k, "1");
  } catch {
    // ignore
  }
};

type Tab = "agent" | "inspector" | "history";

const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"],
  ["← / →", "Previous / next frame (Shift: 10 frames)"],
  ["Home", "Go to start"],
  ["Ctrl+Z / Ctrl+Shift+Z", "Undo / redo (includes the agent's edits)"],
  ["Del", "Delete the selected keyframes, or the selected layer"],
  ["Shift+click keyframes", "Select several keyframes (then set easing or delete them together)"],
  ["Ctrl+C / Ctrl+V", "Copy keyframes / paste them at the playhead onto the selected layer"],
  ["M", "Add a marker at the playhead (drag markers to move, double-click to rename, Alt+click to delete)"],
  ["[ / ]", "Jump to the previous / next marker"],
  ["B / N", "Set the preview loop start / end at the playhead (double-click the range to clear)"],
  ["∿ Graph", "Value curves: drag keyframes and bezier handles to shape the motion"],
  ["Ctrl+D", "Duplicate the selected layer"],
  ["Esc", "Deselect"],
  ["Drag in viewer", "Move · corners scale · top handle rotates · Shift constrains/snaps · Alt disables center snapping"],
  ["Drag number labels", "Scrub values (Shift ×10, Alt ×0.1)"],
  ["◷ / ◆", "Animate a property / add or remove a keyframe at the playhead"],
  ["Drop media", "Images, video or audio onto the viewer to add them as layers"],
];

export function App() {
  const [state] = useServer();
  const editor = useEditor(state.project);
  const [compId, setCompId] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedKeyframes, setSelectedKeyframes] = useState<KeyframeRef[]>([]);
  const [workArea, setWorkArea] = useState<{ start: number; end: number } | null>(null);
  const clipboard = useRef<{ path: string; dt: number; kf: Keyframe<unknown> }[]>([]);
  const [tab, setTab] = useState<Tab>("agent");
  const [toast, setToast] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showWelcome, setShowWelcome] = useState(() => !readFlag(WELCOMED_KEY));
  const [touring, setTouring] = useState(false);
  const [assets, setAssets] = useState<{ src: string; kind: "image" | "video" | "audio" }[]>([]);
  const [muted, setMuted] = useState(false);
  const project = editor.project;
  const comp = project ? (project.compositions.find((c) => c.id === compId) ?? getComp(project)) : null;

  // Drop selections that no longer exist (deleted by the agent, undo, …).
  useEffect(() => {
    if (selected && comp && !comp.layers.some((l) => l.id === selected)) setSelected(null);
  }, [comp, selected]);

  useEffect(() => {
    api<{ assets: { src: string; kind: "image" | "video" | "audio" }[] }>("/api/assets")
      .then((r) => setAssets(r.assets))
      .catch(() => {});
  }, [project]);

  useMediaPlayback(comp, time, playing, muted);

  // Playback loop.
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!playing || !comp) return;
    let raf = 0;
    const tick = (now: number) => {
      const dt = last.current === null ? 0 : (now - last.current) / 1000;
      last.current = now;
      setTime((t) => {
        // Loop inside the preview range when one is set.
        const a = workArea?.start ?? 0;
        const b = workArea?.end ?? comp.duration;
        const next = t + dt;
        return next >= b || next < a ? a + ((next - a) % (b - a) + (b - a)) % (b - a) : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      last.current = null;
    };
  }, [playing, comp?.duration, workArea]);

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
    setSelectedKeyframes((ks) => (id ? ks.filter((k) => k.layerId === id) : []));
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
      if (mod && e.key.toLowerCase() === "c" && selectedKeyframes.length) {
        // Copy keyframes with their timing relative to the earliest one.
        const items = selectedKeyframes
          .map((ref) => {
            const l = comp.layers.find((x) => x.id === ref.layerId);
            const kf = l ? (getIn(l, ref.path) as { keyframes?: Keyframe<unknown>[] })?.keyframes?.[ref.index] : undefined;
            return kf ? { path: ref.path, kf } : null;
          })
          .filter((x): x is { path: string; kf: Keyframe<unknown> } => x !== null);
        const t0 = Math.min(...items.map((i) => i.kf.t));
        clipboard.current = items.map((i) => ({ path: i.path, dt: i.kf.t - t0, kf: i.kf }));
        showToast(`Copied ${items.length} keyframe${items.length > 1 ? "s" : ""}`);
        return;
      }
      if (mod && e.key.toLowerCase() === "v" && clipboard.current.length) {
        if (!selected) return showToast("Select a layer to paste keyframes onto");
        const byPath = new Map<string, Keyframe<unknown>[]>();
        for (const c of clipboard.current) byPath.set(c.path, [...(byPath.get(c.path) ?? []), { ...c.kf, t: time + c.dt }]);
        editor.update((p) =>
          editLayer(p, selected, (l) => [...byPath].reduce((acc, [path, kfs]) => insertKeyframes(acc, path, kfs, comp.fps), l), { compId: comp.id }),
        );
        return;
      }
      if (!mod && (e.key === "m" || e.key === "M")) {
        const t = Math.round(time * 1000) / 1000;
        const ms = (comp.markers ?? []).filter((m) => Math.abs(m.t - t) > 1e-3);
        editor.update((p) => updateComposition(p, { markers: [...ms, { t }].sort((a, b) => a.t - b.t) }, { compId: comp.id }));
        return;
      }
      if (e.key === "[" || e.key === "]") {
        const ms = comp.markers ?? [];
        const m = e.key === "[" ? [...ms].reverse().find((x) => x.t < time - 1e-3) : ms.find((x) => x.t > time + 1e-3);
        if (m) setTime(m.t);
        return;
      }
      if (e.key === "b" || e.key === "B") return setWorkArea((w) => ({ start: Math.min(time, (w?.end ?? comp.duration) - 2 / comp.fps), end: w?.end ?? comp.duration }));
      if (e.key === "n" || e.key === "N") return setWorkArea((w) => ({ start: w?.start ?? 0, end: Math.max(time + 1 / comp.fps, (w?.start ?? 0) + 2 / comp.fps) }));
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "Home") setTime(0);
      else if (e.key === "ArrowRight") setTime((t) => Math.min(comp.duration - 1 / comp.fps, t + (e.shiftKey ? 10 : 1) / comp.fps));
      else if (e.key === "ArrowLeft") setTime((t) => Math.max(0, t - (e.shiftKey ? 10 : 1) / comp.fps));
      else if (e.key === "Escape") {
        setSelected(null);
        setSelectedKeyframes([]);
        setShowHelp(false);
      } else if (e.key === "?") setShowHelp((v) => !v);
      else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedKeyframes.length) {
          const sorted = [...selectedKeyframes].sort((a, b) => b.index - a.index);
          editor.update((p) => sorted.reduce((acc, k) => editLayer(acc, k.layerId, (l) => removeKeyframe(l, k.path, k.index), { compId: comp.id }), p));
          setSelectedKeyframes([]);
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
  }, [comp, editor, selected, selectedKeyframes, time, showToast]);

  const [exportMenu, setExportMenu] = useState(false);
  const closeExportMenu = useCallback(() => setExportMenu(false), []);
  const exportMenuRef = useDismiss<HTMLDivElement>(exportMenu, closeExportMenu);
  const exportAs = async (format: string) => {
    setExportMenu(false);
    try {
      await api("/api/export", { format, compId: comp?.id });
    } catch (e) {
      showToast((e as Error).message);
    }
  };
  // Lottie exports report what couldn't be carried over.
  const lastExport = useRef<string | undefined>(undefined);
  useEffect(() => {
    const ex = state.exportState;
    if (ex?.state === "done" && ex.url !== lastExport.current) {
      lastExport.current = ex.url;
      if (ex.warnings?.length) showToast(`Lottie exported. Note: ${ex.warnings.join(" · ")}`);
    }
  }, [state.exportState, showToast]);

  const importLottieFile = async (file: File | null) => {
    if (!file || !comp) return;
    try {
      const r = await importLottie(file, editor, comp.id, time);
      select(r.layerId);
      showToast(r.warnings.length ? `Imported ${file.name}. Approximated: ${r.warnings.join(" · ")}` : `Imported ${file.name} as an editable layer`);
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const closeWelcome = () => {
    writeFlag(WELCOMED_KEY);
    setShowWelcome(false);
  };
  const topLayer = comp?.layers[comp.layers.length - 1];
  const tourSteps: TourStep[] = [
    {
      target: ".stage-wrap",
      title: "Your canvas",
      body: "Click a layer to select it. Drag to move it, drag a corner to scale, the top handle to rotate. Shift snaps; layers snap to the center lines. Drop images here to add them.",
    },
    {
      target: ".side",
      title: "Your AI motion designer",
      body: "Describe what you want and your own agent (Claude Code, Codex or OpenCode) builds it while you watch. Pick the model up top; Haiku 5.5 makes animations for about a cent. With a layer selected, requests apply only to it.",
      before: () => setTab("agent"),
    },
    {
      target: ".timeline",
      title: "Timeline",
      body: "Every layer and keyframe. Drag bars to move or trim layers, twirl ▸ to see keyframes, drag them to retime, Shift-click to select several. B / N set a preview loop.",
      before: () => setTab("agent"),
    },
    {
      target: ".graph-toggle",
      title: "Graph editor",
      body: "See the motion as curves. Drag keyframes and bezier handles to shape the easing; click the curve in the keyframe bar for presets like Overshoot, Spring and Bounce.",
    },
    {
      target: ".side",
      title: "Fine-tune everything",
      body: "Properties has one-click Animate presets, ◷ to keyframe any property, and Behaviors for endless motion: wiggle, oscillate, spin, loop and follow, with no keyframes needed.",
      before: () => {
        if (!selected && topLayer) setSelected(topLayer.id);
        setTab("inspector");
      },
    },
    {
      target: ".view-tools",
      title: "Viewer tools",
      body: "Show the motion path of the selected layer, title/action-safe guides, and align layers to the frame.",
    },
    {
      target: ".tour-templates",
      title: "Templates",
      body: "Start from a ready-made animation and ask the agent to make it yours: “change the text to …, use our brand colors”.",
    },
    {
      target: ".export-btn",
      title: "Export",
      body: "MP4 for sharing, GIF for docs and chat, WebM or ProRes MOV with transparency for video editors.",
    },
    {
      target: ".help-btn",
      title: "You're set",
      body: "Ctrl+Z undoes anything, including the agent's edits. Press ? for all shortcuts; you can replay this tour from there.",
    },
  ];

  const ex = state.exportState;
  const fileName = state.file.split(/[\\/]/).slice(-2).join("/");
  const selLayer = selected && comp ? comp.layers.find((l) => l.id === selected) : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" />
          <span className="brand-name">OpenEffects</span>
        </div>
        <span className="topbar-divider" />
        <span className="file" title={state.file}>
          {project?.name ?? fileName}
        </span>
        {project && project.compositions.length > 1 && (
          <select className="comp-select" value={comp?.id} onChange={(e) => setCompId(e.target.value)} title="Composition">
            {project.compositions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name ?? c.id}
              </option>
            ))}
          </select>
        )}
        <div className="grow" />
        <div className="toolbar-group">
          <button className="icon-only" onClick={editor.undo} disabled={!editor.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
            <IconUndo />
          </button>
          <button className="icon-only" onClick={editor.redo} disabled={!editor.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
            <IconRedo />
          </button>
        </div>
        <div className="grow" />
        {!state.connected && <span className="pill warn">Reconnecting…</span>}
        {ex?.state === "progress" && (
          <span className="pill progress" style={{ ["--p" as string]: `${ex.progress ?? 0}%` }}>
            Exporting {ex.progress ?? 0}%
          </span>
        )}
        {ex?.state === "done" && ex.url && (
          <a className="pill ok" href={ex.url} target="_blank" rel="noreferrer">
            Export ready
          </a>
        )}
        {ex?.state === "error" && <span className="pill bad" title={ex.error}>Export failed</span>}
        <button className="ghost tour-templates" onClick={() => setShowTemplates(true)} title="Start from a template">
          <IconGrid /> Templates
        </button>
        <button className="icon-only help-btn" onClick={() => setShowHelp(true)} title="Shortcuts and tour (?)" aria-label="Help">
          <IconHelp />
        </button>
        <div className="menu-wrap" ref={exportMenuRef}>
          <button className="primary export-btn" disabled={!project || ex?.state === "progress"} onClick={() => setExportMenu((m) => !m)}>
            <IconExport /> Export <IconChevronDown size={14} />
          </button>
          {exportMenu && (
            <div className="menu menu-right export-menu">
              {EXPORTS.map((e) => (
                <button key={e.format} onClick={() => exportAs(e.format)}>
                  <span className="menu-label">{e.label}</span>
                  <span className="menu-hint-inline">{e.hint}</span>
                </button>
              ))}
              <div className="menu-sep" />
              <button
                onClick={async () => {
                  setExportMenu(false);
                  await importLottieFile(await pickLottieFile());
                }}
              >
                <span className="menu-label">
                  <IconImport size={14} /> Import Lottie…
                </span>
                <span className="menu-hint-inline">As an editable layer</span>
              </button>
            </div>
          )}
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
                onImportLottie={importLottieFile}
              />
              <Timeline
                editor={editor}
                project={project}
                comp={comp}
                time={time}
                playing={playing}
                selected={selected}
                selectedKeyframes={selectedKeyframes}
                assets={assets}
                muted={muted}
                onToggleMute={() => setMuted((m) => !m)}
                workArea={workArea}
                onWorkArea={setWorkArea}
                onSeek={(t) => setTime(t)}
                onTogglePlay={() => setPlaying((p) => !p)}
                onSelect={select}
                onSelectKeyframes={setSelectedKeyframes}
                onImportLottie={async () => importLottieFile(await pickLottieFile())}
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
                {t === "agent" ? <IconSparkles size={15} /> : t === "inspector" ? <IconSliders size={15} /> : <IconClock size={15} />}
                {t === "agent" ? "Agent" : t === "inspector" ? "Properties" : "History"}
                {t === "agent" && state.running && <span className="live-dot" />}
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
              <button
                className="ghost small"
                onClick={() => {
                  setShowHelp(false);
                  setTouring(true);
                }}
              >
                Take the tour
              </button>
              <button
                className="ghost small"
                onClick={() => {
                  setShowHelp(false);
                  setShowWelcome(true);
                }}
              >
                Welcome screen
              </button>
              <button className="icon-only" onClick={() => setShowHelp(false)} aria-label="Close">
                <IconClose />
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
      {showWelcome && !touring && (
        <Welcome
          providers={state.providers}
          onDescribe={() => {
            closeWelcome();
            setTab("agent");
            setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 50);
          }}
          onTemplates={() => {
            closeWelcome();
            setShowTemplates(true);
          }}
          onTour={() => {
            closeWelcome();
            setTouring(true);
          }}
          onSkip={closeWelcome}
        />
      )}
      {touring && <Tour steps={tourSteps} onDone={() => setTouring(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
