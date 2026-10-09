import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createCanvas, GlobalFonts, loadImage, Path2D, type Image } from "@napi-rs/canvas";
import { collectImages, collectMedia, type RenderEnv, type Surface } from "@openeffects/engine";
import { NodeVideoSource } from "./media.ts";
import type { Project } from "@openeffects/schema";

const require = createRequire(import.meta.url);
let bundledFontsRegistered = false;
const registeredDirs = new Set<string>();

/** Registers the bundled Inter family plus any fonts in `<project>/fonts`. */
export function registerFonts(projectDir?: string): void {
  if (!bundledFontsRegistered) {
    bundledFontsRegistered = true;
    try {
      const filesDir = path.join(path.dirname(require.resolve("@fontsource/inter/package.json")), "files");
      for (const f of fs.readdirSync(filesDir)) {
        if (/^inter-(latin|latin-ext)-\d+-(normal|italic)\.woff2$/.test(f)) GlobalFonts.registerFromPath(path.join(filesDir, f), "Inter");
      }
    } catch {
      // Fall back to system fonts.
    }
  }
  if (projectDir) {
    const fontsDir = path.join(projectDir, "fonts");
    if (!registeredDirs.has(fontsDir) && fs.existsSync(fontsDir)) {
      registeredDirs.add(fontsDir);
      for (const f of fs.readdirSync(fontsDir)) {
        if (/\.(ttf|otf|woff2?)$/i.test(f)) GlobalFonts.registerFromPath(path.join(fontsDir, f));
      }
    }
  }
}

export function createSurface(width: number, height: number): Surface {
  const canvas = createCanvas(width, height);
  return { canvas: canvas as unknown as Surface["canvas"], ctx: canvas.getContext("2d") as unknown as CanvasRenderingContext2D };
}

export interface NodeEnv extends RenderEnv {
  projectDir: string;
  /** Decode the video frames needed at composition time t. Call before renderFrame. */
  prepare(t: number, compId?: string): Promise<void>;
  /** Stop video decoders. */
  dispose(): void;
}

const imageCache = new Map<string, { mtime: number; image: Image }>();

export async function createNodeEnv(project: Project, projectDir: string): Promise<NodeEnv> {
  registerFonts(projectDir);
  const images = new Map<string, Image>();
  for (const src of collectImages(project)) {
    const file = path.resolve(projectDir, src);
    try {
      const mtime = fs.statSync(file).mtimeMs;
      let entry = imageCache.get(file);
      if (!entry || entry.mtime !== mtime) {
        entry = { mtime, image: await loadImage(file) };
        imageCache.set(file, entry);
      }
      images.set(src, entry.image);
    } catch {
      // Missing images render as nothing; validation of assets is reported elsewhere.
    }
  }
  const hasVideo = project.compositions.some((c) => c.layers.some((l) => l.type === "video"));
  const videos = hasVideo ? new NodeVideoSource(project, projectDir) : undefined;
  await videos?.init();
  return {
    projectDir,
    createSurface,
    createPath: (d) => new Path2D(d) as unknown as globalThis.Path2D,
    images: images as unknown as RenderEnv["images"],
    video: videos ? { frame: videos.frame, info: videos.infoOf } : undefined,
    prepare: async (t, compId) => {
      await videos?.prepare(t, compId);
    },
    dispose: () => videos?.dispose(),
  };
}

export function missingAssets(project: Project, projectDir: string): string[] {
  const srcs = [...collectImages(project), ...collectMedia(project).map((m) => m.src)];
  return [...new Set(srcs)].filter((src) => !fs.existsSync(path.resolve(projectDir, src)));
}
