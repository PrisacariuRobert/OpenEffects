/** A drawable surface: works with HTMLCanvasElement, OffscreenCanvas and @napi-rs/canvas. */
export interface Surface {
  canvas: CanvasImageSource & { width: number; height: number };
  ctx: CanvasRenderingContext2D;
}

export interface ImageLike {
  width: number;
  height: number;
}

/** Everything the engine needs from its host (browser or Node). */
export interface RenderEnv {
  createSurface(width: number, height: number): Surface;
  createPath(d: string): Path2D;
  /** Preloaded images keyed by the layer `src` string. */
  images: Map<string, CanvasImageSource & ImageLike>;
}

/** Reuses offscreen surfaces between layers and frames. */
export class SurfacePool {
  private free = new Map<string, Surface[]>();
  constructor(private env: RenderEnv) {}

  /**
   * Returns a cleared surface at least width×height. Sizes are rounded up to multiples of
   * 64 so animated regions can reuse surfaces; callers draw from the top-left corner.
   */
  acquire(width: number, height: number): Surface {
    const w = Math.max(64, Math.ceil(width / 64) * 64);
    const h = Math.max(64, Math.ceil(height / 64) * 64);
    const key = `${w}x${h}`;
    const s = this.free.get(key)?.pop() ?? this.env.createSurface(w, h);
    resetContext(s.ctx);
    s.ctx.clearRect(0, 0, w, h);
    return s;
  }

  release(...surfaces: (Surface | undefined)[]): void {
    for (const s of surfaces) {
      if (!s) continue;
      const key = `${s.canvas.width}x${s.canvas.height}`;
      const list = this.free.get(key) ?? [];
      if (list.length < 8) list.push(s);
      this.free.set(key, list);
    }
  }
}

export function resetContext(ctx: CanvasRenderingContext2D): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.shadowColor = "rgba(0,0,0,0)";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}
