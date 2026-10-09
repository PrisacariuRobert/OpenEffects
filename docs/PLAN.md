# OpenEffects: Feasibility, Architecture & Zero-Budget Launch Plan

> **Status (Oct 2026):** Phase 0 is built. The schema, renderer, MCP server (with visual feedback), Claude Code
> adapter, per-turn checkpoints, editor UI, CLI and ffmpeg export all work, and Claude Code made
> [`examples/nebula`](../examples/nebula) from one prompt. Differences from the plan below: the prototype
> renders with Canvas 2D (one engine for preview and export, in browser and Node) and keeps WebGPU for later.
> Codex and OpenCode adapters, a model picker (Claude Haiku 5.5 by default) and `oe ask` followed; five more
> examples were made on Haiku 5.5 for about $0.07 in total. Next: desktop app and npm packaging.

## 1. Is it possible?

**Yes, if the goal is "open-source motion graphics app that AI agents can drive," not "clone every After Effects feature."**

What makes it realistic in 2026:

- **Agents are good at editing structured text and code, and bad at clicking through GUIs.** If the project file is a readable, schema-validated document, Claude Code, Codex, OpenCode and similar agents can create and edit animations reliably.
- **You don't need to pay for AI.** T3 Code's model works: the app launches the AI agent CLIs the user already has installed and signed in to (Claude Code, Codex, OpenCode…), using the user's own subscription. Your costs stay at $0 no matter how many people use the app.
- **The browser is now a capable video engine.** WebGL2/WebGPU handle real-time compositing, WebCodecs handles hardware encoding, and Electron/Tauri turn the result into a desktop app.

What is *not* realistic for a small team:

| Feature | Verdict |
|---|---|
| Opening `.aep` files | No. It's an undocumented binary format. Import Lottie/Bodymovin JSON instead. |
| Running AE plugins (Element 3D, Trapcode…) | No. They're closed and tied to AE. |
| Roto brush, 3D camera tracker, content-aware fill | Later, or via open ML models (SAM 2 etc.) as optional add-ons. |
| Full AE expression compatibility | Partial at most. Use JS/TS expressions with a similar API. |

**Competition (checked Oct 2026):** *Premation* is an open-source, AI-native motion design tool (WebGPU; launched on Product Hunt; Windows-first). *OpenShowreel*-style MCP servers control the real After Effects. So the space is open but not empty. Our angle:

1. **Bring-your-own-agent** (T3 Code-style). Works with whatever coding agent the user already pays for. No account and no API key needed.
2. **Project = plain text + git.** Every AI change can be diffed, reviewed and undone.
3. **MCP-first.** Any agent (Claude Desktop, ChatGPT, Cursor…) can drive OpenEffects, even without our UI.
4. **Cross-platform from day one** (macOS/Windows/Linux + web).

## 2. How the AI connection works (modeled on T3 Code)

T3 Code (`pingdotgg/t3code`, MIT) is a GUI over agents already installed on your machine. Its internals:

- `apps/server`: a local server that **runs provider CLIs as subprocesses**. A per-provider adapter translates each CLI's native protocol into common orchestration events.
- `apps/web`: React/Vite UI. `apps/desktop` wraps it in Electron.
- `packages/contracts`: typed schemas for everything sent over the WebSocket between server and UI.
- An orchestrator turns client commands into events, and **each agent turn ends with a git checkpoint** that can be diffed or restored.
- Users log in to each CLI themselves (`claude auth login`, `codex login`).

OpenEffects uses the same pattern, plus a motion-graphics toolset:

