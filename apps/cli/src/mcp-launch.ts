import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { McpLaunch } from "@openeffects/node";

const require = createRequire(import.meta.url);

/** How agents should launch this CLI's MCP server (`oe mcp <dir>`) for a project. */
export function mcpLaunch(projectDir: string): McpLaunch {
  return {
    command: process.execPath,
    args: [require.resolve("tsx/cli"), fileURLToPath(new URL("./index.ts", import.meta.url)), "mcp", path.resolve(projectDir)],
  };
}
