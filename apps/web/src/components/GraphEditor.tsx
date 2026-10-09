import { useLayoutEffect, useRef, useState } from "react";
import {
  animatedPaths,
  easeKind,
  easeToBezier,
  editLayer,
  getIn,
  isKeyframed,
  sample,
  setIn,
  setKeyframeEase,
  type Composition,
  type Keyframe,
  type Layer,
} from "@openeffects/schema";
import type { Editor } from "../editor.ts";
import type { KeyframeRef } from "./Timeline.tsx";

interface Props {
  editor: Editor;
  comp: Composition;
  layer: Layer | undefined;
  path: string | null;
  time: number;
  selectedKeyframes: KeyframeRef[];
  onSelectKeyframes(k: KeyframeRef[]): void;
  onSelectPath(path: string): void;
  onSeek(t: number): void;
}

const DIM_COLORS = ["#ff6b81", "#4ade80", "#60a5fa"];
const DIM_NAMES = ["X", "Y", "Z"];

const toDims = (v: unknown): number[] | null => (typeof v === "number" ? [v] : Array.isArray(v) && v.every((n) => typeof n === "number") ? (v as number[]) : null);

/**
 * Value graph for one animated property. Drag keyframes (time + value) and the bezier
 * handles of each segment; the handles edit that segment's easing (like After Effects' value graph).
 */
