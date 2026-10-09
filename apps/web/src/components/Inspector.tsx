import { useEffect, useState } from "react";
import {
  ANIMATION_PRESETS,
  animatedPaths,
  behaviorTargets,
  type Behavior,
  EASE_NAMES,
  applyPreset,
  beatMarkers,
  editLayer,
  getComp,
  getIn,
  isKeyframed,
  isMediaLayer,
  keyframeIndexAt,
  removeKeyframe,
  sample,
  setIn,
  setValueAtTime,
  toggleAnimated,
  updateComposition,
  type Composition,
  type Effect,
  type Gradient,
  type Layer,
  type Marker,
  type MediaLayer,
  type Project,
} from "@openeffects/schema";
import { getMediaInfo } from "../browserEnv.ts";
import type { Editor } from "../editor.ts";
import { ColorField, NumberField, Section, SelectField, TextField, Toggle } from "./fields.tsx";
import { JsonEditor } from "./JsonEditor.tsx";

interface Props {
  editor: Editor;
  project: Project;
  compId: string;
  selected: string | null;
  time: number;
  onSeek(t: number): void;
  onSelect(id: string | null): void;
}

type Vec2 = [number, number];

interface Ctx {
  layer: Layer;
  comp: Composition;
  time: number;
  fps: number;
  /** Edit this layer; transient edits only preview. */
  edit(fn: (l: Layer) => Layer, transient?: boolean): void;
  seek(t: number): void;
}

const EFFECT_DEFAULTS: Record<Effect["type"], Effect> = {
  blur: { type: "blur", radius: 8 },
  glow: { type: "glow", radius: 24, intensity: 1 },
  dropShadow: { type: "dropShadow", distance: 10, softness: 20, color: "rgba(0,0,0,0.5)" },
  colorAdjust: { type: "colorAdjust", brightness: 100, contrast: 100, saturation: 100, hue: 0 },
};

