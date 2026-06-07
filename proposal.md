# Proposal: Gamified Interactive Resume

## 1. Vision

Replace the static HTML resume with an interactive, scroll-driven web experience where the resume content is revealed *by playing a game*. Each life chapter — work, education, awards, skills, OSS projects, personal — is a level in a 3D puzzle modelled after **CrazyCubes** (the reference at `References/CrazyCubes/`). The visitor "plays" their way through the candidate's career.

The page must still serve a recruiter who wants the facts in 30 seconds — gamification adds a second, more memorable layer on top, never on top of accessibility. A "Skip & read" toggle is a first-class feature.

## 2. Concept Walkthrough

A visitor lands on a hero page with a glowing isometric scene: a small grid of tiles is arranged so the *tiles themselves spell out* a four-line message —

```
THIS IS A
GAME / RESUME /
ABOUT ME /
INTRO
```

— each glyph built out of base/green tiles, lit from above, drifting gently. The candidate's name and a single-line summary float beside it. The prompt reads **scroll, or press → to begin.**

When the visitor scrolls or presses a direction, the typographic tiles dissolve in a wave (rolling left-to-right) and reform into the **first puzzle level** in the same camera frame — a deliberate "the words become the game" moment. The cube spawns on the base block, the visitor takes control, and as the cube *steps onto* tiles, content cards fade in beside the grid.

**Reveal model — no completion required.** Every block has a content fragment bound to it. Stepping onto a block reveals that fragment immediately. The visitor does not need to clear the level, return to base, or "win" anything to read the resume. Cards stay revealed once shown.

**Scroll is always free.** At any time the visitor can scroll up or down to jump to a different level. The current level pauses in place (state preserved); the next level docks into the camera. There is no gating, no locked levels, no "complete this to continue."

**Levels keep going past the résumé.** After the seven content levels (Intro → Personal), the experience continues into **bonus puzzle levels** that have no résumé content — they are pure CrazyCubes puzzles that ramp up in difficulty for visitors who actually want to play. This is the "endless mode" that lets the game stand on its own legs once the bio is exhausted.

**Difficulty curve.** Level 0 (Intro) is trivially easy — a 1-D path, normal-disappear tiles only. Each subsequent level adds one new block type or one new constraint, so a first-time player learns mechanics gradually. By the bonus levels the player is dealing with combinations (Arrow + Explosive + Shift) and tighter "par-move" budgets.

## 3. Levels & Content Mapping

Levels are split into two arcs: **content levels** (0–6) which carry résumé content, and **bonus levels** (7+) which exist purely as a game and continue indefinitely.

### Content levels

| # | Level Name | Source (`resume.json`) | New mechanic introduced | Reveal-on-touch behaviour |
|---|------------|------------------------|-------------------------|----------------------------|
| 0 | **Intro** | `basics` | Movement only (Base + green Disappear) | Scene opens with tiles spelling "**THIS IS A / GAME / RESUME / ABOUT ME / INTRO**". On first input, the letters dissolve into a 1-D corridor of 5–7 tiles. Stepping on any tile fades in one card: name, label, location, summary, profile links. |
| 1 | **Work** | `work[]` (7 entries) | Disappear-entire-row | Timeline-shaped path. Each tile is one company; stepping on it fades in `{startDate – endDate, position @ company, summary}`. Stepping on a row-clear tile reveals all `highlights` for that company at once. |
| 2 | **Education** | `education[]` | Disappear-similar-in-row | Small grid; tiles reveal institution / degree / years. |
| 3 | **Recognitions** | `awards[]` (3 items) | Explosive | Stepping onto an Explosive tile detonates it and reveals one award card with a particle burst. |
| 4 | **Skills** | `skills[]` (3 groups) | Disappear-similar-in-level | Three clusters of same-coloured tiles; stepping onto one reveals the group name, and *all* sibling tiles light up showing each keyword in the group simultaneously — a visual metaphor for leverage. |
| 5 | **Projects (OSS)** | new section in `resume.json` (Iyan 3D, robot-vacuum Rust firmware, AI contest agent, …) | Shift (teleport) | Each Shift tile is paired to another. Stepping in teleports the cube and reveals one project's card. |
| 6 | **Personal** | new section | Arrow (rail-push) | Arrow tiles send the cube sliding through scenic vignettes. Each tile the cube stops on reveals a personal card (blog, hobbies, interests). |

### Bonus levels (endless)

