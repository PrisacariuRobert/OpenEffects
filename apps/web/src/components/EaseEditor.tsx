import { useEffect, useRef, useState } from "react";
import { EASE_PRESETS, easeToBezier, resolveEase, type Easing } from "@openeffects/schema";

type Bezier = [number, number, number, number];

const SAVED_KEY = "oe.myEasings";
function loadSaved(): { name: string; ease: Bezier }[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
  } catch {
    return [];
  }
}
function storeSaved(list: { name: string; ease: Bezier }[]) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable
  }
}

/** Tiny curve icon for preset buttons and keyframe bars. */
export function CurveIcon({ ease, size = 30 }: { ease: Easing | undefined; size?: number }) {
  const f = resolveEase(ease);
  const pad = size * 0.18;
  const h = size - pad * 2;
  const pts = Array.from({ length: 25 }, (_, i) => {
    const x = i / 24;
    const y = ease === "hold" ? (x < 1 ? 0 : 1) : f(x);
    return `${pad + x * h},${size - pad - y * h}`;
  }).join(" ");
  return (
    <svg className="curve-icon" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <rect x={pad} y={pad} width={h} height={h} className="curve-box" />
      <polyline points={pts} />
    </svg>
  );
}

const W = 200; // editor square, in px
const PAD_Y = 60; // room above/below for overshoot and anticipation

/**
 * Cubic-bezier editor: drag the two handles (Shift snaps to 0.05), pick a preset, or save the
 * curve to "My easings" for reuse. The dot previews the motion.
 */
export function EaseEditor({ value, onChange, onClose }: { value: Easing | undefined; onChange(e: Easing): void; onClose(): void }) {
  const initial = easeToBezier(value);
  const [bez, setBez] = useState<Bezier | null>(initial);
  const [saved, setSaved] = useState(loadSaved);
  const svgRef = useRef<SVGSVGElement>(null);
  const [phase, setPhase] = useState(0);
  const current: Easing | undefined = bez ?? value;

  useEffect(() => setBez(easeToBezier(value)), [JSON.stringify(value)]);

  // Preview animation: a dot travels with the curve.
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      setPhase(((now - start) / 1400) % 1.4);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const toSvg = (x: number, y: number): [number, number] => [x * W, PAD_Y + (1 - y) * W];
  const fromEvent = (e: PointerEvent | React.PointerEvent, snap: boolean): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    let x = Math.min(1, Math.max(0, (e.clientX - r.left) / W));
    let y = 1 - (e.clientY - r.top - PAD_Y) / W;
    y = Math.max(-0.6, Math.min(1.6, y));
    if (snap) {
      x = Math.round(x * 20) / 20;
      y = Math.round(y * 20) / 20;
    }
    return [Number(x.toFixed(3)), Number(y.toFixed(3))];
  };

  const dragHandle = (which: 0 | 1) => (e: React.PointerEvent) => {
    e.preventDefault();
    const base: Bezier = bez ?? [0.4, 0, 0.2, 1];
    let last = base;
    const move = (ev: PointerEvent) => {
      const [x, y] = fromEvent(ev, ev.shiftKey);
      last = which === 0 ? [x, y, base[2], base[3]] : [base[0], base[1], x, y];
      setBez(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onChange(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const f = resolveEase(current);
  const p = Math.min(1, phase);
  const curvePts = Array.from({ length: 61 }, (_, i) => {
    const x = i / 60;
    const [sx, sy] = toSvg(x, current === "hold" ? 0 : f(x));
    return `${sx},${sy}`;
  }).join(" ");
  const [h0x, h0y] = bez ? toSvg(bez[0], bez[1]) : [0, 0];
  const [h1x, h1y] = bez ? toSvg(bez[2], bez[3]) : [0, 0];
  const [ax, ay] = toSvg(0, 0);
  const [bx, by] = toSvg(1, 1);
  const label = bez ? `cubic-bezier(${bez.join(", ")})` : String(value);

  return (
    <div className="ease-editor" onPointerDown={(e) => e.stopPropagation()}>
      <div className="ease-editor-head">
        <strong className="grow">Easing</strong>
        <button className="tiny" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="ease-editor-body">
        <svg ref={svgRef} width={W} height={W + PAD_Y * 2} className="bezier-box">
          <rect x={0} y={PAD_Y} width={W} height={W} className="bezier-area" />
          <line x1={0} y1={PAD_Y + W / 2} x2={W} y2={PAD_Y + W / 2} className="bezier-grid" />
          <line x1={W / 2} y1={PAD_Y} x2={W / 2} y2={PAD_Y + W} className="bezier-grid" />
          <polyline points={curvePts} className="bezier-curve" />
          {bez && (
            <>
              <line x1={ax} y1={ay} x2={h0x} y2={h0y} className="bezier-arm" />
              <line x1={bx} y1={by} x2={h1x} y2={h1y} className="bezier-arm" />
              <circle cx={h0x} cy={h0y} r={7} className="bezier-handle" onPointerDown={dragHandle(0)} />
              <circle cx={h1x} cy={h1y} r={7} className="bezier-handle" onPointerDown={dragHandle(1)} />
            </>
          )}
          {/* motion preview along the bottom */}
          <circle cx={8 + (W - 16) * (current === "hold" ? (p < 1 ? 0 : 1) : f(p))} cy={W + PAD_Y * 2 - 14} r={6} className="bezier-dot" />
        </svg>
        <div className="ease-side">
          {!bez && (
            <p className="muted small">
              “{String(value)}” is a physics-style curve. Drag isn’t available; pick a preset or{" "}
              <button className="link" onClick={() => setBez([0.34, 1.56, 0.64, 1])}>
                switch to a bezier
              </button>
              .
            </p>
          )}
          <div className="ease-presets">
            {EASE_PRESETS.map((pr) => (
              <button key={pr.name} className={`ease-preset ${JSON.stringify(pr.ease) === JSON.stringify(value) ? "active" : ""}`} onClick={() => onChange(pr.ease)} title={pr.name}>
                <CurveIcon ease={pr.ease} />
                <span>{pr.name}</span>
              </button>
            ))}
          </div>
          <div className="muted small my-easings-title">My easings</div>
          <div className="ease-presets">
            {saved.map((s, i) => (
              <span key={i} className="ease-preset saved">
                <button className="bare" onClick={() => onChange(s.ease)} title={s.ease.join(", ")}>
                  <CurveIcon ease={s.ease} />
                  <span>{s.name}</span>
                </button>
                <button
                  className="bare remove"
                  title="Remove"
                  onClick={() => {
                    const next = saved.filter((_, j) => j !== i);
                    setSaved(next);
                    storeSaved(next);
                  }}
                >
                  ×
                </button>
              </span>
            ))}
            {bez && (
              <button
                className="ease-preset add"
                onClick={() => {
                  const name = prompt("Name this easing", `Custom ${saved.length + 1}`);
                  if (!name) return;
                  const next = [...saved, { name, ease: bez }];
                  setSaved(next);
                  storeSaved(next);
                }}
              >
                + Save current
              </button>
            )}
          </div>
          <code className="ease-code">{label}</code>
        </div>
      </div>
    </div>
  );
}
