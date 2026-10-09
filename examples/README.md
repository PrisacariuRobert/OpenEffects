# Examples

Every example except `logo-reveal` and `showreel` was made by an AI agent from **one prompt**, through
OpenEffects, with no hand edits. Open one with `pnpm oe dev examples/<name>` or render it with
`pnpm oe render examples/<name>`.

| Folder | Made by | Time | Cost |
|---|---|---|---|
| [nebula](nebula) | Claude Sonnet 5.5 via the editor | 29 s | $0.25 |
| [kinetic-type](kinetic-type) | Claude Haiku 5.5 via `oe ask` | 29 s | $0.014 |
| [lower-third](lower-third) | Claude Haiku 5.5 via `oe ask` | 53 s | $0.018 |
| [summer-sale](summer-sale) | Claude Haiku 5.5 via `oe ask` | 45 s | $0.013 |
| [bar-chart](bar-chart) | Claude Haiku 5.5 via `oe ask` | 50 s | $0.015 |
| [loader](loader) | Claude Haiku 5.5 via `oe ask` | 21 s | $0.007 |
| [logo-reveal](logo-reveal) | hand-written | | |
| [showreel](showreel) | generated script: nests the AI-made comps as precomps with titles | | |
| [launch-reel](launch-reel) | Claude Code writing the project file directly (no GUI), checked with contact sheets | | |

**launch-reel** is the 32-second OpenEffects launch film: 10 compositions and 145 layers, a 16:9 cut and a 9:16
cut that nests it, an original 120 BPM soundtrack (`assets/soundtrack.mp3`) with scene cuts on its beat markers,
path morphs, behaviors, text animators, and an end card that also exports to Lottie
(`pnpm oe render examples/launch-reel --comp end-card --format lottie`). Render the vertical cut with
`--comp vertical`.

## Prompts

**nebula**: Make a 5-second logo reveal for "Nebula": a glowing ring that draws on, the word NEBULA revealed
letter by letter, and a small tagline "Explore further". Dark space-like background.

**kinetic-type**: Kinetic typography, 6 seconds, 1920x1080: the phrase 'SHIP FASTER. SLEEP BETTER.' Bold, punchy,
word by word, with color accents and a strong ending hold.

**lower-third**: A broadcast lower third for 'Ana Ruiz' with the subtitle 'Product Designer'. It slides in from the
left with an accent bar, holds, then animates out. 6 seconds, 1920x1080, over a soft blurred gradient
background standing in for video.

**summer-sale**: A vertical 1080x1920 social media ad, 5 seconds: 'SUMMER SALE' and a huge '-50%', bouncy energetic
shapes, warm colors, and a 'Shop now' button at the end.

**bar-chart**: An animated bar chart titled 'Monthly active users, 2026' with 6 bars (Jan 12k, Feb 18k, Mar 25k,
Apr 31k, May 44k, Jun 61k) that grow one after another with value labels. Clean, modern, dark theme,
6 seconds, 1920x1080.

**loader**: A seamless looping 3-second loading animation (first and last frame identical): orbiting glowing
dots around a pulsing center and the text 'Loading…' below. 1080x1080.

Reproduce one, e.g.:

```bash
pnpm oe init /tmp/demo
pnpm oe ask /tmp/demo "<prompt>" --model claude-haiku-5-5
```