```
┌──────────────────────── OpenEffects desktop (Electron/Tauri) ────────────────────────┐
│  apps/web (React)                                                                    │
│  ┌──────────┐ ┌──────────────────┐ ┌───────────┐ ┌───────────────────────────────┐   │
│  │ Viewport │ │ Timeline/Keyframe│ │ Properties│ │ Agent chat (diffs, undo turn) │   │
│  └────┬─────┘ └────────┬─────────┘ └─────┬─────┘ └──────────────┬────────────────┘   │
│       └──── packages/engine (scene graph → WebGPU/WebGL2 render frame(t)) ──┘        │
│                               ▲  WebSocket (typed contracts)                         │
│  apps/server (Node/Bun) ──────┴──────────────────────────────────────────────┐       │
│   • Project store: project.oe.json + assets/ in a git repo                   │       │
│   • File watcher → hot-reload UI when the agent edits files                  │       │
│   • Provider adapters (subprocesses, user's own login):                      │       │
│       claude (Agent SDK / stream-json) · codex app-server (JSON-RPC stdio)   │       │
│       opencode (local HTTP server, supports local models via Ollama)         │       │
│   • Checkpoint per turn (hidden git ref) → diff / restore                    │       │
│   • Render worker (headless frames → WebCodecs/ffmpeg → MP4/WebM/GIF/PNG)    │       │
│   • packages/mcp: OpenEffects MCP server, injected into every agent session  │       │
└──────────────────────────────────────────────────────────────────────────────┘───────┘
```

### The MCP tools are the key part

Agents can edit the JSON file directly, but they work much better with dedicated tools, **and they need to see their output**:

| Tool | Purpose |
|---|---|
| `oe_get_project` / `oe_get_layer` | Read the current composition (compact form) |
| `oe_add_layer`, `oe_update_layer`, `oe_delete_layer` | Structural edits, validated against the schema |
| `oe_set_keyframes` | Set a property's keyframes and easing in one call |
| `oe_apply_effect`, `oe_list_effects` | Effect catalog with parameter docs |
| `oe_render_frame(t)` → PNG | **Visual feedback loop**: the agent renders a frame, looks at it, and fixes problems |
| `oe_render_contact_sheet` | Grid of N frames, so the agent can review the motion in one image |
| `oe_import_asset`, `oe_search_templates` | Assets and templates |
| `oe_export` | Final render |

Also ship a short **`AGENTS.md` / skill file** in every project that explains the format, conventions and design tips. That file is what makes general coding agents produce good motion design.

### Auth and terms: be careful here

- Running the user's **own installed, self-authenticated CLI** is the T3 Code approach, and you never touch their credentials. Don't build your own "Log in with Claude/ChatGPT" flow on top of an SDK. Some providers forbid third-party apps from offering consumer-subscription login without approval. Check each provider's current terms before launch.
- Always support two fallbacks: **API key** (BYOK) and **local models** (OpenCode + Ollama/LM Studio). Then nobody is locked out, and you get the local-AI community's interest.

## 3. Project format (the most important design decision)

Use **declarative JSON validated by a schema (Zod/Effect Schema)**, plus optional JS expressions. Avoid "the project is a React program" (Remotion style): a GUI can't round-trip arbitrary code. And Remotion's license is source-available, not OSI open source.

```jsonc
{
  "$schema": "https://openeffects.dev/schema/v1.json",
  "compositions": [{
    "id": "main", "width": 1920, "height": 1080, "fps": 60, "duration": 6,
    "layers": [
      { "id": "title", "type": "text", "text": "OpenEffects",
        "font": { "family": "Inter", "weight": 800, "size": 160 },
        "transform": {
          "position": [960, 540],
          "scale": { "keyframes": [[0, [0,0], "easeOutBack"], [0.6, [100,100]]] },
          "opacity": { "keyframes": [[0, 0], [0.3, 100]] }
        },
        "effects": [{ "type": "glow", "radius": 24, "intensity": 1.2 }] }
    ]
  }]
}
```

Rules: stable `id`s on everything (clean diffs, agents can refer to layers), times in seconds, units documented in the schema, `frame(t)` deterministic (identical output on every render).

## 4. Tech stack (all permissive licenses)

