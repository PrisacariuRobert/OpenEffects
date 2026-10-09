import { useEffect, useRef, useState } from "react";
import { renderFrame } from "@openeffects/engine";
import { getComp, type Project, type VariationsRun } from "@openeffects/schema";
import { api } from "../api.ts";
import { browserEnv, preload } from "../browserEnv.ts";
import { IconClose } from "./Icons.tsx";

/** A looping, live preview of a project (renders frames as it plays). */
function LivePreview({ project }: { project: Project }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    preload(project, "variation").then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, [project]);
  useEffect(() => {
    if (!ready) return;
    const canvas = ref.current!;
    const comp = getComp(project);
    const scale = Math.min(1, 480 / comp.width);
    canvas.width = Math.round(comp.width * scale);
    canvas.height = Math.round(comp.height * scale);
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = ((now - t0) / 1000) % comp.duration;
      try {
        renderFrame(ctx, project, { time: t, scale }, browserEnv);
      } catch {
        // a broken version just stops drawing
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, project]);
  const comp = getComp(project);
  return <canvas ref={ref} className="variation-canvas" style={{ aspectRatio: `${comp.width} / ${comp.height}` }} />;
}

/** The versions of one prompt side by side; pick one to make it the project. */
export function Variations({ run, onUse, onClose, onError }: { run: VariationsRun; onUse(p: Project): void; onClose(): void; onError(m: string): void }) {
  const done = run.items.filter((i) => i.state === "done").length;
  const cost = run.items.reduce((a, i) => a + (i.costUsd ?? 0), 0);
  return (
    <div className="modal-backdrop" onClick={() => !run.running && onClose()}>
      <div className="modal variations" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="grow">
            <strong>{run.running ? `Making ${run.items.length} versions…` : `${done} of ${run.items.length} versions`}</strong>
            <div className="muted small variations-prompt">{run.prompt}</div>
          </div>
          {cost > 0 && <span className="pill">${cost.toFixed(3)}</span>}
          {run.running ? (
            <button className="ghost small" onClick={() => api("/api/variations/stop", {}).catch((e) => onError(e.message))}>
              Stop
            </button>
          ) : (
            <button className="icon-only" aria-label="Close" onClick={onClose}>
              <IconClose />
            </button>
          )}
        </div>
        <div className="variation-grid">
          {run.items.map((item) => (
            <div key={item.index} className={`variation ${item.state}`}>
              <div className="variation-stage">
                {item.project ? (
                  <LivePreview project={item.project} />
                ) : (
                  <div className="variation-wait">
                    {item.state === "working" ? <span className="spinner" /> : null}
                    <span className="small">{item.state === "failed" ? item.error : item.status}</span>
                  </div>
                )}
              </div>
              <div className="variation-foot">
                <span className="variation-dir">{item.direction.split(":")[0]}</span>
                {item.durationMs ? <span className="muted small">{Math.round(item.durationMs / 1000)}s</span> : null}
                <button className="primary small" disabled={!item.project} onClick={() => item.project && onUse(item.project)}>
                  Use this
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="muted small hint">Each version is the same request with a different creative direction, made in its own copy of the project. Using one replaces the current project (Ctrl+Z to go back).</p>
      </div>
    </div>
  );
}
