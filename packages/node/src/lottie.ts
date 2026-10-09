import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { exportLottie, importLottie } from "@openeffects/lottie";
import { getComp, type Project } from "@openeffects/schema";
import { registerFonts } from "./canvas.ts";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };

/** A canvas context with the project's fonts, for measuring text. */
function measureContext(projectDir: string): CanvasRenderingContext2D {
  registerFonts(projectDir);
  return createCanvas(8, 8).getContext("2d") as unknown as CanvasRenderingContext2D;
}

/** Exports a composition to a Lottie JSON file. Images are embedded. */
export async function exportLottieFile(project: Project, projectDir: string, opts: { out?: string; compId?: string } = {}): Promise<{ out: string; warnings: string[]; bytes: number }> {
  const comp = getComp(project, opts.compId);
  const images = new Map<string, { dataUrl: string; width: number; height: number }>();
  for (const c of project.compositions) {
    for (const l of c.layers) {
      if (l.type !== "image" || images.has(l.src)) continue;
      const file = path.resolve(projectDir, l.src);
      if (!fs.existsSync(file)) continue;
      const data = fs.readFileSync(file);
      const img = await loadImage(data).catch(() => null);
      if (!img) continue;
      images.set(l.src, { dataUrl: `data:${MIME[path.extname(file).toLowerCase()] ?? "image/png"};base64,${data.toString("base64")}`, width: img.width, height: img.height });
    }
  }
  const { lottie, warnings } = exportLottie(project, { compId: comp.id, ctx: measureContext(projectDir), readImage: (src) => images.get(src) ?? null });
  const out = opts.out ?? path.join(projectDir, "renders", `${comp.id}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const json = JSON.stringify(lottie);
  fs.writeFileSync(out, json);
  return { out, warnings, bytes: Buffer.byteLength(json) };
}

/**
 * Converts a Lottie JSON file into a project. Embedded and external images are copied into
 * `<projectDir>/assets/`. Returns the project; the caller decides whether to save or merge it.
 */
export function importLottieFile(file: string, projectDir: string, opts: { compId?: string } = {}): { project: Project; warnings: string[] } {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  return importLottieData(json, projectDir, { ...opts, baseDir: path.dirname(file), name: path.basename(file, path.extname(file)) });
}

export function importLottieData(json: unknown, projectDir: string, opts: { compId?: string; baseDir?: string; name?: string } = {}): { project: Project; warnings: string[] } {
  const assetsDir = path.join(projectDir, "assets");
  const prefix = (opts.name ?? "lottie").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 30) || "lottie";
  const save = (base: string, data: Uint8Array, ext: string) => {
    fs.mkdirSync(assetsDir, { recursive: true });
    let name = `${prefix}-${base}.${ext}`;
    for (let n = 2; fs.existsSync(path.join(assetsDir, name)); n++) name = `${prefix}-${base}-${n}.${ext}`;
    fs.writeFileSync(path.join(assetsDir, name), data);
    return `assets/${name}`;
  };
  return importLottie(json, {
    compId: opts.compId,
    ctx: measureContext(projectDir),
    saveImage: save,
    resolveImage: (dir, file) => {
      if (!opts.baseDir) return null;
      const src = path.resolve(opts.baseDir, dir, file);
      // Only files next to the Lottie file (no escaping its folder).
      if (!src.startsWith(path.resolve(opts.baseDir) + path.sep) || !fs.existsSync(src)) return null;
      const ext = path.extname(src).slice(1).toLowerCase() || "png";
      return save(path.basename(src, path.extname(src)).replace(/[^A-Za-z0-9_-]+/g, "_"), fs.readFileSync(src), ext);
    },
  });
}
