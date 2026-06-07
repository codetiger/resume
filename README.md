# Resume

An interactive, gamified résumé. Roll a cube across a 3D tile grid (Three.js); a static
HTML résumé generated from JSON serves as the no-JavaScript fallback.

Demo — [Harishankar Narayanan](https://codetiger.github.io/resume/public/)

## Two stacks

| Stack | Entry | Purpose |
|-------|-------|---------|
| **Game** (primary) | `index.html` + `src/` | Three.js + TypeScript puzzle résumé, built with Vite. |
| **Static fallback** | `public/index.html` | Generated from `resume.json` by the Python builder; what recruiters land on without WebGL/JS. |

## Game (Three.js)

```bash
npm install
npm run dev      # Vite dev server at http://localhost:5173
npm run build    # tsc --noEmit + vite build → dist/
```

Source layout under `src/`:

- `core.ts` — shared primitives: the `Direction` type, `DIRECTION_DELTA`, the `noise()` hash, and the `PALETTE` colour map.
- `engine/` — Three.js infrastructure: `scene.ts` (camera/lighting/renderer) and `models.ts` (OBJ/MTL loading).
- `game/` — gameplay: `grid.ts` (level + tile rules), `player.ts` (rolling cube), `tile.ts`, `decoration.ts` (animated tile overlays), `effects.ts` (projectiles/swirls).

## Static fallback (Python)

```bash
pip3 install -r requirements.txt
python3 build.py          # resume.json + template.html → public/index.html
```

- **Content:** edit `resume.json` ([JSON Resume](https://jsonresume.org/schema/) schema).
- **Design/layout:** edit `template.html` (Jinja2 template, CSS inlined).
- `public/index.html` is generated — do not edit by hand; regenerate with `python3 build.py`.
