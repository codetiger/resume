# Contributing

This repo has three stacks (TypeScript game, Python static-fallback builder, Rust level
generator). Each has its own toolchain; the pre-commit hook ties them together. See
[`docs/architecture.md`](docs/architecture.md) for how they fit together.

## One-time setup

```bash
# Node (game)
npm install

# Python (static fallback) — dev tools pull in the runtime deps too
pip3 install -r requirements-dev.txt

# Rust (level generator)
cd level-gen && cargo build --release && cd ..

# Git hooks across all three stacks
pre-commit install
```

## Day-to-day commands

### TypeScript game

```bash
npm run dev          # Vite dev server (http://localhost:5173)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint  (lint:fix to autofix)
npm run format       # prettier --write  (format:check to verify)
npm test             # vitest run  (test:watch to watch)
npm run build        # tsc + vite build → dist/
```

### Python builder

```bash
python3 build.py            # regenerate assets/resume.html
ruff check .                # lint  (ruff check --fix to autofix)
ruff format .               # format  (--check to verify)
mypy                        # type-check build.py / triangulate.py / wire_ladder.py
pytest                      # unit tests
```

### Rust level generator (run inside `level-gen/`)

```bash
cargo fmt                                       # format  (--check to verify)
cargo clippy --lib --bins --tests -- -D warnings
cargo test
cargo build --release
./target/release/level-gen selftest             # solves DEMO + every shipped level
```

## Conventions & guardrails

- **Don't hand-edit generated files:** `assets/resume.html` (run `build.py`),
  `src/game/levels.json` (run `wire_ladder.py`), anything in `dist/`.
- **Single source of truth:** résumé prose lives in `assets/resume.json`; the game
  references it by JSONPath (see `docs/architecture.md`).
- **Pinned Python deps:** `requirements.txt` is pinned exactly because the avatar mosaic
  must regenerate byte-for-byte. Bump deliberately and re-verify `resume.html`.
- **CI** (`.github/workflows/ci.yml`) runs all of the above on every PR and on `master`;
  `pre-commit run --all-files` reproduces it locally.
- Commit messages: imperative subject; no `Co-Authored-By` trailer.
