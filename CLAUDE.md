# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An interactive résumé in two parts:

1. **Game (primary)** — a Three.js + TypeScript puzzle where a cube rolls across a tile grid.
   Entry point is the root `index.html`, loading `src/main.ts` via Vite.
2. **Static fallback** — a static HTML résumé rendered from `assets/resume.json` at build time by
   a Vite plugin (`src/resume/render.ts` → `resume.html`), served for no-JS/no-WebGL visitors.

Both pages read `assets/resume.json` as the single source of résumé content: the `static-resume`
Vite plugin renders it into `resume.html`, and the game pulls selected fields at build time via the
Vite `resume-refs` plugin. One `npm run build` produces both — there is no Python build.

## Commands

Game:

- **Dev server:** `npm run dev` (Vite, http://localhost:5173)
- **Build:** `npm run build` (`tsc --noEmit` then `vite build` → `dist/`)
- **Quality:** `npm run typecheck` · `npm run format:check` · `npm test` (Vitest)

Quality gates (run by CI in `.github/workflows/ci.yml`):

- Python: `ruff check .` · `ruff format --check .` (lints `level-gen/wire_ladder.py`; deps: `requirements-dev.txt`)
- Rust (`level-gen/`): `cargo fmt --check` · `cargo clippy --lib --bins --tests -- -D warnings` · `cargo test`
- See `README.md` for setup and the full command list.

Static fallback:

- Built by `npm run build` alongside the game — the `static-resume` Vite plugin renders
  `assets/resume.json` via `src/resume/render.ts` into `dist/resume.html`. No separate command.

Level generation (Rust, `level-gen/` — build with `cargo build --release` first):

- **Campaign:** `level-gen campaign --name run1 --duration 60m` — streams + screens millions of
  boards, keeps the best per (size × mechanic × band) bucket in `levels/campaigns/<name>/pool.json`.
  Resumable (`--resume`), Ctrl-C-safe. The quality model selects for levels that **need a plan**:
  resists random/greedy play (a hard gate), delayed consequences, sharp solution, spectacle.
- **Status / report:** `level-gen campaign-status --name run1` · `level-gen rank --name run1 --out ../levels/report.md`.
- **Curate:** `level-gen curate --from-campaign run1 --profile initial32 --out ../levels/ladder32.json`
  — 6 tutorial rungs then a steep ramp into hard/expert.
- **Wire into the game:** `python3 level-gen/wire_ladder.py` (ladder32.json + résumé content → `src/game/levels.json`).
- **Selftest:** `level-gen selftest` solves DEMO + every shipped level and prints the quality model.

## Architecture

### Game (`src/`)

- `core.ts` — shared primitives used across modules: the `Direction` and `TileKind` unions,
  `DIRECTION_DELTA` grid steps, the deterministic `noise()` hash, and the `PALETTE` colour map. Add
  shared constants/colours/types here rather than re-declaring them per module (core depends on
  nothing — the game layer depends on core, not the reverse).
- `engine/scene.ts` — Three.js scene, camera, lighting, parallax.
- `engine/models.ts` — loads + normalises the player/platform OBJ+MTL meshes (`loadNormalizedModel`).
- `game/layout.ts` — Three.js-free board parsing/validation: `CellDef`, `LevelLayout`, `parseLayout()`
  (compact char grid → level), and `validateLayout()`. Kept canvas-free so it's unit-testable.
- `game/grid.ts` — `buildLevel()` constructs the board, tile state, chain reactions (blasts/lines),
  and win/lose rules. Re-exports the layout types; `DEMO_LAYOUT` is the demo.
- `game/player.ts` — rolling/falling/teleporting cube physics (unit-tested).
- `game/tile.ts` — per-kind tile materials (colours from `PALETTE`).
- `game/contact.ts` — `decodePhone()` for the play-to-unlock phone reveal.
- `game/decoration.ts` — animated 8×8 cube-grid overlays per tile kind (one shared animator).
- `game/effects.ts` — transient projectiles and teleport swirls.
- Tests live next to their module as `*.test.ts` (Vitest); the suite runs headlessly (node).

### Static fallback

Pipeline (all TypeScript, inside the Vite build): `assets/resume.json` → `src/resume/render.ts` →
injected into `resume.html` by the `static-resume` plugin in `vite.config.ts`.

- `assets/resume.json` — résumé content ([JSON Resume](https://jsonresume.org/schema/) schema).
- `resume.html` — the page shell (CSS inline; design-system tokens via `/design-system/tokens.css`);
  its `<main class="pg">%RESUME%</main>` placeholder is filled at build time.
- `src/resume/render.ts` — `renderResume(resume, base)`, a pure function returning the body HTML
  (unit-tested in `render.test.ts`). The avatar is a plain `<img>` from `basics.picture`.

Edit `assets/resume.json` (content) or `resume.html` / `src/resume/render.ts` (layout); `npm run
build` (or `npm run dev`) regenerates the page. No separate build step, no Python.

### Assets (`assets/` — Vite `publicDir`)

Single source for everything served statically: `models/` (player/platform OBJ+MTL, loaded by
`engine/models.ts`), `harishankar.jpeg` (the avatar, shown on the game home screen and the static
résumé), and `resume.json`. Vite serves `assets/` in dev and copies it into `dist/` on build — so
the deploy is simply `dist/` (game `index.html` + `resume.html` side by side, with `models/`, the
avatar, and `resume.json` alongside). No manual copy step; one `vite build` emits both pages.
