import type { Composition, Layer, Project } from "./schema.ts";

/*
 * What an agent turn changed, layer by layer, so the editor can show it and revert parts.
 */

export interface LayerChange {
  id: string;
  kind: "added" | "removed" | "changed";
  /** Changed top-level properties, dotted one level deep (e.g. transform.position, text, fill). */
  props: string[];
}

export interface CompDiff {
  compId: string;
  /** Composition settings that changed (width, duration, background…). */
  settings: string[];
  layers: LayerChange[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function changedProps(a: Layer, b: Layer): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    if (same(va, vb)) continue;
    if (k === "transform" && va && vb && typeof va === "object" && typeof vb === "object") {
      for (const sub of new Set([...Object.keys(va), ...Object.keys(vb)])) {
        if (!same((va as Record<string, unknown>)[sub], (vb as Record<string, unknown>)[sub])) out.push(`transform.${sub}`);
      }
    } else out.push(k);
  }
  return out;
}

/** Layer-level differences between two versions of a project, per composition. */
export function diffProjects(before: Project, after: Project): CompDiff[] {
  const out: CompDiff[] = [];
  const beforeComps = new Map(before.compositions.map((c) => [c.id, c]));
  for (const comp of after.compositions) {
    const prev = beforeComps.get(comp.id);
    if (!prev) {
      out.push({ compId: comp.id, settings: ["added"], layers: comp.layers.map((l) => ({ id: l.id, kind: "added", props: [] })) });
      continue;
    }
    const settings = (Object.keys({ ...prev, ...comp }) as (keyof Composition)[]).filter((k) => k !== "layers" && !same(prev[k], comp[k]));
    const prevLayers = new Map(prev.layers.map((l) => [l.id, l]));
    const nextIds = new Set(comp.layers.map((l) => l.id));
    const layers: LayerChange[] = [];
    for (const l of comp.layers) {
      const p = prevLayers.get(l.id);
      if (!p) layers.push({ id: l.id, kind: "added", props: [] });
      else {
        const props = changedProps(p, l);
        if (props.length) layers.push({ id: l.id, kind: "changed", props });
      }
    }
    for (const p of prev.layers) if (!nextIds.has(p.id)) layers.push({ id: p.id, kind: "removed", props: [] });
    if (settings.length || layers.length) out.push({ compId: comp.id, settings, layers });
  }
  return out;
}

/** Puts one layer back the way it was in `before` (re-adding, removing or restoring it). */
export function revertLayer(current: Project, before: Project, compId: string, layerId: string): Project {
  const prevComp = before.compositions.find((c) => c.id === compId);
  const prevLayer = prevComp?.layers.find((l) => l.id === layerId);
  return {
    ...current,
    compositions: current.compositions.map((c) => {
      if (c.id !== compId) return c;
      const at = c.layers.findIndex((l) => l.id === layerId);
      if (!prevLayer) return { ...c, layers: c.layers.filter((l) => l.id !== layerId) }; // it was added
      if (at >= 0) return { ...c, layers: c.layers.map((l) => (l.id === layerId ? prevLayer : l)) };
      // It was removed: put it back where it was, relative to the layers that remain.
      const prevIndex = prevComp!.layers.findIndex((l) => l.id === layerId);
      const before = prevComp!.layers.slice(0, prevIndex).map((l) => l.id);
      let insertAt = 0;
      c.layers.forEach((l, i) => {
        if (before.includes(l.id)) insertAt = i + 1;
      });
      const layers = [...c.layers];
      layers.splice(insertAt, 0, prevLayer);
      return { ...c, layers };
    }),
  };
}