Levels 7+ have no résumé content — pure CrazyCubes puzzles. The grid grows, par-moves tighten, and block types combine. Generated procedurally from a small set of hand-curated seed puzzles plus algorithmic variants. A "You've reached the résumé's end — keep playing?" overlay greets the visitor at the boundary, with a clear "or jump to contact" link.

Bonus levels *do* have a win condition (clear all non-base tiles, return to base) and award an optional move-count score. This is where the game stops being a delivery vehicle for content and starts being a game.

### Difficulty curve

| Tier | Levels | New mechanic | Grid | Par moves |
|------|--------|--------------|------|-----------|
| Tutorial | 0 | Movement | 1×5 corridor | n/a |
| Easy | 1–2 | + row-clear, + similar-in-row | 5×5, 4×4 | generous |
| Medium | 3–4 | + Explosive, + similar-in-level | 5×5, 6×6 | moderate |
| Harder | 5–6 | + Shift, + Arrow | 6×6 with gaps | tight |
| Bonus 7+ | endless | Combinations | 6×6 → 8×8 | tight |

A visitor can scroll past any level without engaging it. Levels do not block each other.

## 4. Game Mechanics (from CrazyCubes)

The block taxonomy is taken directly from `References/CrazyCubes/all blocks.png`:

| Block | Behaviour | Reuse in resume context |
|-------|-----------|--------------------------|
| **Base** (white) | Start & end tile. | Level entry/exit. Always one per level. |
| **Disappear — normal** (green) | Vanishes after the cube steps off. | Default tile. Reveals one resume bullet. |
| **Disappear — entire row** (orange/striped) | Stepping on it clears the entire row. | Used to reveal a *group* of bullets at once (e.g. all highlights of a company). |
| **Disappear — similar in row** (orange) | Clears all matching tiles in the same row. | Used in Skills to clear a keyword cluster. |
| **Disappear — similar in level** (orange/light) | Clears all same-type tiles on the board. | Skills level finale. |
| **Arrow** (yellow, chevrons) | Forces the cube to slide in the arrow's direction until it hits a non-arrow tile. | Used in **Personal** for guided rails. |
| **Shift** (cyan) | Teleports the cube to a paired Shift tile. | Used in **Projects** to jump between projects. |
| **Explosive** (red, ✕) | Detonates on step, removing itself + 4 neighbours. | Used in **Recognitions** for the burst effect. |

**Reveal trigger:** stepping the cube onto a tile *immediately* reveals that tile's bound content card. No "clear the level to read it." Cards persist once shown, even if the visitor scrolls away and back.

**Win condition (optional, content levels):** all non-Base tiles cleared and cube returned to Base awards a small "Level Mastered ✓" badge in the mini-map. It is purely cosmetic — the visitor does not need it to read anything or to advance.

**Win condition (bonus levels):** the same — clear all tiles, return to Base. Move count is recorded against a per-level par.

**Controls:** Arrow keys / WASD on desktop, swipe on mobile, on-screen D-pad as fallback. Page scroll (mouse wheel / trackpad / vertical swipe outside the play area) jumps between levels at any time. `Esc` opens an overlay with the current level's full text content for accessibility.

## 5. Visual Direction

The CrazyCubes screenshots are the north star: isometric camera, dark teal/navy background with subtle radial vignette, tiles with strong neon-coloured outline glow, soft shadow under each tile, and the player cube glowing cyan with a faint emissive halo.

**Rendering targets:**

- **Engine:** Three.js + WebGL2. Optionally upgrade hot levels to WebGPU when available (progressive enhancement).
- **Look:** physically-based shading on tiles (metallic + roughness maps from `References/CrazyCubes/3d texture/`), screen-space ambient occlusion (SSAO), bloom on emissive channels, subtle chromatic aberration on the bloom pass for a "ray-traced" feel without the cost.
- **Lighting:** one key directional light + one fill + per-tile emissive. HDR pipeline with ACES tone mapping. Soft contact shadows under tiles.
- **Parallax:** background star/grid plane drifts opposite to cube motion; foreground particles drift slightly in-direction. Camera has a small mouse-driven parallax (≤2°) to keep the scene "alive" when idle.
- **Materials:** glossy clearcoat on tile tops (the white square inset readout), matte sides, slight Fresnel rim. Player cube has an animated emissive pulse synced to a 0.8 Hz bob.
- **Post-FX stack:** SSAO → Bloom → Vignette → Tone map → FXAA. Toggle in a settings panel.
- **Typography:** content cards float in a glass-morphism panel beside the active grid — frosted, low-saturation, with a thin neon edge that matches the level's accent colour.

