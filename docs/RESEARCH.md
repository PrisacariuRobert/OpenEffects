# What users expect from OpenEffects: UX research (Oct 2026)

A short desk study of motion design tools and AI motion tools, to decide what to build next.
Sources are listed at the end. Most are product docs, reviews and forum threads, so treat the
findings as directional rather than statistically representative.

## Who uses this app

1. **Non-designers with a deadline** (founders, marketers, developers, creators): want a good result fast,
   from a prompt or a template, and to change text, colors and timing without learning motion design.
2. **Motion designers** curious about AI: want the AI to do the tedious 80% and to keep frame-level control
   of timing and easing. They judge a tool by its timeline and graph editor.
3. **Developers / agents**: want scriptable, text-based projects (already covered: JSON + MCP + CLI).

## What we learned

| Finding | Evidence | What it means for OpenEffects |
|---|---|---|
| AI output must be an **editable project**, not a finished video; users dislike "lottery" regeneration | Motionly, Higgsfield Vibe Motion and Genmo reviews; Animdock review notes prompts get interpreted too literally and a shallow timeline blocks pros | Keep the AI writing a real timeline; make every result tweakable by hand; scope AI edits to a selection (done) |
| **Easing is where quality lives.** Modern tools pair easing presets with a draggable bezier curve and let you save custom curves | Jitter custom easings (presets, draw your own, save for reuse); Lottie Creator easing docs (bezier editor, graph editor for overshoot/snappy motion, spring curve) | Build a graph editor + ease editor with presets, overshoot/anticipation, and saved "My easings" |
| The **After Effects graph editor is a known pain point**; Cavalry's is praised; designers miss built-in bounce/overshoot | Nick Ritter's Cavalry vs AE graph editor comparison; designer commentary | Make curves direct-manipulation: drag keyframes and handles on a value graph, presets one click away |
| **One-click animation presets** make tools approachable (animate text by line/word/letter, fade/slide/pop) | Jitter help center and reviews ("easy to navigate especially for first-time users") | Add an "Animate" preset library applied at the playhead, for in, out and loops |
| **Keyframe icons that show their easing** speed up reading a timeline | Lottie Creator keyframe docs (diamond = linear, circle = eased, …) | Shape-code keyframes by easing |
| Pros expect **multi-select, copy/paste and retiming of keyframes**, plus fast keyboard workflows | Blender/AE add-on feature sets; Lottie Creator shortcuts (P/S/R/T) | Shift-click multi-select, Ctrl+C/V keyframes at the playhead, bulk delete/ease |
| **Motion paths** on the canvas help understand and edit movement | Lottie Creator motion paths; Reallusion forum request | Draw the position path with keyframe dots in the viewer |
| Basic layout aids are table stakes: **align, safe areas, preview range** | Common to AE/Premiere/Figma-style tools | Align buttons, title/action-safe guides, a loop region for previews |
| AE users' biggest complaints are **stability, speed and price**, not missing features | Adobe community bug reports (2026), G2/Capterra reviews | Stay fast and light (browser, instant preview), free, and never lose work (autosave + checkpoints, done) |
| **Procedural "behaviours"** (wiggle, noise, stagger) beat hand-keyframing repetitive motion | Cavalry reviews and School of Motion | Next: behaviours such as wiggle/loop as properties, not keyframes |

## Prioritized feature list

Built in this round:

1. **Graph editor**: value curves for the selected property, draggable keyframes (time and value) and bezier
   handles per segment, auto-fit, aligned with the timeline. Toggle with the **Graph** button.
2. **Ease editor**: bezier box with two handles and a live preview, presets including overshoot and anticipation,
   and a saved "My easings" library. Applies to every selected keyframe.
3. **Keyframe workflow**: easing-coded keyframe shapes, Shift-click multi-select, Ctrl+C / Ctrl+V at the playhead,
   bulk delete and bulk easing.
4. **Animate presets**: one-click fade, slide, pop, zoom, blur, spin, typewriter (in and out), plus pulse, float and
   wiggle loops, applied at the playhead.
5. **Viewer aids**: motion path overlay, align buttons, title/action-safe guides.
6. **Preview range** (loop region) on the timeline ruler.

Built next: **behaviors** (wiggle, oscillate, drift, loop, follow) as procedural properties, and a **first-run welcome
screen + spotlight tour** (three ways to start, agent setup check, replay from `?`).

Then: **video and audio layers with markers** (waveforms in the timeline, M / `[` `]` markers, one-click beat and
hit detection, snapping to markers, audio mixed into exports), so motion can be cut to music, the most common
request for social video.

Still open: preset sharing, Lottie import/export, Figma import.

## Sources

- After Effects 2026 bug reports: [timeline hang](https://community.adobe.com/bug-reports-528/ae-2026-hangs-when-selecting-multiple-layers-and-keyframes-1644280),
  [regressions](https://community.adobe.com/bug-reports-528/3-critical-regressions-object-matte-v4-chatter-scene-edit-pre-comp-offset-and-broken-auto-save-1644575),
  [stop making apps worse](https://community.adobe.com/questions-529/stop-making-apps-worse-1551895); [G2 reviews](https://g2.com/products/adobe-after-effects/reviews?page=2)
- Jitter: [custom easings changelog](https://jitter.video/changelog/2025-02-18-custom-easings), [what is Jitter](https://help.jitter.video/en/articles/12089209-what-is-jitter),
  [Capterra reviews](https://www.capterra.com/p/230448/Jitter/reviews), [Toolradar](https://toolradar.com/tools/jitter)
- Cavalry: [School of Motion: getting started](https://schoolofmotion.com/blog/getting-started-with-cavalry-5-things-every-beginner-should-know),
  [graph editor comparison](https://lesterbanks.com/2021/05/cavalry-vs-after-effects-a-graph-editor-comparison/),
  [2026 review](https://superrendersfarm.com/article/cavalry-motion-design-review-2026)
- Lottie Creator: [easing](https://docs.lottiefiles.com/en/creator/07_animation/easing), [keyframes](https://docs.lottiefiles.com/en/creator/07_animation/keyframes),
  [product page](https://lottiefiles.com/creator)
- AI motion tools: [Higgsfield Vibe Motion review](https://whyops.com/blog/higgsfield-vibe-motion-review),
  [Animdock review](https://aiindigo.com/blog/animdock-motion-templates-in-the-browser-a-practical-review-for-2026),
  [Genmo review](https://aiindigo.com/blog/genmo-review-2026-high-end-motion-control-for-the-modern-creator),
  [Wireflow 2026 roundup](https://www.wireflow.ai/blog/best-ai-tools-for-motion-graphics-design-2026), [Motionly](https://www.producthunt.com/products/motionly)
- Motion paths / keyframe tools: [Reallusion forum](https://forum.reallusion.com/Topic331368.aspx), [Blender animation add-on](https://www.blenderkit.com/addons/fe9df247-5dd5-441d-91dc-aafdde63db3e)
