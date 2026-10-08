# OpenEffects

**Open-source motion graphics, driven by the AI agent you already use.**

Describe an animation, and your coding agent (Claude Code today; Codex and OpenCode next) builds it on a
real timeline while you watch the preview update live. Then tweak any keyframe by hand, undo any AI
turn, and export to MP4, GIF, WebM or ProRes.

![A logo reveal made by Claude Code in OpenEffects from one prompt](docs/media/nebula.gif)

*The animation above was made by Claude Code in OpenEffects from a single prompt (29 seconds, $0.25), see [examples/nebula](examples/nebula).*

![The OpenEffects editor](docs/media/editor.png)

## Why OpenEffects

- **Bring your own agent.** Like [T3 Code](https://github.com/pingdotgg/t3code), OpenEffects runs the agent
  CLI you already have installed and signed in to. No extra account, no API key, no AI bill from us.
- **Agents can see their own work.** The MCP server renders frames and contact sheets back to the agent,
  so it checks for clipping, overlaps and timing and fixes them before it says it's done.
- **Projects are plain JSON + git.** One readable `project.oe.json` per project, validated by a strict
  schema with precise error messages. Every agent turn is checkpointed (hidden git refs) and can be undone.
- **Works from the terminal too.** Every project folder has an `AGENTS.md` guide and a `.mcp.json`, so
  `cd my-project && claude` just works, as does any other MCP-capable agent.

## Quick start

Requirements: Node 20+, [pnpm](https://pnpm.io), [ffmpeg](https://ffmpeg.org) (for video export) and
[Claude Code](https://claude.com/claude-code) installed and logged in (`claude` once in a terminal).

```bash
git clone https://github.com/PrisacariuRobert/OpenEffects && cd OpenEffects
pnpm install
pnpm build:web

pnpm oe init ~/my-first-animation      # create a project
pnpm oe dev ~/my-first-animation       # open http://127.0.0.1:4310
```

Type what you want in the **Agent** panel, e.g. *"Make a 5-second logo reveal for 'Nebula' with a glowing
ring that draws on"*.

### CLI

| Command | What it does |
|---|---|
| `oe init [dir]` | New project: `project.oe.json`, `AGENTS.md`, `.mcp.json`, git repo |
| `oe dev [dir]` | Editor with live preview, timeline, agent panel, history (`--port`) |
| `oe render [dir]` | Export (`--format mp4\|webm\|gif\|mov\|png --out file --scale 0.5`) |
| `oe frame [dir] --time 2` | Render one frame to PNG |
| `oe sheet [dir]` | Contact sheet of the whole animation |
| `oe validate [dir]` | Check the project file |
| `oe mcp [dir]` | OpenEffects MCP server on stdio |

(Run them as `pnpm oe …` from the repo until the npm package is published.)

### Using other agents

Any MCP client can drive OpenEffects. Point it at `oe mcp <project-dir>`, e.g. for Claude Desktop or Cursor:

```json
{
  "mcpServers": {
    "openeffects": { "command": "pnpm", "args": ["--silent", "--dir", "/path/to/OpenEffects", "oe", "mcp", "/path/to/project"] }
  }
}
```

## How it works

```
 Browser editor (React)  ◄── WebSocket: live project, agent events, checkpoints ──┐
   preview · timeline · agent chat · inspector · history                         │
                                                                                  │
 oe dev (Node server) ────────────────────────────────────────────────────────────┘
   ├─ watches project.oe.json → hot reload
   ├─ agent adapters: spawns YOUR `claude` CLI (stream-json), normalizes events
   ├─ checkpoints: git snapshot before/after every turn (private index, hidden refs)
   └─ export: same engine, headless (@napi-rs/canvas) → ffmpeg
          │
          ▼  the agent connects to …
 oe mcp (MCP server): oe_get_project · oe_add_layer · oe_update_layer · oe_set_keyframes ·
                      oe_render_frame · oe_render_contact_sheet · oe_export · …
```

| Package | Role |
|---|---|
| `packages/schema` | Project format (Zod), keyframe interpolation, easings, edit operations, agent guide, wire contracts |
| `packages/engine` | Deterministic renderer: `renderFrame(ctx, project, { time })` on any Canvas 2D (browser or Node) |
| `packages/node` | Headless rendering, contact sheets, ffmpeg export, project I/O |
| `packages/mcp` | The OpenEffects MCP server |
| `apps/server` | Local server: hot reload, agent adapters, checkpoints, export jobs |
| `apps/web` | The editor UI |
| `apps/cli` | The `oe` command |

### What the engine supports today

Layers: solid, rect, ellipse, SVG path (with trim paths), text, image, null (parenting), nested compositions.
Animation: keyframes on any property with 30+ easings or cubic-bezier, per-character/word/line text animators.
Compositing: blend modes, track mattes, parenting. Effects: blur, glow, drop shadow, color adjust.
Export: MP4 (H.264), WebM (VP9 with alpha), MOV (ProRes 4444 with alpha), GIF, PNG sequence.

The format is documented for agents in [`AGENTS.md`](packages/schema/src/guide.ts), and as a JSON Schema in
[`schema/project.schema.json`](schema/project.schema.json) for editor autocomplete.

## Status and roadmap

This is an early prototype (Phase 0 of the [plan](docs/PLAN.md)). Next up:

- [ ] Codex (`codex app-server`) and OpenCode adapters, plus API-key and local-model fallbacks
- [ ] Desktop app (Electron/Tauri) and `npx openeffects` packaging
- [ ] Direct manipulation in the viewport, graph editor, video layers, audio
- [ ] WebGPU renderer, shader effect plugins, Lottie import/export
- [ ] Template gallery

## Contributing

Contributions are welcome, especially new effects, easings, templates and agent adapters. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

The agent architecture is modeled on [T3 Code](https://github.com/pingdotgg/t3code) by Ping Labs (MIT): a local
server that runs the user's own agent CLIs and turns their output into provider-neutral events, with
per-turn git checkpoints. OpenEffects is not affiliated with Adobe; After Effects is a trademark of Adobe Inc.

## License

[MIT](LICENSE)