| Part | Choice | Why |
|---|---|---|
| Monorepo | pnpm or Bun workspaces + Turborepo, TypeScript | Same layout as T3 Code |
| UI | React + Vite, Zustand, Radix/shadcn | Fast to build, many contributors know it |
| Renderer | **PixiJS v8** (MIT, WebGPU + WebGL2) or your own WebGPU layer; GLSL/WGSL shader effects | Real-time 2D compositing |
| Text | Canvas/HarfBuzz (harfbuzzjs), opentype.js | Text animators need per-glyph control |
| 3D (later) | three.js (MIT) | 3D layers and cameras |
| Export | WebCodecs + `mediabunny`/mp4 muxer; ffmpeg as an optional system dependency | Avoids bundling GPL ffmpeg |
| Desktop | Electron (like T3 Code) or Tauri (smaller binaries) | Cross-platform |
| Agents | Claude Agent SDK / `claude` CLI, `codex app-server`, OpenCode; `@modelcontextprotocol/sdk` | Same approach as T3 Code |
| Interop | Lottie import/export | Brings in existing After Effects users via Bodymovin |

**Project license:** MIT or Apache-2.0. Don't put "After Effects" or Adobe branding in the name, logo or UI. Phrases like "an open-source alternative to After Effects" in copy are fine. Note: "OpenFX" is an existing VFX plugin standard, so make sure the name and logo can't be confused with it.

## 5. Roadmap

**Phase 0: Prove the loop (2–3 weeks).** A CLI plus a minimal web preview. Schema v1, engine renders text/shapes/images with keyframes, `oe_render_frame` works, Claude Code edits `project.oe.json` over MCP. *Demo: "make a 5-second logo reveal" → MP4.* **Record this demo. It's your first marketing asset.**

**Phase 1: MVP editor (6–8 weeks).**
- Viewport, timeline, keyframe/graph editor, properties panel, undo/redo
- Layers: solid, shape, text, image, video, precomp, adjustment; masks and track mattes
- ~12 shader effects: blur, glow, drop shadow, color correct, gradient ramp, noise/grain, chromatic aberration, wipe, displacement, turbulent distort, vignette, LUT
- Agent panel with Claude Code + Codex + OpenCode adapters, per-turn checkpoints, diffs
- Export MP4/WebM/GIF/PNG sequence; desktop builds for all three OSes via GitHub Actions

**Phase 2: Community growth (ongoing).**
- Template gallery (each template is a JSON file, so contributing one takes a single PR)
- Effect plugin API (a WGSL shader plus a parameter schema), so the community can add effects
- Lottie import/export, expressions, text animators, motion blur
- Hosted web version (static site + the user's own agent via remote server, like T3 Code's remote access)

**Phase 3: Advanced.** 3D layers/camera, audio-reactive animation, optional ML models (SAM 2 roto, background removal), collaborative editing.

## 6. Zero-budget marketing plan

The product produces its own marketing: **every feature is a 15-second video of a prompt turning into an animation.**

### Positioning: the open-source Claude Motion

