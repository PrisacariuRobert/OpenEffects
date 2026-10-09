import { collectFonts, collectImages, collectMedia, type MediaInfo, type RenderEnv } from "@openeffects/engine";
import type { Project } from "@openeffects/schema";

const images = new Map<string, HTMLImageElement>();
const videos = new Map<string, HTMLVideoElement>();
const mediaInfo = new Map<string, MediaInfo & { hasAudio?: boolean; hasVideo?: boolean }>();
const listeners = new Set<() => void>();

export const mediaUrl = (src: string) => `/api/assets/${src.split("/").map(encodeURIComponent).join("/")}`;

/** Video playback state, shared with the media controller. */
export const playback = { playing: false };

/** Re-render whenever a video finishes seeking to a requested frame. */
export function onMediaFrame(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function videoElement(src: string): HTMLVideoElement {
  let el = videos.get(src);
  if (!el) {
    el = document.createElement("video");
    el.src = mediaUrl(src);
    el.preload = "auto";
    el.muted = true; // audio of video layers is played by the media controller's own elements
    el.playsInline = true;
    el.crossOrigin = "anonymous";
    const notify = () => listeners.forEach((f) => f());
    const video = el;
    // "seeked" can fire before the new frame is drawable; redraw again once it is presented.
    const onSeeked = () => {
      notify();
      if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(() => notify());
      setTimeout(notify, 60);
    };
    el.addEventListener("seeked", onSeeked);
    el.addEventListener("loadeddata", notify);
    // Formats this browser can't decode (ProRes, or H.264 without proprietary codecs):
    // fall back to frames decoded by the server's ffmpeg.
    el.addEventListener("error", () => {
      undecodable.add(src);
      notify();
    });
    videos.set(src, el);
  }
  return el;
}

const undecodable = new Set<string>();
const serverFrames = new Map<string, HTMLImageElement>(); // `${src}@${frame}` → loaded frame
const lastServerFrame = new Map<string, HTMLImageElement>();
const pending = new Set<string>();

/** A server-decoded frame (quantized to 1/30 s); shows the nearest loaded frame meanwhile. */
function serverFrame(src: string, sourceTime: number): HTMLImageElement | undefined {
  const n = Math.round(sourceTime * 30);
  const key = `${src}@${n}`;
  const hit = serverFrames.get(key);
  if (hit) {
    lastServerFrame.set(src, hit);
    return hit;
  }
  if (!pending.has(key) && pending.size < 4) {
    pending.add(key);
    const img = new Image();
    img.onload = () => {
      pending.delete(key);
      serverFrames.set(key, img);
      if (serverFrames.size > 240) serverFrames.delete(serverFrames.keys().next().value!);
      listeners.forEach((f) => f());
    };
    img.onerror = () => pending.delete(key);
    img.src = `/api/videoframe?src=${encodeURIComponent(src)}&t=${(n / 30).toFixed(4)}`;
  }
  return lastServerFrame.get(src);
}

export function getMediaInfo(src: string) {
  return mediaInfo.get(src);
}

export const browserEnv: RenderEnv = {
  createSurface(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return { canvas, ctx: canvas.getContext("2d")! };
  },
  createPath: (d) => new Path2D(d),
  images,
  video: {
    frame(src, sourceTime) {
      const el = videoElement(src);
      if (undecodable.has(src)) {
        const img = serverFrame(src, sourceTime);
        return img;
      }
      if (el.readyState < 2) return undefined;
      // While paused, seek to the exact frame; while playing, the controller keeps it in sync.
      if (!playback.playing && Math.abs(el.currentTime - sourceTime) > 0.01 && !el.seeking) el.currentTime = sourceTime;
      return Object.assign(el, { width: el.videoWidth, height: el.videoHeight }) as HTMLVideoElement;
    },
    info: (src) => mediaInfo.get(src),
  },
};

/** Loads images, fonts and media info the project needs. Resolves once everything is ready (or failed). */
export async function preload(project: Project, version: string): Promise<void> {
  const fonts = collectFonts(project).map((f) => document.fonts.load(`${f.style} ${f.weight} 32px "${f.family}"`).catch(() => []));
  const imgs = collectImages(project).map(
    (src) =>
      new Promise<void>((resolve) => {
        const existing = images.get(src);
        if (existing?.dataset.version === version) return resolve();
        const img = new Image();
        img.dataset.version = version;
        img.onload = () => {
          images.set(src, img);
          resolve();
        };
        img.onerror = () => {
          images.delete(src);
          resolve();
        };
        img.src = `${mediaUrl(src)}?v=${version}`;
      }),
  );
  const media = collectMedia(project).map(async ({ src, type }) => {
    if (!mediaInfo.has(src)) {
      try {
        const r = await fetch(`/api/media?src=${encodeURIComponent(src)}`);
        if (r.ok) mediaInfo.set(src, await r.json());
      } catch {
        // offline or missing: the layer renders as nothing
      }
    }
    if (type === "video") videoElement(src);
  });
  await Promise.all([...fonts, ...imgs, ...media]);
}
