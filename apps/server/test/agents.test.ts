import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createClaudeParser } from "../src/agents/claude.ts";
import { CodexProvider, createCodexParser } from "../src/agents/codex.ts";
import { OpenCodeProvider, createOpenCodeParser } from "../src/agents/opencode.ts";
import { AgentSession } from "../src/agents/session.ts";
import type { AdapterEvent } from "../src/agents/types.ts";

/*
 * Fixtures mirror real CLI output: the Claude lines and the Codex thread/turn/error lines
 * were captured from claude 2.1 / codex-cli 0.162; item shapes follow codex exec's
 * JSONL schema; OpenCode lines follow `opencode run --format json` (1.18).
 */

function collect() {
  const events: AdapterEvent[] = [];
  return { events, emit: (e: AdapterEvent) => events.push(e) };
}

describe("Claude Code parser", () => {
  it("maps init, text, tool calls/results and the final result", () => {
    const { events, emit } = collect();
    const p = createClaudeParser(emit);
    p.onMessage({ type: "system", subtype: "init", session_id: "s-1", model: "claude-haiku-5-5" });
    p.onMessage({ type: "assistant", message: { content: [{ type: "text", text: "On it." }, { type: "tool_use", id: "t1", name: "mcp__openeffects__oe_add_layer", input: { layer: { id: "a" } } }] } });
    p.onMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: 'Added layer "a".' }] }] } });
    p.onMessage({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.012, duration_ms: 9000, usage: { input_tokens: 10, output_tokens: 5 }, session_id: "s-1" });
    expect(events.map((e) => e.type)).toEqual(["status", "text", "tool-call", "tool-result"]);
    expect(p.state).toMatchObject({ sessionId: "s-1", result: { ok: true, costUsd: 0.012, durationMs: 9000 } });
  });
});

