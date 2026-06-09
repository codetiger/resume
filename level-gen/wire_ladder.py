#!/usr/bin/env python3
"""Wire the curated 32-level ladder into the game's src/game/levels.json.

- Layouts come from levels/ladder32.json (the level-gen `initial32` curation).
- The existing résumé content (the 16 hand-written content blocks) is carried onto
  ladder levels 0-15, each with one `i` (content marker) placed on a random green tile.
- Levels 16-31 become pure-puzzle "Bonus" levels with no `i` (no content reveal).

Run from anywhere:  python3 level-gen/wire_ladder.py
Re-runnable: it reads the résumé content from the current levels.json entries 0-15,
which keep their content across runs.
"""
import json
import os
import random
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repo root
LADDER = os.path.join(ROOT, "levels", "ladder32.json")
LEVELS = os.path.join(ROOT, "src", "game", "levels.json")
SOLVER = os.path.join(ROOT, "level-gen", "target", "release", "level-gen")

ladder = json.load(open(LADDER))["levels"]
existing = json.load(open(LEVELS))["levels"]

# Résumé content + display names, taken from the current game levels (the first 16).
resume = [(lvl["name"], lvl["content"]) for lvl in existing[:16]]


def normalize(layout):
    """Drop any pre-placed 'i' so every green is a plain 'n'."""
    return [row.replace("i", "n") for row in layout]


def green_cells(layout):
    return [
        (r, c)
        for r, row in enumerate(layout)
        for c, ch in enumerate(row)
        if ch == "n"
    ]


def put(layout, r, c, ch):
    row = list(layout[r])
    row[c] = ch
    layout[r] = "".join(row)


def is_solvable(layout):
    """Ask the solver whether this layout is solvable (info is required + step-only)."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump({"layout": layout}, f)
        path = f.name
    try:
        res = subprocess.run([SOLVER, "solve", path], capture_output=True, text=True)
        return "solvable=true" in res.stdout
    finally:
        os.unlink(path)


def place_info(layout, rng):
    """Put 'i' on a green that keeps the level solvable (info must be steppable). Returns layout."""
    greens = green_cells(layout)
    rng.shuffle(greens)
    for r, c in greens:
        cand = list(layout)
        put(cand, r, c, "i")
        if is_solvable(cand):
            return cand
    # Fallback: no verified spot (shouldn't happen) — use the first green.
    cand = list(layout)
    r, c = green_cells(layout)[0]
    put(cand, r, c, "i")
    print(f"  warning: no solver-verified info placement; used first green")
    return cand


rng = random.Random(42)  # deterministic 'i' placement
out = []
for idx, lvl in enumerate(ladder):
    layout = normalize(list(lvl["layout"]))
    if idx < len(resume):
        name, content = resume[idx]
        layout = place_info(layout, rng)  # résumé info on a solver-verified random green
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

with open(LEVELS, "w") as f:
    json.dump({"levels": out}, f, indent=2, ensure_ascii=False)
    f.write("\n")

info_levels = sum(1 for l in out if any("i" in row for row in l["layout"]))
print(
    f"Wrote {len(out)} levels to {os.path.relpath(LEVELS, ROOT)} "
    f"({info_levels} with résumé info, {len(out) - info_levels} bonus)"
)