A **"Lite mode"** automatically activates on low-end devices (battery saver, <60 fps for 2 s, prefers-reduced-motion): drops post-FX, swaps PBR for flat-shaded toon, halves DPR.

## 6. Page Architecture

```
[ Level 0: Intro — typographic tiles spell "THIS IS A / GAME / RESUME / ABOUT ME / INTRO" ]
       │
       ▼  (free scroll)
[ Level 1: Work ]
       │
       ▼
[ Level 2: Education ]
       │
       ▼
       …
       │
       ▼
[ Level 6: Personal ]
       │
       ▼
[ "End of résumé — keep playing?" boundary ]
       │
       ▼
[ Level 7+: Bonus puzzles, endless ]
       │
       ▼
[ Outro: contact + download PDF + credits ]   ← always reachable via "Jump to contact"
```

- **Scroll is always free.** Scroll up/down jumps between levels at any time, regardless of progress in the current level. The active level pauses (state preserved) and the next docks into the camera.
- **Input separation:** vertical scroll = navigate levels. Arrow keys / WASD / on-grid swipes = move the cube. There is no scroll-lock or input-capture; the canvas only consumes directional input that originates inside its bounds.
- A persistent left-edge **mini-map** lists all levels (content + bonus, with the bonus tail rendered as "∞"). Each node shows three states: *unvisited*, *visited* (any tile stepped on), *mastered* (completed). Clicking jumps to that level.
- A persistent top-right **toolbar**: `Skip & read` (full static resume in a sidebar), `Mute`, `Lite mode`, `Restart level`, `Jump to contact`, `Download PDF`.
- A persistent bottom-right **"Read all"** affordance on every level — opens the level's bound content as a list, regardless of which tiles have been touched. Recruiter escape hatch.

## 7. Accessibility & Fallbacks

- **Skip & read** dumps the entire `resume.json` rendered as the existing static HTML — recruiters who don't want to play get one click to the facts.
- **Keyboard-only play** is fully supported.
- **Screen readers:** every revealed card is appended to a live region; the canvas itself is `aria-hidden`.
- **`prefers-reduced-motion`:** disables parallax, bob, and camera transitions; tiles fade rather than pop.
- **No-WebGL fallback:** server-rendered static page (the current `public/index.html`) is served when `webgl` is undetected.
- **Mobile:** levels reflow to portrait, on-screen D-pad, smaller grids (4×4 max).
- **Performance budget:** initial bundle ≤ 250 KB gz (excluding lazy-loaded level meshes), TTI < 3 s on a mid-range mobile, 60 fps on M1 / mid-range Android.

## 8. Technical Architecture

```
resume.json  ──┐
               ├──► build.py (Jinja2)  ──► public/index.html  (shell + SEO meta + static fallback)
levels.json  ──┤                                    │
               │                                    ▼
template.html ─┘                          [ JS bundle (Three.js) ]
                                                    │
                                                    ▼
                                          [ Game loop + level loader ]
```

- **`resume.json`** stays the single source of truth for content.
- **`levels.json`** (new) describes each level's grid layout, block types, and which `resume.json` field each block is bound to. Authored by hand for content levels (0–6) and seed bonus levels; bonus levels beyond the seeds are generated procedurally at runtime from a small set of templates + difficulty parameters. Validated at build time.
- **Intro level typography** is a build-time step: a tiny Python helper in `build.py` rasterises the four-line message ("THIS IS A / GAME / RESUME / ABOUT ME / INTRO") at low resolution into a bitmap, then emits a tile coordinate list into `levels.json`. Changing the headline text only requires a re-run of `build.py`.
- **`build.py`** keeps doing what it does — rendering the static fallback HTML — and additionally emits a small `content.js` module (the same data as JSON) that the game reads at runtime.
- **Game code** lives in a new `src/` (TypeScript). Entry point: `src/main.ts`. Bundled with **Vite** to `public/assets/`.
- **Assets:** 3D meshes are simple beveled cubes generated procedurally in code (no GLTF needed for tiles); textures are reused from `References/CrazyCubes/3d texture/` (re-encoded as KTX2). Player cube can be a slightly more detailed GLTF.

### Proposed file layout

