import fs from "node:fs";
import path from "node:path";
import { fillTemplate, validateBrand, validateProject, type BrandKit, type Project } from "@openeffects/schema";
import { exportVideo, type ExportFormat } from "./render.ts";

export const BRAND_FILE = "brand.json";

/** The project's brand kit, or null when it has none. Throws on an invalid file. */
export function readBrand(projectDir: string): BrandKit | null {
  const file = path.join(projectDir, BRAND_FILE);
  if (!fs.existsSync(file)) return null;
  const r = validateBrand(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!r.ok) throw new Error(`brand.json has errors:\n- ${r.errors.join("\n- ")}`);
  return r.brand;
}

export function saveBrand(projectDir: string, brand: unknown): BrandKit {
  const r = validateBrand(brand);
  if (!r.ok) throw new Error(`Invalid brand kit:\n- ${r.errors.join("\n- ")}`);
  fs.writeFileSync(path.join(projectDir, BRAND_FILE), JSON.stringify(r.brand, null, 2) + "\n");
  return r.brand;
}

const slug = (s: string) => s.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").toLowerCase().slice(0, 60);

export interface BatchOptions {
  format?: ExportFormat;
  compId?: string;
  /** Output folder. Default <project>/renders/batch. */
  outDir?: string;
  /** File name template, e.g. "{{name}}-promo". Default: the first column, else row-N. */
  name?: string;
  scale?: number;
  onRow?: (index: number, total: number, file: string) => void;
  onProgress?: (row: number, frame: number, frames: number) => void;
  signal?: AbortSignal;
}

/** Renders one video per data row, filling {{field}} placeholders from the row. */
export async function renderBatch(project: Project, projectDir: string, rows: Record<string, string>[], opts: BatchOptions = {}): Promise<{ files: string[]; errors: string[] }> {
  const format = opts.format ?? "mp4";
  const outDir = opts.outDir ?? path.join(projectDir, "renders", "batch");
  fs.mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  const errors: string[] = [];
  const used = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    if (opts.signal?.aborted) break;
    const row = rows[i];
    const filled = fillTemplate(project, row);
    const valid = validateProject(filled);
    if (!valid.ok) {
      errors.push(`Row ${i + 1}: ${valid.errors[0]}`);
      continue;
    }
    const firstCol = Object.values(row)[0] ?? "";
    let base = slug(opts.name ? fillTemplate(opts.name, row) : firstCol) || `row-${i + 1}`;
    for (let n = 2; used.has(base); n++) base = `${base}-${n}`;
    used.add(base);
    const out = path.join(outDir, `${base}.${format === "png" ? "" : format}`.replace(/\.$/, ""));
    await exportVideo(filled, projectDir, {
      out,
      format,
      compId: opts.compId,
      scale: opts.scale ?? (format === "gif" ? 0.5 : 1),
      signal: opts.signal,
      onProgress: (f, total) => opts.onProgress?.(i, f, total),
    });
    files.push(out);
    opts.onRow?.(i, rows.length, out);
  }
  return { files, errors };
}
