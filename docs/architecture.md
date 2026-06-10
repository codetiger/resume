# Architecture & data contracts

Three independent stacks share one source of truth (`assets/resume.json`). This note
documents how they fit together and the data contracts between them — the places where
a change on one side silently breaks the other.

## Stacks

| Stack           | Language      | Entry                               | Output                |
| --------------- | ------------- | ----------------------------------- | --------------------- |
| Game (primary)  | TypeScript    | `index.html` + `src/main.ts` (Vite) | `dist/` (game bundle) |
| Static fallback | Python/Jinja2 | `build.py` + `template.html`        | `assets/resume.html`  |
| Level generator | Rust          | `level-gen/` (`cargo`)              | `levels/ladder*.json` |

`assets/` is Vite's `publicDir`: it is served in dev and copied into `dist/` on build,
so deployment is just `dist/` (game `index.html` + `resume.html` side by side).

## Single source of truth: `assets/resume.json`

All résumé prose lives here once. Both stacks read it:

- **Static fallback:** `build.py` renders it through `template.html`.
- **Game:** `src/game/levels.json` references fields with JSONPath (`"$.basics.name"`)
  strings. The `resume-refs` Vite plugin (`vite.config.ts`) resolves those at build time
  and exposes the result as the virtual module `virtual:levels`. The raw `resume.json`
  (and `jsonpath-plus`) never ship in the client bundle.

## Data contracts

These are the cross-stack couplings to keep in sync.

### 1. Solver CLI ↔ `wire_ladder.py` (text protocol)

`level-gen/wire_ladder.py` shells out to the release solver binary
(`level-gen solve <layout.json>`) and parses its **stdout** for substrings:
`solvable=true`, `landsOnInfo=true`, and `difficulty=<float>` (see `solve_info()`).
Changing the solver's `print_report` format in `main.rs` will break the placement
logic. The call has a 60s timeout; a timeout is treated as unsolvable.

### 2. Curated ladder ↔ game catalogue

`wire_ladder.py` reads `levels/ladder128.json` and the existing résumé content from the
first 16 entries of `src/game/levels.json`, then rewrites `levels.json`. `levels.json` is
generated — edit content via `assets/resume.json` / the ladder, then re-wire. On load,
`src/game/levels.ts` validates each level (rectangular grid, exactly one base, known
glyphs via `parseLayout`, tag ∈ {`resume`, `meta`}) and throws on anything malformed.

### 3. Prebaked résumé blob ↔ static page decoder

`build.py:prebake_data()` packs the résumé into a tab/newline-delimited text blob, then
`base64(zlib(...))`. The inlined `<script>` in `template.html` decodes the mirror image
of this format at runtime. The field order, separators, and section breaks are a shared
contract — change one side and the other must match.

### 4. Avatar hex-mosaic ↔ client decoder

`triangulate.py` encodes the avatar as a bit-packed binary header + palette + indices,
`base64(deflate(...))` (format documented in `export_hex_mosaic`'s docstring). The
client decoder in `template.html` reads that exact byte layout. Pillow/numpy are pinned
in `requirements.txt` because the MEDIANCUT quantization is only deterministic within a
version — an unpinned bump changes the bytes, hence `resume.html`.

### 5. Obfuscated phone (play-to-unlock)

`resume.json` stores the phone encoded. The `resume-refs` plugin ships only that encoded
value (`virtual:contact`), never the rest of the contact block. `src/game/contact.ts`
`decodePhone()` turns it into a display string at runtime, after the player finishes the
game — so the raw number is never plain text in the repo or the bundle.

## Build & deploy

`.github/workflows/deploy.yml` (push to `master`): `build.py` → `vite build` → upload
`dist/` to GitHub Pages. `.github/workflows/ci.yml` (PRs + master) runs the quality gate
for all three stacks. The level generator is **not** part of the deploy build; its
output (`ladder*.json` → `levels.json`) is committed ahead of time.
