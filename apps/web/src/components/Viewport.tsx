import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invert, isActive, layerGeometry, pointInQuad, renderFrame, type LayerGeometry } from "@openeffects/engine";
import { addLayer, editLayer, getIn, isKeyframed, mediaKind, sample, setValueAtTime, uniqueLayerId, type Composition, type Layer, type Project } from "@openeffects/schema";
import { browserEnv, onMediaFrame, preload } from "../browserEnv.ts";
import type { Editor } from "../editor.ts";
import { IconAlignBottom, IconAlignHCenter, IconAlignLeft, IconAlignRight, IconAlignTop, IconAlignVCenter, IconCenter, IconPath, IconSafe } from "./Icons.tsx";

interface Props {
  editor: Editor;
  project: Project;
  comp: Composition;
  time: number;
  errors: string[];
  selected: string | null;
  onSelect(id: string | null): void;
  onEditText(): void;
  onError(message: string): void;
  onImportLottie(file: File): void;
}

type Pt = [number, number];
type Drag =
  | { kind: "move"; id: string; start: Pt; startValue: Pt; inv: [number, number, number, number] }
  | { kind: "scale"; id: string; start: Pt; pivot: Pt; startValue: number | Pt }
  | { kind: "rotate"; id: string; start: Pt; pivot: Pt; startValue: number };

const SNAP_PX = 8;