Anthropic's Claude Motion (beta, October 2026, Team and Enterprise plans) validates the idea: motion
graphics as code that an AI writes, not generated video. OpenEffects is the open alternative, and every
message should say so in one line: **"The open-source alternative to Claude Motion: any agent, any plan,
a real timeline, Lottie in and out."** Lead with what people can't get there: free and local, works with
Codex/OpenCode/local models, hand-editing on a timeline, transparent ProRes/WebM and Lottie export. Stay
factual and friendly in comparisons (link to Anthropic's own docs, never imply affiliation), and remind
Claude users that OpenEffects runs on their existing Claude Code login.

Launch hooks that ride the news: "I rebuilt Claude Motion as an open-source app", a side-by-side video of
the same prompt in both, and a Show HN titled "Show HN: OpenEffects – an open-source Claude Motion
alternative with a real timeline and Lottie export".

### Free infrastructure
- GitHub (code, Issues, Discussions, Actions for builds, Releases for binaries). All free for public repos.
- Website and docs: Cloudflare Pages or GitHub Pages. Domain is the only optional cost (~$10/yr). Until then, use `*.pages.dev`.
- Community: Discord server (free).
- Code signing: apply to the **SignPath Foundation** (free signing for OSS on Windows). For macOS, ship unsigned at first with clear install notes; Apple's program costs $99/yr later.
- Donations: GitHub Sponsors + Open Collective from day one.

### Before launch (build in public)
1. **Make the README the landing page:** a GIF of a prompt becoming an animation at the top, a one-line pitch, a single install command (`npx openeffects@latest`, like `npx t3@latest`).
2. **Post progress 3–5 times a week** on X, Bluesky, LinkedIn, Threads. Short screen recordings, no editing needed. "Day 12: Claude just animated a kinetic-typography intro in my open-source After Effects alternative" works well.
3. **Short video:** TikTok, YouTube Shorts and Reels with before/after: "this took 2 hours in AE / 40 seconds with a prompt." This is the format motion designers share.
4. Collect a waitlist with GitHub "Watch → Releases" or a free Buttondown/Substack newsletter.

### Launch week (spread out, one channel per day)
- **Show HN**: "Show HN: OpenEffects – open-source motion graphics app driven by your own AI agent". Post on a weekday morning US Eastern time and answer every comment.
- **Reddit** (read each subreddit's self-promo rules first, and lead with the demo, not the link): r/opensource, r/selfhosted, r/LocalLLaMA (local-model support), r/ClaudeAI, r/ChatGPTCoding, r/motiondesign, r/MotionGraphics, r/webdev, r/javascript. Be careful in r/AfterEffects: ask for feedback, don't advertise.
- **Product Hunt**: launch at 00:01 PT and line up early supporters from Discord beforehand.
- **dev.to / Hashnode / Medium**: a technical post, "How I connected Claude Code and Codex to a WebGPU motion engine (T3 Code-style)". Developers share architecture posts.

### Free distribution channels people overlook
- **MCP registries:** list the MCP server in the official MCP Registry, Smithery, Glama, mcp.so and PulseMCP. Each listing is a permanent free storefront.
- **Awesome lists:** submit PRs to awesome-mcp-servers, awesome-claude-code, awesome-selfhosted (if applicable), awesome-motion-graphics/creative-coding, awesome-webgpu.
- **Agent ecosystems:** publish an OpenEffects *skill*/plugin for Claude Code and an AGENTS.md template. People find tools through their agents.
- **T3 Code's audience:** credit T3 Code clearly in the README and architecture post, and tag @t3dotgg / pingdotgg when you post the architecture write-up. Theo often covers interesting open-source projects. Don't spam. One good post with a working demo is enough.
- **SEO pages on the docs site:** "Free After Effects alternative", "AI motion graphics open source", "Lottie animation with AI", "Animate with Claude Code". People search for these phrases every day.
- **Templates as content:** each new template becomes a post, a Short and a GitHub release note. Ask the community to submit templates, and credit authors in every post (they'll share it too).

### Turn users into contributors
- Label 20+ `good first issue`s (new effect, new template, new easing curve). Each is self-contained.
- Write CONTRIBUTING.md and a "build your first effect in 10 minutes" guide.
- A weekly "Made with OpenEffects" community showcase (Discord + social reposts).
- Hacktoberfest (October) and Google Summer of Code / GSoC-style mentoring later.

### Metrics to track (free)
GitHub stars/clones (Insights), release download counts, Discord members, PostHog free tier or Plausible self-hosted for website traffic. **Opt-in only** for any in-app telemetry. Open-source users care about this.

## 7. Next concrete steps

1. Set up the monorepo (`apps/web`, `apps/server`, `apps/desktop`, `packages/engine`, `packages/schema`, `packages/mcp`, `packages/contracts`).
2. Write schema v1 and the `frame(t)` renderer for text + shapes + keyframes.
3. Build the MCP server with `oe_get_project`, `oe_update_layer`, `oe_set_keyframes`, `oe_render_frame`.
4. Connect Claude Code first (simplest), then Codex app-server, then OpenCode.
5. Record the first demo video and start posting.