/** One animatable property: stopwatch, value editor and keyframe navigation. */
function PropRow({
  ctx,
  label,
  path,
  kind,
  fallback,
  step = 1,
  min,
  max,
  suffix,
}: {
  ctx: Ctx;
  label: string;
  path: string;
  kind: "number" | "vec2" | "color" | "scale";
  fallback: unknown;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  const prop = getIn(ctx.layer, path);
  const animated = isKeyframed(prop as never);
  const value = sample(prop as never, ctx.time, fallback as never) as unknown;
  const set = (v: unknown, transient?: boolean) => ctx.edit((l) => setValueAtTime(l, path, ctx.time, v, ctx.fps), transient);
  const kfIndex = keyframeIndexAt(prop, ctx.time, ctx.fps);
  const times = animated ? (prop as { keyframes: { t: number }[] }).keyframes.map((k) => k.t) : [];
  const prev = [...times].reverse().find((t) => t < ctx.time - 0.5 / ctx.fps);
  const next = times.find((t) => t > ctx.time + 0.5 / ctx.fps);

  let field;
  if (kind === "number") field = <NumberField value={value as number} step={step} min={min} max={max} suffix={suffix} onChange={set} width={70} />;
  else if (kind === "color") field = <ColorField value={value as string} onChange={set} />;
  else if (kind === "scale" && typeof value === "number") {
    field = (
      <>
        <NumberField value={value} step={step} suffix="%" onChange={set} width={56} />
        <button className="tiny" title="Scale X and Y separately" onClick={() => set([value, value])}>⛓</button>
      </>
    );
  } else {
    const v = (Array.isArray(value) ? value : [value, value]) as Vec2;
    field = (
      <>
        <NumberField label="X" value={v[0]} step={step} onChange={(x, tr) => set([x, v[1]], tr)} width={56} />
        <NumberField label="Y" value={v[1]} step={step} onChange={(y, tr) => set([v[0], y], tr)} width={56} />
        {kind === "scale" && (
          <button className="tiny" title="Link X and Y" onClick={() => set(v[0])}>
            ⛓
          </button>
        )}
      </>
    );
  }

  return (
    <div className={`prop-row ${animated ? "animated" : ""}`}>
      <button
        className={`stopwatch ${animated ? "on" : ""}`}
        title={animated ? "Stop animating (keeps the current value)" : "Animate this property (adds a keyframe here)"}
        onClick={() => ctx.edit((l) => toggleAnimated(l, path, ctx.time, fallback))}
      >
        ◷
      </button>
      <span className="prop-label">
        {label}
        {ctx.layer.behaviors?.some((b) => b.property === path && b.enabled !== false) && (
          <span className="driven" title="Also driven by a behavior (see Behaviors)">
            ∿
          </span>
        )}
      </span>
      <span className="prop-value">{field}</span>
      {animated && (
        <span className="kf-nav">
          <button className="tiny" disabled={prev === undefined} onClick={() => prev !== undefined && ctx.seek(prev)} title="Previous keyframe">
            ‹
          </button>
          <button
            className={`tiny kf-toggle ${kfIndex >= 0 ? "on" : ""}`}
            title={kfIndex >= 0 ? "Remove keyframe" : "Add keyframe"}
            onClick={() => ctx.edit((l) => (kfIndex >= 0 ? removeKeyframe(l, path, kfIndex) : setValueAtTime(l, path, ctx.time, value, ctx.fps)))}
          >
            ◆
          </button>
          <button className="tiny" disabled={next === undefined} onClick={() => next !== undefined && ctx.seek(next)} title="Next keyframe">
            ›
          </button>
        </span>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="prop-row">
      <span className="stopwatch-spacer" />
      <span className="prop-label">{label}</span>
      <span className="prop-value">{children}</span>
    </div>
  );
}

/** Solid color or gradient fill. */
function FillEditor({ ctx, path, fallback }: { ctx: Ctx; path: string; fallback: string }) {
  const fill = getIn(ctx.layer, path) as string | Gradient | { keyframes: unknown[] } | undefined;
  const isGradient = typeof fill === "object" && fill !== null && "stops" in fill;
  const mode = isGradient ? (fill as Gradient).type : "color";
  const setMode = (m: string) => {
    if (m === mode) return;
    const color = isGradient ? (fill as Gradient).stops[0][1] : (sample(fill as never, ctx.time, fallback as never) as string);
    const next: unknown = m === "color" ? color : { type: m, stops: [[0, color], [1, "#6b56ff"]] };
    ctx.edit((l) => setIn(l, path, next));
  };
  return (
    <>
      <Row label="Type">
        <SelectField value={mode} options={[{ value: "color", label: "Color" }, { value: "linear", label: "Linear gradient" }, { value: "radial", label: "Radial gradient" }]} onChange={setMode} />
      </Row>
      {!isGradient && <PropRow ctx={ctx} label="Color" path={path} kind="color" fallback={fallback} />}
      {isGradient &&
        (fill as Gradient).stops.map(([offset, color], i) => (
          <Row key={i} label={`Stop ${i + 1}`}>
            <ColorField value={color} onChange={(c, tr) => ctx.edit((l) => setIn(l, `${path}.stops.${i}`, [offset, c]), tr)} />
            <NumberField value={Math.round(offset * 100)} min={0} max={100} suffix="%" width={36} onChange={(o, tr) => ctx.edit((l) => setIn(l, `${path}.stops.${i}`, [o / 100, color]), tr)} />
            {(fill as Gradient).stops.length > 2 && (
              <button className="tiny" title="Remove stop" onClick={() => ctx.edit((l) => setIn(l, `${path}.stops.${i}`, undefined))}>
                ×
              </button>
            )}
          </Row>
        ))}
      {isGradient && (
        <Row label="">
          <button className="ghost small" onClick={() => ctx.edit((l) => setIn(l, `${path}.stops`, [...(fill as Gradient).stops, [1, "#ffffff"]]))}>
            + Stop
          </button>
        </Row>
      )}
    </>
  );
}

function StrokeEditor({ ctx }: { ctx: Ctx }) {
  const stroke = getIn(ctx.layer, "stroke");
  if (!stroke) {
    return (
      <Row label="">
        <button className="ghost small" onClick={() => ctx.edit((l) => setIn(l, "stroke", { color: "#ffffff", width: 4 }))}>
          + Add stroke
        </button>
      </Row>
    );
  }
  return (
    <>
      <PropRow ctx={ctx} label="Color" path="stroke.color" kind="color" fallback="#ffffff" />
      <PropRow ctx={ctx} label="Width" path="stroke.width" kind="number" fallback={4} min={0} step={0.5} />
      <Row label="Caps">
        <SelectField value={(getIn(ctx.layer, "stroke.cap") as string) ?? "butt"} options={["butt", "round", "square"]} onChange={(v) => ctx.edit((l) => setIn(l, "stroke.cap", v))} />
        <button className="tiny" title="Remove stroke" onClick={() => ctx.edit((l) => setIn(l, "stroke", undefined))}>
          ×
        </button>
      </Row>
    </>
  );
}

function EffectsEditor({ ctx }: { ctx: Ctx }) {
  const effects = ctx.layer.effects ?? [];
  const [adding, setAdding] = useState<string>("");
  return (
    <>
      {effects.map((fx, i) => {
        const p = `effects.${i}`;
        return (
          <div className="effect-card" key={i}>
            <div className="effect-head">
              <strong>{fx.type}</strong>
              <span className="grow" />
              <button className="tiny" disabled={i === 0} title="Move up" onClick={() => ctx.edit((l) => ({ ...l, effects: swap(l.effects ?? [], i, i - 1) }))}>
                ↑
              </button>
              <button className="tiny" title="Remove effect" onClick={() => ctx.edit((l) => setIn(l, p, undefined))}>
                ×
              </button>
            </div>
            {fx.type === "blur" && <PropRow ctx={ctx} label="Radius" path={`${p}.radius`} kind="number" fallback={0} min={0} step={0.5} />}
            {fx.type === "glow" && (
              <>
                <PropRow ctx={ctx} label="Radius" path={`${p}.radius`} kind="number" fallback={20} min={0} />
                <PropRow ctx={ctx} label="Intensity" path={`${p}.intensity`} kind="number" fallback={1} min={0} step={0.05} />
                <PropRow ctx={ctx} label="Color" path={`${p}.color`} kind="color" fallback="#ffffff" />
              </>
            )}
            {fx.type === "dropShadow" && (
              <>
                <PropRow ctx={ctx} label="Color" path={`${p}.color`} kind="color" fallback="rgba(0,0,0,0.5)" />
                <PropRow ctx={ctx} label="Distance" path={`${p}.distance`} kind="number" fallback={10} />
                <PropRow ctx={ctx} label="Angle" path={`${p}.angle`} kind="number" fallback={135} suffix="°" />
                <PropRow ctx={ctx} label="Softness" path={`${p}.softness`} kind="number" fallback={20} min={0} />
              </>
            )}
            {fx.type === "colorAdjust" && (
              <>
                <PropRow ctx={ctx} label="Brightness" path={`${p}.brightness`} kind="number" fallback={100} suffix="%" />
                <PropRow ctx={ctx} label="Contrast" path={`${p}.contrast`} kind="number" fallback={100} suffix="%" />
                <PropRow ctx={ctx} label="Saturation" path={`${p}.saturation`} kind="number" fallback={100} suffix="%" />
                <PropRow ctx={ctx} label="Hue" path={`${p}.hue`} kind="number" fallback={0} suffix="°" />
              </>
            )}
          </div>
        );
      })}
      <Row label="">
        <select
          className="field-select"
          value={adding}
          onChange={(e) => {
            const t = e.target.value as Effect["type"];
            setAdding("");
            if (t) ctx.edit((l) => ({ ...l, effects: [...(l.effects ?? []), EFFECT_DEFAULTS[t]] }));
          }}
        >
          <option value="">+ Add effect…</option>
          <option value="glow">Glow</option>
          <option value="blur">Blur</option>
          <option value="dropShadow">Drop shadow</option>
          <option value="colorAdjust">Color adjust</option>
        </select>
      </Row>
    </>
  );
}

function swap<T>(arr: T[], i: number, j: number): T[] {
  const out = [...arr];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

function TextAnimatorEditor({ ctx }: { ctx: Ctx }) {
  const layer = ctx.layer as Extract<Layer, { type: "text" }>;
  const a = layer.animator;
  const set = (path: string, v: unknown, transient?: boolean) => ctx.edit((l) => setIn(l, `animator.${path}`, v), transient);
  if (!a) {
    return (
      <Row label="">
        <button
          className="ghost small"
          onClick={() =>
            ctx.edit((l) =>
              setIn(l, "animator", { by: "character", stagger: 0.04, duration: 0.6, ease: "easeOutCubic", from: { opacity: 0, offset: [0, 40] } }),
            )
          }
        >
          + Animate text in (per letter / word / line)
        </button>
      </Row>
    );
  }
  const from = a.from ?? {};
  return (
    <>
      <Row label="By">
        <SelectField value={a.by ?? "character"} options={["character", "word", "line"]} onChange={(v) => set("by", v)} />
        <SelectField value={a.order ?? "forward"} options={["forward", "reverse", "center", "random"]} onChange={(v) => set("order", v)} />
      </Row>
      <Row label="Timing">
        <NumberField label="Delay" value={a.delay ?? 0} step={0.05} onChange={(v, tr) => set("delay", v, tr)} width={44} />
        <NumberField label="Stagger" value={a.stagger ?? 0.04} min={0} step={0.01} onChange={(v, tr) => set("stagger", v, tr)} width={44} />
        <NumberField label="Dur" value={a.duration ?? 0.6} min={0.01} step={0.05} onChange={(v, tr) => set("duration", v, tr)} width={44} />
      </Row>
      <Row label="Ease">
        <SelectField value={typeof a.ease === "string" ? a.ease : "easeOutCubic"} options={EASE_NAMES.filter((e) => e !== "hold")} onChange={(v) => set("ease", v)} />
      </Row>
      <Row label="From">
        <NumberField label="Opacity" value={from.opacity ?? 100} min={0} max={100} onChange={(v, tr) => set("from.opacity", v, tr)} width={40} />
        <NumberField label="Blur" value={from.blur ?? 0} min={0} onChange={(v, tr) => set("from.blur", v, tr)} width={36} />
      </Row>
      <Row label="">
        <NumberField label="X" value={from.offset?.[0] ?? 0} onChange={(v, tr) => set("from.offset", [v, from.offset?.[1] ?? 0], tr)} width={40} />
        <NumberField label="Y" value={from.offset?.[1] ?? 0} onChange={(v, tr) => set("from.offset", [from.offset?.[0] ?? 0, v], tr)} width={40} />
        <NumberField label="Scale" value={from.scale ?? 100} onChange={(v, tr) => set("from.scale", v, tr)} width={40} />
        <NumberField label="Rot" value={from.rotation ?? 0} onChange={(v, tr) => set("from.rotation", v, tr)} width={36} />
      </Row>
      <Row label="">
        <button className="ghost small" onClick={() => ctx.edit((l) => setIn(l, "animator", undefined))}>
          Remove text animation
        </button>
      </Row>
    </>
  );
}

const BEHAVIOR_INFO: Record<Behavior["type"], { icon: string; name: string; hint: string }> = {
  wiggle: { icon: "∿", name: "Wiggle", hint: "Organic, random-looking motion" },
  oscillate: { icon: "〜", name: "Oscillate", hint: "Regular back-and-forth: pulse, float, sway" },
  drift: { icon: "↻", name: "Drift / spin", hint: "Constant change per second" },
  loop: { icon: "⟲", name: "Loop keyframes", hint: "Repeat this property's keyframes forever" },
  follow: { icon: "⇢", name: "Follow layer", hint: "Copy another layer's motion with a delay" },
};

const VEC_PATHS = new Set(["transform.position", "transform.anchor", "size"]);

/** A number or an [x, y] pair, depending on the property. */
function AmountField({ value, vec, onChange, step = 1 }: { value: number | [number, number] | undefined; vec: boolean; onChange(v: number | [number, number], transient?: boolean): void; step?: number }) {
  const v = value ?? 0;
  if (!vec) return <NumberField value={Array.isArray(v) ? v[0] : v} step={step} width={52} onChange={onChange} />;
  const pair: [number, number] = Array.isArray(v) ? v : [v, v];
  return (
    <>
      <NumberField label="X" value={pair[0]} step={step} width={44} onChange={(x, tr) => onChange([x, pair[1]], tr)} />
      <NumberField label="Y" value={pair[1]} step={step} width={44} onChange={(y, tr) => onChange([pair[0], y], tr)} />
    </>
  );
}

function defaultBehavior(type: Behavior["type"], layer: Layer, comp: Composition): Behavior | null {
  const other = comp.layers.find((l) => l.id !== layer.id);
  switch (type) {
    case "wiggle":
      return { type, property: "transform.position", amount: 10, frequency: 2 };
    case "oscillate":
      return { type, property: "transform.position", amplitude: [0, 15], frequency: 0.5 };
    case "drift":
      return { type, property: "transform.rotation", speed: 90 };
    case "loop": {
      const path = animatedPaths(layer)[0];
      return path ? { type, property: path, mode: "cycle" } : null;
    }
    case "follow":
      return other ? { type, property: "transform.position", layer: other.id, delay: 0.15 } : null;
  }
}

/** Procedural motion attached to properties (wiggle, oscillate, drift, loop, follow). */
function BehaviorsEditor({ ctx }: { ctx: Ctx }) {
  const list = ctx.layer.behaviors ?? [];
  const [adding, setAdding] = useState("");
  const set = (i: number, key: string, v: unknown, transient?: boolean) => ctx.edit((l) => setIn(l, `behaviors.${i}.${key}`, v), transient);
  const targets = behaviorTargets(ctx.layer);
  const animated = animatedPaths(ctx.layer);
  return (
    <>
      {list.length === 0 && <p className="muted small hint-inline">Behaviors add endless, procedural motion to a property without keyframes.</p>}
      {list.map((b, i) => {
        const info = BEHAVIOR_INFO[b.type];
        const options = (b.type === "loop" ? animated.map((p) => ({ path: p, label: p })) : targets).map((t) => ({ value: t.path, label: t.label }));
        if (!options.some((o) => o.value === b.property)) options.unshift({ value: b.property, label: b.property });
        const vec = VEC_PATHS.has(b.property) || (b.property === "transform.scale" && Array.isArray(getIn(ctx.layer, b.property)));
        return (
          <div className={`effect-card behavior ${b.enabled === false ? "disabled" : ""}`} key={i}>
            <div className="effect-head">
              <span className="behavior-icon">{info.icon}</span>
              <strong title={info.hint}>{info.name}</strong>
              <span className="grow" />
              <Toggle value={b.enabled !== false} onChange={(on) => set(i, "enabled", on ? undefined : false)} />
              <button className="tiny" title="Remove behavior" onClick={() => ctx.edit((l) => setIn(l, `behaviors.${i}`, undefined))}>
                ×
              </button>
            </div>
            <Row label="Property">
              <SelectField value={b.property} options={options} onChange={(v) => set(i, "property", v)} />
            </Row>
            {b.type === "wiggle" && (
              <>
                <Row label="Amount">
                  <AmountField value={b.amount} vec={vec} onChange={(v, tr) => set(i, "amount", v, tr)} />
                </Row>
                <Row label="Speed">
                  <NumberField value={b.frequency ?? 2} min={0.05} step={0.1} suffix="/s" width={44} onChange={(v, tr) => set(i, "frequency", v, tr)} />
                  <NumberField label="Detail" value={b.octaves ?? 1} min={1} max={4} width={28} onChange={(v, tr) => set(i, "octaves", Math.round(v) === 1 ? undefined : Math.round(v), tr)} />
                  <NumberField label="Seed" value={b.seed ?? 1} step={1} width={36} onChange={(v, tr) => set(i, "seed", Math.round(v), tr)} />
                  <button className="tiny" title="New random pattern" onClick={() => set(i, "seed", Math.floor(Math.random() * 9999))}>
                    🎲
                  </button>
                </Row>
              </>
            )}
            {b.type === "oscillate" && (
              <>
                <Row label="Amplitude">
                  <AmountField value={b.amplitude} vec={vec} onChange={(v, tr) => set(i, "amplitude", v, tr)} />
                </Row>
                <Row label="Wave">
                  <SelectField value={b.wave ?? "sine"} options={["sine", "triangle", "square", "saw"]} onChange={(v) => set(i, "wave", v === "sine" ? undefined : v)} />
                  <NumberField label="Freq" value={b.frequency ?? 1} min={0.05} step={0.05} suffix="Hz" width={40} onChange={(v, tr) => set(i, "frequency", v, tr)} />
                  <NumberField label="Phase" value={b.phase ?? 0} step={5} suffix="°" width={36} onChange={(v, tr) => set(i, "phase", v || undefined, tr)} />
                </Row>
              </>
            )}
            {b.type === "drift" && (
              <Row label="Per second">
                <AmountField value={b.speed} vec={vec} onChange={(v, tr) => set(i, "speed", v, tr)} />
              </Row>
            )}
            {b.type === "loop" && (
              <Row label="Mode">
                <SelectField value={b.mode ?? "cycle"} options={[{ value: "cycle", label: "Cycle (repeat)" }, { value: "pingpong", label: "Ping-pong (back and forth)" }]} onChange={(v) => set(i, "mode", v)} />
              </Row>
            )}
            {b.type === "follow" && (
              <>
                <Row label="Leader">
                  <SelectField value={b.layer} options={ctx.comp.layers.filter((l) => l.id !== ctx.layer.id).map((l) => ({ value: l.id, label: l.name ?? l.id }))} onChange={(v) => set(i, "layer", v)} />
                  <NumberField label="Delay" value={b.delay ?? 0.1} min={0} step={0.02} suffix="s" width={40} onChange={(v, tr) => set(i, "delay", v, tr)} />
                </Row>
                <Row label="Offset">
                  <AmountField value={b.offset} vec={vec} onChange={(v, tr) => set(i, "offset", v, tr)} />
                </Row>
              </>
            )}
            <Row label="When">
              <NumberField label="From" value={b.start ?? ctx.layer.in ?? 0} min={0} step={0.1} suffix="s" width={36} onChange={(v, tr) => set(i, "start", v, tr)} />
              <NumberField label="To" value={b.end ?? ctx.comp.duration} min={0} step={0.1} suffix="s" width={36} onChange={(v, tr) => set(i, "end", v >= ctx.comp.duration ? undefined : v, tr)} />
              {b.type !== "loop" && b.type !== "follow" && (
                <NumberField label="Fade in" value={b.fadeIn ?? 0} min={0} step={0.1} suffix="s" width={32} onChange={(v, tr) => set(i, "fadeIn", v || undefined, tr)} />
              )}
            </Row>
          </div>
        );
      })}
      <Row label="">
        <select
          className="field-select"
          value={adding}
          onChange={(e) => {
            const type = e.target.value as Behavior["type"];
            setAdding("");
            if (!type) return;
            const b = defaultBehavior(type, ctx.layer, ctx.comp);
            if (b) ctx.edit((l) => ({ ...l, behaviors: [...(l.behaviors ?? []), b] }));
          }}
        >
          <option value="">+ Add behavior…</option>
          {(Object.keys(BEHAVIOR_INFO) as Behavior["type"][]).map((t) => (
            <option key={t} value={t} disabled={!defaultBehavior(t, ctx.layer, ctx.comp)}>
              {BEHAVIOR_INFO[t].icon} {BEHAVIOR_INFO[t].name}
              {t === "loop" && animated.length === 0 ? " (animate something first)" : ""}
            </option>
          ))}
        </select>
      </Row>
    </>
  );
}

/** One-click animations applied at the playhead; they write normal, editable keyframes. */
function AnimatePresets({ ctx }: { ctx: Ctx }) {
  const [duration, setDuration] = useState(0.6);
  const groups: [string, "in" | "out" | "loop"][] = [
    ["In", "in"],
    ["Out", "out"],
    ["Loop", "loop"],
  ];
  return (
    <>
      {groups.map(([title, kind]) => (
        <div className="preset-group" key={kind}>
          <span className="preset-kind">{title}</span>
          <span className="preset-chips">
            {ANIMATION_PRESETS.filter((p) => p.kind === kind && (!p.textOnly || ctx.layer.type === "text")).map((p) => (
              <button
                key={p.id}
                className="preset-chip"
                title={`${p.description}${kind === "loop" ? " (from the playhead to the end)" : ` (starts at the playhead, ${duration}s)`}`}
                onClick={() => ctx.edit((l) => applyPreset(l, p.id, { comp: ctx.comp, time: ctx.time, duration }))}
              >
                {p.name}
              </button>
            ))}
          </span>
        </div>
      ))}
      <Row label="Length">
        <NumberField value={duration} min={0.1} max={5} step={0.05} suffix="s" width={44} onChange={(v) => setDuration(v)} />
        <span className="muted small">Presets start at the playhead · Ctrl+Z to undo</span>
      </Row>
    </>
  );
}

type MediaMeta = { duration: number; width?: number; height?: number; hasAudio?: boolean; hasVideo?: boolean };

/** Source, timing and sound of a video/audio layer, plus beat detection into markers. */
function MediaEditor({ ctx, layer, editor }: { ctx: Ctx; layer: MediaLayer; editor: Editor }) {
  const [info, setInfo] = useState<MediaMeta | null>((getMediaInfo(layer.src) as MediaMeta | undefined) ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`/api/media?src=${encodeURIComponent(layer.src)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => alive && setInfo(m))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, [layer.src]);
  const comp = ctx.comp;
  const speed = layer.speed ?? 1;
  const start = layer.in ?? 0;
  /** Composition time at which the media runs out (or the comp ends). */
  const mediaEnd = info ? start + (info.duration - (layer.trimStart ?? 0)) / speed : null;

  const detect = async (mode: "beats" | "onsets") => {
    setBusy(mode);
    setNote(null);
    try {
      const r = await fetch(`/api/beats?src=${encodeURIComponent(layer.src)}`);
      const data = (await r.json()) as { bpm?: number; beats?: number[]; onsets?: number[]; error?: string };
      if (!r.ok) throw new Error(data.error ?? "Beat detection failed");
      const label = mode === "beats" ? "beat" : "hit";
      const found = beatMarkers(layer, (mode === "beats" ? data.beats : data.onsets) ?? [], comp, label);
      editor.update((p) => {
        // Replace earlier markers of the same kind; keep the user's own markers.
        const keep = (comp.markers ?? []).filter((m) => !m.label?.startsWith(`${label} `));
        const markers = [...keep, ...found].sort((a, b) => a.t - b.t);
        return updateComposition(p, { markers: markers.length ? markers : null }, { compId: comp.id });
      });
      setNote(`${found.length} ${mode === "beats" ? "beat" : "hit"} markers${data.bpm ? ` · ~${Math.round(data.bpm)} BPM` : ""}`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Row label="Source">
        <TextField value={layer.src} onChange={(v) => ctx.edit((x) => setIn(x, "src", v))} />
      </Row>
      <p className="muted small media-info">
        {info
          ? [
              `${info.duration.toFixed(2)}s`,
              info.width && info.height ? `${info.width}×${info.height}` : null,
              info.hasAudio ? "sound" : layer.type === "video" ? "no sound" : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : "Media not found in the project folder"}
      </p>
      <Row label="Play">
        <NumberField label="From" value={layer.trimStart ?? 0} min={0} step={0.05} suffix="s" width={46} onChange={(v, tr) => ctx.edit((x) => setIn(x, "trimStart", v > 0 ? v : undefined), tr)} />
        <NumberField label="Speed" value={speed} min={0.1} max={16} step={0.05} suffix="×" width={40} onChange={(v, tr) => ctx.edit((x) => setIn(x, "speed", v === 1 ? undefined : v), tr)} />
      </Row>
      <Row label="Length">
        <button
          className="ghost small"
          disabled={!mediaEnd}
          title="End the layer where the media ends"
          onClick={() => mediaEnd && ctx.edit((x) => setIn(x, "out", mediaEnd >= comp.duration ? undefined : Math.round(mediaEnd * 1000) / 1000))}
        >
          Fit to media
        </button>
        {layer.type === "video" && <Toggle value={!!layer.loop} label="Loop" onChange={(v) => ctx.edit((x) => setIn(x, "loop", v || undefined))} />}
      </Row>
      {(layer.type === "audio" || info?.hasAudio) && (
        <>
          <PropRow ctx={ctx} label="Volume" path="volume" kind="number" fallback={100} min={0} max={200} suffix="%" />
          <Row label="Mute">
            <Toggle value={!!layer.muted} onChange={(v) => ctx.edit((x) => setIn(x, "muted", v || undefined))} />
            <span className="muted small">Muted layers are left out of exports</span>
          </Row>
          <Row label="Markers">
            <button className="ghost small" disabled={!!busy} title="Add a marker on every beat (steady tempo)" onClick={() => detect("beats")}>
              {busy === "beats" ? "Listening…" : "◆ Beats"}
            </button>
            <button className="ghost small" disabled={!!busy} title="Add a marker on every hit (drums, accents)" onClick={() => detect("onsets")}>
              {busy === "onsets" ? "Listening…" : "◆ Hits"}
            </button>
          </Row>
          {note && <p className="muted small media-info">{note}. Keyframes and layers snap to markers when dragged.</p>}
        </>
      )}
    </>
  );
}

function LayerInspector({ ctx, comp, editor, onSelect }: { ctx: Ctx; comp: Composition; editor: Editor; onSelect(id: string | null): void }) {
  const l = ctx.layer;
  const others = comp.layers.filter((o) => o.id !== l.id);
  const center: Vec2 = l.type === "path" ? [0, 0] : [comp.width / 2, comp.height / 2];
  return (
    <>
      {l.type !== "audio" && (
        <Section title="Animate">
          <AnimatePresets ctx={ctx} />
        </Section>
      )}
      <Section title="Layer">
        <Row label="Name">
          <TextField value={l.name ?? l.id} onChange={(v) => ctx.edit((x) => setIn(x, "name", v.trim() && v !== x.id ? v : undefined))} />
        </Row>
        <Row label="Visible">
          <Toggle value={l.visible !== false} onChange={(v) => ctx.edit((x) => setIn(x, "visible", v ? undefined : false))} />
          <span className="muted small">Blend</span>
          <SelectField
            value={l.blend ?? "normal"}
            options={["normal", "add", "screen", "multiply", "overlay", "lighten", "darken", "difference"]}
            onChange={(v) => ctx.edit((x) => setIn(x, "blend", v === "normal" ? undefined : v))}
          />
        </Row>
        <Row label="Time">
          <NumberField label="In" value={l.in ?? 0} min={0} step={0.05} suffix="s" width={46} onChange={(v, tr) => ctx.edit((x) => setIn(x, "in", v > 0 ? v : undefined), tr)} />
          <NumberField label="Out" value={l.out ?? comp.duration} min={0} step={0.05} suffix="s" width={46} onChange={(v, tr) => ctx.edit((x) => setIn(x, "out", v >= comp.duration ? undefined : v), tr)} />
        </Row>
        <Row label="Parent">
          <SelectField value={l.parent ?? ""} options={[{ value: "", label: "None" }, ...others.map((o) => ({ value: o.id, label: o.name ?? o.id }))]} onChange={(v) => ctx.edit((x) => setIn(x, "parent", v || undefined))} />
        </Row>
        <Row label="Matte">
          <SelectField
            value={l.matte?.layer ?? ""}
            options={[{ value: "", label: "None" }, ...others.map((o) => ({ value: o.id, label: o.name ?? o.id }))]}
            onChange={(v) => ctx.edit((x) => setIn(x, "matte", v ? { layer: v, ...(x.matte?.mode ? { mode: x.matte.mode } : {}) } : undefined))}
          />
          {l.matte && (
            <SelectField value={l.matte.mode ?? "alpha"} options={[{ value: "alpha", label: "Show inside" }, { value: "alphaInverted", label: "Show outside" }]} onChange={(v) => ctx.edit((x) => setIn(x, "matte.mode", v === "alpha" ? undefined : v))} />
          )}
          {l.matte && (
            <button className="tiny" title="Select the matte layer" onClick={() => onSelect(l.matte!.layer)}>
              →
            </button>
          )}
        </Row>
      </Section>

      {l.type === "text" && (
        <Section title="Text">
          <Row label="Text">
            <TextField multiline value={l.text} onChange={(v) => ctx.edit((x) => setIn(x, "text", v))} />
          </Row>
          <Row label="Font">
            <SelectField
              value={l.font?.family ?? "Inter"}
              options={["Inter", "Georgia", "Times New Roman", "Arial", "Courier New", "Impact"].includes(l.font?.family ?? "Inter") ? ["Inter", "Georgia", "Times New Roman", "Arial", "Courier New", "Impact"] : [l.font!.family!, "Inter"]}
              onChange={(v) => ctx.edit((x) => setIn(x, "font.family", v === "Inter" ? undefined : v))}
            />
            <SelectField
              value={String(l.font?.weight ?? 700)}
              options={["100", "200", "300", "400", "500", "600", "700", "800", "900"].map((w) => ({ value: w, label: `${w}` }))}
              onChange={(v) => ctx.edit((x) => setIn(x, "font.weight", Number(v)))}
            />
            <button className={`tiny ${l.font?.style === "italic" ? "active" : ""}`} title="Italic" onClick={() => ctx.edit((x) => setIn(x, "font.style", x.type === "text" && x.font?.style === "italic" ? undefined : "italic"))}>
              <em>I</em>
            </button>
          </Row>
          <PropRow ctx={ctx} label="Size" path="font.size" kind="number" fallback={96} min={1} />
          <Row label="Align">
            <SelectField value={l.align ?? "center"} options={["left", "center", "right"]} onChange={(v) => ctx.edit((x) => setIn(x, "align", v === "center" ? undefined : v))} />
            <NumberField label="Line" value={l.lineHeight ?? 1.2} step={0.05} min={0.5} width={40} onChange={(v, tr) => ctx.edit((x) => setIn(x, "lineHeight", v), tr)} />
          </Row>
          <PropRow ctx={ctx} label="Tracking" path="letterSpacing" kind="number" fallback={0} />
        </Section>
      )}

      {isMediaLayer(l) && (
        <Section title={l.type === "video" ? "Video" : "Audio"}>
          <MediaEditor ctx={ctx} layer={l} editor={editor} />
        </Section>
      )}

      {(l.type === "rect" || l.type === "ellipse" || l.type === "solid" || l.type === "image" || l.type === "video") && (
        <Section title="Shape">
          <PropRow
            ctx={ctx}
            label="Size"
            path="size"
            kind="vec2"
            fallback={l.type === "solid" ? [comp.width, comp.height] : l.type === "video" ? [getMediaInfo(l.src)?.width ?? comp.width, getMediaInfo(l.src)?.height ?? comp.height] : [100, 100]}
          />
          {l.type === "rect" && <PropRow ctx={ctx} label="Corners" path="radius" kind="number" fallback={0} min={0} />}
        </Section>
      )}

      {l.type === "path" && (
        <Section title="Path">
          <Row label="SVG d">
            <TextField multiline value={l.d} onChange={(v) => ctx.edit((x) => setIn(x, "d", v))} />
          </Row>
          <PropRow ctx={ctx} label="Trim start" path="trim.start" kind="number" fallback={0} min={0} max={100} suffix="%" />
          <PropRow ctx={ctx} label="Trim end" path="trim.end" kind="number" fallback={100} min={0} max={100} suffix="%" />
        </Section>
      )}

      {l.type === "comp" && (
        <Section title="Precomp">
          <Row label="Time offset">
            <NumberField value={l.timeOffset ?? 0} step={0.05} suffix="s" onChange={(v, tr) => ctx.edit((x) => setIn(x, "timeOffset", v || undefined), tr)} />
          </Row>
        </Section>
      )}

      {(l.type === "text" || l.type === "rect" || l.type === "ellipse" || l.type === "path" || l.type === "solid") && (
        <Section title={l.type === "solid" ? "Color" : "Fill"}>
          <FillEditor ctx={ctx} path={l.type === "solid" ? "color" : "fill"} fallback="#ffffff" />
        </Section>
      )}
      {(l.type === "text" || l.type === "rect" || l.type === "ellipse" || l.type === "path") && (
        <Section title="Stroke" defaultOpen={!!(l as { stroke?: unknown }).stroke}>
          <StrokeEditor ctx={ctx} />
        </Section>
      )}

      {l.type !== "audio" && (
        <Section title="Transform">
          <PropRow ctx={ctx} label="Position" path="transform.position" kind="vec2" fallback={center} />
          <PropRow ctx={ctx} label="Scale" path="transform.scale" kind="scale" fallback={100} />
          <PropRow ctx={ctx} label="Rotation" path="transform.rotation" kind="number" fallback={0} suffix="°" />
          <PropRow ctx={ctx} label="Opacity" path="transform.opacity" kind="number" fallback={100} min={0} max={100} suffix="%" />
          <PropRow ctx={ctx} label="Anchor" path="transform.anchor" kind="vec2" fallback={[0, 0]} />
        </Section>
      )}

      {l.type === "text" && (
        <Section title="Text animation" defaultOpen={!!l.animator}>
          <TextAnimatorEditor ctx={ctx} />
        </Section>
      )}

      <Section title="Behaviors" defaultOpen={!!l.behaviors?.length}>
        <BehaviorsEditor ctx={ctx} />
      </Section>

      {l.type !== "audio" && (
        <Section title="Effects" defaultOpen={!!l.effects?.length}>
          <EffectsEditor ctx={ctx} />
        </Section>
      )}
    </>
  );
}

/** The composition's markers: jump to, rename, recolor or delete them. */
function MarkersEditor({ editor, comp, onSeek }: { editor: Editor; comp: Composition; onSeek(t: number): void }) {
  const markers = comp.markers ?? [];
  const set = (next: Marker[]) => editor.update((p) => updateComposition(p, { markers: next.length ? next : null }, { compId: comp.id }));
  return (
    <Section title={`Markers${markers.length ? ` (${markers.length})` : ""}`} defaultOpen={markers.length > 0} actions={
      markers.length > 1 ? (
        <button className="tiny" title="Delete all markers" onClick={() => set([])}>
          Clear
        </button>
      ) : undefined
    }>
      {markers.length === 0 && <p className="muted small hint">Press M to drop a marker at the playhead, or use ◆ Beats on an audio layer. Drags snap to markers.</p>}
      <div className="marker-list">
        {markers.map((m, i) => (
          <div key={i} className="marker-item">
            <button className="tiny" title="Go to marker" onClick={() => onSeek(m.t)}>
              {m.t.toFixed(2)}s
            </button>
            <TextField value={m.label ?? ""} onChange={(v) => set(markers.map((x, j) => (j === i ? { ...x, label: v.trim() || undefined } : x)))} />
            <button className="tiny" title="Delete marker" onClick={() => set(markers.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

const PRESETS = [
  { label: "16:9", w: 1920, h: 1080 },
  { label: "9:16", w: 1080, h: 1920 },
  { label: "1:1", w: 1080, h: 1080 },
  { label: "4:5", w: 1080, h: 1350 },
  { label: "4K", w: 3840, h: 2160 },
];

function CompInspector({ editor, comp }: { editor: Editor; comp: Composition }) {
  const set = (patch: Record<string, unknown>, transient?: boolean) => editor.update((p) => updateComposition(p, patch, { compId: comp.id }), { transient });
  return (
    <Section title="Composition">
      <Row label="Name">
        <TextField value={comp.name ?? comp.id} onChange={(v) => set({ name: v })} />
      </Row>
      <Row label="Format">
        <span className="preset-row">
          {PRESETS.map((p) => (
            <button key={p.label} className={`tiny ${comp.width === p.w && comp.height === p.h ? "active" : ""}`} onClick={() => set({ width: p.w, height: p.h })}>
              {p.label}
            </button>
          ))}
        </span>
      </Row>
      <Row label="Size">
        <NumberField label="W" value={comp.width} min={16} max={8192} onChange={(v, tr) => set({ width: Math.round(v) }, tr)} width={56} />
        <NumberField label="H" value={comp.height} min={16} max={8192} onChange={(v, tr) => set({ height: Math.round(v) }, tr)} width={56} />
      </Row>
      <Row label="Timing">
        <SelectField value={String(comp.fps)} options={["24", "25", "30", "50", "60"].includes(String(comp.fps)) ? ["24", "25", "30", "50", "60"] : [String(comp.fps), "24", "25", "30", "50", "60"]} onChange={(v) => set({ fps: Number(v) })} />
        <span className="muted small">fps</span>
        <NumberField label="Length" value={comp.duration} min={0.1} step={0.1} suffix="s" width={44} onChange={(v, tr) => set({ duration: v }, tr)} />
      </Row>
      <Row label="Background">
        {comp.background ? (
          <>
            <ColorField value={comp.background} onChange={(v, tr) => set({ background: v }, tr)} />
            <button className="tiny" title="Transparent background" onClick={() => set({ background: null })}>
              ×
            </button>
          </>
        ) : (
          <button className="ghost small" onClick={() => set({ background: "#0b0d17" })}>
            Transparent: add a color
          </button>
        )}
      </Row>
    </Section>
  );
}

/** Visual property editor for the selected layer (or the composition), with a JSON escape hatch. */
export function Inspector({ editor, project, compId, selected, time, onSeek, onSelect }: Props) {
  const [mode, setMode] = useState<"visual" | "json">("visual");
  const comp = getComp(project, compId);
  const layer = selected ? comp.layers.find((l) => l.id === selected) : undefined;
  const ctx: Ctx | null = layer
    ? {
        layer,
        comp,
        time,
        fps: comp.fps,
        seek: onSeek,
        edit: (fn, transient) => editor.update((p) => editLayer(p, layer.id, fn, { compId }), { transient }),
      }
    : null;

  return (
    <div className="inspector">
      <div className="inspector-head">
        <strong className="grow">{layer ? (layer.name ?? layer.id) : (comp.name ?? comp.id)}</strong>
        <span className="muted small">{layer ? layer.type : "composition"}</span>
        <div className="seg">
          <button className={mode === "visual" ? "active" : ""} onClick={() => setMode("visual")}>
            Visual
          </button>
          <button className={mode === "json" ? "active" : ""} onClick={() => setMode("json")}>
            JSON
          </button>
        </div>
      </div>
      <div className="inspector-body">
        {mode === "json" ? (
          <JsonEditor editor={editor} project={project} compId={compId} selected={selected} />
        ) : ctx ? (
          <LayerInspector ctx={ctx} comp={comp} editor={editor} onSelect={onSelect} />
        ) : (
          <>
            <CompInspector editor={editor} comp={comp} />
            <MarkersEditor editor={editor} comp={comp} onSeek={onSeek} />
            <p className="muted small hint">Select a layer in the viewer or the timeline to edit it. Tip: ◷ animates a property, ◆ adds a keyframe at the playhead.</p>
          </>
        )}
      </div>
    </div>
  );
}
