// Builds the publishable `openeffects` npm package in apps/cli/dist/package:
//   bin/oe.mjs   the CLI, editor server and MCP server bundled into one file
//   web/dist     the built editor
//   examples/    the starter templates
// Native and font packages stay real dependencies. Run: pnpm --filter openeffects build:package
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const cliDir = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(cliDir, "../..");
const out = path.join(cliDir, "dist", "package");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "bin"), { recursive: true });

console.log("Building the editor…");
execFileSync("pnpm", ["--filter", "@openeffects/web", "build"], { cwd: root, stdio: "inherit" });
fs.cpSync(path.join(root, "apps/web/dist"), path.join(out, "web/dist"), { recursive: true });

console.log("Copying templates…");
for (const name of fs.readdirSync(path.join(root, "examples"))) {
  const src = path.join(root, "examples", name);
  if (!fs.statSync(src).isDirectory() || name === "showreel") continue;
  fs.cpSync(src, path.join(out, "examples", name), {
    recursive: true,
    filter: (f) => !/[/\\](renders|\.openeffects|\.git)([/\\]|$)|(AGENTS|CLAUDE)\.md$|\.mcp\.json$/.test(f),
  });
}

console.log("Bundling the CLI…");
const external = ["@napi-rs/canvas", "@fontsource/inter", "vite"];
await build({
  entryPoints: [path.join(cliDir, "src/index.ts")],
  outfile: path.join(out, "bin/oe.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external,
  legalComments: "none",
  // Bundled CommonJS dependencies call require().
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __oeCreateRequire } from "node:module";\nglobalThis.require ??= __oeCreateRequire(import.meta.url);' },
  logLevel: "warning",
});
fs.chmodSync(path.join(out, "bin/oe.mjs"), 0o755);

const cli = read("apps/cli/package.json");
const nodePkg = read("packages/node/package.json");
const rootPkg = read("package.json");
const registry = read("server.json");
if (registry.version !== cli.version || registry.packages[0].version !== cli.version) throw new Error(`server.json version must match ${cli.version}`);
const pkg = {
  name: "openeffects",
  version: cli.version,
  // Lets the MCP registry verify that server.json and this package belong together.
  mcpName: registry.name,
  description: rootPkg.description,
  keywords: ["motion-graphics", "animation", "after-effects", "lottie", "video", "mcp", "ai-agent", "claude-code", "codex", "claude-motion"],
  homepage: "https://github.com/PrisacariuRobert/OpenEffects#readme",
  repository: { type: "git", url: "git+https://github.com/PrisacariuRobert/OpenEffects.git" },
  bugs: "https://github.com/PrisacariuRobert/OpenEffects/issues",
  author: rootPkg.author,
  license: "MIT",
  type: "module",
  bin: { openeffects: "bin/oe.mjs", oe: "bin/oe.mjs" },
  files: ["bin", "web", "examples"],
  engines: { node: ">=20" },
  dependencies: Object.fromEntries(external.filter((d) => nodePkg.dependencies[d]).map((d) => [d, nodePkg.dependencies[d]])),
};
fs.writeFileSync(path.join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
for (const f of ["README.md", "LICENSE"]) fs.copyFileSync(path.join(root, f), path.join(out, f));

const size = (dir: string): number => fs.readdirSync(dir, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`Package ready in ${path.relative(root, out)} (${(size(out) / 1e6).toFixed(1)} MB). Try it: cd ${path.relative(root, out)} && npm pack`);
