import { useEffect, useRef, useState } from "react";
import { renderFrame } from "@openeffects/engine";
import { getComp, type Project } from "@openeffects/schema";
import { api } from "../api.ts";
import { browserEnv, preload } from "../browserEnv.ts";

interface Template {
  name: string;
  project: Project;
}

/** A live thumbnail: the template rendered by the real engine, animating on hover. */
function Thumb({ project }: { project: Project }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const comp = getComp(project);
    const canvas = ref.current!;
    const scale = Math.min(240 / comp.width, 150 / comp.height);
    canvas.width = Math.round(comp.width * scale);
    canvas.height = Math.round(comp.height * scale);
    let raf = 0;
    let cancelled = false;
    const draw = (t: number) => renderFrame(canvas.getContext("2d")!, project, { time: t, scale }, browserEnv);
    preload(project, "tpl").then(() => {
      if (cancelled) return;
      if (!hover) return draw(comp.duration * 0.75);
      const start = performance.now();
      const tick = (now: number) => {
        draw(((now - start) / 1000) % comp.duration);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [project, hover]);
  return <canvas ref={ref} className="thumb" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} />;
}

export function Templates({ onUse, onClose }: { onUse(project: Project): void; onClose(): void }) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  useEffect(() => {
    api<{ templates: Template[] }>("/api/templates")
      .then((r) => setTemplates(r.templates))
      .catch(() => setTemplates([]));
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong className="grow">Start from a template</strong>
          <button className="ghost small" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="muted small">
          Replaces the current project (you can undo with Ctrl+Z). Hover to preview. Then ask the agent to make it yours: "change the text to …, use our brand colors".
        </p>
        <div className="template-grid">
          {templates === null && <span className="muted">Loading…</span>}
          {templates?.map((t) => {
            const comp = getComp(t.project);
            return (
              <button key={t.name} className="template" onClick={() => onUse(t.project)}>
                <Thumb project={t.project} />
                <span className="template-name">{t.project.name ?? t.name}</span>
                <span className="muted small">
                  {comp.width}×{comp.height} · {comp.duration}s
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
