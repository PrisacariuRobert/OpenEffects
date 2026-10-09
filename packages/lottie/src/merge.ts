import { addLayer, getComp, uniqueLayerId, type Composition, type Layer, type Project } from "@openeffects/schema";

/**
 * Adds an imported project (e.g. from a Lottie file) to an existing one: its compositions
 * are added under unique ids and its main composition is placed as a precomp layer in the
 * target composition, scaled to fit and centered. Returns the new project and layer id.
 */
export function addAsPrecomp(target: Project, imported: Project, opts: { compId?: string; name?: string; time?: number } = {}): { project: Project; layerId: string; compId: string } {
  const host = getComp(target, opts.compId);
  const taken = new Set(target.compositions.map((c) => c.id));
  const base = (opts.name ?? imported.name ?? "lottie").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "lottie";
  const rename = new Map<string, string>();
  for (const c of imported.compositions) {
    let id = c === imported.compositions[0] ? base : `${base}-${c.id}`;
    for (let n = 2; taken.has(id); n++) id = `${c === imported.compositions[0] ? base : `${base}-${c.id}`}-${n}`;
    taken.add(id);
    rename.set(c.id, id);
  }
  const comps: Composition[] = imported.compositions.map((c) => ({
    ...c,
    id: rename.get(c.id)!,
    layers: c.layers.map((l) => (l.type === "comp" && rename.has(l.comp) ? { ...l, comp: rename.get(l.comp)! } : l)),
  }));
  const main = comps[0];
  let project: Project = { ...target, compositions: [...target.compositions, ...comps] };
  const layerId = uniqueLayerId(project, base, host.id);
  const fit = Math.min(1, host.width / main.width, host.height / main.height);
  const at = opts.time ?? 0;
  const layer: Layer = {
    id: layerId,
    type: "comp",
    comp: main.id,
    ...(opts.name ? { name: opts.name } : {}),
    ...(at > 0 ? { in: at } : {}),
    ...(at + main.duration < host.duration ? { out: Math.round((at + main.duration) * 1000) / 1000 } : {}),
    transform: { position: [host.width / 2, host.height / 2], ...(fit < 1 ? { scale: Math.round(fit * 1000) / 10 } : {}) },
  };
  project = addLayer(project, layer, { compId: host.id });
  return { project, layerId, compId: main.id };
}
