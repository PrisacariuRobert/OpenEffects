import { EASE_NAMES } from "./easing.ts";

/**
 * The guide every agent gets. It's written into each project as AGENTS.md / CLAUDE.md
 * and is also returned by the `oe_get_guide` MCP tool. Keep it short and concrete:
 * agents follow examples far better than prose.
 */
export const AGENT_GUIDE = `# OpenEffects project: guide for AI agents

You are editing an OpenEffects motion graphics project. The whole animation lives in
\`project.oe.json\`. The OpenEffects app hot-reloads it, so every valid edit shows up
in the user's preview immediately.

## Workflow (follow this)
1. \`oe_get_project\` to read the current state.
2. Make changes with the OpenEffects MCP tools (\`oe_add_layer\`, \`oe_update_layer\`,
   \`oe_set_keyframes\`, ...) or by editing \`project.oe.json\` directly.
   Every tool validates the result and rejects invalid edits with a precise error.
3. **Check your work visually.** Call \`oe_render_contact_sheet\` (a grid of frames
   across the timeline) and/or \`oe_render_frame\` at key moments. Look for text that is
   clipped, overlapping, off-screen, unreadable or badly timed, and fix it.
4. Finish with a 1-3 sentence summary of what you made. Do not export unless asked.

## Format essentials
- Units: pixels, seconds, degrees, percent (opacity 0-100, scale 100 = original).
- Coordinates: [0,0] is the top-left of the composition. Most layers draw **centered
  on their position**, and position defaults to the composition center. Path layers
  draw raw SVG coordinates instead; their position defaults to [0,0].
- Parenting: a child's transform is applied inside its parent's coordinate space. To move or
  scale many layers together (a "camera"), add a null with \`anchor\` = \`position\` = the
  composition center, then set \`parent\` on the children: their coordinates stay unchanged.
- Layers render in array order: **the last layer is on top**.
- Keyframe times are absolute composition seconds.
- Any animatable property is either a value or \`{ "keyframes": [{ "t": 0, "v": ..., "ease": "easeOutCubic" }, ...] }\`.
  \`ease\` on a keyframe controls the motion towards the NEXT keyframe (default easeInOut).
  Use \`"hold"\` for a jump cut. Cubic-bezier arrays like [0.2, 0, 0, 1] also work.
- Easings: ${EASE_NAMES.join(", ")}.

## Layer types
| type | key fields |
|---|---|
| solid | color (color or gradient), size? (default = comp size) |
| rect | size [w,h], radius?, fill?, stroke? |
| ellipse | size [w,h], fill?, stroke? |
| path | d (SVG path data; keyframe it to morph shapes — every keyframe needs the same commands), fill?, stroke?, trim { start?, end? } (percent; animate end 0→100 to draw lines on) |
| text | text, font { family?, weight?, size? }, fill?, stroke?, align?, letterSpacing?, lineHeight?, animator? |
| image | src (relative path, e.g. assets/logo.png), size? |
| video | src (assets/clip.mp4), size?, trimStart?, speed?, loop?, volume? (animatable 0-100), muted? |
| audio | src (assets/music.mp3), trimStart?, speed?, volume? (animatable), muted?; no picture, plays in preview and exports |
| null | (invisible) used as a parent to move several layers together |
| comp | comp (id of another composition), timeOffset?, timeRemap? (animatable seconds of the nested comp: freeze, slow-mo, reverse) |

Common to every layer: id (unique), name?, in?, out?, visible?, parent?, transform
{ position, anchor, scale, rotation, opacity }, effects[], blend
(normal|add|screen|multiply|overlay|lighten|darken|difference), matte { layer, mode: alpha|alphaInverted }.

Fill = a color (\`"#ff3366"\`, animatable) or a gradient:
\`{ "type": "linear", "stops": [[0, "#ff3366"], [1, "#6633ff"]], "from": [-200, 0], "to": [200, 0] }\`
\`{ "type": "radial", "stops": [[0, "#fff"], [1, "#0000"]], "radius": 300 }\` (layer-local coordinates; [0,0] = layer center).

Effects: \`{ "type": "blur", "radius": 8 }\`, \`{ "type": "glow", "radius": 30, "intensity": 1.5, "color": "#7af" }\`,
\`{ "type": "dropShadow", "distance": 12, "softness": 24, "color": "rgba(0,0,0,0.5)" }\`,
\`{ "type": "colorAdjust", "brightness": 110, "contrast": 120, "saturation": 80, "hue": 0 }\`. Effect params are animatable.

Text animator (per-character/word/line build-in, the classic kinetic-typography move):
\`"animator": { "by": "character", "stagger": 0.03, "duration": 0.6, "ease": "easeOutBack", "from": { "opacity": 0, "offset": [0, 40], "scale": 60, "blur": 8 } }\`

Track matte (reveal text from behind a moving shape): give the shape \`"visible": false\` and set
\`"matte": { "layer": "<shape id>" }\` on the text.

## Example layer
\`\`\`json
{
  "id": "title", "type": "text", "text": "HELLO",
  "font": { "family": "Inter", "weight": 800, "size": 180 },
  "fill": { "type": "linear", "stops": [[0, "#ffffff"], [1, "#9fb4ff"]], "from": [0, -90], "to": [0, 90] },
  "transform": {
    "scale": { "keyframes": [{ "t": 0, "v": 80, "ease": "easeOutBack" }, { "t": 0.8, "v": 100 }] },
    "opacity": { "keyframes": [{ "t": 0, "v": 0, "ease": "easeOutCubic" }, { "t": 0.4, "v": 100 }] }
  },
  "effects": [{ "type": "glow", "radius": 30, "intensity": 0.8 }]
}
\`\`\`

## Markers, music and timing
Compositions can have \`markers: [{ "t": 1.5, "label": "drop" }]\`. With an audio layer, \`oe_detect_beats\` adds a
marker on every beat (or on every hit); read them back with \`oe_get_project\` and put keyframes on those times to
sync motion to the music. Media layers use \`in\`/\`out\` like any layer; \`trimStart\` skips into the file.

## Lottie

- \`oe_export\` with format "lottie" writes a Lottie JSON for websites and iOS/Android apps. Shapes, text, images,
  precomps, mattes, keyframes and easing carry over; behaviors and text animators are baked. Glow, color adjust,
  video and audio have no Lottie equivalent (the notes say so).
- \`oe_import_lottie\` turns a .json Lottie file in the project into editable layers (added as a precomp layer).

## Behaviors (procedural motion)
Instead of many keyframes, attach a behavior to a property (\`behaviors\` array on the layer, or \`oe_add_behavior\`).
They add on top of the static/keyframed value every frame:
- \`{ "type": "wiggle", "property": "transform.position", "amount": 8, "frequency": 3 }\`: organic jitter (seeded, smooth)
- \`{ "type": "oscillate", "property": "transform.scale", "amplitude": 5, "frequency": 1, "wave": "sine" }\`: pulse / float / sway
- \`{ "type": "drift", "property": "transform.rotation", "speed": 90 }\`: constant change per second (spin, slow pan)
- \`{ "type": "loop", "property": "transform.position", "mode": "pingpong" }\`: repeat the keyframes forever
- \`{ "type": "follow", "property": "transform.position", "layer": "leader", "delay": 0.15, "offset": [0, 40] }\`: trail another layer
Optional on all: start, end (seconds), fadeIn (seconds), enabled. Use [x, y] amounts for per-axis motion (e.g. [0, 12] = vertical only).

## Animation presets
\`oe_apply_preset\` adds a ready-made, editable animation to a layer at a time: fade-in, slide-up/down/left/right,
pop-in, zoom-in, blur-in, spin-in, typewriter / words-up / letters-pop (text), fade-out, slide-out-down, pop-out,
zoom-out, and loops pulse, float, wiggle, spin. Use them for quick, consistent motion, then fine-tune the keyframes.

## Motion design tips
- Fast in, slow settle: easeOutCubic/Expo for entrances, easeInCubic for exits, easeInOut for moves.
- Stagger elements by 0.05-0.15 s instead of animating everything at once.
- Keep important content inside the title-safe area (inner 90%) and hold the final state ≥1 s.
- Layer depth: background (solid/gradient) → shapes/accents → text → glow/highlights.
- Contrast: light text on dark backgrounds (or the reverse); avoid pure #000 on #fff glare.
- The default font is Inter (100-900). Other installed system fonts may work but are not portable.
`;
