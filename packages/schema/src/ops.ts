import type { Composition, Keyframe, Layer, Project } from "./schema.ts";

/*
 * Pure edit operations on a project. They never mutate their input; callers validate
 * the result before saving. Shared by the MCP server, the HTTP server and the UI.
 */

export class EditError extends Error {}

export function getComp(project: Project, compId?: string): Composition {
  if (compId === undefined) return project.compositions[0];
  const comp = project.compositions.find((c) => c.id === compId);
  if (!comp) throw new EditError(`Composition "${compId}" not found. Available: ${project.compositions.map((c) => c.id).join(", ")}`);
  return comp;
}

function withComp(project: Project, compId: string | undefined, fn: (comp: Composition) => Composition): Project {
  const target = getComp(project, compId);
  return { ...project, compositions: project.compositions.map((c) => (c === target ? fn(structuredClone(c)) : c)) };
}

function layerIndex(comp: Composition, id: string): number {
  const i = comp.layers.findIndex((l) => l.id === id);
  if (i < 0) throw new EditError(`Layer "${id}" not found in composition "${comp.id}". Layers: ${comp.layers.map((l) => l.id).join(", ") || "(none)"}`);
  return i;
}

export function addLayer(project: Project, layer: Layer, opts: { compId?: string; index?: number } = {}): Project {
  return withComp(project, opts.compId, (comp) => {
    if (comp.layers.some((l) => l.id === layer.id)) throw new EditError(`Layer id "${layer.id}" already exists`);
    const index = opts.index === undefined ? comp.layers.length : Math.max(0, Math.min(comp.layers.length, opts.index));
    comp.layers.splice(index, 0, layer);
    return comp;
  });
}

/**
 * Deep-merge `patch` into a layer. Objects merge recursively; arrays and keyframed
 * values are replaced wholesale; `null` deletes a key.
 */
export function updateLayer(project: Project, id: string, patch: Record<string, unknown>, opts: { compId?: string } = {}): Project {
  return withComp(project, opts.compId, (comp) => {
    const i = layerIndex(comp, id);
    comp.layers[i] = deepMerge(comp.layers[i], patch) as Layer;
    return comp;
  });
}

export function deleteLayer(project: Project, id: string, opts: { compId?: string } = {}): Project {
  return withComp(project, opts.compId, (comp) => {
    comp.layers.splice(layerIndex(comp, id), 1);
    return comp;
  });
}

export function moveLayer(project: Project, id: string, index: number, opts: { compId?: string } = {}): Project {
  return withComp(project, opts.compId, (comp) => {
    const [layer] = comp.layers.splice(layerIndex(comp, id), 1);
    comp.layers.splice(Math.max(0, Math.min(comp.layers.length, index)), 0, layer);
    return comp;
  });
}

/** Set keyframes on a dotted property path, e.g. "transform.position" or "font.size". */
export function setKeyframes(
  project: Project,
  layerId: string,
  property: string,
  keyframes: Keyframe<unknown>[],
  opts: { compId?: string } = {},
): Project {
  return withComp(project, opts.compId, (comp) => {
    const i = layerIndex(comp, layerId);
    const sorted = [...keyframes].sort((a, b) => a.t - b.t);
    const value = sorted.length === 1 && sorted[0].ease === undefined ? sorted[0].v : { keyframes: sorted };
    comp.layers[i] = setPath(comp.layers[i], property.split("."), value) as Layer;
    return comp;
  });
}

export function updateComposition(project: Project, patch: Record<string, unknown>, opts: { compId?: string } = {}): Project {
  if ("layers" in patch) throw new EditError("Use the layer tools to change layers");
  return withComp(project, opts.compId, (comp) => deepMerge(comp, patch) as Composition);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch) || !isPlainObject(base) || "keyframes" in patch) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = deepMerge(base[k], v);
  }
  return out;
}

function setPath(obj: unknown, path: string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const base = isPlainObject(obj) ? obj : {};
  return { ...base, [head]: setPath(base[head], rest, value) };
}

let counter = 0;
export function newId(prefix = "layer"): string {
  counter = (counter + 1) % 1296;
  return `${prefix}-${Date.now().toString(36).slice(-4)}${counter.toString(36)}`;
}
