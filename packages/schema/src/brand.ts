import { z } from "zod";
import { isColor } from "./color.ts";
import type { Project } from "./schema.ts";

/*
 * Brand kit (brand.json next to project.oe.json): the colors, fonts, logo and voice every
 * animation in the project should use. Agents read it before designing; the editor edits it.
 */

const BrandColor = z.string().refine(isColor, { message: "Expected a color like #ff3366" });
const BrandFont = z.strictObject({
  family: z.string().min(1),
  weight: z.number().int().min(100).max(900).optional(),
});

export const BrandKitSchema = z.strictObject({
  name: z.string().optional().describe("Brand or product name"),
  colors: z.record(z.string(), BrandColor).optional().describe('Named colors, e.g. { "primary": "#0a84ff", "background": "#0b0b0c", "text": "#ffffff" }'),
  fonts: z.strictObject({ heading: BrandFont.optional(), body: BrandFont.optional() }).optional(),
  logo: z.string().optional().describe("Path of the logo in the project, e.g. assets/logo.svg"),
  voice: z.string().max(2000).optional().describe("Tone of voice and copy rules, e.g. 'Short, confident, no exclamation marks'"),
});
export type BrandKit = z.infer<typeof BrandKitSchema>;

export function validateBrand(data: unknown): { ok: true; brand: BrandKit } | { ok: false; errors: string[] } {
  const r = BrandKitSchema.safeParse(data);
  if (r.success) return { ok: true, brand: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

/** A short brief for agents. */
export function brandBrief(b: BrandKit): string {
  const lines = [`Brand kit${b.name ? ` for ${b.name}` : ""}: use these instead of inventing a palette or fonts.`];
  if (b.colors && Object.keys(b.colors).length) lines.push(`Colors: ${Object.entries(b.colors).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  if (b.fonts?.heading) lines.push(`Headings: ${b.fonts.heading.family}${b.fonts.heading.weight ? ` ${b.fonts.heading.weight}` : ""}.`);
  if (b.fonts?.body) lines.push(`Body text: ${b.fonts.body.family}${b.fonts.body.weight ? ` ${b.fonts.body.weight}` : ""}.`);
  if (b.logo) lines.push(`Logo: ${b.logo} (an image layer; keep its proportions).`);
  if (b.voice) lines.push(`Voice: ${b.voice}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- data-driven templates

const FIELD = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** Placeholder names used anywhere in the project: {{name}}, {{ price }}… */
export function templateFields(project: Project): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") for (const m of v.matchAll(FIELD)) found.add(m[1]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(project);
  return [...found];
}

/** Replaces {{field}} placeholders in every string (text, colors, image paths…) with row values. */
export function fillTemplate<T>(value: T, row: Record<string, string>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(FIELD, (all, key: string) => (key in row ? row[key] : all));
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** RFC 4180-style CSV → rows keyed by the header line. Handles quotes, commas and newlines in fields. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}
