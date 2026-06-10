# Resume

An interactive, gamified résumé. Roll a cube across a 3D tile grid (Three.js); a static
HTML résumé generated from JSON serves as the no-JavaScript fallback.

Demo — [Game](https://codetiger.github.io/resume/) · [Static résumé](https://codetiger.github.io/resume/resume.html)

## Two stacks

| Stack               | Entry                            | Purpose                                                                                              |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Game** (primary)  | `index.html` + `src/`            | Three.js + TypeScript puzzle résumé, built with Vite.                                                |
| **Static fallback** | `assets/resume.html` (generated) | Generated from `assets/resume.json` by the Python builder; what recruiters land on without WebGL/JS. |

`assets/resume.json` is the single source of truth: the game's `src/game/levels.json`
references it with JSONPath (`$…`) strings, resolved at build time by the
`resume-refs` Vite plugin in `vite.config.ts`.

All static assets live in `assets/` — the models (`assets/models/`), the avatar
(`assets/harishankar.jpeg`), and `resume.json`. It is Vite's `publicDir`, so it is served
in dev and copied into `dist/` on build (no manual copy step in the workflow).

## Game (Three.js)

```bash
npm install
npm run dev        # Vite dev server at http://localhost:5173
npm run build      # tsc --noEmit + vite build → dist/ (game only)
npm run build:site # python3 build.py + npm run build → dist/ (game + static résumé)
```

Deployment is automated: pushing to `master` runs `.github/workflows/deploy.yml`,
which builds both stacks and publishes `dist/` to GitHub Pages (game at `/resume/`,
static résumé at `/resume/resume.html`). Requires repo **Settings → Pages → Source =
"GitHub Actions"** (one-time).

Source layout under `src/`:

- `core.ts` — shared primitives: the `Direction` type, `DIRECTION_DELTA`, the `noise()` hash, and the `PALETTE` colour map.
- `engine/` — Three.js infrastructure: `scene.ts` (camera/lighting/renderer) and `models.ts` (OBJ/MTL loading).
- `game/` — gameplay: `grid.ts` (level + tile rules), `player.ts` (rolling cube), `tile.ts`, `decoration.ts` (animated tile overlays), `effects.ts` (projectiles/swirls).

## Static fallback (Python)

```bash
pip3 install -r requirements.txt
python3 build.py          # assets/resume.json + template.html → assets/resume.html
```

- **Content:** edit `assets/resume.json` ([JSON Resume](https://jsonresume.org/schema/) schema).
- **Design/layout:** edit `template.html` (Jinja2 template, CSS inlined).
- `assets/resume.html` is generated — do not edit by hand; regenerate with `python3 build.py`.
