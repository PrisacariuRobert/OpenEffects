/**
 * Writes schema/project.schema.json from the Zod schema, so editors (VS Code etc.) can
 * autocomplete and validate project.oe.json files through their "$schema" field.
 * Run with: pnpm schema:json
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ProjectSchema } from "../src/schema.ts";

const out = path.resolve(import.meta.dirname, "../../../schema/project.schema.json");
const json = z.toJSONSchema(ProjectSchema, { unrepresentable: "any", io: "input", reused: "ref" });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ title: "OpenEffects project", ...json }, null, 2) + "\n");
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
