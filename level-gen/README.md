# level-gen

Offline Rust tool that **solves**, **generates**, and **curates** levels for the rolling-cube résumé
game (`../src`). It reasons about the same tile mechanics (mirrored from `../src/game/grid.ts`) to:

- exhaustively solve a board and emit the **raw winning move sequences** + state-space counts,
- generate boards at a target **difficulty / size / tile set**, and
- curate hundreds of boards into a **tutorial-first, gradually-harder ladder**.

See `PROPOSAL.md` for the design. Generated boards land in `../levels/`.

## Build

```sh
cargo build --release          # binary at target/release/level-gen
cargo test                     # unit tests + solver self-tests
```

## Usage

```sh
# Verify the solver against DEMO_LAYOUT + every shipped src/game/levels.json board
./target/release/level-gen selftest

# Generate one board (target difficulty 0.4, greens + arrows + teleports)
./target/release/level-gen gen --cols 5 --rows 5 --difficulty 0.4 \
    --allow n,arrow,shift --seed 3 --out ../levels

# Generate a pool of 100 boards spread across sizes / tile-sets / difficulty
./target/release/level-gen gen --batch 100 --seed 5000 --out ../levels

# Generate a large pool tuned for the initial-32 set (parallel; tutorial + mid + hard sub-pools)
./target/release/level-gen gen --batch 1500 --profile spread --seed 9000 --out ../levels

# Solve / re-score an existing board file (idempotence check)
./target/release/level-gen solve ../levels/<file>.json

# Curate the pool into a 16-level game ladder (even-spaced ramp)
./target/release/level-gen curate ../levels --count 16 --out ../levels/ladder.json

# Curate the initial 32-level set: 6 tutorial (one per tile type) + 10 + 10 + 6,
# selected by interest (unique pattern OR deceptively hard) across percentile bands
./target/release/level-gen curate ../levels --profile initial32 --out ../levels/ladder32.json
```

Generation runs in parallel (rayon). The `spread` profile builds three sub-pools — minimal
single-tile-type tutorial boards (incl. pure row/col lines), a mid range, and a targeted very-hard
tail — so every difficulty band is well populated. The `initial32` curation profile sorts the pool by
difficulty, takes one minimal board per tile type for the tutorial, then fills three percentile bands
(early/mid/hard) with boards selected for **interest** = `max(visual-uniqueness, deceptive-hardness)`,
spread to rise smoothly and kept diverse (no near-duplicates).

`--allow` accepts a comma list of `n` (always on), `arrow`, `shift`, `line`, `explosive`. Generation is
deterministic per `--seed`.

## Layout notation

One char per cell (same as `src/game/levels.json`, with a small extension):

| char | tile | char | tile |
|------|------|------|------|
| `.` | hole | `>` `<` `^` `v` | arrow → right / left / back (up a row) / forward (down a row) |
| `b` | base (start = finish) | `t` | teleport, default pair |
| `n` | green (≡ in-game `n`/`i`) | `1`–`9` | teleport endpoint, pair = the digit (two per id) |
| `x` | explosive | `r` `c` | disappear-line, row / col sweep |
| `i` | green + content marker (curation only) | `a` | legacy alias for `>` |

## Output schema (`levels/*.json`)

```json
{
  "name": "gen-6x6-expert-s5093",
  "seed": 5093,
  "layout": ["3nrn..", "nnn.c.", "^c.n4.", "n4nxnb", "ncnnnn", "nn..3n"],
  "request": { "targetDifficulty": 0.77, "allow": ["n","arrow","shift","line","explosive"], "cols": 6, "rows": 6 },
  "solutions": ["vv<>>v<<^^<<^<<><vv>^^v>"],
  "solutionCount": 1,
  "reachableStates": 39815,
  "deadEndStates": 39790,
  "difficulty": 0.767,
  "band": "expert",
  "exact": true
}
```

`solvable`, `shortestPath`, and the shortest-solution count derive from `solutions` (deduped: no exact
duplicates and no exact-reverse pairs). `exact` is `false` when state exploration or solution counting was
capped. The curated `ladder.json` is in the shape `src/game/levels.ts` consumes (`number, name, layout,
content`) with extra `difficulty`/`band` metadata.

## Project layout

| file | role |
|------|------|
| `src/model.rs` | board primitives (Direction, TileKind, Level) |
| `src/io.rs` | layout encode/decode + JSON records |
| `src/solver.rs` | timed exhaustive solver → raw solution data |
| `src/difficulty.rs` | raw data → difficulty score (pure function) |
| `src/generate.rs` | constructive backbone + mutation operators |
| `src/anneal.rs` | simulated-annealing primitives |
| `src/curate.rs` | pool → tutorial-first ladder |
| `src/main.rs` | CLI (`solve` / `selftest` / `gen` / `curate`) |
