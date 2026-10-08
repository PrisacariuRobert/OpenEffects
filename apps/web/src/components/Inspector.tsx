import { useState } from "react";
import {
  EASE_NAMES,
  editLayer,
  getComp,
  getIn,
  isKeyframed,
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
  type Project,
} from "@openeffects/schema";
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
      <span className="prop-label">{label}</span>
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

function LayerInspector({ ctx, comp, onSelect }: { ctx: Ctx; comp: Composition; onSelect(id: string | null): void }) {
  const l = ctx.layer;
  const others = comp.layers.filter((o) => o.id !== l.id);
  const center: Vec2 = l.type === "path" ? [0, 0] : [comp.width / 2, comp.height / 2];
  return (
    <>
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

      {(l.type === "rect" || l.type === "ellipse" || l.type === "solid" || l.type === "image") && (
        <Section title="Shape">
          <PropRow ctx={ctx} label="Size" path="size" kind="vec2" fallback={l.type === "solid" ? [comp.width, comp.height] : [100, 100]} />
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

      <Section title="Transform">
        <PropRow ctx={ctx} label="Position" path="transform.position" kind="vec2" fallback={center} />
        <PropRow ctx={ctx} label="Scale" path="transform.scale" kind="scale" fallback={100} />
        <PropRow ctx={ctx} label="Rotation" path="transform.rotation" kind="number" fallback={0} suffix="°" />
        <PropRow ctx={ctx} label="Opacity" path="transform.opacity" kind="number" fallback={100} min={0} max={100} suffix="%" />
        <PropRow ctx={ctx} label="Anchor" path="transform.anchor" kind="vec2" fallback={[0, 0]} />
      </Section>

      {l.type === "text" && (
        <Section title="Text animation" defaultOpen={!!l.animator}>
          <TextAnimatorEditor ctx={ctx} />
        </Section>
      )}

      <Section title="Effects" defaultOpen={!!l.effects?.length}>
        <EffectsEditor ctx={ctx} />
      </Section>
    </>
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
          <LayerInspector ctx={ctx} comp={comp} onSelect={onSelect} />
        ) : (
          <>
            <CompInspector editor={editor} comp={comp} />
            <p className="muted small hint">Select a layer in the viewer or the timeline to edit it. Tip: ◷ animates a property, ◆ adds a keyframe at the playhead.</p>
          </>
        )}
      </div>
    </div>
  );
}