describe("Codex parser", () => {
  it("maps thread, MCP tool calls, messages and usage", () => {
    const { events, emit } = collect();
    const p = createCodexParser(emit);
    p.onMessage({ type: "thread.started", thread_id: "01a11dd0-8690-7f43-a415-8f62d66305d5" });
    p.onMessage({ type: "turn.started" });
    p.onMessage({ type: "item.started", item: { id: "item_1", type: "mcp_tool_call", server: "openeffects", tool: "oe_render_frame", arguments: { time: 1 }, status: "in_progress" } });
    p.onMessage({ type: "item.completed", item: { id: "item_1", type: "mcp_tool_call", server: "openeffects", tool: "oe_render_frame", arguments: { time: 1 }, result: { content: [{ type: "image" }, { type: "text", text: "Frame at t=1s" }] }, status: "completed" } });
    p.onMessage({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Done." } });
    p.onMessage({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 80 } });
    expect(events).toEqual([
      { type: "status", text: "Connected to Codex" },
      { type: "tool-call", id: "item_1", name: "mcp__openeffects__oe_render_frame", input: { time: 1 } },
      { type: "tool-result", id: "item_1", ok: true, summary: "[image] Frame at t=1s" },
      { type: "text", text: "Done." },
    ]);
    expect(p.state).toMatchObject({ sessionId: "01a11dd0-8690-7f43-a415-8f62d66305d5", completed: true, tokens: { input: 1200, output: 80 } });
  });

  it("records failures and ignores transient reconnect notices", () => {
    const { events, emit } = collect();
    const p = createCodexParser(emit);
    p.onMessage({ type: "error", message: "Reconnecting... 2/5 (stream disconnected before completion)" });
    p.onMessage({ type: "item.completed", item: { id: "x", type: "mcp_tool_call", server: "openeffects", tool: "oe_add_layer", error: { message: "Edit rejected" }, status: "failed" } });
    p.onMessage({ type: "turn.failed", error: { message: "stream disconnected" } });
    expect(events).toEqual([{ type: "tool-result", id: "x", ok: false, summary: "Edit rejected" }]);
    expect(p.state.error).toBe("stream disconnected");
    expect(p.state.completed).toBe(false);
  });
});

describe("OpenCode parser", () => {
  it("maps tool_use, text, step costs and errors", () => {
    const { events, emit } = collect();
    const p = createOpenCodeParser(emit);
    const base = { timestamp: 1, sessionID: "ses_1" };
    p.onMessage({ ...base, type: "step_start", part: {} });
    p.onMessage({ ...base, type: "tool_use", part: { type: "tool", tool: "openeffects_oe_get_project", callID: "c1", state: { status: "completed", input: {}, output: "main: 1920x1080" } } });
    p.onMessage({ ...base, type: "text", part: { type: "text", text: "Built it." } });
    p.onMessage({ ...base, type: "step_finish", part: { cost: 0.002, tokens: { input: 100, output: 20, cache: { read: 50, write: 0 } } } });
    expect(events.map((e) => e.type)).toEqual(["status", "tool-call", "tool-result", "text"]);
    expect(events[1]).toMatchObject({ name: "mcp__openeffects__oe_get_project" });
    expect(p.state).toMatchObject({ sessionId: "ses_1", costUsd: 0.002, tokens: { input: 150, output: 20 }, steps: 1 });
    p.onMessage({ ...base, type: "error", error: { name: "APIError", data: { message: "Forbidden" } } });
    expect(p.state.error).toBe("Forbidden");
  });
});

/** A fake agent CLI: answers --version / login status / models, and streams canned JSONL. */
function fakeCli(dir: string, name: string, lines: (args: string[], prompt: string) => unknown[]): string {
  const file = path.join(dir, name);
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("${name} 9.9.9"); process.exit(0); }
if (args[0] === "login") { console.log("Logged in"); process.exit(0); }
if (args[0] === "models") { console.log("opencode/free-model-free\\nanthropic/claude-haiku-5-5"); process.exit(0); }
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const lines = (${lines.toString()})(args, prompt);
  for (const l of lines) console.log(JSON.stringify(l));
});
`;
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

describe("AgentSession with real processes", () => {
  const mcp = { command: process.execPath, args: ["oe-mcp.js", "/tmp/project"] };

  it("runs Codex turns, resumes the thread and checkpoints each turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oe-agent-"));
    const bin = fakeCli(dir, "codex", (args, prompt) => [
      { type: "thread.started", thread_id: "thread-42" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "m", type: "agent_message", text: JSON.stringify({ args, prompt }) } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
    ]);
    const texts: string[] = [];
    const session = new AgentSession({
      projectDir: dir,
      mcp,
      providers: [new CodexProvider(bin)],
      onEvent: (e) => e.type === "text" && texts.push(e.text),
    });
    const first = await (await session.start("codex", "make a logo", "gpt-test")).done;
    expect(first).toMatchObject({ ok: true, sessionId: "thread-42", tokens: { input: 10, output: 2 } });
    const run1 = JSON.parse(texts[0]);
    expect(run1.prompt).toBe("make a logo");
    expect(run1.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(run1.args).toContain(`mcp_servers.openeffects.command=${JSON.stringify(process.execPath)}`);
    expect(run1.args).toContain('mcp_servers.openeffects.args=["oe-mcp.js", "/tmp/project"]');
    expect(run1.args[run1.args.indexOf("-m") + 1]).toBe("gpt-test");
    expect(run1.args.at(-1)).toBe("-"); // prompt is read from stdin

    await (await session.start("codex", "make it gold")).done;
    const run2 = JSON.parse(texts[1]);
    expect(run2.args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(run2.args.slice(-2)).toEqual(["thread-42", "-"]);

    expect((await session.checkpoints.list()).length).toBe(4);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, ".openeffects", "session.json"), "utf8"));
    expect(saved).toMatchObject({ sessionId: "thread-42", provider: "codex" });
  });

  it("injects the MCP server into OpenCode and reports cost", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oe-agent-"));
    const bin = fakeCli(dir, "opencode", (args) => [
      { type: "step_start", timestamp: 1, sessionID: "ses_9", part: {} },
      { type: "text", timestamp: 2, sessionID: "ses_9", part: { text: process.env.OPENCODE_CONFIG_CONTENT ?? "no config" } },
      { type: "text", timestamp: 3, sessionID: "ses_9", part: { text: JSON.stringify(args) } },
      { type: "step_finish", timestamp: 4, sessionID: "ses_9", part: { cost: 0.001, tokens: { input: 5, output: 1 } } },
    ]);
    const texts: string[] = [];
    const provider = new OpenCodeProvider(bin);
    const status = await provider.status();
    expect(status.models.map((m) => m.id)[0]).toBe("opencode/free-model-free");
    const session = new AgentSession({ projectDir: dir, mcp, providers: [provider], onEvent: (e) => e.type === "text" && texts.push(e.text) });
    const r = await (await session.start("opencode", "hello", "opencode/free-model-free")).done;
    expect(r).toMatchObject({ ok: true, sessionId: "ses_9", costUsd: 0.001 });
    const config = JSON.parse(texts[0]);
    expect(config.mcp.openeffects).toMatchObject({ type: "local", command: [process.execPath, "oe-mcp.js", "/tmp/project"] });
    const args = JSON.parse(texts[1]);
    expect(args).toEqual(expect.arrayContaining(["run", "--format", "json", "-m", "opencode/free-model-free"]));
  });

  it("refuses providers that are not set up, with the setup hint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oe-agent-"));
    const session = new AgentSession({ projectDir: dir, mcp, providers: [new CodexProvider(path.join(dir, "missing-codex"))] });
    await expect(session.start("codex", "hi")).rejects.toThrow(/codex login|Install Codex/);
  });
});
