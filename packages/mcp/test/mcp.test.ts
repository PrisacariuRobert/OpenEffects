import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { blankProject } from "@openeffects/schema";
import { saveProject } from "@openeffects/node";
import { createMcpServer } from "../src/index.ts";

let file: string;
let client: Client;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oe-mcp-"));
  file = path.join(dir, "project.oe.json");
  saveProject(file, blankProject("Test"));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(file).connect(a);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(b);
});

const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const textOf = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");

describe("OpenEffects MCP server", () => {
  it("exposes the editing and rendering tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["oe_get_guide", "oe_get_project", "oe_add_layer", "oe_apply_preset", "oe_update_layer", "oe_set_keyframes", "oe_render_frame", "oe_render_contact_sheet", "oe_export"]) {
      expect(names).toContain(n);
    }
  });

  it("applies valid edits to the project file", async () => {
    const r = await client.callTool({ name: "oe_add_layer", arguments: { layer: { id: "dot", type: "ellipse", size: [40, 40], fill: "#ff0" } } });
    expect(r.isError).toBeFalsy();
    expect(read().compositions[0].layers.map((l: { id: string }) => l.id)).toEqual(["hello", "dot"]);
    await client.callTool({
      name: "oe_set_keyframes",
      arguments: { layerId: "dot", property: "transform.opacity", keyframes: [{ t: 0, v: 0 }, { t: 1, v: 100 }] },
    });
    expect(read().compositions[0].layers[1].transform.opacity.keyframes).toHaveLength(2);
    // `id` works as an alias, matching the other layer tools.
    const alias = await client.callTool({ name: "oe_set_keyframes", arguments: { id: "dot", property: "transform.rotation", keyframes: [{ t: 0, v: 0 }, { t: 1, v: 90 }] } });
    expect(alias.isError).toBeFalsy();
  });

  it("applies animation presets", async () => {
    const r = await client.callTool({ name: "oe_apply_preset", arguments: { layerId: "hello", preset: "pop-in", time: 0.5 } });
    expect(r.isError).toBeFalsy();
    expect(read().compositions[0].layers[0].transform.scale.keyframes[0]).toMatchObject({ t: 0.5, v: 0, ease: "easeOutBack" });
  });

  it("rejects invalid edits with a precise error and leaves the file untouched", async () => {
    const before = fs.readFileSync(file, "utf8");
    const r = await client.callTool({ name: "oe_update_layer", arguments: { id: "hello", patch: { fill: "blurple" } } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/layers\[0\]\.fill/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("returns rendered frames as images", async () => {
    const r = await client.callTool({ name: "oe_render_frame", arguments: { time: 1, width: 320 } });
    const img = (r.content as { type: string; mimeType?: string }[]).find((c) => c.type === "image");
    expect(img?.mimeType).toBe("image/png");
  });
});
