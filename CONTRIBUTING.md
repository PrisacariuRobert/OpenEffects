# Contributing to OpenEffects

Thanks for helping! OpenEffects is a TypeScript monorepo (pnpm workspaces). Source files run directly
through `tsx` and Vite, so there's no build step during development.

```bash
pnpm install
pnpm typecheck      # tsc over the whole repo
pnpm test           # vitest (export tests need ffmpeg)
pnpm dev            # editor on examples/logo-reveal (Vite dev mode when apps/web/dist is absent or OE_DEV=1)
```

## Good first contributions

- **A new effect.** Add its Zod schema to `packages/schema/src/schema.ts` (the `Effect` union), implement it in
  `applyEffect` in `packages/engine/src/render.ts`, add its spill to `layerRegion`, document it in
  `packages/schema/src/guide.ts`, and add a pixel test in `packages/node/test/render.test.ts`.
- **A new easing.** `packages/schema/src/easing.ts`.
- **An example or template.** Add a folder under `examples/` with a `project.oe.json`. Every example is
  validated by the test suite. If an agent made it, include the prompt.
- **An agent adapter** (Gemini CLI, Aider…). Implement `AgentProvider` from
  `apps/server/src/agents/types.ts` (see `claude.ts`, `codex.ts`, `opencode.ts`; `process.ts` handles
  spawning and JSONL), register it in `defaultProviders()` in `apps/server/src/agents/session.ts`, and add
  parser fixtures plus a fake-CLI test to `apps/server/test/agents.test.ts`.
  Adapters must run the user's own CLI and never handle their credentials.

## Rules of thumb

- The project file stays human-readable and minimal: defaults live in the engine, not in the file.
- Schema objects are strict. If you add a field, add it to the schema, the guide and the JSON Schema
  (`pnpm schema:json`; a test fails if you forget).
- The engine must be deterministic and run in both the browser and Node. Use only the Canvas 2D API.
- Keep agent-facing error messages precise (path + reason). Agents fix what they can read.
