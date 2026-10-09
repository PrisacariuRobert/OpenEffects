import type { Layer } from "./schema.ts";

export type MediaLayer = Extract<Layer, { type: "video" | "audio" }>;

export const isMediaLayer = (l: Layer): l is MediaLayer => l.type === "video" || l.type === "audio";

/**
 * Time inside the media file that a video/audio layer shows at composition time t:
 * (t - in) × speed + trimStart, looped for looping videos when the media duration is known.
 */
export function mediaSourceTime(layer: MediaLayer, t: number, mediaDuration?: number): number {
  const trim = layer.trimStart ?? 0;
  let ft = (t - (layer.in ?? 0)) * (layer.speed ?? 1) + trim;
  if (mediaDuration && mediaDuration > trim) {
    if (layer.type === "video" && layer.loop) ft = trim + ((((ft - trim) % (mediaDuration - trim)) + (mediaDuration - trim)) % (mediaDuration - trim));
    else ft = Math.min(ft, mediaDuration - 1e-3);
  }
  return Math.max(0, ft);
}

export const MEDIA_EXTENSIONS = {
  image: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"],
  video: [".mp4", ".webm", ".mov", ".m4v"],
  audio: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".flac"],
};

export function mediaKind(file: string): "image" | "video" | "audio" | null {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  for (const [kind, exts] of Object.entries(MEDIA_EXTENSIONS)) if (exts.includes(ext)) return kind as "image" | "video" | "audio";
  return null;
}

/** Composition time at which a media layer plays `fileTime` (inverse of mediaSourceTime, no loop). */
export function compTimeOfSource(layer: MediaLayer, fileTime: number): number {
  return (layer.in ?? 0) + (fileTime - (layer.trimStart ?? 0)) / (layer.speed ?? 1);
}

/**
 * Markers for detected beats/hits of a media layer: mapped to composition time and kept
 * within the layer's span and the composition.
 */
export function beatMarkers(layer: MediaLayer, fileTimes: number[], comp: { duration: number }, label = "beat"): { t: number; label: string }[] {
  const start = layer.in ?? 0;
  const end = Math.min(layer.out ?? comp.duration, comp.duration);
  return fileTimes
    .map((ft) => compTimeOfSource(layer, ft))
    .filter((t) => t >= start - 1e-6 && t <= end + 1e-6)
    .map((t, i) => ({ t: Math.round(t * 1000) / 1000, label: `${label} ${i + 1}` }));
}
