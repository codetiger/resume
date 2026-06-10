#!/usr/bin/env python3
"""Wire the curated 128-level ladder into the game's src/game/levels.json.

- Layouts come from levels/ladder128.json (the level-gen `initial128` curation).
- The existing résumé content (the 16 hand-written content blocks) is carried onto
  ladder levels 0-15, each with one `i` (content marker) placed on a random green tile.
- Levels 16-127 become pure-puzzle "Bonus" levels with no `i` (no content reveal).

Run from anywhere:  python3 level-gen/wire_ladder.py
Re-runnable: it reads the résumé content from the current levels.json entries 0-15,
which keep their content across runs.
"""

from __future__ import annotations

import json
import random
import re
import subprocess
import tempfile
from pathlib import Path

# Levels 0-5 are the learnable tutorial rungs: keep them as easy as the layout allows by choosing
# the info placement with the lowest resulting difficulty. Later content levels just need solvable.
TUTORIAL_COUNT = 6

# Cap a single-board solve so a pathological layout can't hang the whole wiring run.
SOLVE_TIMEOUT_SECS = 60

ROOT = Path(__file__).resolve().parent.parent  # repo root
LADDER = ROOT / "levels" / "ladder128.json"
LEVELS = ROOT / "src" / "game" / "levels.json"
SOLVER = ROOT / "level-gen" / "target" / "release" / "level-gen"

Layout = list[str]


def load_levels(path: Path) -> list[dict]:
    """Read a `{ "levels": [...] }` JSON file and return its levels array."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)["levels"]


def normalize(layout: Layout) -> Layout:
    """Drop any pre-placed 'i' so every green is a plain 'n'."""
    return [row.replace("i", "n") for row in layout]


def green_cells(layout: Layout) -> list[tuple[int, int]]:
    return [(r, c) for r, row in enumerate(layout) for c, ch in enumerate(row) if ch == "n"]


def put(layout: Layout, r: int, c: int, ch: str) -> None:
    row = list(layout[r])
    row[c] = ch
    layout[r] = "".join(row)


def solve_info(layout: Layout) -> tuple[bool, bool, float | None]:
    """Run the solver on a layout; return (solvable, lands_on_info, difficulty).

    On a solver timeout the board is treated as unsolvable so the scan moves on
    rather than hanging.
    """
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump({"layout": layout}, f)
        path = f.name
    try:
        res = subprocess.run(
            [str(SOLVER), "solve", path],
            capture_output=True,
            text=True,
            timeout=SOLVE_TIMEOUT_SECS,
        )
    except subprocess.TimeoutExpired:
        print(f"  warning: solver timed out after {SOLVE_TIMEOUT_SECS}s; treating as unsolvable")
        return False, False, None
    finally:
        Path(path).unlink()
    solvable = "solvable=true" in res.stdout
    lands = "landsOnInfo=true" in res.stdout
    m = re.search(r"difficulty=([0-9.]+)", res.stdout)
    return solvable, lands, (float(m.group(1)) if m else None)


def place_info(layout: Layout, rng: random.Random, minimize: bool = False) -> Layout:
    """Put 'i' on a green where the level stays solvable AND the cube can actually land on the
    info tile on a winning line (so its content is reachable). When `minimize`, pick the lowest-
    difficulty such spot (keeps tutorial rungs learnable); otherwise the first one found. Falls
    back to any solvable spot, then the first green, if nothing better exists."""
    greens = green_cells(layout)
    rng.shuffle(greens)  # randomised tie-break / scan order
    best_landable: tuple[float, Layout] | None = None  # (difficulty, layout): solvable AND landable
    first_solvable: Layout | None = None  # solvable but maybe not landable
    for r, c in greens:
        cand = list(layout)
        put(cand, r, c, "i")
        solvable, lands, diff = solve_info(cand)
        if not solvable:
            continue
        if first_solvable is None:
            first_solvable = cand
        if lands:
            d = diff if diff is not None else 1.0
            if best_landable is None or d < best_landable[0]:
                best_landable = (d, cand)
            if not minimize:
                return cand  # first landable spot is good enough
    if best_landable is not None:
        return best_landable[1]
    if first_solvable is not None:
        print("  warning: no landable info spot; used a solvable (content may be blast-only)")
        return first_solvable
    # Fallback: nothing verified (shouldn't happen) — use the first green.
    cand = list(layout)
    r, c = green_cells(layout)[0]
    put(cand, r, c, "i")
    print("  warning: no solver-verified info placement; used first green")
    return cand


def main() -> None:
    ladder = load_levels(LADDER)
    existing = load_levels(LEVELS)
    # Résumé content + display names, taken from the current game levels (the first 16).
    resume = [(lvl["name"], lvl["content"]) for lvl in existing[:16]]

    rng = random.Random(42)  # deterministic 'i' placement
    out = []
    for idx, lvl in enumerate(ladder):
        layout = normalize(list(lvl["layout"]))
        if idx < len(resume):
            name, content = resume[idx]
            # Tutorial rungs (first 6): minimise added difficulty so they stay learnable.
            layout = place_info(layout, rng, minimize=idx < TUTORIAL_COUNT)
            out.append({"number": idx, "name": name, "layout": layout, "content": content})
        else:
            bonus_n = idx - len(resume) + 1
            out.append(
                {
                    "number": idx,
                    "name": f"Bonus {bonus_n}",
                    "layout": layout,  # no 'i' -> pure puzzle, no content reveal
                    "content": {"heading": f"Bonus {bonus_n}", "tag": "meta", "bullets": []},
                }
            )

    with open(LEVELS, "w", encoding="utf-8") as f:
        json.dump({"levels": out}, f, indent=2, ensure_ascii=False)
        f.write("\n")

    info_levels = sum(1 for lvl in out if any("i" in row for row in lvl["layout"]))
    print(
        f"Wrote {len(out)} levels to {LEVELS.relative_to(ROOT)} "
        f"({info_levels} with résumé info, {len(out) - info_levels} bonus)"
    )


if __name__ == "__main__":
    main()
