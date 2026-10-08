import { useEffect, useRef, useState, type ReactNode } from "react";
import { parseColor } from "@openeffects/schema";

/** Commit modes: `transient` while dragging (preview only), final on release/blur. */
export type Commit<T> = (value: T, transient?: boolean) => void;

const fmt = (v: number, step: number) => {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return Number.isFinite(v) ? String(Number(v.toFixed(decimals))) : "0";
};

/**
 * Number input with an After Effects style "scrubby" label: drag horizontally to change the
 * value (Shift = ×10, Alt = ×0.1), click to type.
 */
export function NumberField({
  value,
  onChange,
  step = 1,
  min,
  max,
  label,
  suffix,
  width = 64,
}: {
  value: number;
  onChange: Commit<number>;
  step?: number;
  min?: number;
  max?: number;
  label?: string;
  suffix?: string;
  width?: number;
}) {
  const [text, setText] = useState(fmt(value, step));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(fmt(value, step));
  }, [value, step, focused]);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

  const scrub = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = value;
    let last = start;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      last = clamp(Number((start + dx * step * mult).toFixed(4)));
      onChange(last, true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("scrubbing");
      if (moved) onChange(last, false);
    };
    document.body.classList.add("scrubbing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const commitText = () => {
    const v = Number(text);
    if (Number.isFinite(v) && text.trim() !== "") onChange(clamp(v));
    else setText(fmt(value, step));
  };

  return (
    <span className="num">
      {label && (
        <span className="num-label" onPointerDown={scrub} title="Drag to change (Shift ×10, Alt ×0.1)">
          {label}
        </span>
      )}
      <input
        style={{ width }}
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commitText();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const v = clamp(value + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
            onChange(Number(v.toFixed(4)));
          }
        }}
      />
      {suffix && <span className="num-suffix">{suffix}</span>}
    </span>
  );
}

function toHex(color: string): { hex: string; alpha: number } {
  const c = parseColor(color) ?? [255, 255, 255, 1];
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return { hex: `#${h(c[0])}${h(c[1])}${h(c[2])}`, alpha: c[3] };
}

/** Color swatch (native picker) + alpha + editable text value. */
export function ColorField({ value, onChange }: { value: string; onChange: Commit<string> }) {
  const { hex, alpha } = toHex(value);
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const withAlpha = (h: string, a: number) => (a >= 0.999 ? h : `${h}${Math.round(a * 255).toString(16).padStart(2, "0")}`);
  return (
    <span className="color-field">
      <input type="color" value={hex} onInput={(e) => onChange(withAlpha((e.target as HTMLInputElement).value, alpha), true)} onChange={(e) => onChange(withAlpha(e.target.value, alpha))} />
      <input
        className="color-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => (parseColor(text) ? onChange(text) : setText(value))}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <NumberField value={Math.round(alpha * 100)} min={0} max={100} step={1} width={36} suffix="%" onChange={(a, tr) => onChange(withAlpha(hex, a / 100), tr)} />
    </span>
  );
}

export function SelectField<T extends string>({ value, options, onChange }: { value: T; options: (T | { value: T; label: string })[]; onChange(v: T): void }) {
  return (
    <select className="field-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => {
        const opt = typeof o === "string" ? { value: o, label: o } : o;
        return (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        );
      })}
    </select>
  );
}

export function TextField({ value, onChange, multiline, placeholder }: { value: string; onChange(v: string): void; multiline?: boolean; placeholder?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const props = {
    className: "text-field",
    value: text,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
    onBlur: () => text !== value && onChange(text),
  };
  return multiline ? (
    <textarea {...props} rows={Math.min(6, Math.max(2, text.split("\n").length))} />
  ) : (
    <input {...props} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
  );
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange(v: boolean): void; label?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" />
      {label}
    </label>
  );
}

export function Section({ title, children, actions, defaultOpen = true }: { title: string; children: ReactNode; actions?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`section ${open ? "open" : ""}`}>
      <header onClick={() => setOpen(!open)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span className="grow">{title}</span>
        <span onClick={(e) => e.stopPropagation()}>{actions}</span>
      </header>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

/** Keeps a ref to the latest value (for pointer handlers). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
