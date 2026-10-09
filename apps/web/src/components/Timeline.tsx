import { useRef, useState } from "react";
import {
  EASE_NAMES,
  addLayer,
  animatedPaths,
  collectKeyframeTimes,
  deleteLayer,
  duplicateLayer,
  editLayer,
  easeKind,
  getIn,
  moveKeyframe,
  moveLayer,
  removeKeyframe,
  resolveEase,
  setIn,
  setKeyframeEase,
  shiftLayerTime,
  uniqueLayerId,
  type Composition,
  type Easing,
  type Keyframe,
  type Layer,
  type Project,
} from "@openeffects/schema";
import type { Editor } from "../editor.ts";
import { CurveIcon, EaseEditor } from "./EaseEditor.tsx";
import { GraphEditor } from "./GraphEditor.tsx";

export interface KeyframeRef {
  layerId: string;
  path: string;
  index: number;
}

interface Props {
  editor: Editor;
  project: Project;
  comp: Composition;
  time: number;
  playing: boolean;
  selected: string | null;
  selectedKeyframes: KeyframeRef[];
  assets: string[];
  workArea: { start: number; end: number } | null;
  onWorkArea(w: { start: number; end: number } | null): void;
  onSeek(t: number): void;
  onTogglePlay(): void;
  onSelect(id: string | null): void;
  onSelectKeyframes(k: KeyframeRef[]): void;
}

const TYPE_ICON: Record<string, string> = { solid: "■", rect: "▭", ellipse: "●", path: "✎", text: "T", image: "▣", null: "✛", comp: "❒" };

