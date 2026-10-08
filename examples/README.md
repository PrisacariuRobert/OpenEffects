# Examples

| Folder | Made by | Notes |
|---|---|---|
| [logo-reveal](logo-reveal) | hand-written | Path trim, glow, track-matte wipe, per-word text animator |
| [nebula](nebula) | Claude Code via OpenEffects | One prompt, 29 s, $0.25 (see below) |

Open one with `pnpm oe dev examples/<name>` or render it with `pnpm oe render examples/<name>`.

### nebula: the prompt

> Make a 5-second logo reveal for "Nebula": a glowing ring that draws on, the word NEBULA revealed letter
> by letter, and a small tagline "Explore further". Dark space-like background.

Claude Code read the project, wrote the animation with `oe_write_project`, fixed one validation error the tool
reported, checked a contact sheet, and finished. The file in this folder is its output, unedited.
