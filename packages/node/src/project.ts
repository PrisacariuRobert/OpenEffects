import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AGENT_GUIDE, blankProject, validateProject, type Project } from "@openeffects/schema";

export const PROJECT_FILE = "project.oe.json";

export class ProjectValidationError extends Error {
  constructor(public errors: string[]) {
    super(`Invalid project:\n- ${errors.join("\n- ")}`);
  }
}

/** Accepts a project folder or a path to a project file. */
export function resolveProjectFile(target = "."): string {
  const abs = path.resolve(target);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return path.join(abs, PROJECT_FILE);
  return abs;
}

export type ReadResult = { ok: true; project: Project } | { ok: false; errors: string[]; raw?: unknown };

export function readProject(file: string): ReadResult {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, errors: [`Cannot read ${file}`] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`${path.basename(file)} is not valid JSON: ${(e as Error).message}`] };
  }
  const r = validateProject(data);
  return r.ok ? r : { ok: false, errors: r.errors, raw: data };
}

export function loadProject(file: string): Project {
  const r = readProject(file);
  if (!r.ok) throw new ProjectValidationError(r.errors);
  return r.project;
}

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2) + "\n";
}

/** Validates, then writes atomically so watchers never see a half-written file. */
export function saveProject(file: string, project: unknown): Project {
  const r = validateProject(project);
  if (!r.ok) throw new ProjectValidationError(r.errors);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serializeProject(r.project));
  fs.renameSync(tmp, file);
  return r.project;
}

export interface McpLaunch {
  command: string;
  args: string[];
}

/**
 * Create a new project folder: project file, agent guide (AGENTS.md + CLAUDE.md),
 * .mcp.json so any MCP-aware agent started in the folder finds OpenEffects, and a git repo
 * (used for per-turn checkpoints).
 */
export function initProject(dir: string, opts: { name?: string; mcp?: McpLaunch; project?: Project } = {}): string {
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  const file = path.join(dir, PROJECT_FILE);
  if (!fs.existsSync(file)) saveProject(file, opts.project ?? blankProject(opts.name ?? path.basename(path.resolve(dir))));
  writeAgentFiles(dir, opts.mcp);
  const gitignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, "renders/\n.openeffects/\n");
  if (!fs.existsSync(path.join(dir, ".git"))) {
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["-c", "user.name=OpenEffects", "-c", "user.email=openeffects@localhost", "commit", "-qm", "New OpenEffects project"], { cwd: dir });
    } catch {
      // git is optional; checkpoints are disabled without it.
    }
  }
  return file;
}

export function writeAgentFiles(dir: string, mcp?: McpLaunch): void {
  fs.writeFileSync(path.join(dir, "AGENTS.md"), AGENT_GUIDE);
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "@AGENTS.md\n");
  if (mcp) {
    const config = { mcpServers: { openeffects: { command: mcp.command, args: mcp.args } } };
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(config, null, 2) + "\n");
  }
}
