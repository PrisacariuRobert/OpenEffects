import { useRef } from "react";
import { collectKeyframeTimes, type Composition } from "@openeffects/schema";

interface Props {
  comp: Composition;
  time: number;
  playing: boolean;
  selected: string | null;
  onSeek(t: number): void;
  onTogglePlay(): void;
  onSelect(id: string | null): void;
}

const TYPE_ICON: Record<string, string> = {
  solid: "■",
  rect: "▭",
  ellipse: "●",
  path: "✎",
  text: "T",
  image: "▣",
  null: "✛",
  comp: "❒",
};

function formatTime(t: number, fps: number): string {
  const s = Math.floor(t);
  const f = Math.floor((t - s) * fps + 1e-6);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

export function Timeline({ comp, time, playing, selected, onSeek, onTogglePlay, onSelect }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pct = (t: number) => `${(Math.min(Math.max(t, 0), comp.duration) / comp.duration) * 100}%`;

  const seekFromEvent = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const frame = Math.round(p * comp.duration * comp.fps);
    onSeek(Math.min(frame / comp.fps, comp.duration - 1 / comp.fps));
  };
  const startScrub = (e: React.PointerEvent) => {
    seekFromEvent(e.clientX);
    const move = (ev: PointerEvent) => seekFromEvent(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const step = comp.duration > 20 ? 5 : comp.duration > 8 ? 1 : 0.5;
  const ticks: number[] = [];
  for (let t = 0; t <= comp.duration + 1e-6; t += step) ticks.push(t);
  // Like After Effects, the top of the list is the top of the stack.
  const layers = [...comp.layers].reverse();

  return (
    <div className="timeline">
      <div className="transport">
        <button className="icon-btn" onClick={() => onSeek(0)} title="Go to start (Home)">⏮</button>
        <button className="icon-btn play" onClick={onTogglePlay} title="Play/Pause (Space)">
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="timecode">{formatTime(time, comp.fps)}</span>
        <span className="muted">
          / {formatTime(comp.duration, comp.fps)} · {comp.width}×{comp.height} · {comp.fps} fps
        </span>
      </div>
      <div className="tl-grid">
        <div className="tl-names">
          <div className="tl-ruler-spacer" />
          {layers.map((l) => (
            <div
              key={l.id}
              className={`tl-name ${selected === l.id ? "sel" : ""} ${l.visible === false ? "hidden" : ""}`}
              onClick={() => onSelect(selected === l.id ? null : l.id)}
              title={`${l.type} · ${l.id}`}
            >
              <span className="tl-icon">{TYPE_ICON[l.type] ?? "?"}</span>
              <span className="tl-label">{l.name ?? l.id}</span>
              {l.matte && <span className="tl-tag">matte</span>}
              {l.parent && <span className="tl-tag">↳ {l.parent}</span>}
            </div>
          ))}
        </div>
        <div className="tl-tracks" ref={trackRef} onPointerDown={startScrub}>
          <div className="tl-ruler">
            {ticks.map((t) => (
              <span key={t} className="tick" style={{ left: pct(t) }}>
                {Number.isInteger(t) ? `${t}s` : ""}
              </span>
            ))}
          </div>
          {layers.map((l) => {
            const kfs = [...collectKeyframeTimes(l)];
            if (l.type === "text" && l.animator) {
              const start = (l.in ?? 0) + (l.animator.delay ?? 0);
              kfs.push(start);
            }
            return (
              <div key={l.id} className={`tl-row ${selected === l.id ? "sel" : ""}`}>
                <div
                  className={`tl-bar type-${l.type} ${l.visible === false ? "hidden" : ""}`}
                  style={{ left: pct(l.in ?? 0), width: `calc(${pct(l.out ?? comp.duration)} - ${pct(l.in ?? 0)})` }}
                />
                {kfs.map((t) => (
                  <span key={t} className="kf" style={{ left: pct(t) }} />
                ))}
              </div>
            );
          })}
          <div className="playhead" style={{ left: pct(time) }} />
        </div>
      </div>
    </div>
  );
}
