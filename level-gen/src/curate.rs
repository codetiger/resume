//! Curator — turn a pool of generated boards into a tutorial-first, gradually-harder ladder.
//!
//! The teaching order follows the game's design doc (`../proposal.md` §3): movement first, then one
//! new mechanic at a time, then combined boards that ramp in difficulty. Each chosen board gets one
//! green promoted to the in-game `i` (content marker). See `PROPOSAL.md` §7.

use crate::io::{parse_layout, LevelRecord};
use serde::Serialize;
use std::collections::HashSet;

/// A board is "clean" if it has no useless specials (a line with no green in its line, a mine with
/// no green neighbour) and no unpaired teleport. Used to keep such boards out of the ladder even if
/// they slipped into an older pool generated before these gates existed.
fn is_clean(rec: &LevelRecord) -> bool {
    match parse_layout(&rec.layout) {
        Ok(level) => level.useless_special_count() == 0 && level.unpaired_shift_count() == 0,
        Err(_) => false,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Mechanic {
    Arrow,
    Shift,
    Line,
    Explosive,
}

/// Teaching order: introduce these one at a time after the movement-only intro.
pub const TEACHING_ORDER: [Mechanic; 4] = [
    Mechanic::Line,
    Mechanic::Explosive,
    Mechanic::Shift,
    Mechanic::Arrow,
];

/// Which special mechanics appear in a layout.
pub fn mechanics_of(layout: &[String]) -> HashSet<Mechanic> {
    let mut set = HashSet::new();
    for row in layout {
        for ch in row.chars() {
            match ch {
                '>' | '<' | '^' | 'v' | 'a' => {
                    set.insert(Mechanic::Arrow);
                }
                't' | '1'..='9' => {
                    set.insert(Mechanic::Shift);
                }
                'r' | 'c' => {
                    set.insert(Mechanic::Line);
                }
                'x' => {
                    set.insert(Mechanic::Explosive);
                }
                _ => {}
            }
        }
    }
    set
}

/// One level in the curated ladder, in the shape `src/game/levels.ts` consumes, with extra
/// `difficulty`/`band` metadata (ignored by the game loader) for inspection.
#[derive(Clone, Debug, Serialize)]
pub struct CuratedLevel {
    pub number: usize,
    pub name: String,
    pub layout: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub difficulty: Option<f64>,
    pub band: String,
    pub content: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct Ladder {
    pub levels: Vec<CuratedLevel>,
}

/// Promote one green (`n`) to the content marker (`i`) — the cell farthest from the base, so the
/// reveal sits "deep" in the level. Falls back to the first green.
fn assign_info(layout: &[String]) -> Vec<String> {
    let rows = layout.len();
    let cols = layout.first().map(|r| r.chars().count()).unwrap_or(0);
    let mut base = (0usize, 0usize);
    for (r, row) in layout.iter().enumerate() {
        for (c, ch) in row.chars().enumerate() {
            if ch == 'b' {
                base = (c, r);
            }
        }
    }
    let mut best: Option<(usize, usize, i64)> = None;
    for (r, row) in layout.iter().enumerate() {
        for (c, ch) in row.chars().enumerate() {
            if ch == 'n' {
                let d = (c as i64 - base.0 as i64).abs() + (r as i64 - base.1 as i64).abs();
                if best.map_or(true, |(_, _, bd)| d > bd) {
                    best = Some((c, r, d));
                }
            }
        }
    }
    let mut out: Vec<Vec<char>> = layout.iter().map(|r| r.chars().collect()).collect();
    if let Some((c, r, _)) = best {
        out[r][c] = 'i';
    }
    let _ = (rows, cols);
    out.into_iter().map(|r| r.into_iter().collect()).collect()
}

/// A simple structural fingerprint to drop near-duplicate boards (same shape + difficulty band).
fn fingerprint(rec: &LevelRecord) -> String {
    format!("{}|{}", rec.layout.join("/"), rec.band)
}

fn content_stub(name: &str) -> serde_json::Value {
    serde_json::json!({
        "heading": name,
        "tag": "bonus",
        "bullets": [],
    })
}

/// Evenly sample `k` items from `items` (always keeping the first and last).
fn evenly_spaced<T: Clone>(items: &[T], k: usize) -> Vec<T> {
    if items.len() <= k || k == 0 {
        return items.to_vec();
    }
    if k == 1 {
        return vec![items[0].clone()];
    }
    (0..k)
        .map(|i| {
            let idx = (i * (items.len() - 1)) / (k - 1);
            items[idx].clone()
        })
        .collect()
}

/// Build the ladder. `pool` is the generated corpus (each must be solvable with a difficulty).
/// `max_levels`, if set, keeps the tutorial block plus an evenly difficulty-spaced ramp.
pub fn curate(pool: &[LevelRecord], max_levels: Option<usize>) -> Ladder {
    let mut used: HashSet<usize> = HashSet::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut tutorial: Vec<&LevelRecord> = Vec::new();
    let mut ramp: Vec<&LevelRecord> = Vec::new();

    // Only consider solvable, scored boards, sorted easiest-first.
    let mut order: Vec<usize> = (0..pool.len())
        .filter(|&i| pool[i].difficulty.is_some() && is_clean(&pool[i]))
        .collect();
    order.sort_by(|&a, &b| {
        pool[a]
            .difficulty
            .partial_cmp(&pool[b].difficulty)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // 1) Movement-only intro: the easiest board with no specials.
    if let Some(&i) = order.iter().find(|&&i| mechanics_of(&pool[i].layout).is_empty()) {
        used.insert(i);
        seen.insert(fingerprint(&pool[i]));
        tutorial.push(&pool[i]);
    }

    // 2) One new mechanic at a time: easiest single-mechanic board for each.
    for m in TEACHING_ORDER {
        let want: HashSet<Mechanic> = [m].into_iter().collect();
        if let Some(&i) = order.iter().find(|&&i| {
            !used.contains(&i) && mechanics_of(&pool[i].layout) == want
        }) {
            used.insert(i);
            seen.insert(fingerprint(&pool[i]));
            tutorial.push(&pool[i]);
        }
    }

    // 3) Ramp: monotonically increasing difficulty over the remaining pool, dedup near-duplicates.
    for &i in &order {
        if used.contains(&i) {
            continue;
        }
        let fp = fingerprint(&pool[i]);
        if seen.contains(&fp) {
            continue;
        }
        used.insert(i);
        seen.insert(fp);
        ramp.push(&pool[i]);
    }

    // Optionally thin the ramp to fit a target ladder length (tutorial is always kept whole).
    if let Some(max) = max_levels {
        let room = max.saturating_sub(tutorial.len()).max(1);
        ramp = evenly_spaced(&ramp, room);
    }

    let levels = tutorial
        .into_iter()
        .chain(ramp)
        .enumerate()
        .map(|(number, rec)| CuratedLevel {
            number,
            name: rec.name.clone(),
            layout: assign_info(&rec.layout),
            difficulty: rec.difficulty,
            band: rec.band.clone(),
            content: content_stub(&rec.name),
        })
        .collect();

    Ladder { levels }
}

// ─── interest-based selection for the initial 32-level set ──────────────────────

/// The six tile types a tutorial introduces, in teaching order.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TutorialType {
    Movement,
    LineRow,
    LineCol,
    Explosive,
    Shift,
    Arrow,
}

pub const TUTORIAL_ORDER: [TutorialType; 6] = [
    TutorialType::Movement,
    TutorialType::LineRow,
    TutorialType::LineCol,
    TutorialType::Explosive,
    TutorialType::Shift,
    TutorialType::Arrow,
];

/// Classify a board as a *pure* single-tile-type tutorial board, or `None` if it mixes mechanics.
pub fn tutorial_type_of(layout: &[String]) -> Option<TutorialType> {
    let mut arrow = false;
    let mut shift = false;
    let mut row = false;
    let mut col = false;
    let mut explosive = false;
    for row_s in layout {
        for ch in row_s.chars() {
            match ch {
                '>' | '<' | '^' | 'v' | 'a' => arrow = true,
                't' | '1'..='9' => shift = true,
                'r' => row = true,
                'c' => col = true,
                'x' => explosive = true,
                _ => {}
            }
        }
    }
    let kinds = [arrow, shift, row, col, explosive];
    match kinds.iter().filter(|b| **b).count() {
        0 => Some(TutorialType::Movement),
        1 => {
            if arrow {
                Some(TutorialType::Arrow)
            } else if shift {
                Some(TutorialType::Shift)
            } else if row {
                Some(TutorialType::LineRow)
            } else if col {
                Some(TutorialType::LineCol)
            } else {
                Some(TutorialType::Explosive)
            }
        }
        _ => None,
    }
}

/// Coarse tile category (direction/pair-agnostic), used for symmetry + similarity.
fn category(ch: char) -> u8 {
    match ch {
        '.' => 0,
        'b' => 1,
        'n' | 'i' => 2,
        '>' | '<' | '^' | 'v' | 'a' => 3,
        't' | '1'..='9' => 4,
        'r' | 'c' => 5,
        'x' => 6,
        _ => 2,
    }
}

fn grid_categories(layout: &[String]) -> Vec<Vec<u8>> {
    layout
        .iter()
        .map(|r| r.chars().map(category).collect())
        .collect()
}

/// Best symmetry match fraction over h-flip / v-flip / 180° (and transpose, if square), in [0,1].
pub fn symmetry(layout: &[String]) -> f64 {
    let g = grid_categories(layout);
    let rows = g.len();
    if rows == 0 {
        return 0.0;
    }
    let cols = g[0].len();
    if cols == 0 {
        return 0.0;
    }
    let total = (rows * cols) as f64;
    let frac = |f: &dyn Fn(usize, usize) -> (usize, usize)| -> f64 {
        let mut m = 0u32;
        for r in 0..rows {
            for c in 0..cols {
                let (rr, cc) = f(r, c);
                if g[r][c] == g[rr][cc] {
                    m += 1;
                }
            }
        }
        m as f64 / total
    };
    let mut best = frac(&|r, c| (r, cols - 1 - c))
        .max(frac(&|r, c| (rows - 1 - r, c)))
        .max(frac(&|r, c| (rows - 1 - r, cols - 1 - c)));
    if rows == cols {
        best = best.max(frac(&|r, c| (c, r)));
    }
    best
}

fn dims(layout: &[String]) -> (usize, usize) {
    (layout.len(), layout.first().map(|r| r.chars().count()).unwrap_or(0))
}

/// How "busy" a board looks, in [0,1]: size, special density, type variety, hole irregularity.
pub fn visual_complexity(rec: &LevelRecord) -> f64 {
    let (rows, cols) = dims(&rec.layout);
    let area = (rows * cols).max(1) as f64;
    let mut tiles = 0u32;
    let mut specials = 0u32;
    for r in &rec.layout {
        for ch in r.chars() {
            if ch != '.' {
                tiles += 1;
            }
            if matches!(category(ch), 3 | 4 | 5 | 6) {
                specials += 1;
            }
        }
    }
    let distinct = mechanics_of(&rec.layout).len() as f64; // 0..4
    let size_term = (tiles as f64 / 30.0).min(1.0);
    let special_term = if tiles > 0 {
        specials as f64 / tiles as f64
    } else {
        0.0
    };
    let type_term = distinct / 4.0;
    let hole_term = (area - tiles as f64) / area;
    (0.4 * size_term + 0.3 * special_term + 0.2 * type_term + 0.1 * hole_term).clamp(0.0, 1.0)
}

/// Special-tile fraction (used to keep "interesting" picks from being uniform fields).
fn special_fraction(layout: &[String]) -> f64 {
    let mut tiles = 0u32;
    let mut specials = 0u32;
    for r in layout {
        for ch in r.chars() {
            if ch != '.' {
                tiles += 1;
            }
            if matches!(category(ch), 3 | 4 | 5 | 6) {
                specials += 1;
            }
        }
    }
    if tiles == 0 {
        0.0
    } else {
        specials as f64 / tiles as f64
    }
}

/// Visually distinctive: structural symmetry, weighted so uniform fields don't score high.
pub fn uniqueness(rec: &LevelRecord) -> f64 {
    let variety = (0.4 + 3.0 * special_fraction(&rec.layout)).clamp(0.0, 1.0);
    symmetry(&rec.layout) * variety
}

/// Deceptively hard: high difficulty but a simple look.
pub fn deceptive(rec: &LevelRecord) -> f64 {
    rec.difficulty.unwrap_or(0.0) * (1.0 - visual_complexity(rec))
}

/// Overall interest: either visually unique OR deceptively hard.
pub fn interest(rec: &LevelRecord) -> f64 {
    uniqueness(rec).max(deceptive(rec))
}

/// Two boards count as similar if same size and >85% of cells share a category.
fn similar(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut total = 0u32;
    let mut same = 0u32;
    for (ra, rb) in a.iter().zip(b) {
        if ra.chars().count() != rb.chars().count() {
            return false;
        }
        for (ca, cb) in ra.chars().zip(rb.chars()) {
            total += 1;
            if category(ca) == category(cb) {
                same += 1;
            }
        }
    }
    total > 0 && same as f64 / total as f64 > 0.85
}

/// Lower is a better tutorial board: easy, simple-looking, small — with a nudge toward interesting.
fn tutorial_score(rec: &LevelRecord) -> f64 {
    rec.difficulty.unwrap_or(1.0) + 0.5 * visual_complexity(rec) - 0.15 * interest(rec)
}

/// Pick up to `k` highest-quality boards from `cands`, skipping near-duplicates of anything already
/// chosen. Falls back to filling by quality if diversity leaves the band short.
fn select_quality_diverse(
    sorted: &[&LevelRecord],
    cands: &[usize],
    k: usize,
    already: &[usize],
) -> Vec<usize> {
    let mut by_q = cands.to_vec();
    by_q.sort_by(|&a, &b| {
        sorted[b]
            .difficulty
            .partial_cmp(&sorted[a].difficulty)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| interest(sorted[b]).partial_cmp(&interest(sorted[a])).unwrap_or(std::cmp::Ordering::Equal))
    });
    let mut picked: Vec<usize> = Vec::new();
    for &idx in &by_q {
        if picked.len() >= k {
            break;
        }
        let diverse = already
            .iter()
            .chain(picked.iter())
            .all(|&j| !similar(&sorted[idx].layout, &sorted[j].layout));
        if diverse {
            picked.push(idx);
        }
    }
    if picked.len() < k {
        for &idx in &by_q {
            if picked.len() >= k {
                break;
            }
            if !picked.contains(&idx) {
                picked.push(idx);
            }
        }
    }
    picked
}

/// Build the initial 32-level set: 6 tutorial (one per tile type) then a **steep** ramp — only a
/// handful of medium boards before the level jumps into hard/expert "needs-a-plan" territory.
/// Picks the highest-quality, diverse board per band, then orders the ramp by rising difficulty.
pub fn curate_initial(pool: &[LevelRecord]) -> Ladder {
    let mut sorted: Vec<&LevelRecord> =
        pool.iter().filter(|r| r.difficulty.is_some() && is_clean(r)).collect();
    sorted.sort_by(|a, b| {
        a.difficulty
            .partial_cmp(&b.difficulty)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let n = sorted.len();
    if n == 0 {
        return Ladder { levels: Vec::new() };
    }
    let mut used = vec![false; n];

    // Tutorial: the most learnable pure board for each tile type, in teaching order. Prefer
    // `easy`-band (greedy-solvable) boards so the first six rungs are genuinely approachable;
    // only fall back to harder pure boards if a mechanic has no easy example.
    let mut tutorial: Vec<usize> = Vec::new();
    for t in TUTORIAL_ORDER {
        let pick = |easy_only: bool| {
            (0..n)
                .filter(|&i| {
                    !used[i]
                        && tutorial_type_of(&sorted[i].layout) == Some(t)
                        && (!easy_only || sorted[i].band == "easy")
                })
                .min_by(|&a, &b| {
                    tutorial_score(sorted[a])
                        .partial_cmp(&tutorial_score(sorted[b]))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        };
        if let Some(idx) = pick(true).or_else(|| pick(false)) {
            used[idx] = true;
            tutorial.push(idx);
        }
    }

    // Steep ramp: a few medium boards, then hard, then a deep expert bench. Each band picks the
    // best, most diverse boards; bands that underflow are topped up from the harder bands below.
    let mut rest: Vec<usize> = Vec::new();
    for (band, k) in [("medium", 4usize), ("hard", 10), ("expert", 12)] {
        let cands: Vec<usize> = (0..n).filter(|&i| !used[i] && sorted[i].band == band).collect();
        let already: Vec<usize> = tutorial.iter().chain(rest.iter()).copied().collect();
        for idx in select_quality_diverse(&sorted, &cands, k, &already) {
            used[idx] = true;
            rest.push(idx);
        }
    }

    // Fill to 32 from the remaining hardest boards (keeps the ramp's upper character).
    let want = 32;
    if tutorial.len() + rest.len() < want {
        let mut extra: Vec<usize> = (0..n).filter(|&i| !used[i]).collect();
        extra.sort_by(|&a, &b| {
            sorted[b]
                .difficulty
                .partial_cmp(&sorted[a].difficulty)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        for idx in extra {
            if tutorial.len() + rest.len() >= want {
                break;
            }
            used[idx] = true;
            rest.push(idx);
        }
    }

    // Tutorial keeps teaching order; everything after rises in difficulty.
    rest.sort_by(|&a, &b| {
        sorted[a]
            .difficulty
            .partial_cmp(&sorted[b].difficulty)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let levels = tutorial
        .into_iter()
        .chain(rest)
        .enumerate()
        .map(|(number, idx)| {
            let rec = sorted[idx];
            CuratedLevel {
                number,
                name: rec.name.clone(),
                layout: assign_info(&rec.layout),
                difficulty: rec.difficulty,
                band: rec.band.clone(),
                content: content_stub(&rec.name),
            }
        })
        .collect();

    Ladder { levels }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mechanics_detection() {
        let m = mechanics_of(&["b>n".to_string(), "x1n".to_string(), "rcn".to_string()]);
        assert!(m.contains(&Mechanic::Arrow));
        assert!(m.contains(&Mechanic::Shift));
        assert!(m.contains(&Mechanic::Line));
        assert!(m.contains(&Mechanic::Explosive));
    }

    #[test]
    fn info_assigned_far_from_base() {
        let out = assign_info(&["bn".to_string(), "nn".to_string()]);
        // farthest green from base (0,0) is (1,1) → becomes 'i'
        assert_eq!(out[1].chars().nth(1).unwrap(), 'i');
        assert_eq!(out.iter().flat_map(|r| r.chars()).filter(|&c| c == 'i').count(), 1);
    }

    fn rec(layout: &[&str], difficulty: f64) -> LevelRecord {
        LevelRecord {
            name: "t".into(),
            layout: layout.iter().map(|s| s.to_string()).collect(),
            solution_count: 1,
            reachable_states: 100,
            dead_end_states: 10,
            difficulty: Some(difficulty),
            band: "x".into(),
            exact: true,
            ..Default::default()
        }
    }

    #[test]
    fn symmetry_perfect_for_symmetric_layout() {
        let s = symmetry(&["nxn".to_string(), "x.x".to_string(), "nxn".to_string()]);
        assert!((s - 1.0).abs() < 1e-9, "expected 1.0, got {}", s);
    }

    #[test]
    fn tutorial_types_pure_vs_mixed() {
        assert_eq!(tutorial_type_of(&["bnn".to_string()]), Some(TutorialType::Movement));
        assert_eq!(tutorial_type_of(&["brn".to_string()]), Some(TutorialType::LineRow));
        assert_eq!(tutorial_type_of(&["bcn".to_string()]), Some(TutorialType::LineCol));
        assert_eq!(tutorial_type_of(&["bxn".to_string()]), Some(TutorialType::Explosive));
        assert_eq!(tutorial_type_of(&["b1n1".to_string()]), Some(TutorialType::Shift));
        assert_eq!(tutorial_type_of(&["b>n".to_string()]), Some(TutorialType::Arrow));
        assert_eq!(tutorial_type_of(&["brxn".to_string()]), None); // mixed
    }

    #[test]
    fn visual_complexity_orders_busy_above_simple() {
        let busy = rec(&["bx>1", "rcxn", "n1.x", "vnnn"], 0.5);
        let simple = rec(&["bn", "nn"], 0.5);
        assert!(visual_complexity(&busy) > visual_complexity(&simple));
    }

    #[test]
    fn deceptive_prefers_small_hard() {
        let small_hard = rec(&["bn", "nn"], 0.8);
        let big_hard = rec(&["bx>1nn", "rcxnvn", "n1.xnn", "vnnnrn"], 0.8);
        assert!(deceptive(&small_hard) > deceptive(&big_hard));
    }
}
