import { useEffect, useState } from "react";
import { templateFields, type BrandKit, type Project } from "@openeffects/schema";
import { ColorField, Section, SelectField, TextField } from "./fields.tsx";
import { IconClose, IconPlus } from "./Icons.tsx";

const WEIGHTS = ["300", "400", "500", "600", "700", "800", "900"];
const STARTER: BrandKit = { colors: { primary: "#0a84ff", background: "#0b0b0c", text: "#ffffff" }, fonts: { heading: { family: "Inter", weight: 800 }, body: { family: "Inter", weight: 500 } } };

/** The project's brand kit (brand.json): what the agent uses instead of inventing a style. */
export function BrandPanel({ onAsk, onError }: { onAsk(prompt: string): void; onError(message: string): void }) {
  const [brand, setBrand] = useState<BrandKit | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    fetch("/api/brand")
      .then((r) => r.json())
      .then((d: { brand: BrandKit | null; error?: string }) => {
        setBrand(d.brand);
        if (d.error) onError(d.error);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [onError]);

  const change = (next: BrandKit) => {
    setBrand(next);
    setDirty(true);
  };
  const save = async () => {
    const r = await fetch("/api/brand", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(brand) });
    const d = (await r.json()) as { brand?: BrandKit; error?: string };
    if (!r.ok) return onError(d.error ?? "Couldn't save the brand kit");
    setBrand(d.brand ?? brand);
    setDirty(false);
  };

  if (!loaded) return null;
  return (
    <Section title="Brand kit" defaultOpen={!!brand}>
      {!brand ? (
        <div className="brand-empty">
          <p className="muted small hint">Save your colors, fonts, logo and tone once. The agent uses them in every animation of this project.</p>
          <button className="ghost small" onClick={() => change(STARTER)}>
            <IconPlus size={14} /> Create brand kit
          </button>
        </div>
      ) : (
        <div className="brand-kit">
          <div className="prop-row">
            <span className="prop-label">Name</span>
            <span className="prop-value">
              <TextField value={brand.name ?? ""} placeholder="Acme" onChange={(v) => change({ ...brand, name: v.trim() || undefined })} />
            </span>
          </div>
          <div className="brand-swatches">
            {Object.entries(brand.colors ?? {}).map(([name, color]) => (
              <div key={name} className="brand-swatch">
                <ColorField swatch value={color} onChange={(v) => change({ ...brand, colors: { ...brand.colors, [name]: v } })} />
                <span className="small">{name}</span>
                <button
                  className="icon-only"
                  aria-label={`Remove ${name}`}
                  onClick={() => {
                    const { [name]: _gone, ...rest } = brand.colors ?? {};
                    change({ ...brand, colors: rest });
                  }}
                >
                  <IconClose size={12} />
                </button>
              </div>
            ))}
            <button
              className="ghost small"
              onClick={() => {
                const names = ["secondary", "accent", "highlight", "muted", "surface"];
                const name = names.find((n) => !(n in (brand.colors ?? {}))) ?? `color${Object.keys(brand.colors ?? {}).length + 1}`;
                change({ ...brand, colors: { ...brand.colors, [name]: "#ff9f0a" } });
              }}
            >
              <IconPlus size={14} /> Color
            </button>
          </div>
          {(["heading", "body"] as const).map((role) => (
            <div key={role} className="prop-row">
              <span className="prop-label">{role === "heading" ? "Headings" : "Body"}</span>
              <span className="prop-value">
                <TextField value={brand.fonts?.[role]?.family ?? ""} placeholder="Inter" onChange={(v) => change({ ...brand, fonts: { ...brand.fonts, [role]: v.trim() ? { ...brand.fonts?.[role], family: v.trim() } : undefined } })} />
                <SelectField
                  value={String(brand.fonts?.[role]?.weight ?? (role === "heading" ? 800 : 500))}
                  options={WEIGHTS}
                  onChange={(v) => change({ ...brand, fonts: { ...brand.fonts, [role]: { family: brand.fonts?.[role]?.family ?? "Inter", weight: Number(v) } } })}
                />
              </span>
            </div>
          ))}
          <div className="prop-row">
            <span className="prop-label">Logo</span>
            <span className="prop-value">
              <TextField value={brand.logo ?? ""} placeholder="assets/logo.svg" onChange={(v) => change({ ...brand, logo: v.trim() || undefined })} />
            </span>
          </div>
          <div className="prop-row">
            <span className="prop-label">Voice</span>
            <span className="prop-value">
              <TextField multiline value={brand.voice ?? ""} placeholder="Short, confident, no exclamation marks" onChange={(v) => change({ ...brand, voice: v.trim() || undefined })} />
            </span>
          </div>
          <div className="brand-actions">
            <button className="primary small" disabled={!dirty} onClick={save}>
              {dirty ? "Save brand kit" : "Saved"}
            </button>
            <button className="ghost small" disabled={dirty} title="Save first" onClick={() => onAsk("Restyle this project with our brand kit (oe_get_brand): use its colors, fonts and logo, and rewrite any copy in its voice. Keep the timing and motion.")}>
              Apply with agent
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

/** {{field}} placeholders: preview them with sample values and batch-render one video per CSV row. */
export function TemplatePanel({ project, values, onValues, onBatch }: { project: Project; values: Record<string, string>; onValues(v: Record<string, string>): void; onBatch(): void }) {
  const fields = templateFields(project);
  return (
    <Section title={fields.length ? `Template fields (${fields.length})` : "Template fields"} defaultOpen={fields.length > 0}>
      {fields.length === 0 ? (
        <p className="muted small hint">
          Make personalized videos: write <code>{"{{name}}"}</code> in any text (or image path), then render one video per row of a CSV with <b>Export → Batch from CSV</b>.
        </p>
      ) : (
        <>
          <p className="muted small hint">Preview values (only shown in the viewer):</p>
          {fields.map((f) => (
            <div key={f} className="prop-row">
              <span className="prop-label mono">{`{{${f}}}`}</span>
              <span className="prop-value">
                <TextField value={values[f] ?? ""} placeholder={f} onChange={(v) => onValues({ ...values, [f]: v })} />
              </span>
            </div>
          ))}
          <div className="brand-actions">
            <button className="ghost small" onClick={onBatch}>
              Batch from CSV…
            </button>
          </div>
        </>
      )}
    </Section>
  );
}