export function GraphEditor({ editor, comp, layer, path, time, selectedKeyframes, onSelectKeyframes, onSelectPath, onSeek }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 600, h: 200 });
  /** Per property: dimensions the user toggled via the legend (otherwise: only the ones that change). */
  const [dimChoice, setDimChoice] = useState<Record<string, number[]>>({});
  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const paths = layer ? animatedPaths(layer) : [];
  if (!layer || paths.length === 0) {
    return (
      <div className="graph-empty" ref={wrapRef}>
        <p className="muted">Select an animated layer to see its curves. Animate a property with ◷ in Properties, or apply an Animate preset.</p>
      </div>
    );
  }
  const activePath = path && paths.includes(path) ? path : paths[0];
  const prop = getIn(layer, activePath) as { keyframes: Keyframe<unknown>[] };
  const kfs = isKeyframed(prop as never) ? prop.keyframes : [];
  const fallback = toDims(kfs[0]?.v) ? kfs[0].v : 0;
  const graphable = toDims(kfs[0]?.v) !== null;
  const D = comp.duration;
  const W = size.w;
  const H = Math.max(80, size.h - 30);
  const top = 26;

  // Show only the dimensions that actually move (X at 960 would flatten a small Y move),
  // unless the user picked dimensions in the legend.
  const dimCount = graphable ? (toDims(kfs[0].v) ?? []).length : 0;
  const varying = Array.from({ length: dimCount }, (_, d) => d).filter((d) => kfs.some((k) => Math.abs(toDims(k.v)![d] - toDims(kfs[0].v)![d]) > 1e-6));
  const visible = dimChoice[activePath] ?? (varying.length ? varying : Array.from({ length: dimCount }, (_, d) => d));
  const toggleDim = (d: number) => {
    const next = visible.includes(d) ? visible.filter((x) => x !== d) : [...visible, d].sort();
    if (next.length) setDimChoice({ ...dimChoice, [activePath]: next });
  };

  // Sample the curves and fit the vertical range to the visible dimensions.
  const N = Math.max(60, Math.round(W / 3));
  const samples: number[][] = [];
  let min = Infinity;
  let max = -Infinity;
  if (graphable) {
    for (let i = 0; i <= N; i++) {
      const d = toDims(sample(prop as never, (i / N) * D, fallback as never)) ?? [];
      samples.push(d);
      for (const dim of visible) {
        min = Math.min(min, d[dim]);
        max = Math.max(max, d[dim]);
      }
    }
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  }
  if (max - min < 1e-6) {
    min -= 1;
    max += 1;
  }
  const padV = (max - min) * 0.15;
  const vMin = min - padV;
  const vMax = max + padV;
  const x = (t: number) => (t / D) * W;
  const y = (v: number) => top + (1 - (v - vMin) / (vMax - vMin)) * H;
  const tAt = (px: number) => Math.min(D, Math.max(0, (px / W) * D));
  const vAt = (py: number) => vMin + (1 - (py - top) / H) * (vMax - vMin);
  const dims = dimCount;
  const isSel = (i: number) => selectedKeyframes.some((k) => k.layerId === layer.id && k.path === activePath && k.index === i);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const commit = (fn: (l: Layer) => Layer, transient: boolean) => editor.update((p) => editLayer(p, layer.id, fn, { compId: comp.id }), { transient });

  /** Drag a keyframe point: horizontal = time (snapped to frames), vertical = this dimension's value. */
  const dragKey = (i: number, dim: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const ref = { layerId: layer.id, path: activePath, index: i };
    onSelectKeyframes(e.shiftKey ? [...selectedKeyframes.filter((k) => !(k.path === ref.path && k.index === i)), ref] : [ref]);
    const base = layer;
    const baseKfs = kfs;
    const [x0, y0] = local(e);
    const lo = i > 0 ? baseKfs[i - 1].t + 1 / comp.fps : 0;
    const hi = i < baseKfs.length - 1 ? baseKfs[i + 1].t - 1 / comp.fps : D;
    let last: Layer = base;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const [px, py] = local(ev);
      if (!moved && Math.hypot(px - x0, py - y0) < 3) return;
      moved = true;
      let dx = px - x0;
      let dy = py - y0;
      if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      const k = baseKfs[i];
      const t = Math.round(Math.min(hi, Math.max(lo, k.t + (dx / W) * D)) * comp.fps) / comp.fps;
      const dv = -(dy / H) * (vMax - vMin);
      const vals = toDims(k.v)!.slice();
      vals[dim] = Number((vals[dim] + dv).toFixed(2));
      const v = typeof k.v === "number" ? vals[0] : vals;
      const next = baseKfs.map((kk, j) => (j === i ? { ...kk, t: Number(t.toFixed(3)), v } : kk));
      last = setIn(base, activePath, { keyframes: next });
      commit(() => last, true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) commit(() => last, false);
      else onSeek(kfs[i].t);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Drag a bezier handle of segment i (between keyframe i and i+1). */
  const dragHandle = (i: number, which: 0 | 1, dim: number, virtualDv: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const a = kfs[i];
    const b = kfs[i + 1];
    const v0 = toDims(a.v)![dim];
    const v1 = toDims(b.v)![dim];
    const dv = Math.abs(v1 - v0) > 1e-6 ? v1 - v0 : virtualDv;
    const start = easeToBezier(a.ease) ?? [0.4, 0, 0.2, 1];
    let last = start;
    const move = (ev: PointerEvent) => {
      const [px, py] = local(ev);
      const nx = Math.min(1, Math.max(0, (tAt(px) - a.t) / (b.t - a.t)));
      const ny = (vAt(py) - v0) / dv;
      const snap = (n: number) => (ev.shiftKey ? Math.round(n * 20) / 20 : Number(n.toFixed(3)));
      last = which === 0 ? [snap(nx), snap(ny), start[2], start[3]] : [start[0], start[1], snap(nx), snap(ny)];
      commit((l) => setKeyframeEase(l, activePath, i, last as [number, number, number, number]), true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      commit((l) => setKeyframeEase(l, activePath, i, last as [number, number, number, number]), false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const ticks = Array.from({ length: 5 }, (_, i) => vMin + ((i + 0.5) / 5) * (vMax - vMin));

  return (
    <div className="graph" ref={wrapRef}>
      <div className="graph-head">
        <select className="field-select" value={activePath} onChange={(e) => onSelectPath(e.target.value)}>
          {paths.map((p) => (
            <option key={p} value={p}>
              {layer.name ?? layer.id} › {p}
            </option>
          ))}
        </select>
        {Array.from({ length: dims }, (_, d) => (
          <button
            key={d}
            className={`legend ${visible.includes(d) ? "" : "off"}`}
            style={{ color: DIM_COLORS[d] }}
            onClick={() => toggleDim(d)}
            title={dims > 1 ? "Show / hide this dimension" : undefined}
          >
            ● {dims > 1 ? DIM_NAMES[d] : "value"}
          </button>
        ))}
        <span className="muted small grow">Drag points to retime / change values · drag ◯ handles to shape easing · Shift constrains</span>
      </div>
      {!graphable ? (
        <p className="muted graph-msg">This property ({activePath}) isn’t numeric, so it has no curve. Its keyframes are in the timeline.</p>
      ) : (
        <svg
          ref={svgRef}
          width={W}
          height={H + top + 4}
          className="graph-svg"
          onPointerDown={(e) => {
            onSelectKeyframes([]);
            onSeek(Math.round(tAt(local(e)[0]) * comp.fps) / comp.fps);
          }}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={0} x2={W} y1={y(v)} y2={y(v)} className="graph-grid" />
              <text x={4} y={y(v) - 3} className="graph-label">
                {Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)}
              </text>
            </g>
          ))}
          {visible.map((d) => (
            <polyline key={d} className="graph-curve" stroke={DIM_COLORS[d]} points={samples.map((s, i) => `${x((i / N) * D)},${y(s[d])}`).join(" ")} />
          ))}
          {/* bezier handles per segment, drawn on the dimension that moves the most */}
          {kfs.slice(0, -1).map((a, i) => {
            const b = kfs[i + 1];
            const va = toDims(a.v)!;
            const vb = toDims(b.v)!;
            let dim = visible[0];
            for (const d of visible) if (Math.abs(vb[d] - va[d]) > Math.abs(vb[dim] - va[dim])) dim = d;
            const bz = easeToBezier(a.ease);
            if (!bz) {
              return (
                <text key={i} x={(x(a.t) + x(b.t)) / 2} y={top + 12} className="graph-ease-name" textAnchor="middle">
                  {String(a.ease)}
                </text>
              );
            }
            const virtual = (vMax - vMin) * 0.25;
            const dv = Math.abs(vb[dim] - va[dim]) > 1e-6 ? vb[dim] - va[dim] : virtual;
            const h1: [number, number] = [x(a.t + bz[0] * (b.t - a.t)), y(va[dim] + bz[1] * dv)];
            const h2: [number, number] = [x(a.t + bz[2] * (b.t - a.t)), y(va[dim] + bz[3] * dv)];
            return (
              <g key={i}>
                <line className="graph-arm" x1={x(a.t)} y1={y(va[dim])} x2={h1[0]} y2={h1[1]} />
                <line className="graph-arm" x1={x(b.t)} y1={y(vb[dim])} x2={h2[0]} y2={h2[1]} />
                <circle className="graph-handle" cx={h1[0]} cy={h1[1]} r={5} onPointerDown={dragHandle(i, 0, dim, virtual)} />
                <circle className="graph-handle" cx={h2[0]} cy={h2[1]} r={5} onPointerDown={dragHandle(i, 1, dim, virtual)} />
              </g>
            );
          })}
          {kfs.map((k, i) =>
            toDims(k.v)!.map((v, d) => !visible.includes(d) ? null : (
              <rect
                key={`${i}-${d}`}
                className={`graph-key ${isSel(i) ? "sel" : ""} kind-${easeKind(k.ease)}`}
                x={x(k.t) - 5}
                y={y(v) - 5}
                width={10}
                height={10}
                transform={`rotate(45 ${x(k.t)} ${y(v)})`}
                style={{ stroke: DIM_COLORS[d] }}
                onPointerDown={dragKey(i, d)}
              >
                <title>
                  {k.t.toFixed(2)}s · {v.toFixed(1)}
                </title>
              </rect>
            )),
          )}
          <line className="graph-playhead" x1={x(time)} x2={x(time)} y1={0} y2={H + top} />
        </svg>
      )}
    </div>
  );
}
