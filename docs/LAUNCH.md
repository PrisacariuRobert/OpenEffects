# Launch kit

Everything needed to ship OpenEffects publicly on a zero budget. Nothing here has been posted or
published yet; each step is done by the maintainer, in order.

## 1. Release checklist

- [ ] `pnpm typecheck && pnpm test` pass on `main`.
- [ ] Bump the version in `apps/cli/package.json` **and** `server.json` (both `version` fields). The
      package build refuses to run if they differ.
- [ ] `pnpm build:package`, then test the tarball outside the repo:
      ```bash
      cd apps/cli/dist/package && npm pack
      mkdir /tmp/oe-try && cd /tmp/oe-try && npm i /path/to/openeffects-<version>.tgz
      npx oe app demo        # opens the editor window, creates the project
      ```
- [ ] Publish to npm: `cd apps/cli/dist/package && npm publish` (needs an npm account with 2FA).
      Afterwards `npx openeffects app my-video` works for everyone.
- [ ] Tag the release: `git tag v<version> && git push --tags`, then create a GitHub release with the
      launch reel GIF and the "What's new" list.
- [ ] Turn on GitHub Pages (Settings → Pages → Deploy from branch → `main`, folder `/site`) so the
      landing page is live.
- [ ] List the MCP server in the official registry (step 2).
- [ ] Repo settings: description, website (the Pages URL), topics `motion-graphics`, `after-effects`,
      `lottie`, `mcp`, `ai-agents`, `claude-code`, `codex`, `animation`, `video-editor`. Upload
      `site/media/poster.jpg` as the social preview image.

## 2. MCP registry

[`server.json`](../server.json) describes the `oe mcp` server for the
[MCP registry](https://registry.modelcontextprotocol.io). The npm package carries a matching
`mcpName`, which the registry checks to confirm the package belongs to this repo.

```bash
# after npm publish
brew install mcp-publisher          # or download it from github.com/modelcontextprotocol/registry releases
mcp-publisher login github          # proves ownership of io.github.PrisacariuRobert/*
mcp-publisher publish               # run from the repo root, reads server.json
```

Other directories that index MCP servers from GitHub or by submission: Smithery, Glama, mcp.so,
PulseMCP and the `awesome-mcp-servers` list (a one-line PR under its closest media/art category).

## 3. Where to post, and in what order

| When | Where | Angle |
|---|---|---|
| Day 0, morning (US time) | Show HN | Technical: renderer, agents checking their own frames, plain JSON + git |
| Day 0 | X / Bluesky / Threads | The 20-second launch reel plus "made by my agent, finished by me" |
| Day 0 | r/MotionDesign, r/AfterEffects | The editor and Lottie export, not the AI; ask for feedback |
| Day 1 | r/ClaudeAI, r/LocalLLaMA, r/opensource | Bring your own agent; free and local models through OpenCode |
| Day 2 | Product Hunt | Launch reel as the first media item; gallery GIFs after it |
| Week 1 | dev.to / Hashnode write-up | "How an AI agent animates on a timeline", with the contact-sheet loop |
| Week 1 | LottieFiles community, Figma/Lottie Discords | Lottie import/export round trip |

Rules that matter more than reach: reply to every comment on launch day, never post the same text
twice, and don't ask for upvotes.

## 4. Post drafts

### Show HN

> **Show HN: OpenEffects – open-source motion graphics made by the coding agent you already use**
>
> OpenEffects is a local, MIT-licensed motion graphics editor (timeline, keyframes, graph editor,
> Lottie and video export) that your own agent CLI drives over MCP: Claude Code, Codex or
> OpenCode, so any model, including free and local ones. There's no account and no API key; it runs
> the agent you're already logged in to, the way T3 Code does.
>
> Some things that turned out to matter:
>
> - Agents check their own work. The MCP server renders frames and contact sheets back to the
>   agent, so it catches clipped text and bad timing before it says it's done.
> - Projects are one JSON file with a strict schema, and every agent turn is a git checkpoint. You
>   can see what the agent changed per layer and revert one layer.
> - "Make 4 versions" runs parallel turns with different creative directions, each in its own copy
>   of the project, previewed live side by side.
> - Brand kits, `{{name}}` templates and `oe batch rows.csv` give one personalized video per row.
>   Word-by-word captions come from SRT/VTT or a local whisper.cpp.
>
> Cheap models do fine: most gallery examples cost one to two cents on Haiku. Try it:
> `npx openeffects app my-video`. Repo: https://github.com/PrisacariuRobert/OpenEffects
>
> It's early. I'd love to hear what breaks and which effects you miss most.

### X / Bluesky thread

1. I built an open-source After Effects that your AI agent drives. You describe the animation, your
   own agent (Claude Code, Codex, OpenCode) builds it on a real timeline, and you finish it by hand.
   Free, local, MIT. 🧵 *(attach launch.mp4)*
2. No new account, no API key: it runs the agent CLI you're already logged in to. Pick any model.
   The gallery examples cost about 1–2¢ each on cheap models. *(attach gallery GIF grid)*
3. "Make 4 versions" gives you four creative directions at once, rendered live side by side. Pick
   one, keep editing. *(attach variations GIF)*
4. Brand kit + `{{name}}` templates + a CSV gives you one video per row. *(attach batch GIF)*
5. Export MP4, ProRes with alpha, WebM, GIF or Lottie, and import Lottie as editable layers.
   `npx openeffects app my-video` · github.com/PrisacariuRobert/OpenEffects

### Reddit (r/MotionDesign)

> **I made a free, open-source motion tool where an AI agent does the first draft and you keep full
> keyframe control**
>
> Not a "generate a video" thing: everything is real layers and keyframes, with a graph editor,
> ease editor, beat markers from your audio and Lottie export. The agent just saves you the boring
> first 80%. I'd really value feedback from people who animate for a living: what would make you
> trust it on a real job? (Video and repo link in the comments.)

### Product Hunt

- **Tagline:** Motion graphics made by your own AI agent, finished by you
- **Description:** OpenEffects is a free, open-source motion design editor. Describe an animation and
  the AI agent you already use builds it on a real timeline. Then tweak keyframes, try four
  versions at once, apply your brand kit, batch personalized videos from a CSV and export to MP4,
  GIF or Lottie.
- **First comment:** why bring-your-own-agent (no AI bill from us, any model, local works), what's
  next on the roadmap, and a request for feedback.

## 5. Assets

| Asset | File |
|---|---|
| Launch reel 16:9 / 9:16 | `site/media/launch.mp4`, `site/media/launch-vertical.mp4` |
| Launch reel GIF (README) | `docs/media/launch.gif` |
| Poster / social preview | `site/media/poster.jpg` |
| Feature GIFs (made with Sonnet 5.5) | `docs/media/gallery/` |
| Editor screenshots | `docs/media/*.png` |
| Landing page | `site/index.html` |
