import { describe, expect, it } from "vitest";
import { diffProjects, revertLayer, type Project } from "../src/index.ts";

const before: Project = {
  version: 1,
  compositions: [{ id: "main", width: 400, height: 300, fps: 30, duration: 2, layers: [
    { id: "bg", type: "solid", color: "#000" },
    { id: "title", type: "text", text: "Hello", transform: { position: [200, 150] } },
    { id: "old", type: "rect", size: [10, 10] },
  ] }],
};
const after: Project = {
  version: 1,
  compositions: [{ id: "main", width: 400, height: 300, fps: 30, duration: 3, layers: [
    { id: "bg", type: "solid", color: "#000" },
    { id: "title", type: "text", text: "Hi", transform: { position: [200, 100] } },
    { id: "new", type: "ellipse", size: [20, 20] },
  ] }],
};

describe("diff", () => {
  it("lists added, removed and changed layers with their properties", () => {
    const [d] = diffProjects(before, after);
    expect(d.settings).toEqual(["duration"]);
    expect(d.layers).toEqual([
      { id: "title", kind: "changed", props: ["text", "transform.position"] },
      { id: "new", kind: "added", props: [] },
      { id: "old", kind: "removed", props: [] },
    ]);
    expect(diffProjects(before, before)).toEqual([]);
  });

  it("reverts one layer at a time", () => {
    let p = revertLayer(after, before, "main", "title");
    expect(p.compositions[0].layers[1]).toEqual(before.compositions[0].layers[1]);
    p = revertLayer(p, before, "main", "new");
    expect(p.compositions[0].layers.map((l) => l.id)).toEqual(["bg", "title"]);
    p = revertLayer(p, before, "main", "old");
    expect(p.compositions[0].layers.map((l) => l.id)).toEqual(["bg", "title", "old"]);
    expect(diffProjects(before, p)[0].layers).toEqual([]);
  });
});