/** Live preview with direct manipulation: select, move, scale, rotate, drop images. */
export function Viewport({ editor, project, comp, time, errors, selected, onSelect, onEditText, onError, onImportLottie }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [ready, setReady] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const [dropping, setDropping] = useState(false);
  const [showPath, setShowPath] = useState(true);
  const [showSafe, setShowSafe] = useState(false);
  const drag = useRef<Drag | null>(null);
  /** True once the pointer has moved enough to count as a drag (a plain click must not edit). */
  const moved = useRef(false);
  const lastDelta = useRef<Pt>([0, 0]);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    preload(project, String(Date.now())).then(() => !cancelled && setReady((n) => n + 1));
    return () => {
      cancelled = true;
    };
  }, [project]);

  // Redraw when a video element lands on the requested frame.
  useEffect(() => onMediaFrame(() => setReady((n) => n + 1)), []);

  const pad = 32;
  const fit = Math.min((box.w - pad * 2) / comp.width, (box.h - pad * 2) / comp.height);
  const displayW = Math.max(1, Math.floor(comp.width * fit));
  const displayH = Math.max(1, Math.floor(comp.height * fit));
  const k = displayW / comp.width; // screen px per comp px
  const dpr = window.devicePixelRatio || 1;
  const renderScale = Math.min(1, fit * dpr);
  const t = Math.min(time, comp.duration - 1e-6);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || fit <= 0) return;
    const w = Math.max(1, Math.round(comp.width * renderScale));
    const h = Math.max(1, Math.round(comp.height * renderScale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    try {
      renderFrame(canvas.getContext("2d")!, project, { compId: comp.id, time: t, scale: renderScale }, browserEnv);
    } catch (e) {
      console.error(e);
    }
  }, [project, comp, t, renderScale, fit, ready]);

  const geometry = (id: string | null): LayerGeometry | null => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!id || !ctx) return null;
    try {
      return layerGeometry(ctx, project, browserEnv, { compId: comp.id, time: t }, id);
    } catch {
      return null;
    }
  };

  const toComp = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  };

  const hitTest = (p: Pt): string | null => {
    for (let i = comp.layers.length - 1; i >= 0; i--) {
      const l = comp.layers[i];
      if (l.visible === false || l.type === "null" || l.type === "audio" || !isActive(l, comp, t)) continue;
      if (l.type === "solid" && !l.size) continue; // full-frame backgrounds: select from the timeline
      const g = geometry(l.id);
      if (g && pointInQuad(g.quad, p[0], p[1])) return l.id;
    }
    return null;
  };

  const layerById = (id: string) => comp.layers.find((l) => l.id === id);
  const fallbackPos = (l: Layer): Pt => (l.type === "path" ? [0, 0] : [comp.width / 2, comp.height / 2]);
  const edit = (id: string, path: string, value: unknown, transient: boolean) =>
    editor.update((p) => editLayer(p, id, (l) => setValueAtTime(l, path, t, value, comp.fps), { compId: comp.id }), { transient });

  const startDrag = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation();
    e.preventDefault();
    drag.current = d;
    moved.current = false;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = toComp(e);
    const id = hitTest(p);
    onSelect(id);
    if (!id) return;
    const l = layerById(id)!;
    const g = geometry(id)!;
    const lin = invert([g.parentWorld[0], g.parentWorld[1], g.parentWorld[2], g.parentWorld[3], 0, 0]);
    startDrag(e, { kind: "move", id, start: p, startValue: sample(l.transform?.position, t, fallbackPos(l)) as Pt, inv: [lin[0], lin[1], lin[2], lin[3]] });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const p = toComp(e);
    if (!d) {
      setHover(hitTest(p));
      return;
    }
    if (!moved.current) {
      if (Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) * k < 3) return;
      moved.current = true;
    }
    if (d.kind === "move") {
      let dx = p[0] - d.start[0];
      let dy = p[1] - d.start[1];
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      // Snap the layer's pivot to the composition center lines (hold Alt to disable).
      // The preview already includes the previous delta, so offset by the change since then.
      const g = geometry(d.id);
      const next: { x?: number; y?: number } = {};
      if (g && !e.altKey) {
        const pivotX = g.pivot[0] + (dx - lastDelta.current[0]);
        const pivotY = g.pivot[1] + (dy - lastDelta.current[1]);
        if (Math.abs(pivotX - comp.width / 2) * k < SNAP_PX) {
          dx += comp.width / 2 - pivotX;
          next.x = comp.width / 2;
        }
        if (Math.abs(pivotY - comp.height / 2) * k < SNAP_PX) {
          dy += comp.height / 2 - pivotY;
          next.y = comp.height / 2;
        }
      }
      lastDelta.current = [dx, dy];
      setGuides(next);
      const [a, b, c, dd] = d.inv;
      const v: Pt = [round(d.startValue[0] + a * dx + c * dy), round(d.startValue[1] + b * dx + dd * dy)];
      edit(d.id, "transform.position", v, true);
    } else if (d.kind === "scale") {
      const f = Math.hypot(p[0] - d.pivot[0], p[1] - d.pivot[1]) / Math.max(1e-6, Math.hypot(d.start[0] - d.pivot[0], d.start[1] - d.pivot[1]));
      const snap = (v: number) => (e.shiftKey ? Math.round(v / 5) * 5 : round(v));
      const v = Array.isArray(d.startValue) ? [snap(d.startValue[0] * f), snap(d.startValue[1] * f)] : snap(d.startValue * f);
      edit(d.id, "transform.scale", v, true);
    } else {
      const a0 = Math.atan2(d.start[1] - d.pivot[1], d.start[0] - d.pivot[0]);
      const a1 = Math.atan2(p[1] - d.pivot[1], p[0] - d.pivot[0]);
      let deg = d.startValue + ((a1 - a0) * 180) / Math.PI;
      deg = e.shiftKey ? Math.round(deg / 15) * 15 : round(deg);
      edit(d.id, "transform.rotation", deg, true);
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    lastDelta.current = [0, 0];
    setGuides({});
    if (!d || !moved.current) return;
    // Commit the gesture as one undo step (re-applying the last transient value).
    const l = layerById(d.id);
    if (!l) return;
    const path = d.kind === "move" ? "transform.position" : d.kind === "scale" ? "transform.scale" : "transform.rotation";
    const fallback = d.kind === "move" ? fallbackPos(l) : d.kind === "scale" ? 100 : 0;
    edit(d.id, path, sample(getIn(l, path) as never, t, fallback as never), false);
  };

  // Drop media from the desktop: upload into assets/ and add a layer. Images land where dropped,
  // videos fill the frame, audio goes to the bottom of the stack.
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const lotties = [...e.dataTransfer.files].filter((f) => /\.json$/i.test(f.name));
    for (const f of lotties) onImportLottie(f);
    const files = [...e.dataTransfer.files].filter((f) => mediaKind(f.name));
    if (!files.length && lotties.length) return;
    if (!files.length) return onError("Drop images (PNG, JPG, WebP, GIF, SVG), video (MP4, WebM, MOV) or audio (MP3, WAV, M4A, OGG, FLAC) to add them.");
    const at = toComp(e);
    for (const file of files) {
      try {
        const res = await fetch(`/api/assets?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
        const data = (await res.json()) as { src?: string; kind?: string; error?: string };
        if (!res.ok || !data.src) throw new Error(data.error ?? "Upload failed");
        const kind = mediaKind(file.name);
        if (kind === "video" || kind === "audio") {
          const info = (await fetch(`/api/media?src=${encodeURIComponent(data.src)}`).then((r) => (r.ok ? r.json() : null))) as { width?: number; height?: number; duration?: number } | null;
          editor.update((p) => {
            const id = uniqueLayerId(p, file.name.replace(/\.[^.]+$/, ""), comp.id);
            const out = info?.duration && info.duration < comp.duration ? Math.round(info.duration * 1000) / 1000 : undefined;
            let layer: Layer;
            if (kind === "audio") layer = { id, type: "audio", src: data.src!, ...(out ? { out } : {}) };
            else {
              const s = info?.width && info.height ? Math.min(1, comp.width / info.width, comp.height / info.height) : 1;
              layer = { id, type: "video", src: data.src!, ...(out ? { out } : {}), ...(info?.width && info.height ? { size: [Math.round(info.width * s), Math.round(info.height * s)] as [number, number] } : {}) };
            }
            setTimeout(() => onSelect(id));
            return addLayer(p, layer, { compId: comp.id, index: kind === "audio" ? 0 : undefined });
          });
          continue;
        }
        const size = await imageSize(file);
        const s = Math.min(1, (comp.width * 0.6) / size[0], (comp.height * 0.6) / size[1]);
        editor.update((p) => {
          const id = uniqueLayerId(p, file.name.replace(/\.[^.]+$/, ""), comp.id);
          const layer: Layer = { id, type: "image", src: data.src!, size: [Math.round(size[0] * s), Math.round(size[1] * s)], transform: { position: [Math.round(at[0]), Math.round(at[1])] } };
          setTimeout(() => onSelect(id));
          return addLayer(p, layer, { compId: comp.id });
        });
      } catch (err) {
        onError((err as Error).message);
      }
    }
  };

  const sel = selected && layerById(selected)?.type !== "audio" ? geometry(selected) : null;

  /** Align the selected layer's bounding box to the composition (sets position at the playhead). */
  const align = (h: "left" | "center" | "right" | null, v: "top" | "middle" | "bottom" | null) => {
    if (!sel || !selected) return;
    const l = layerById(selected)!;
    const xs = sel.quad.map((q) => q[0]);
    const ys = sel.quad.map((q) => q[1]);
    const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    const dx = h === "left" ? -box.x0 : h === "right" ? comp.width - box.x1 : h === "center" ? comp.width / 2 - (box.x0 + box.x1) / 2 : 0;
    const dy = v === "top" ? -box.y0 : v === "bottom" ? comp.height - box.y1 : v === "middle" ? comp.height / 2 - (box.y0 + box.y1) / 2 : 0;
    const inv = invert([sel.parentWorld[0], sel.parentWorld[1], sel.parentWorld[2], sel.parentWorld[3], 0, 0]);
    const cur = sample(l.transform?.position, t, fallbackPos(l)) as Pt;
    edit(selected, "transform.position", [round(cur[0] + inv[0] * dx + inv[2] * dy), round(cur[1] + inv[1] * dx + inv[3] * dy)], false);
  };

  // Motion path: where the selected layer's position travels, with its keyframes.
  let motionPath: { points: Pt[]; keys: Pt[] } | null = null;
  const selPos = selected ? layerById(selected)?.transform?.position : undefined;
  if (showPath && sel && isKeyframed(selPos as never)) {
    const kfs = (selPos as { keyframes: { t: number; v: Pt }[] }).keyframes;
    const pw = sel.parentWorld;
    const toC = ([x, y]: Pt): Pt => [pw[0] * x + pw[2] * y + pw[4], pw[1] * x + pw[3] * y + pw[5]];
    const t0 = kfs[0].t;
    const t1 = kfs[kfs.length - 1].t;
    const steps = Math.max(2, Math.min(240, Math.round((t1 - t0) * 60)));
    motionPath = {
      points: Array.from({ length: steps + 1 }, (_, i) => toC(sample(selPos as never, t0 + ((t1 - t0) * i) / steps, [0, 0] as never) as Pt)),
      keys: kfs.map((k) => toC(k.v)),
    };
  }
  const hov = hover && hover !== selected ? geometry(hover) : null;
  const toScreen = (q: Pt[]) => q.map(([x, y]) => `${x * k},${y * k}`).join(" ");
  const selLayer = selected ? layerById(selected) : undefined;

  return (
    <div
      className={`viewport ${dropping ? "dropping" : ""}`}
      ref={wrapRef}
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {fit > 0 && (
        <div className="stage-wrap" style={{ width: displayW, height: displayH }}>
          <canvas ref={canvasRef} className="stage" style={{ width: displayW, height: displayH }} />
          <svg
            className="overlay"
            width={displayW}
            height={displayH}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => !drag.current && setHover(null)}
            onDoubleClick={() => selLayer?.type === "text" && onEditText()}
            onKeyDown={(e) => e.key === "Escape" && editor.cancel()}
          >
            {guides.x !== undefined && <line className="guide" x1={guides.x * k} x2={guides.x * k} y1={0} y2={displayH} />}
            {guides.y !== undefined && <line className="guide" y1={guides.y * k} y2={guides.y * k} x1={0} x2={displayW} />}
            {showSafe && (
              <>
                <rect className="safe" x={displayW * 0.05} y={displayH * 0.05} width={displayW * 0.9} height={displayH * 0.9} />
                <rect className="safe title" x={displayW * 0.1} y={displayH * 0.1} width={displayW * 0.8} height={displayH * 0.8} />
              </>
            )}
            {motionPath && (
              <g className="motion-path">
                <polyline points={toScreen(motionPath.points)} />
                {motionPath.points.filter((_, i) => i % 4 === 0).map((p, i) => (
                  <circle key={i} cx={p[0] * k} cy={p[1] * k} r={1.5} className="mp-dot" />
                ))}
                {motionPath.keys.map((p, i) => (
                  <rect key={i} x={p[0] * k - 4} y={p[1] * k - 4} width={8} height={8} className="mp-key" transform={`rotate(45 ${p[0] * k} ${p[1] * k})`} />
                ))}
              </g>
            )}
            {hov && <polygon className="hover-box" points={toScreen(hov.quad)} />}
            {sel && (
              <g>
                <polygon className="sel-box" points={toScreen(sel.quad)} />
                <circle className="pivot" cx={sel.pivot[0] * k} cy={sel.pivot[1] * k} r={4} />
                {sel.quad.map((c, i) => (
                  <rect
                    key={i}
                    className="handle"
                    x={c[0] * k - 5}
                    y={c[1] * k - 5}
                    width={10}
                    height={10}
                    onPointerDown={(e) =>
                      selLayer &&
                      startDrag(e, { kind: "scale", id: selLayer.id, start: toComp(e), pivot: sel.pivot, startValue: sample(selLayer.transform?.scale, t, 100 as number | Pt) as number | Pt })
                    }
                  />
                ))}
                {(() => {
                  const top: Pt = [(sel.quad[0][0] + sel.quad[1][0]) / 2, (sel.quad[0][1] + sel.quad[1][1]) / 2];
                  const dir = [top[0] - sel.pivot[0], top[1] - sel.pivot[1]];
                  const len = Math.hypot(dir[0], dir[1]) || 1;
                  const h: Pt = [top[0] * k + (dir[0] / len) * 24, top[1] * k + (dir[1] / len) * 24];
                  return (
                    <>
                      <line className="rot-stem" x1={top[0] * k} y1={top[1] * k} x2={h[0]} y2={h[1]} />
                      <circle
                        className="handle rot"
                        cx={h[0]}
                        cy={h[1]}
                        r={6}
                        onPointerDown={(e) => selLayer && startDrag(e, { kind: "rotate", id: selLayer.id, start: toComp(e), pivot: sel.pivot, startValue: sample(selLayer.transform?.rotation, t, 0) })}
                      />
                    </>
                  );
                })()}
              </g>
            )}
          </svg>
        </div>
      )}
      <div className="view-tools" onPointerDown={(e) => e.stopPropagation()}>
        <button className={`seg-btn ${showPath ? "active" : ""}`} title="Motion path of the selected layer" onClick={() => setShowPath(!showPath)}>
          <IconPath size={15} />
          Path
        </button>
        <button className={`seg-btn ${showSafe ? "active" : ""}`} title="Title / action safe guides" onClick={() => setShowSafe(!showSafe)}>
          <IconSafe size={15} />
          Guides
        </button>
        {selected && selLayer?.type !== "audio" && (
          <span className="align-tools" title="Align the selected layer to the frame">
            <span className="view-tools-sep" />
            {(
              [
                [IconAlignLeft, "Align left", "left", null],
                [IconAlignHCenter, "Center horizontally", "center", null],
                [IconAlignRight, "Align right", "right", null],
                [IconAlignTop, "Align top", null, "top"],
                [IconAlignVCenter, "Center vertically", null, "middle"],
                [IconAlignBottom, "Align bottom", null, "bottom"],
                [IconCenter, "Center in frame", "center", "middle"],
              ] as const
            ).map(([Icon, label, h, v]) => (
              <button key={label} className="seg-btn icon" title={label} aria-label={label} onClick={() => align(h, v)}>
                <Icon size={15} />
              </button>
            ))}
          </span>
        )}
      </div>
      {dropping && <div className="drop-hint">Drop images, video, audio or Lottie files</div>}
      {errors.length > 0 && (
        <div className="error-banner">
          <strong>project.oe.json has errors</strong> (showing the last valid version)
          <ul>
            {errors.slice(0, 6).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const round = (v: number) => Math.round(v * 10) / 10;

function imageSize(file: File): Promise<Pt> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve([img.naturalWidth || 400, img.naturalHeight || 400]);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => resolve([400, 400]);
    img.src = url;
  });
}
