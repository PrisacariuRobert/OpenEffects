import { useEffect, useLayoutEffect, useState } from "react";
import type { ProviderStatus } from "@openeffects/schema";
import { IconGrid, IconPlay, IconSparkles } from "./Icons.tsx";

export interface TourStep {
  /** CSS selector of the element to spotlight. */
  target: string;
  title: string;
  body: string;
  /** Runs before the step is shown (switch tabs, select a layer…). */
  before?: () => void;
}

type Rect = { x: number; y: number; w: number; h: number };

/**
 * Spotlight tour: dims the app except the step's target and explains it in a card.
 * The app stays usable underneath, so people can try things as they go.
 */
export function Tour({ steps, onDone }: { steps: TourStep[]; onDone(): void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const step = steps[i];

  useEffect(() => {
    step.before?.();
  }, [i]);

  // Track the target's position (it may move as panels open or the window resizes).
  useLayoutEffect(() => {
    let raf = 0;
    const measure = () => {
      const el = document.querySelector(step.target);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect((prev) => (prev && prev.x === r.x && prev.y === r.y && prev.w === r.width && prev.h === r.height ? prev : { x: r.x, y: r.y, w: r.width, h: r.height }));
      } else setRect(null);
      raf = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(raf);
  }, [step.target]);

  const next = () => (i < steps.length - 1 ? setI(i + 1) : onDone());
  const back = () => i > 0 && setI(i - 1);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
      else if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") back();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // Put the card on the side of the target with the most room.
  const W = window.innerWidth;
  const H = window.innerHeight;
  const card = { w: 340, h: 190 };
  const pad = 14;
  let pos = { left: (W - card.w) / 2, top: (H - card.h) / 2 };
  if (rect) {
    const room = { right: W - (rect.x + rect.w), left: rect.x, bottom: H - (rect.y + rect.h), top: rect.y };
    const best = (Object.keys(room) as (keyof typeof room)[]).reduce((a, b) => (room[b] > room[a] ? b : a));
    if (best === "right") pos = { left: rect.x + rect.w + pad, top: rect.y + rect.h / 2 - card.h / 2 };
    if (best === "left") pos = { left: rect.x - card.w - pad, top: rect.y + rect.h / 2 - card.h / 2 };
    if (best === "bottom") pos = { left: rect.x + rect.w / 2 - card.w / 2, top: rect.y + rect.h + pad };
    if (best === "top") pos = { left: rect.x + rect.w / 2 - card.w / 2, top: rect.y - card.h - pad };
    pos.left = Math.max(12, Math.min(W - card.w - 12, pos.left));
    pos.top = Math.max(12, Math.min(H - card.h - 12, pos.top));
  }

  return (
    <div className="tour" role="dialog" aria-label="Tour">
      {rect ? (
        <div className="tour-spot" style={{ left: rect.x - 6, top: rect.y - 6, width: rect.w + 12, height: rect.h + 12 }} />
      ) : (
        <div className="tour-dim" />
      )}
      <div className="tour-card" style={{ left: pos.left, top: pos.top, width: card.w }}>
        <div className="tour-progress">
          {steps.map((_, j) => (
            <span key={j} className={j === i ? "on" : j < i ? "done" : ""} />
          ))}
        </div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-actions">
          <button className="ghost small" onClick={onDone}>
            Skip tour
          </button>
          <span className="grow" />
          {i > 0 && (
            <button className="ghost small" onClick={back}>
              Back
            </button>
          )}
          <button className="primary small" onClick={next}>
            {i < steps.length - 1 ? `Next (${i + 1}/${steps.length})` : "Start creating"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** First-run welcome: pick a way to start, and check that an agent is set up. */
export function Welcome({
  providers,
  onDescribe,
  onTemplates,
  onTour,
  onSkip,
}: {
  providers: ProviderStatus[];
  onDescribe(): void;
  onTemplates(): void;
  onTour(): void;
  onSkip(): void;
}) {
  const ready = providers.filter((p) => p.available);
  return (
    <div className="modal-backdrop welcome-backdrop">
      <div className="modal welcome">
        <div className="welcome-hero">
          <span className="logo big" />
          <div>
            <h2>Welcome to OpenEffects</h2>
            <p className="muted">Motion graphics made by your AI agent, finished by you. How do you want to start?</p>
          </div>
        </div>
        <div className="welcome-choices">
          <button className="welcome-choice" onClick={onDescribe}>
            <span className="wc-icon blue"><IconSparkles size={18} /></span>
            <strong>Describe an animation</strong>
            <span className="muted small">Type what you want; your agent builds it on the timeline while you watch.</span>
          </button>
          <button className="welcome-choice" onClick={onTemplates}>
            <span className="wc-icon purple"><IconGrid size={18} /></span>
            <strong>Start from a template</strong>
            <span className="muted small">Logo reveals, kinetic type, lower thirds, social ads, charts, loops.</span>
          </button>
          <button className="welcome-choice" onClick={onTour}>
            <span className="wc-icon orange"><IconPlay size={16} /></span>
            <strong>Take the 1-minute tour</strong>
            <span className="muted small">See where everything is: canvas, AI, timeline, graph, presets, export.</span>
          </button>
        </div>
        <div className={`welcome-agents ${ready.length ? "ok" : "warn"}`}>
          {providers.length === 0 ? (
            "Checking for AI agents…"
          ) : ready.length ? (
            <>
              ✓ AI agent ready: <strong>{ready.map((p) => p.label).join(", ")}</strong>. Your own login is used; OpenEffects never sees your keys.
            </>
          ) : (
            <>
              No AI agent found yet. Install one and log in once in a terminal: <code>claude</code> (Claude Code), <code>codex login</code> (Codex) or{" "}
              <code>opencode auth login</code> (OpenCode, also free and local models). Everything else works without one.
            </>
          )}
        </div>
        <div className="welcome-foot">
          <button className="ghost small" onClick={onSkip}>
            Skip, I know my way around
          </button>
        </div>
      </div>
    </div>
  );
}
