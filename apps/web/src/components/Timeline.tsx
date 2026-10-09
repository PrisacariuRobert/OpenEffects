import { useCallback, useEffect, useRef, useState } from "react";
import {
  EASE_NAMES,
  addLayer,
  animatedPaths,
  collectKeyframeTimes,
  deleteLayer,
  duplicateLayer,
  editLayer,
  easeKind,
  getComp,
  getIn,
  moveKeyframe,
  moveLayer,
  removeKeyframe,
  resolveEase,
  setIn,
  sample,
  setKeyframeEase,
  shiftLayerTime,
  uniqueLayerId,
  updateComposition,
  mediaSourceTime,
  isMediaLayer,
  type Composition,
  type Easing,
  type Keyframe,
  type Layer,
  type Marker,
  type MediaLayer,
  type Project,
} from "@openeffects/schema";
import type { Editor } from "../editor.ts";
import { useDismiss } from "../useDismiss.ts";
import { getMediaInfo } from "../browserEnv.ts";
import { loadWaveform } from "../mediaPlayback.ts";
import { CurveIcon, EaseEditor } from "./EaseEditor.tsx";
import { GraphEditor } from "./GraphEditor.tsx";
import {
  IconAddMarker,
  IconChevronDown,
  IconChevronRight,
  IconDuplicate,
  IconEye,
  IconEyeOff,
  IconGraph,
  IconImport,
  IconMuted,
  IconNextMarker,
  IconPause,
  IconPlay,
  IconPlus,
  IconPrevMarker,
  IconSpeaker,
  IconToStart,
  IconTrash,
} from "./Icons.tsx";

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
  assets: { src: string; kind: "image" | "video" | "audio" }[];
  muted: boolean;
  onToggleMute(): void;
  workArea: { start: number; end: number } | null;
  onWorkArea(w: { start: number; end: number } | null): void;
  onSeek(t: number): void;
  onTogglePlay(): void;
  onSelect(id: string | null): void;
  onSelectKeyframes(k: KeyframeRef[]): void;
  onImportLottie(): void;
}

const TYPE_ICON: Record<string, string> = { solid: "■", rect: "▭", ellipse: "●", path: "✎", text: "T", image: "▣", video: "▶", audio: "♪", null: "✛", comp: "❒" };
const KIND_ICON = { image: "▣", video: "▶", audio: "♪" } as const;

/** Waveform of a media layer, drawn inside its timeline bar for the part that plays. */
function Waveform({ layer, duration }: { layer: MediaLayer; duration: number }) {
  const [wave, setWave] = useState<{ perSecond: number; peaks: number[] } | null>(null);
  useEffect(() => {
    let alive = true;
    loadWaveform(layer.src).then((w) => alive && setWave(w));
    return () => {
      alive = false;
    };
  }, [layer.src]);
  if (!wave) return null;
  const start = layer.in ?? 0;
  const end = layer.out ?? duration;
  const info = getMediaInfo(layer.src);
  const N = 160;
  let d = "";
  for (let i = 0; i < N; i++) {
    const ft = mediaSourceTime(layer, start + ((i + 0.5) / N) * (end - start), info?.duration);
    const past = info && !(layer.type === "video" && layer.loop) && ft >= info.duration - 0.01;
    const peak = past ? 0 : (wave.peaks[Math.floor(ft * wave.perSecond)] ?? 0) * Math.min(1, sample(layer.volume, start, 100) / 100);
    const h = Math.max(0.5, peak * 44);
    d += `M${i + 0.5} ${50 - h}V${50 + h}`;
  }
  return (
    <svg className="waveform" viewBox={`0 0 ${N} 100`} preserveAspectRatio="none">
      <path d={d} />
    </svg>
  );
}

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
    case "video":
      return { id, type: "video", src: src ?? "" };
    case "audio":
      return { id, type: "audio", src: src ?? "" };
    default:
      return { id, type: "null" };
  }
}

