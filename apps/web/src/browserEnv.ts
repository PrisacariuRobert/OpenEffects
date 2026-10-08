import { collectFonts, collectImages, type RenderEnv } from "@openeffects/engine";
import type { Project } from "@openeffects/schema";

const images = new Map<string, HTMLImageElement>();

export const browserEnv: RenderEnv = {
  createSurface(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return { canvas, ctx: canvas.getContext("2d")! };
  },
  createPath: (d) => new Path2D(d),
  images,
};

/** Loads images and fonts the project needs. Resolves once everything is ready (or failed). */
export async function preload(project: Project, version: string): Promise<void> {
  const fonts = collectFonts(project).map((f) => document.fonts.load(`${f.style} ${f.weight} 32px "${f.family}"`).catch(() => []));
  const imgs = collectImages(project).map(
    (src) =>
      new Promise<void>((resolve) => {
        const key = src;
        const existing = images.get(key);
        if (existing?.dataset.version === version) return resolve();
        const img = new Image();
        img.dataset.version = version;
        img.onload = () => {
          images.set(key, img);
          resolve();
        };
        img.onerror = () => {
          images.delete(key);
          resolve();
        };
        img.src = `/api/assets/${src.split("/").map(encodeURIComponent).join("/")}?v=${version}`;
      }),
  );
  await Promise.all([...fonts, ...imgs]);
}
