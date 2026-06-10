# level-gen

Offline Rust tool that **solves**, **generates at scale**, and **curates** levels for the
rolling-cube résumé game (`../src`). It reasons about the same tile mechanics (mirrored from
`../src/game/grid.ts`) to:

- exhaustively **solve** a board — raw winning move sequences, state-space counts, and a quality model,
- run a **campaign** that streams and screens millions of boards, keeping only the best,
- **curate** the kept boards into a tutorial-first, steeply-ramping ladder, and
- emit a browsable **rank** report so picks can be eyeballed.

Generated data lands in `../levels/`. Solver and game are kept in lockstep — changing tile mechanics
in one without the other corrupts the curated levels.

## Build

```sh
cargo build --release          # binary at target/release/level-gen
cargo test                     # unit tests
./target/release/level-gen selftest   # solve DEMO + every shipped level, print the quality model
```

## Quick start — generate, pick, wire

The whole pipeline, from an empty pool to playable levels:

```sh
cd level-gen
cargo build --release

# 1. Run a campaign (streams + screens millions of boards, keeps the best per bucket).
#    Resumable and Ctrl-C-safe; run it as long as you like.
./target/release/level-gen campaign --name run1 --duration 60m

#    Watch progress from another shell (or after a stop):
./target/release/level-gen campaign-status --name run1

#    Continue a stopped/parked campaign where it left off:
./target/release/level-gen campaign --name run1 --duration 60m --resume

# 2. Eyeball the haul — a per-bucket leaderboard with ASCII board art + metrics.
./target/release/level-gen rank --name run1 --out ../levels/report.md

# 3. Curate the 32-level ladder (6 easy tutorials, then a steep ramp into hard/expert).
./target/release/level-gen curate --from-campaign run1 --profile initial32 --out ../levels/ladder32.json

# 4. Wire it into the game (run from the repo root): merges résumé content onto the
#    first 16 and places a reachable, landable info tile on each.
cd .. && python3 level-gen/wire_ladder.py

# 5. Build the game.
npm run build
```

The campaign writes a bounded **top-K pool** to `../levels/campaigns/<name>/pool.json` plus a
`manifest.json` cursor (so it resumes exactly). Both are gitignored — the pool is reproducible from
the seed range.

## What makes a "good" level

The generator selects for levels that **need a plan** — not levels that are merely large. Each board
is solved exhaustively and scored from player-behaviour metrics (`src/metrics.rs`, weighted in
`src/difficulty.rs`):

- **resistance** `1 − P(random player wins)` — a thoughtless player almost never stumbles in (headline),
- **planning** — commitment (wrong moves doom you) + delay (you stay alive a while after the mistake),
- **uniqueness** — the solution is a sharp needle in a large can-win space,
- **branching** — genuine decision points where most plausible moves are traps (not a corridor),
- **spectacle** — the solution actually triggers lines / blasts / teleports ("interesting to watch").

A board is also **rejected outright** unless it passes these structural rules:

1. **No dead tiles** — every tile is reachable (cube can occupy it, incl. arrow/shift slide-throughs)
   or gets cleared; no useless hanging tiles.
2. **Shifts paired** — every teleport id has exactly two cells (lone shifts are normalised to greens).
3. **Mostly green** — specials are ≤ 30% of standing tiles; the board is a field of greens to clear
   with only a sprinkle of specials.
4. **No useless specials** — a line tile has a green/info in its swept row/column; an explosive has a
   green/info among its four neighbours (otherwise it fires uselessly).
5. **Landable content** — the cube can rest on a green on a winning line, so a résumé info tile can
   always be placed somewhere it can be reached and landed on.

Plus a hard **anti-trial-and-error gate**: combined boards a naive greedy player solves, or that a
random player beats more than ~15% of the time, are discarded. `selftest` fails if any shipped level
is unsolvable or has dead tiles, unpaired shifts, or useless specials.

### Generation throughput (two tiers)

For volume, combined boards use a two-tier pipeline: a random board (backbone ring + a green-biased
burst of mutations) is killed cheaply at a **screen** (`src/screen.rs`: simulated greedy/random
players + a capped BFS) before paying for a full deep solve + quality score on the survivors. The six
single-mechanic **tutorial** boards are annealed (`src/generate.rs`) so each reliably teaches one tile.
Throughput is millions of boards/hour on a few cores.

## Command reference

```sh
# Streaming campaign (primary). --resume continues an existing run.
level-gen campaign --name run1 --root ../levels/campaigns --duration 60m \
    --threads 0 --topk 64 --iters 140 --seed-base 1 --max-size 8 --max-random 0.15 [--resume]

# One-shot status of a running/stopped campaign (manifest + best buckets).
level-gen campaign-status --name run1 --root ../levels/campaigns

# Browsable markdown leaderboard from a campaign pool (board art + metrics).
level-gen rank --name run1 --root ../levels/campaigns --out ../levels/report.md --per-bucket 8

# Curate a ladder. --from-campaign reads <root>/<name>/pool.json; otherwise reads a dir of gen-*.json.
level-gen curate --from-campaign run1 --root ../levels/campaigns --profile initial32 --out ../levels/ladder32.json
level-gen curate ../levels --count 16 --out ../levels/ladder.json          # legacy: even-spaced ramp from a dir

# Solve / re-score one board file (prints raw data + full quality breakdown).
level-gen solve ../levels/<file>.json

# Verify solver + all shipped levels; fails on any structural-rule violation.
level-gen selftest

# Legacy one-off / batch generation (no screen; anneal toward a difficulty target).
level-gen gen --cols 5 --rows 5 --difficulty 0.4 --allow n,arrow,shift --seed 3 --out ../levels
level-gen gen --batch 1500 --profile spread --seed 9000 --out ../levels
```

