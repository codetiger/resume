# Resume

An interactive, gamified résumé. Roll a cube across a 3D tile grid (Three.js); a static
HTML résumé rendered from JSON serves as the no-JavaScript fallback. One Vite build, no Python.

Demo — [Game](https://codetiger.in/resume/) · [Static résumé](https://codetiger.in/resume/resume.html)

## Two stacks

| Stack               | Entry                                  | Purpose                                                                                                      |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Game** (primary)  | `index.html` + `src/`                  | Three.js + TypeScript puzzle résumé, built with Vite.                                                        |
| **Static fallback** | `resume.html` + `src/resume/render.ts` | Rendered from `assets/resume.json` at build time by a Vite plugin; what recruiters land on without WebGL/JS. |

`assets/resume.json` is the single source of truth: the game's `src/game/levels.json`
references it with JSONPath (`$…`) strings, resolved at build time by the
`resume-refs` Vite plugin in `vite.config.ts`.

All static assets live in `assets/` — the models (`assets/models/`), the avatar
(`assets/harishankar.jpeg`), and `resume.json`. It is Vite's `publicDir`, so it is served
in dev and copied into `dist/` on build (no manual copy step in the workflow).

## Game (Three.js)

```bash
npm install
npm run dev   # Vite dev server at http://localhost:5173 (game + /resume.html)
npm run build # tsc --noEmit + vite build → dist/ (game index.html + resume.html)
```

Deployment is manual: run `npm run build` to produce `dist/` (the game
`index.html` and `resume.html` side by side, with `models/`, the avatar, and
`resume.json` alongside), then publish `dist/` to your host. CI
(`.github/workflows/ci.yml`) runs the quality checks only; it does not deploy.

Source layout under `src/`:

- `core.ts` — shared primitives: the `Direction` and `TileKind` types, `DIRECTION_DELTA`, the `noise()` hash, and the `PALETTE` colour map.
- `engine/` — Three.js infrastructure: `scene.ts` (camera/lighting/renderer) and `models.ts` (OBJ/MTL loading).
- `game/` — gameplay: `layout.ts` (Three.js-free board parsing/validation), `grid.ts` (level + tile rules), `player.ts` (rolling cube), `tile.ts`, `contact.ts`, `decoration.ts` (animated tile overlays), `effects.ts` (projectiles/swirls).

## Static fallback

Built by the same `npm run build` (and live under `npm run dev`): the `static-resume` Vite
plugin renders `assets/resume.json` into `resume.html`, so it ships as plain HTML — no Python.

- **Content:** edit `assets/resume.json` ([JSON Resume](https://jsonresume.org/schema/) schema).
- **Layout:** edit `src/resume/render.ts` (the body markup; unit-tested in `render.test.ts`) or
  `resume.html` (the page shell + CSS). The avatar is a plain `<img>` from `basics.picture`.
- Styling uses the shared design system via `/design-system/tokens.css` (with fallbacks).

## Level generation (Rust)

The puzzle ladder is produced offline by the `level-gen/` crate (solver + campaign +
curator) and wired into the game with `level-gen/wire_ladder.py`. See
[`level-gen/README.md`](level-gen/README.md) for the workflow and
[`levels/README.md`](levels/README.md) for the candidate → curated → wired lifecycle.

## Development

Quick reference for the three stacks:

```bash
# TypeScript game
npm run typecheck && npm test && npm run build

# Python helper (level-gen/wire_ladder.py)
pip3 install -r requirements-dev.txt
ruff check . && ruff format --check .

# Rust level generator
cd level-gen && cargo fmt --check && cargo clippy --lib --bins --tests -- -D warnings && cargo test
```

CI (`.github/workflows/ci.yml`) runs the same checks on every PR and push to `master`.
