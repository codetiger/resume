# levels/

Level data for the game, at three stages of a pipeline. Most of what lands here is
**transient and git-ignored** — only the curated ladders are tracked, because they're
the durable, reviewable output.

## Lifecycle

```
campaign / gen ──▶ candidate pool ──▶ curate ──▶ ladder ──▶ wire ──▶ game
  (search)          gen-*.json /        (pick)    ladder*.json  (place    src/game/
                    campaigns/<name>/             (tracked)     info +    levels.json
                    pool.json (ignored)                         résumé)   (tracked)
```

1. **Search** — `level-gen campaign --name <run>` (or `gen --batch --profile spread`)
   generates and screens millions of boards. Output:
   - `campaigns/<name>/pool.json` + `manifest.json` — a resumable top-K pool. **Ignored.**
   - `gen-*.json` — a flat candidate pool from `gen --batch`. **Ignored.**
   - `report.md` — a browsable per-bucket ranking (`level-gen rank`). **Ignored.**
2. **Curate** — `level-gen curate --from-campaign <run> --profile initial128` picks a
   teaching-ordered ladder and writes `ladder128.json` (and `ladder32.json` for the
   shorter profile). **Tracked** — these are the reproducible, reviewed end product.
3. **Wire** — `python3 level-gen/wire_ladder.py` merges `ladder128.json` with the
   résumé content from `assets/resume.json` and writes `src/game/levels.json`
   (placing one info tile on the first 16 levels). **Tracked.**

## What's tracked vs. ignored

| Path                        | Tracked? | Why                                             |
| --------------------------- | -------- | ----------------------------------------------- |
| `ladder32.json`             | ✅       | Curated short ladder (reproducible end product) |
| `ladder128.json`            | ✅       | Curated full ladder (wired into the game)       |
| `gen-*.json`                | ❌       | Transient candidate pool; reproducible by seed  |
| `campaigns/<name>/`         | ❌       | Transient campaign state; resumable by seed     |
| `report.md`                 | ❌       | Generated ranking report                        |

The ignored artifacts are large and fully reproducible from the seed range, so they
stay out of git. Regenerating a ladder is a deliberate, reviewed step — see
[`../level-gen/README.md`](../level-gen/README.md).