function formatTime(t: number, fps: number): string {
  const s = Math.floor(t + 1e-6);
  const f = Math.floor((t - s) * fps + 1e-6);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

const PRETTY: Record<string, string> = {
  "transform.position": "Position",
  "transform.scale": "Scale",
  "transform.rotation": "Rotation",
  "transform.opacity": "Opacity",
  "transform.anchor": "Anchor",
  "font.size": "Font size",
  letterSpacing: "Tracking",
  "trim.start": "Trim start",
  "trim.end": "Trim end",
};
const pretty = (path: string, layer: Layer) => {
  if (PRETTY[path]) return PRETTY[path];
  const fx = /^effects\.(\d+)\.(\w+)$/.exec(path);
  if (fx) return `${layer.effects?.[Number(fx[1])]?.type ?? "effect"} ${fx[2]}`;
  return path.replace(/\./g, " › ");
};

/** Default layers for the Add menu, centered and visible. */
function newLayer(kind: string, comp: Composition, id: string, src?: string): Layer {
  const center: [number, number] = [comp.width / 2, comp.height / 2];
  switch (kind) {
    case "text":
      return { id, type: "text", text: "Your text", font: { size: Math.round(comp.height / 10), weight: 700 }, fill: "#ffffff" };
    case "rect":
      return { id, type: "rect", size: [Math.round(comp.width / 4), Math.round(comp.height / 4)], radius: 24, fill: "#6b56ff" };
    case "ellipse":
      return { id, type: "ellipse", size: [Math.round(comp.height / 4), Math.round(comp.height / 4)], fill: "#ff5d8f" };
    case "solid":
      return { id, type: "solid", color: "#14162a" };
    case "line":
      return {
        id,
        type: "path",
        d: `M ${center[0] - comp.width / 5} ${center[1]} L ${center[0] + comp.width / 5} ${center[1]}`,
        stroke: { color: "#ffffff", width: 8, cap: "round" },
        trim: { end: { keyframes: [{ t: 0, v: 0, ease: "easeInOutCubic" }, { t: 1, v: 100 }] } },
      };
    case "image":
      return { id, type: "image", src: src ?? "" };
    default:
      return { id, type: "null" };
  }
}

export function Timeline(props: Props) {
  const { editor, comp, time, playing, selected, selectedKeyframes, assets, workArea, onWorkArea, onSeek, onTogglePlay, onSelect, onSelectKeyframes } = props;
  const [graph, setGraph] = useState(false);
  const [graphPath, setGraphPath] = useState<string | null>(null);
  const [easeOpen, setEaseOpen] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  const [reorder, setReorder] = useState<{ id: string; over: number } | null>(null);
  const D = comp.duration;
  const pct = (t: number) => `${(Math.min(Math.max(t, 0), D) / D) * 100}%`;
  const snap = (t: number) => Math.round(t * comp.fps) / comp.fps;
  const timeAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * D;
  };
  const secondsPerPx = () => D / (trackRef.current?.getBoundingClientRect().width || 1);
  const layersTopFirst = [...comp.layers].reverse(); // like After Effects: top of list = top of stack

  /** Generic horizontal drag: calls onMove with the time delta, commits on release. */
  const dragTime = (e: React.PointerEvent, onMove: (dt: number, transient: boolean) => void) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    let last = 0;
    const move = (ev: PointerEvent) => {
      last = snap((ev.clientX - x0) * secondsPerPx());
      onMove(last, true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (last !== 0) onMove(last, false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const scrub = (e: React.PointerEvent) => {
    onSelectKeyframes([]);
    const seek = (x: number) => onSeek(Math.min(snap(timeAt(x)), D - 1 / comp.fps));
    seek(e.clientX);
    const move = (ev: PointerEvent) => seek(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const editL = (id: string, fn: (l: Layer) => Layer, transient = false) => editor.update((p) => editLayer(p, id, fn, { compId: comp.id }), { transient });

  const add = (kind: string, src?: string) => {
    setMenu(false);
    editor.update((p) => {
      const id = uniqueLayerId(p, kind === "image" && src ? src.split("/").pop()!.replace(/\.[^.]+$/, "") : kind, comp.id);
      setTimeout(() => onSelect(id));
      // Solids go to the bottom (backgrounds); everything else on top.
      return addLayer(p, newLayer(kind, comp, id, src), { compId: comp.id, index: kind === "solid" ? 0 : undefined });
    });
  };

  const startReorder = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    const y0 = e.clientY;
    let active = false;
    let over = -1;
    const rows = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(".tl-name[data-index]") ?? [])];
    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientY - y0) < 4) return;
      active = true;
      const hit = rows.find((r) => {
        const b = r.getBoundingClientRect();
        return ev.clientY >= b.top && ev.clientY < b.bottom;
      });
      if (hit) over = Number(hit.dataset.index);
      setReorder({ id, over });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setReorder(null);
      if (active && over >= 0) {
        // `over` is a top-first row index; convert to the stacking index.
        editor.update((p) => moveLayer(p, id, comp.layers.length - 1 - over, { compId: comp.id }));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const step = D > 20 ? 5 : D > 8 ? 1 : 0.5;
  const ticks: number[] = [];
  for (let t = 0; t <= D + 1e-6; t += step) ticks.push(Number(t.toFixed(3)));

  // Selected keyframes that still exist (the agent or undo may have removed some).
  const selKfs = selectedKeyframes
    .map((ref) => {
      const l = comp.layers.find((x) => x.id === ref.layerId);
      const kf = l ? (getIn(l, ref.path) as { keyframes?: Keyframe<unknown>[] })?.keyframes?.[ref.index] : undefined;
      return l && kf ? { ref, layer: l, kf } : null;
    })
    .filter((x): x is { ref: KeyframeRef; layer: Layer; kf: Keyframe<unknown> } => x !== null);
  const firstSel = selKfs[0];
  const applyEase = (ease: Easing) =>
    editor.update((p) =>
      selKfs.reduce((acc, { ref }) => editLayer(acc, ref.layerId, (l) => setKeyframeEase(l, ref.path, ref.index, ease), { compId: comp.id }), p),
    );
  const deleteSelected = () => {
    // Delete from the highest index down so earlier indices stay valid.
    const sorted = [...selKfs].sort((a, b) => b.ref.index - a.ref.index);
    editor.update((p) => sorted.reduce((acc, { ref }) => editLayer(acc, ref.layerId, (l) => removeKeyframe(l, ref.path, ref.index), { compId: comp.id }), p));
    onSelectKeyframes([]);
  };
  const toggleKf = (ref: KeyframeRef, additive: boolean) => {
    const has = selectedKeyframes.some((k) => k.layerId === ref.layerId && k.path === ref.path && k.index === ref.index);
    if (additive) onSelectKeyframes(has ? selectedKeyframes.filter((k) => !(k.layerId === ref.layerId && k.path === ref.path && k.index === ref.index)) : [...selectedKeyframes, ref]);
    else if (!has) onSelectKeyframes([ref]);
  };

  /** Drag the loop region handles on the ruler. */
  const dragWorkArea = (which: "start" | "end" | "both") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const w0 = workArea ?? { start: 0, end: D };
    const x0 = e.clientX;
    const move = (ev: PointerEvent) => {
      const dt = snap((ev.clientX - x0) * secondsPerPx());
      const min = 2 / comp.fps;
      if (which === "start") onWorkArea({ start: Math.max(0, Math.min(w0.end - min, w0.start + dt)), end: w0.end });
      else if (which === "end") onWorkArea({ start: w0.start, end: Math.min(D, Math.max(w0.start + min, w0.end + dt)) });
      else {
        const len = w0.end - w0.start;
        const s0 = Math.max(0, Math.min(D - len, w0.start + dt));
        onWorkArea({ start: s0, end: s0 + len });
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className={`timeline ${graph ? "graph-mode" : ""}`}>
      <div className="transport">
        <button className="icon-btn" onClick={() => onSeek(0)} title="Go to start (Home)">⏮</button>
        <button className="icon-btn play" onClick={onTogglePlay} title="Play/Pause (Space)">{playing ? "❚❚" : "▶"}</button>
        <span className="timecode">{formatTime(time, comp.fps)}</span>
        <span className="muted small">/ {formatTime(D, comp.fps)} · {comp.width}×{comp.height} · {comp.fps} fps</span>
        <span className="grow" />
        {firstSel && (
          <span className="kf-bar">
            <span className="kf-dot">◆</span>
            <span>
              {selKfs.length > 1 ? `${selKfs.length} keyframes` : `${pretty(firstSel.ref.path, firstSel.layer)} @ ${firstSel.kf.t.toFixed(2)}s`}
            </span>
            <span className="muted small">ease</span>
            <select
              className="field-select"
              value={typeof firstSel.kf.ease === "string" ? firstSel.kf.ease : firstSel.kf.ease ? "custom" : "easeInOut"}
              onChange={(e) => applyEase(e.target.value as Easing)}
            >
              {typeof firstSel.kf.ease === "object" && <option value="custom">custom bezier</option>}
              {EASE_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button className="bare curve-btn" title="Edit the curve" onClick={() => setEaseOpen(!easeOpen)}>
              <CurveIcon ease={firstSel.kf.ease} size={30} />
            </button>
            <button className="tiny" title="Delete keyframes (Del)" onClick={deleteSelected}>
              🗑
            </button>
            {easeOpen && (
              <div className="ease-pop">
                <EaseEditor value={firstSel.kf.ease} onChange={applyEase} onClose={() => setEaseOpen(false)} />
              </div>
            )}
          </span>
        )}
      </div>
      <div className="tl-grid">
        <div className="tl-names">
          <div className="tl-toolbar">
            <div className="menu-wrap">
              <button className="small primary-ghost" onClick={() => setMenu(!menu)} title="Add a layer">
                + Layer
              </button>
              {menu && (
                <div className="menu" onMouseLeave={() => setMenu(false)}>
                  <button onClick={() => add("text")}>T  Text</button>
                  <button onClick={() => add("rect")}>▭  Rectangle</button>
                  <button onClick={() => add("ellipse")}>●  Ellipse</button>
                  <button onClick={() => add("line")}>✎  Line (draws on)</button>
                  <button onClick={() => add("solid")}>■  Background solid</button>
                  <button onClick={() => add("null")}>✛  Null (parent / camera)</button>
                  {assets.length > 0 && <div className="menu-sep">Images in assets/</div>}
                  {assets.map((a) => (
                    <button key={a} onClick={() => add("image", a)}>
                      ▣  {a.replace(/^assets\//, "")}
                    </button>
                  ))}
                  <div className="menu-hint">Tip: drop images onto the viewer</div>
                </div>
              )}
            </div>
            <button className={`tiny ${graph ? "active" : ""}`} title="Graph editor: value curves and easing handles" onClick={() => setGraph(!graph)}>
              ∿ Graph
            </button>
            <button className="tiny" disabled={!selected} title="Duplicate (Ctrl+D)" onClick={() => selected && editor.update((p) => {
              const r = duplicateLayer(p, selected, { compId: comp.id });
              setTimeout(() => onSelect(r.id));
              return r.project;
            })}>
              ⧉
            </button>
            <button className="tiny" disabled={!selected} title="Delete (Del)" onClick={() => {
              if (!selected) return;
              editor.update((p) => deleteLayer(p, selected, { compId: comp.id }));
              onSelect(null);
            }}>
              🗑
            </button>
          </div>
          {layersTopFirst.map((l, row) => {
            const paths = expanded.has(l.id) ? animatedPaths(l) : [];
            const canExpand = animatedPaths(l).length > 0;
            return (
              <div key={l.id}>
                <div
                  data-index={row}
                  className={`tl-name ${selected === l.id ? "sel" : ""} ${l.visible === false ? "hidden" : ""} ${reorder?.over === row && reorder.id !== l.id ? "drop-target" : ""} ${reorder?.id === l.id ? "dragging" : ""}`}
                  onPointerDown={(e) => {
                    onSelect(l.id);
                    startReorder(e, l.id);
                  }}
                  title={`${l.type} · ${l.id} · drag to reorder`}
                >
                  <button
                    className={`twirl ${canExpand ? "" : "invisible"}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      const next = new Set(expanded);
                      next.has(l.id) ? next.delete(l.id) : next.add(l.id);
                      setExpanded(next);
                    }}
                  >
                    {expanded.has(l.id) ? "▾" : "▸"}
                  </button>
                  <button
                    className="eye"
                    title={l.visible === false ? "Show" : "Hide"}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => editL(l.id, (x) => setIn(x, "visible", x.visible === false ? undefined : false))}
                  >
                    {l.visible === false ? "◌" : "◉"}
                  </button>
                  <span className="tl-icon">{TYPE_ICON[l.type] ?? "?"}</span>
                  <span className="tl-label">{l.name ?? l.id}</span>
                  {l.matte && <span className="tl-tag">matte</span>}
                  {l.parent && <span className="tl-tag">↳ {l.parent}</span>}
                </div>
                {paths.map((p) => (
                  <div key={p} className="tl-name sub">
                    <span className="tl-sublabel">{pretty(p, l)}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <div className="tl-tracks" ref={trackRef} onPointerDown={scrub}>
          <div className="tl-ruler">
            {ticks.map((t) => (
              <span key={t} className="tick" style={{ left: pct(t) }}>
                {Number.isInteger(t) ? `${t}s` : ""}
              </span>
            ))}
            {workArea && (
              <div className="work-area" style={{ left: pct(workArea.start), width: `calc(${pct(workArea.end)} - ${pct(workArea.start)})` }} onPointerDown={dragWorkArea("both")} title="Preview loop range (B / N set start / end, double-click to clear)" onDoubleClick={() => onWorkArea(null)}>
                <span className="wa-handle left" onPointerDown={dragWorkArea("start")} />
                <span className="wa-handle right" onPointerDown={dragWorkArea("end")} />
              </div>
            )}
          </div>
          {graph && (
            <div className="graph-wrap" onPointerDown={(e) => e.stopPropagation()}>
              <GraphEditor
                editor={editor}
                comp={comp}
                layer={comp.layers.find((l) => l.id === selected)}
                path={graphPath ?? firstSel?.ref.path ?? null}
                time={time}
                selectedKeyframes={selectedKeyframes}
                onSelectKeyframes={onSelectKeyframes}
                onSelectPath={setGraphPath}
                onSeek={onSeek}
              />
            </div>
          )}
          {!graph && layersTopFirst.map((l) => {
            const start = l.in ?? 0;
            const end = l.out ?? D;
            const allKfs = [...collectKeyframeTimes(l)];
            const paths = expanded.has(l.id) ? animatedPaths(l) : [];
            return (
              <div key={l.id}>
                <div className={`tl-row ${selected === l.id ? "sel" : ""}`}>
                  <div
                    className={`tl-bar type-${l.type} ${l.visible === false ? "hidden" : ""}`}
                    style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }}
                    title="Drag to move in time; drag the edges to trim"
                    onPointerDown={(e) => {
                      onSelect(l.id);
                      const base = l;
                      dragTime(e, (dt, tr) => editL(l.id, () => shiftLayerTime(base, dt), tr));
                    }}
                  >
                    <span
                      className="trim left"
                      onPointerDown={(e) => {
                        onSelect(l.id);
                        dragTime(e, (dt, tr) => editL(l.id, (x) => setIn(x, "in", Math.max(0, Math.min(end - 1 / comp.fps, start + dt)) || undefined), tr));
                      }}
                    />
                    <span
                      className="trim right"
                      onPointerDown={(e) => {
                        onSelect(l.id);
                        dragTime(e, (dt, tr) => {
                          const out = Math.max(start + 1 / comp.fps, end + dt);
                          editL(l.id, (x) => setIn(x, "out", out >= D ? undefined : out), tr);
                        });
                      }}
                    />
                  </div>
                  {!expanded.has(l.id) && allKfs.map((t) => <span key={t} className="kf summary kind-eased" style={{ left: pct(t) }} />)}
                </div>
                {paths.map((path) => {
                  const kfList = (getIn(l, path) as { keyframes: Keyframe<unknown>[] }).keyframes ?? [];
                  const kfs = kfList.map((k) => k.t);
                  return (
                    <div key={path} className="tl-row sub">
                      {kfs.map((t, i) => {
                        const isSel = selectedKeyframes.some((k) => k.layerId === l.id && k.path === path && k.index === i);
                        return (
                          <span
                            key={i}
                            className={`kf kind-${easeKind(kfList[i].ease)} ${isSel ? "sel" : ""}`}
                            style={{ left: pct(t) }}
                            title={`${t.toFixed(2)}s · drag to retime, click to edit easing`}
                            onPointerDown={(e) => {
                              e.stopPropagation(); // don't let the track scrubber clear the selection
                              onSelect(l.id);
                              setGraphPath(path);
                              toggleKf({ layerId: l.id, path, index: i }, e.shiftKey);
                              if (e.shiftKey) return;
                              const base = l;
                              dragTime(e, (dt, tr) => {
                                const next = moveKeyframe(base, path, i, Math.min(D, Math.max(0, t + dt)));
                                editL(l.id, () => next, tr);
                                // Keep the moved keyframe selected after re-sorting.
                                const newIndex = ((getIn(next, path) as { keyframes: Keyframe<unknown>[] }).keyframes ?? []).findIndex((k) => Math.abs(k.t - snapT(t + dt)) < 1e-6);
                                if (!tr && newIndex >= 0) onSelectKeyframes([{ layerId: l.id, path, index: newIndex }]);
                              });
                            }}
                          />
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div className="playhead" style={{ left: pct(time) }} />
        </div>
      </div>
    </div>
  );
}

const snapT = (t: number) => Math.round(Math.max(0, t) * 1000) / 1000;
