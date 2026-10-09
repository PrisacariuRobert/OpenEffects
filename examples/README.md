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
| [logo-variations](logo-variations) | Claude Sonnet 5.5 via `oe ask --variations 4` | 36 s | $0.98 for four |
| [reference-title](reference-title) | Claude Sonnet 5.5 via `oe ask --ref poster.png` | 47 s | $0.33 |
| [team-welcome](team-welcome) | Claude Sonnet 5.5 via `oe ask`, then `oe batch` | 26 s + 9 s render | $0.25 |
| [captions-clip](captions-clip) | Claude Sonnet 5.5 via `oe ask` (2 turns, see below) | 85 s | $1.25 |

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

### Made with the new features (Claude Sonnet 5.5)

**logo-variations** (`--variations 4`): A 4-second logo sting (1920x1080) for 'Lumen', a calm note-taking app.
Build a simple mark from shapes plus the wordmark.
*Each version gets the same prompt plus one creative direction. All four are in `versions/`; the project
itself is the calm one.*

**reference-title** (`--ref poster.png`): Make a 6-second 16:9 (1920x1080) animated title card for this podcast
episode in the style of the reference poster: same palette, the big red circle, heavy uppercase type, thin black
rules, generous margins. Recompose it for landscape. Animate it like a confident Swiss-design title sequence:
rules drawing on, the circle growing in, the title sliding up line by line, then a still hold. Check a contact
sheet before you finish.

**team-welcome** (with `brand.json` and `team.csv` already in the folder): Make a 6-second square (1080x1080)
'welcome to the team' card for new hires, using our brand kit (colors, fonts, logo, voice). It must be a
template: put {{name}}, {{role}} and {{city}} placeholders in the text so we can render one video per row of
team.csv (names up to ~16 characters, roles up to ~20). Animate it with polish: the logo, a staggered entrance
for the name and role, a subtle accent element, and a calm hold at the end. Check a contact sheet before you
finish. Then: `pnpm oe batch examples/team-welcome --data examples/team-welcome/team.csv`.

**captions-clip** (with `assets/captions.srt` in the folder): Make a 9-second vertical social clip (1080x1920,
30 fps). It's a teaser for OpenEffects, an open-source motion graphics tool driven by AI agents. Behind the text,
build a calm but alive animated background: soft gradient shapes drifting, a few accent elements that move in
time with the four caption lines in assets/captions.srt (cues at 0.4s, 2.3s, 4.6s, 6.9s). Leave the lower half
clear for captions. Then add word-by-word captions from assets/captions.srt with oe_add_captions in the pop style,
large and readable for phones. End on an 'OpenEffects' wordmark at 8.6s. Check a contact sheet before you finish.
*The first take showed two caption lines overlapping for a moment and an orphaned last word. That was a bug in
the caption tool, not the agent, and it's fixed. A second turn re-added the captions with the fixed tool and
moved the wordmark later so the last line can be read.*

Reproduce one, e.g.:

```bash
pnpm oe init /tmp/demo
pnpm oe ask /tmp/demo "<prompt>" --model claude-haiku-5-5
```