```
resume/
├── build.py                       # extended: emits content.js + copies assets
├── resume.json                    # unchanged source of truth
├── levels.json                    # NEW: level definitions
├── template.html                  # extended: hosts canvas + static fallback
├── requirements.txt
├── package.json                   # NEW: Vite + Three.js
├── tsconfig.json                  # NEW
├── src/                           # NEW: game source
│   ├── main.ts
│   ├── engine/                    # renderer, post-FX, input
│   ├── game/                      # board, blocks, rules, level loop
│   ├── content/                   # binds resume.json fields → reveals
│   └── ui/                        # cards, toolbar, minimap, skip-mode
├── public/
│   ├── index.html                 # generated
│   ├── assets/                    # generated by Vite
│   └── textures/                  # re-encoded from References/
└── References/CrazyCubes/         # unchanged
```

## 9. Build & Dev Loop

- `pip3 install -r requirements.txt` and `npm install` — one-time setup.
- `npm run dev` — Vite dev server with HMR for the game.
- `python3 build.py` — renders `index.html` (shell + static fallback) and copies content.
- `npm run build` — produces optimised JS bundle into `public/assets/`.
- `npm run preview` — serves `public/` exactly as GitHub Pages will.
- CI: a single `make build` runs both Python and Vite builds; output is `public/`, which is what GitHub Pages already serves. **No change to deployment.**

## 10. Phased Delivery

The proposal is large; suggested phasing so each step ships something usable:

1. **Phase 0 — Scaffold (½ day).** Add Vite + Three.js, render an empty isometric scene with one base block and the existing static resume below it (everything still works for recruiters from day one).
2. **Phase 1 — Intro level + reveal-on-touch (2–3 days).** Typography-to-puzzle dissolve, cube movement, base + green-disappear blocks, on-touch content cards bound to `basics`. No post-FX yet.
3. **Phase 2 — Block taxonomy (2 days).** Implement remaining 6 block types with their behaviours. Author Work + Skills levels.
4. **Phase 3 — Free-scroll navigation (1 day).** Multi-level scroll docking, mini-map, "Read all" panel, Esc overlay, level state preservation across scrolls.
5. **Phase 4 — Visual polish (2 days).** PBR materials, SSAO, bloom, parallax, particles, audio cues. Lite mode toggle.
6. **Phase 5 — Remaining content levels (2 days).** Education, Recognitions, Projects, Personal.
7. **Phase 6 — Bonus / endless levels (1–2 days).** Seed puzzles + procedural variants, par-move scoring, "End of résumé" boundary card.
8. **Phase 7 — Accessibility & perf (1–2 days).** Skip mode, reduced motion, keyboard, screen-reader live region, mobile D-pad, perf budget enforcement.
9. **Phase 8 — Content tuning.** New `resume.json` sections for OSS projects + personal; copy passes.

Total rough estimate: **~2.5 weeks** of focused work for a polished v1.

## 11. Open Questions

- **OSS Projects & Personal sections** don't yet exist in `resume.json` — should I extend the schema, or store these only in `levels.json`? *Recommend: extend `resume.json`, keep it the single source of truth.*
- **Difficulty:** should levels be solvable on the first try (puzzles tuned for flow), or genuinely challenging? *Recommend: trivially solvable, with optional "par moves" for engaged visitors.*
- **Audio:** ambient pad + tile clicks + reveal chimes — yes/no? Default-muted with a clear unmute affordance.
- **Analytics:** track level-completion funnels to see if recruiters actually play, or skip? Privacy-respecting (Plausible / self-hosted) only.
- **PDF export:** keep generating one from `resume.json` for the "download PDF" button — useful as the recruiter-friendly artefact.

## 12. Risks

- **Recruiter friction.** Mitigated by `Skip & read` being prominent and the static HTML fallback being fully functional.
- **Performance on low-end devices.** Mitigated by Lite mode + auto-detection.
- **Bundle size.** Three.js is ~150 KB gz; budget is tight but fine. Avoid heavy GLTFs; generate geometry in code.
- **Maintenance.** Adding a new role to `resume.json` should *not* require editing `levels.json` for the Work level — the level reads the array generically and lays out the grid procedurally. Only structural levels (Intro, Personal) hand-author their grids.
- **SEO.** Static fallback is the canonical SEO content; the game shell adds nothing. `resume.json` → static HTML keeps Google happy.

## 13. Success Criteria

- A recruiter can get every fact from the current resume in ≤ 30 seconds via Skip mode.
- A curious visitor can play through all 7 levels in ≤ 5 minutes.
- The page runs at 60 fps on an M1 MacBook and ≥ 30 fps on a 2021 mid-range Android.
- Lighthouse: Performance ≥ 85, Accessibility ≥ 95.
- The static fallback at `public/index.html` (with JS disabled) still renders the full résumé.