- `campaign` flags: `--duration` accepts `60m`, `1h`, `3600s`, or bare seconds; `--threads 0` = auto
  (cores − 1); `--topk` is kept-per-bucket (size × mechanic × band); `--max-size` caps the board edge
  (≤ 8 stays playable); `--max-random` is the random-player win-rate gate.
- `curate --profile initial32` builds **6 tutorial rungs** (one per tile type, easy-band preferred so
  they're learnable) then a **steep ramp** — a few medium boards, then hard, then a deep expert bench —
  quality-ranked within each band, diversity-filtered, and cleaned of any rule-violating boards.
- `--allow` accepts a comma list of `n` (always on), `arrow`, `shift`, `line`, `explosive`.
- Generation is **deterministic per seed**, so a campaign re-run with the same `--seed-base` reproduces
  the same boards.

## Layout notation

One char per cell (same as `src/game/levels.json`, with a small extension):

| char | tile                                      | char            | tile                                                          |
| ---- | ----------------------------------------- | --------------- | ------------------------------------------------------------- |
| `.`  | hole                                      | `>` `<` `^` `v` | arrow → right / left / back (up a row) / forward (down a row) |
| `b`  | base (start = finish)                     | `t`             | teleport, default pair                                        |
| `n`  | green (clear to win)                      | `1`–`9`         | teleport endpoint, pair = the digit (two per id)              |
| `x`  | explosive (landmine)                      | `r` `c`         | disappear-line, row / col sweep                               |
| `i`  | green + content marker (placed at wiring) | `a`             | legacy alias for `>`                                          |

`i` behaves exactly like a green for destruction (cleared by step-off, blast, or line) and counts
toward the win the same way; it additionally reveals its résumé content when the cube lands on it.

## Output schema

Campaign pool entries / `gen-*.json` records (`src/io.rs`):

```json
{
  "name": "gen-6x6-expert-s5093",
  "seed": 5093,
  "layout": ["nnrn..", "nnn.c.", "..nnn.", "nnnxnb", "ncnnnn", "nn..nn"],
  "request": {
    "targetDifficulty": 0.77,
    "allow": ["n", "arrow", "shift", "line", "explosive"],
    "cols": 6,
    "rows": 6
  },
  "solutions": ["vv<>>v<<^^<<^<<><vv>^^v>"],
  "solutionCount": 1,
  "reachableStates": 39815,
  "deadEndStates": 39790,
  "difficulty": 0.767,
  "band": "expert",
  "exact": true,
  "randomSolveProb": 0.0001,
  "greedySolves": false,
  "commitment": 0.57,
  "maxDoomDelay": 12,
  "optimalPathFraction": 0.04,
  "decision": 0.41,
  "forcedFraction": 0.18,
  "spectacle": 0.62,
  "spectacleRequired": true
}
```

`difficulty` is the composite quality in `[0,1]`; `band` (easy/medium/hard/expert) is derived from
behavioural gates, not score thresholds. The quality scalars are persisted so a pool can be re-ranked
without re-solving. `exact` is `false` when state exploration / solution counting was capped (such
boards are dropped by the campaign). The curated `ladder32.json` is in the shape `src/game/levels.ts`
consumes (`number, name, layout, content`) with extra `difficulty`/`band` metadata.

## Project layout

| file                | role                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------- |
| `src/model.rs`      | board primitives + validity checks (paired shifts, useless specials, …)                 |
| `src/io.rs`         | layout encode/decode + JSON records (quality scalars)                                   |
| `src/solver.rs`     | exhaustive timed solver → raw data, reachability, dead-tiles, lands-on-info             |
| `src/metrics.rs`    | player-behaviour quality metrics over the state graph                                   |
| `src/difficulty.rs` | metrics → composite quality score + gate-based band (pure function)                     |
| `src/screen.rs`     | cheap Tier-1 screen: simulated greedy/random players + capped BFS                       |
| `src/generate.rs`   | constructive backbone + green-biased mutation operators + anneal                        |
| `src/anneal.rs`     | simulated-annealing primitives                                                          |
| `src/topk.rs`       | bounded per-bucket top-K reservoir + persistence                                        |
| `src/campaign.rs`   | streaming, resumable generation campaign (orchestrator)                                 |
| `src/curate.rs`     | pool → tutorial-first, steeply-ramping, cleaned ladder                                  |
| `src/main.rs`       | CLI (`solve` / `selftest` / `gen` / `curate` / `campaign` / `campaign-status` / `rank`) |
| `wire_ladder.py`    | merge `ladder32.json` + résumé content → `../src/game/levels.json`                      |

```

```
