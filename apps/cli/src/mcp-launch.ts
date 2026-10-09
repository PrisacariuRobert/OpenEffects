import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { McpLaunch } from "@openeffects/node";

const require = createRequire(import.meta.url);
const self = fileURLToPath(import.meta.url);

/** True when running from the published single-file build (npx openeffects), not the TypeScript source. */
export const bundled = !self.endsWith(".ts");

/** Where the published build keeps the editor and the starter templates. */
export const packageDir = path.resolve(path.dirname(self), "..");

/** How agents should launch this CLI's MCP server (`oe mcp <dir>`) for a project. */
export function mcpLaunch(projectDir: string): McpLaunch {
  const dir = path.resolve(projectDir);
  if (bundled && /[/\\]_npx[/\\]/.test(self)) {
    // Run with `npx openeffects`: npm's cache can be cleaned, so agents go through npx too.
    const { version } = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as { version: string };
    const args = ["-y", `openeffects@${version}`, "mcp", dir];
    return process.platform === "win32" ? { command: "cmd", args: ["/c", "npx", ...args] } : { command: "npx", args };
  }
  const cli = bundled ? [self] : [require.resolve("tsx/cli"), fileURLToPath(new URL("./index.ts", import.meta.url))];
  return { command: process.execPath, args: [...cli, "mcp", dir] };
}

/** Server options that only differ in the published build. */
export function serverPaths(): { webDir?: string; templatesDir?: string } {
  return bundled ? { webDir: path.join(packageDir, "web"), templatesDir: path.join(packageDir, "examples") } : {};
}
