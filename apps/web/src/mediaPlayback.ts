import { useEffect, useRef } from "react";
import { isActive } from "@openeffects/engine";
import { isMediaLayer, mediaSourceTime, sample, type Composition } from "@openeffects/schema";
import { getMediaInfo, mediaUrl, playback, videoElement } from "./browserEnv.ts";

/**
 * Plays audio (and the sound of video layers) in sync with the timeline during playback,
 * and keeps video elements running so frames are drawn live. Corrects drift, applies
 * (keyframed) volume, speed, mute, and pauses everything when playback stops.
 */
export function useMediaPlayback(comp: Composition | null, time: number, playing: boolean, muted: boolean) {
  const sounds = useRef(new Map<string, HTMLAudioElement>()); // by layer id

  useEffect(() => {
    playback.playing = playing;
    if (!playing) {
      for (const a of sounds.current.values()) a.pause();
      if (comp) for (const l of comp.layers) if (l.type === "video") videoElement(l.src).pause();
    }
  }, [playing, comp]);

  useEffect(() => {
    if (!comp) return;
    const live = new Set<string>();
    for (const l of comp.layers) {
      if (!isMediaLayer(l)) continue;
      const info = getMediaInfo(l.src);
      const active = playing && isActive(l, comp, time) && l.visible !== false;
      const st = mediaSourceTime(l, time, info?.duration);
      const ended = info && !(l.type === "video" && l.loop) && st >= info.duration - 0.02;
      const sync = (el: HTMLMediaElement) => {
        if (!active || ended) {
          if (!el.paused) el.pause();
          return;
        }
        el.playbackRate = l.speed ?? 1;
        if (el.paused) {
          el.currentTime = st;
          void el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - st) > 0.2) {
          el.currentTime = st; // loops, jumps, preview range wraps
        }
      };
      if (l.type === "video") sync(videoElement(l.src));
      if (l.type === "audio" || info?.hasAudio) {
        live.add(l.id);
        let a = sounds.current.get(l.id);
        if (!a || !a.src.endsWith(mediaUrl(l.src))) {
          a?.pause();
          a = new Audio(mediaUrl(l.src));
          a.preload = "auto";
          sounds.current.set(l.id, a);
        }
        a.muted = muted || !!l.muted;
        a.volume = Math.max(0, Math.min(1, sample(l.volume, time, 100) / 100));
        sync(a);
      }
    }
    for (const [id, a] of sounds.current) {
      if (!live.has(id)) {
        a.pause();
        sounds.current.delete(id);
      }
    }
  }, [comp, time, playing, muted]);

  useEffect(
    () => () => {
      for (const a of sounds.current.values()) a.pause();
    },
    [],
  );
}

const waveCache = new Map<string, Promise<{ perSecond: number; peaks: number[] } | null>>();

/** Waveform peaks for a media file (cached; null if it has no audio). */
export function loadWaveform(src: string) {
  let p = waveCache.get(src);
  if (!p) {
    p = fetch(`/api/waveform?src=${encodeURIComponent(src)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    waveCache.set(src, p);
  }
  return p;
}
