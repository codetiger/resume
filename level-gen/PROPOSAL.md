# Proposal & design: `level-gen` — algorithmic level generator, solver & curator

A standalone Rust tool that reasons about the rolling-cube puzzle (the Three.js game in `../src`) to:

- **(A) Solve** a board exhaustively and emit the **raw solution data** it would take to beat it;
- **(B) Generate** boards at a requested *difficulty*, *size*, and *allowed tile set*, where difficulty
  is computed from that raw data;
- **(C) Curate** — the real goal — by generating **hundreds** of boards and ordering them into a
  tutorial-first, gradually-harder ladder (`levels/ladder.json`) ready to seed the game's
  `src/game/levels.json`.

This document records the design and the decisions behind it. For how to run it, see `README.md`.

---

## 1. Game model (ground truth from `../src/game/grid.ts`, `core.ts`, `player.ts`)

- The cube moves **one tile per keypress** in 4 directions (`>` right, `<` left, `^` back/up-a-row,
  `v` forward/down-a-row). The rolling animation is **cosmetic** — orientation never affects rules — so
  a puzzle state is just `(position, tile-states)`.
- **Objective:** be on the **base** with **every green cleared**. Base is start = finish. Greens crumble
  when you *step off* them, so each green is visited at most once — a *cover-and-return* puzzle.
- **`i` ≡ `n`:** `info` is mechanically a green tile carrying cosmetic content. The solver models it as a
  plain green; the generator emits only `n`; the in-game `i` marker is assigned during curation.
- **Tiles & chains** (all mirrored exactly in `solver.rs`):
  - **arrow** — forces a one-tile slide in its direction (chains through consecutive arrows; sliding off
    an edge is a fall = loss).
  - **shift** — teleports to the active partner sharing its pair id (not back to where you came from).
  - **disappear-line** (`r`/`c`) — fires **once**, sweeping its row/col: clears greens, chains explosives
    and other lines.
  - **explosive** (`x`) — arms on landing; lights a fuse on step-off; detonates after **1.8 s ≈ 5 moves**
    (`grid.ts:468`), clearing its 4 neighbours (everything except base/info), chaining explosives and
    lines. Detonating on/under the cube is a loss.

The explosive/line timing is the one mechanic that forces a *timed* solver (below).

---

## 2. Solver & raw data (`solver.rs`)

A compact, hashable state `{ pos, present-bitset, line-fired-bitset, active-fuses }` is explored with BFS
over the timed move graph. Actions are the 4 moves plus a **`wait`** pseudo-move (only when a fuse is
burning, which bounds the space). Each move resolves step-off effects, forced slide/teleport chains, then
advances time one tick — burning fuses and resolving any detonation cascade **atomically**.

**Timing is discretised** (fuse = 5 ticks; sphere travel instant; cascades atomic). Data is exact for
time-free boards and *approximate near timing edges* for explosive/line boards — flagged via `exact`.

The solver emits **raw** data, not pre-digested metrics:

- **`solutions`** — winning move strings (e.g. `">>vv<<^^"`), **deduped** so no exact duplicate *and* no
  exact-reverse pair survives (the mirror reverses order and inverts each heading). Enumerated over
  can-win states as simple paths; `solvable`, `shortestPath` and the shortest-solution count derive from
  this list.
- **`solutionCount`** — total distinct canonical solutions (capped; flagged inexact if hit).
- **`reachableStates`**, **`deadEndStates`** — state-space size and the count of reachable states from
  which no win is reachable (reverse-reachability from win states).

Exact solving is exponential in destructible-tile count; the explorer caps at a configurable state budget
(default 400k) and marks results inexact beyond it. All tutorial/early levels solve exactly and instantly.

---

## 3. Difficulty (`difficulty.rs`) — a pure function of the raw data

Difficulty is computed **from the stored raw fields**, so a whole pool can be re-ranked instantly after a
weight change without re-solving. With `L = shortestPath`, `N = solutionCount`, `S = reachableStates`,
`T = deadEndStates`:

```
bigspace = clamp01( (ln(S+1) − ln(S_MIN)) / (ln(S_REF) − ln(S_MIN)) )   # 0 for tiny boards
fewness  = K_RARE / (N + K_RARE)                                        # 1 when few solutions
needle   = bigspace × fewness        # "many places to explore, few of them solve" ← the key idea
depth    = sat(L / L_REF)            # longer minimal solution ⇒ harder to plan
trap     = T / S                     # unforgiving (many dead ends) ⇒ harder
difficulty = clamp01( 0.45·needle + 0.25·depth + 0.30·trap )            # in [0,1]
```

