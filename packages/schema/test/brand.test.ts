import { describe, expect, it } from "vitest";
import { brandBrief, fillTemplate, parseCsv, templateFields, validateBrand, validateProject, type Project } from "../src/index.ts";

const project: Project = {
  version: 1,
  compositions: [
    { id: "main", width: 400, height: 300, fps: 30, duration: 2, layers: [
      { id: "hi", type: "text", text: "Happy birthday, {{name}}!" },
      { id: "sub", type: "text", text: "{{ city }} · {{name}}" },
      { id: "pic", type: "image", src: "assets/{{photo}}" },
    ] },
  ],
};

describe("templates", () => {
  it("finds placeholders and fills them per row", () => {
    expect(templateFields(project).sort()).toEqual(["city", "name", "photo"]);
    const filled = fillTemplate(project, { name: "Ana", city: "Lisbon", photo: "ana.png" });
    const layers = filled.compositions[0].layers;
    expect(layers[0].type === "text" && layers[0].text).toBe("Happy birthday, Ana!");
    expect(layers[1].type === "text" && layers[1].text).toBe("Lisbon · Ana");
    expect(layers[2].type === "image" && layers[2].src).toBe("assets/ana.png");
    expect(validateProject(filled).ok).toBe(true);
    // Unknown fields stay as written; the original is untouched.
    expect(fillTemplate("{{missing}}", {})).toBe("{{missing}}");
    expect(project.compositions[0].layers[0].type === "text" && project.compositions[0].layers[0].text).toContain("{{name}}");
  });

  it("parses CSV with quotes, commas, newlines and a BOM", () => {
    const rows = parseCsv('﻿name,quote,score\r\nAna,"Hello, ""world""",10\nBo,"two\nlines",\n\n');
    expect(rows).toEqual([
      { name: "Ana", quote: 'Hello, "world"', score: "10" },
      { name: "Bo", quote: "two\nlines", score: "" },
    ]);
    expect(parseCsv("")).toEqual([]);
  });
});

describe("brand kits", () => {
  it("validates and summarizes", () => {
    const ok = validateBrand({ name: "Acme", colors: { primary: "#ff3366", text: "white" }, fonts: { heading: { family: "Inter", weight: 800 } }, logo: "assets/logo.svg", voice: "Short and warm." });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(brandBrief(ok.brand)).toMatch(/Acme[\s\S]*primary #ff3366[\s\S]*Inter 800[\s\S]*assets\/logo.svg[\s\S]*Short and warm/);
    const bad = validateBrand({ colors: { primary: "not-a-color" }, extra: 1 });
    expect(bad.ok).toBe(false);
  });
});