export function Timeline(props: Props) {
  const { editor, comp, time, playing, selected, selectedKeyframes, assets, workArea, onWorkArea, onSeek, onTogglePlay, onSelect, onSelectKeyframes, muted, onToggleMute, onImportLottie } = props;
  const [graph, setGraph] = useState(false);
  const [graphPath, setGraphPath] = useState<string | null>(null);
  const [easeOpen, setEaseOpen] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  const [menuAt, setMenuAt] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 });
  const [reorder, setReorder] = useState<{ id: string; over: number } | null>(null);
  const D = comp.duration;
  const pct = (t: number) => `${(Math.min(Math.max(t, 0), D) / D) * 100}%`;
  const closeMenu = useCallback(() => setMenu(false), []);
  const addMenuRef = useDismiss<HTMLDivElement>(menu, closeMenu);
  const markers = comp.markers ?? [];
  /** Snap a time to a marker (within 6 px) or else to the nearest frame. */
  const snap = (t: number) => {
    const tol = 6 * secondsPerPx();
    const m = markers.find((mk) => Math.abs(mk.t - t) <= tol);
    return m ? m.t : Math.round(t * comp.fps) / comp.fps;
  };
  const setMarkers = (fn: (m: Marker[]) => Marker[], transient = false) =>
    editor.update(
      (p) => {
        const next = fn(getComp(p, comp.id).markers ?? []).sort((a, b) => a.t - b.t);
        return updateComposition(p, { markers: next.length ? next : null }, { compId: comp.id });
      },
      { transient },
    );
  const prevMarker = [...markers].reverse().find((m) => m.t < time - 1e-3);
  const nextMarker = markers.find((m) => m.t > time + 1e-3);
  const timeAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * D;
  };
  const secondsPerPx = () => D / (trackRef.current?.getBoundingClientRect().width || 1);
  const layersTopFirst = [...comp.layers].reverse(); // like After Effects: top of list = top of stack

  /**
   * Generic horizontal drag: calls onMove with the time delta, commits on release. With
   * `anchor` (the dragged item's own time), the result snaps to markers and frames.
   */
  const dragTime = (e: React.PointerEvent, onMove: (dt: number, transient: boolean) => void, anchor = 0) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    let last = 0;
    const move = (ev: PointerEvent) => {
      last = snap(anchor + (ev.clientX - x0) * secondsPerPx()) - anchor;
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

  const add = async (kind: string, src?: string) => {
    setMenu(false);
    let layerExtra: Partial<Layer> = {};
    if ((kind === "video" || kind === "audio") && src) {
      // Fit videos to the frame and end media layers where the file ends.
      const info = await fetch(`/api/media?src=${encodeURIComponent(src)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (info?.duration && info.duration < D) layerExtra = { out: Math.round(info.duration * 1000) / 1000 };
      if (kind === "video" && info?.width && info?.height) {
        const s = Math.min(1, comp.width / info.width, comp.height / info.height);
        layerExtra = { ...layerExtra, size: [Math.round(info.width * s), Math.round(info.height * s)] } as Partial<Layer>;
      }
    }
    editor.update((p) => {
      const base = src ? src.split("/").pop()!.replace(/\.[^.]+$/, "") : kind;
      const id = uniqueLayerId(p, base, comp.id);
      setTimeout(() => onSelect(id));
      // Solids and audio go to the bottom; everything else on top.
      return addLayer(p, { ...newLayer(kind, comp, id, src), ...layerExtra } as Layer, { compId: comp.id, index: kind === "solid" || kind === "audio" ? 0 : undefined });
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
        <button className="icon-only" onClick={() => onSeek(0)} title="Go to start (Home)" aria-label="Go to start">
          <IconToStart />
        </button>
        <button className="play-btn" onClick={onTogglePlay} title="Play/Pause (Space)" aria-label={playing ? "Pause" : "Play"}>
          {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
        </button>
        <span className="timecode">{formatTime(time, comp.fps)}</span>
        <span className="marker-nav">
          <button className="icon-only" disabled={!prevMarker} title="Previous marker ( [ )" aria-label="Previous marker" onClick={() => prevMarker && onSeek(prevMarker.t)}>
            <IconPrevMarker />
          </button>
          <button className="icon-only" title="Add a marker at the playhead (M)" aria-label="Add marker" onClick={() => setMarkers((m) => [...m.filter((x) => Math.abs(x.t - time) > 1e-3), { t: Math.round(time * 1000) / 1000 }])}>
            <IconAddMarker />
          </button>
          <button className="icon-only" disabled={!nextMarker} title="Next marker ( ] )" aria-label="Next marker" onClick={() => nextMarker && onSeek(nextMarker.t)}>
            <IconNextMarker />
          </button>
        </span>
        <button className={`icon-only ${muted ? "active" : ""}`} title={muted ? "Unmute preview audio" : "Mute preview audio"} aria-label="Mute" onClick={onToggleMute}>
          {muted ? <IconMuted /> : <IconSpeaker />}
        </button>
        <span className="comp-meta">
          {formatTime(D, comp.fps)} · {comp.width}×{comp.height} · {comp.fps} fps
        </span>
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
              <IconTrash size={15} />
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
            <div className="menu-wrap" ref={addMenuRef}>
              <button
                className="add-layer"
                onClick={(e) => {
                  // The timeline scrolls: anchor the popover to the window, opening upwards.
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenuAt({ left: r.left, bottom: window.innerHeight - r.top + 6 });
                  setMenu(!menu);
                }}
                title="Add a layer"
              >
                <IconPlus size={14} /> Layer
              </button>
              {menu && (
                <div className="menu menu-fixed" style={menuAt}>
                  <button onClick={() => add("text")}>T  Text</button>
                  <button onClick={() => add("rect")}>▭  Rectangle</button>
                  <button onClick={() => add("ellipse")}>●  Ellipse</button>
                  <button onClick={() => add("line")}>✎  Line (draws on)</button>
                  <button onClick={() => add("solid")}>■  Background solid</button>
                  <button onClick={() => add("null")}>✛  Null (parent / camera)</button>
                  {assets.length > 0 && <div className="menu-sep">Media in assets/</div>}
                  {assets.map((a) => (
                    <button key={a.src} onClick={() => add(a.kind, a.src)}>
                      {KIND_ICON[a.kind]}  {a.src.replace(/^assets\//, "")}
                    </button>
                  ))}
                  <div className="menu-sep" />
                  <button
                    onClick={() => {
                      setMenu(false);
                      onImportLottie();
                    }}
                  >
                    <IconImport size={14} />  Lottie file…
                  </button>
                  <div className="menu-hint">Tip: drop images, video, audio or Lottie files onto the viewer</div>
                </div>
              )}
            </div>
            <button className={`tiny graph-toggle ${graph ? "active" : ""}`} title="Graph editor: value curves and easing handles" onClick={() => setGraph(!graph)}>
              <IconGraph size={15} /> Graph
            </button>
            <button className="tiny" disabled={!selected} title="Duplicate (Ctrl+D)" onClick={() => selected && editor.update((p) => {
              const r = duplicateLayer(p, selected, { compId: comp.id });
              setTimeout(() => onSelect(r.id));
              return r.project;
            })}>
              <IconDuplicate size={15} />
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
                    {expanded.has(l.id) ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                  </button>
                  <button
                    className="eye"
                    title={l.visible === false ? "Show" : "Hide"}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => editL(l.id, (x) => setIn(x, "visible", x.visible === false ? undefined : false))}
                  >
                    {l.visible === false ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                  </button>
                  <span className="tl-icon">{TYPE_ICON[l.type] ?? "?"}</span>
                  <span className="tl-label">{l.name ?? l.id}</span>
                  {!!l.behaviors?.length && (
                    <span className="tl-tag behavior-tag" title={l.behaviors.map((b) => `${b.type} → ${b.property}`).join("\n")}>
                      ∿ {l.behaviors.length}
                    </span>
                  )}
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
            {markers.map((m, i) => (
              <span
                key={`${m.t}-${i}`}
                className="marker"
                style={{ left: pct(m.t), ...(m.color ? { ["--mk" as string]: m.color } : {}) }}
                title={`${m.label ?? "Marker"} · ${m.t.toFixed(2)}s · drag to move · double-click to rename · Alt+click to delete`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (e.altKey || e.button === 2) {
                    e.preventDefault();
                    setMarkers((ms) => ms.filter((_, j) => j !== i));
                    return;
                  }
                  const x0 = e.clientX;
                  let moved = false;
                  let t = m.t;
                  const move = (ev: PointerEvent) => {
                    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
                    moved = true;
                    t = Math.min(D, Math.max(0, Math.round((m.t + (ev.clientX - x0) * secondsPerPx()) * comp.fps) / comp.fps));
                    setMarkers((ms) => ms.map((x, j) => (j === i ? { ...x, t } : x)), true);
                  };
                  const up = () => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                    if (moved) setMarkers((ms) => ms.map((x, j) => (j === i ? { ...x, t } : x)));
                    else onSeek(m.t);
                  };
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }}
                onContextMenu={(e) => e.preventDefault()}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  const label = prompt("Marker label", m.label ?? "");
                  if (label !== null) setMarkers((ms) => ms.map((x, j) => (j === i ? { ...x, label: label || undefined } : x)));
                }}
              >
              </span>
            ))}
            {markers.map((m, i) =>
              m.label ? (
                // Labels get the room up to the next marker and truncate beyond it.
                <span
                  key={`lb-${i}`}
                  className="marker-label"
                  style={{ left: `calc(${pct(m.t)} + 7px)`, maxWidth: `calc(${pct((markers[i + 1]?.t ?? D) - m.t)} - 10px)`, ...(m.color ? { color: m.color } : {}) }}
                >
                  {m.label}
                </span>
              ) : null,
            )}
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
                      dragTime(e, (dt, tr) => editL(l.id, () => shiftLayerTime(base, dt), tr), start);
                    }}
                  >
                    {isMediaLayer(l) && <Waveform layer={l} duration={D} />}
                    <span
                      className="trim left"
                      onPointerDown={(e) => {
                        onSelect(l.id);
                        dragTime(e, (dt, tr) => editL(l.id, (x) => setIn(x, "in", Math.max(0, Math.min(end - 1 / comp.fps, start + dt)) || undefined), tr), start);
                      }}
                    />
                    <span
                      className="trim right"
                      onPointerDown={(e) => {
                        onSelect(l.id);
                        dragTime(e, (dt, tr) => {
                          const out = Math.max(start + 1 / comp.fps, end + dt);
                          editL(l.id, (x) => setIn(x, "out", out >= D ? undefined : out), tr);
                        }, end);
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
                              }, t);
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
          {markers.map((m, i) => (
            <div key={`ml-${i}`} className="marker-line" style={{ left: pct(m.t) }} />
          ))}
          <div className="playhead" style={{ left: pct(time) }} />
        </div>
      </div>
    </div>
  );
}

const snapT = (t: number) => Math.round(Math.max(0, t) * 1000) / 1000;