The **needle** term deliberately requires *both* a large reachable space *and* few solutions — a tiny
constrained board with one solution is easy, not hard (this corrects the naive sparsity metric, which
rewards small boards). Bands: `easy <0.20`, `medium <0.45`, `hard <0.70`, `expert` above.

Calibration is empirical and lives entirely in `DifficultyConfig` (weights + reference constants). It was
sanity-checked against the 16 shipped boards (all land easy→low-medium) and `DEMO_LAYOUT`.

---

## 4. Generator (`generate.rs` + `anneal.rs`) — hybrid

**Phase A — constructive solvable backbone.** A backtracking random self-avoiding **loop** through the
base; its cells become greens, so walking the loop *is* a guaranteed solution. (Grid graphs are
bipartite, so loops have an even cell count — enforced at close.)

**Phase B — special tiles are the difficulty lever.** Simulated annealing adds/removes/relocates/retypes
special tiles and greens to drive the solver-measured difficulty toward the target. Each kind moves the
raw data in a characteristic way (arrows → depth/traps, shifts → branching, lines → solution count,
explosives → timed traps). Every candidate is re-solved; **unsolvable candidates are never accepted**.
`allow` restricts which specials may appear (enabling single-mechanic tutorial boards) and `require`
forces a mechanic to be present.

---

## 5. Curation (`curate.rs`) — the real deliverable

From the generated pool the curator builds an ordered ladder:

1. **Movement-only intro** — the easiest board with no specials.
2. **One mechanic at a time** — the easiest single-mechanic board for each, in the game's teaching order
   (line → explosive → shift → arrow), matching `../proposal.md` §3.
3. **Ramp** — the remaining boards in increasing difficulty, near-duplicates dropped; optionally thinned
   to a target length with an evenly difficulty-spaced sample.

Each chosen board gets one green promoted to the in-game `i` (content marker, placed farthest from base).
The output is in the shape `src/game/levels.ts` consumes (`number, name, layout, content`) plus
`difficulty`/`band` metadata (ignored by the game loader).

**Initial-32 profile (`curate --profile initial32`).** Builds the game's first 32-level set as
**6 tutorial + 10 + 10 + 6**: one minimal board per tile type (teaching order Movement → Line-row →
Line-col → Explosive → Shift → Arrow), then three **percentile bands** of the pool (early/mid/hard).
Within each band, boards are chosen by **interest = max(uniqueness, deceptive)** and **spread** across
the band's difficulty range so the curve rises smoothly, with a diversity gate dropping near-duplicates:
- *visual_complexity* — how busy a board looks (size, special density, type variety, hole shape);
- *uniqueness* — structural symmetry (h/v/180°/transpose), weighted down for uniform fields;
- *deceptive* — `difficulty × (1 − visual_complexity)`: hard but simple-looking.

The matching `gen --profile spread` produces a large parallel pool (rayon) with dedicated tutorial,
mid and very-hard sub-pools so every band is populated. Bands are **relative** (percentiles of the
pool), so the structure always fills regardless of the absolute difficulty scale.

---

## 6. Output format (`levels/*.json`) — simple `layout` notation

Tile positions use the same `layout` array-of-strings as `src/game/levels.json`, with a minimal
backward-compatible extension: direction arrows `> < ^ v` and digit teleport pairs `1`–`9` (the shared
chars `. b n i x r c t` are unchanged; `a` is a legacy alias for `>`). The raw solution data and
difficulty sit alongside. See `README.md` for the exact schema.

---

## 7. Status & follow-ups

Implemented and validated end-to-end: solver self-tests pass against `DEMO_LAYOUT` and all 16 shipped
boards; generation is deterministic per seed; a 100-board pool curates into a clean tutorial-first ladder
(easy → expert).

Deferred (game integration): a converter writing the curated ladder into `src/game/levels.json` requires
extending `parseLayout`/`LevelDef` to honour the new arrow-direction chars and digit shift-pairs (today
arrows hardcode `right` and shifts hardcode pair 1; `DEMO_LAYOUT` patches `dir` in code). Résumé content
mapping is a separate authoring step. Both are intentionally out of scope here.
