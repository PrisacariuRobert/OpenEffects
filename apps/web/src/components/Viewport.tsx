import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { renderFrame } from "@openeffects/engine";
import type { Composition, Project } from "@openeffects/schema";
import { browserEnv, preload } from "../browserEnv.ts";

interface Props {
  project: Project;
  comp: Composition;
  time: number;
  errors: string[];
}

/** Live preview: renders the current frame with the same engine used for export. */
export function Viewport({ project, comp, time, errors }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [ready, setReady] = useState(0);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reload fonts/images whenever the project changes, then re-render.
  useEffect(() => {
    let cancelled = false;
    preload(project, String(Date.now())).then(() => !cancelled && setReady((n) => n + 1));
    return () => {
      cancelled = true;
    };
  }, [project]);

  const pad = 32;
  const fit = Math.min((box.w - pad * 2) / comp.width, (box.h - pad * 2) / comp.height);
  const displayW = Math.max(1, Math.floor(comp.width * fit));
  const displayH = Math.max(1, Math.floor(comp.height * fit));
  const dpr = window.devicePixelRatio || 1;
  const renderScale = Math.min(1, fit * dpr);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || fit <= 0) return;
    const w = Math.max(1, Math.round(comp.width * renderScale));
    const h = Math.max(1, Math.round(comp.height * renderScale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d")!;
    try {
      renderFrame(ctx, project, { compId: comp.id, time: Math.min(time, comp.duration - 1e-6), scale: renderScale }, browserEnv);
    } catch (e) {
      console.error(e);
    }
  }, [project, comp, time, renderScale, fit, ready]);

  return (
    <div className="viewport" ref={wrapRef}>
      {fit > 0 && <canvas ref={canvasRef} className="stage" style={{ width: displayW, height: displayH }} />}
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
