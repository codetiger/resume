//! Generator — hybrid constructive backbone + simulated annealing. See `PROPOSAL.md` §5/6.
//!
//! Phase A builds a guaranteed-solvable backbone: a random self-avoiding **loop** through the base.
//! Its cells become greens, so walking the loop is a solution. Phase B anneals special tiles and
//! extra greens onto the board to drive the (solver-measured) difficulty toward the target, never
//! accepting an unsolvable candidate.

use crate::anneal;
use crate::difficulty::{self, DifficultyConfig};
use crate::io::{encode_layout, GenRequest, LevelRecord};
use crate::model::{Direction, Level, Sweep, TileKind};
use crate::solver::{solve, SolveConfig, SolveResult};
use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

/// Which special tiles the generator may introduce (greens + base are always available).
#[derive(Clone, Copy, Debug)]
pub struct AllowSet {
    pub arrow: bool,
    pub shift: bool,
    pub line: bool,
    pub explosive: bool,
}

impl AllowSet {
    pub fn none() -> Self {
        AllowSet {
            arrow: false,
            shift: false,
            line: false,
            explosive: false,
        }
    }

    pub fn all() -> Self {
        AllowSet {
            arrow: true,
            shift: true,
            line: true,
            explosive: true,
        }
    }

    /// Parse tokens like `["n","arrow","shift","line","explosive"]` (aliases: x, t, a, r/c).
    pub fn from_tokens(toks: &[String]) -> Self {
        let mut s = AllowSet::none();
        for t in toks {
            match t.to_lowercase().as_str() {
                "arrow" | "a" | ">" | "<" | "^" | "v" => s.arrow = true,
                "shift" | "t" | "teleport" => s.shift = true,
                "line" | "r" | "c" | "sweep" => s.line = true,
                "explosive" | "x" | "bomb" => s.explosive = true,
                "n" | "green" | "b" | "base" | "" => {}
                other => eprintln!("warning: unknown tile token {:?} (ignored)", other),
            }
        }
        s
    }

    pub fn to_tokens(&self) -> Vec<String> {
        let mut v = vec!["n".to_string()];
        if self.arrow {
            v.push("arrow".into());
        }
        if self.shift {
            v.push("shift".into());
        }
        if self.line {
            v.push("line".into());
        }
        if self.explosive {
            v.push("explosive".into());
        }
        v
    }

    pub fn any(&self) -> bool {
        self.arrow || self.shift || self.line || self.explosive
    }
}

#[derive(Clone, Debug)]
pub struct GenSpec {
    pub cols: usize,
    pub rows: usize,
    pub target: f64,
    pub allow: AllowSet,
    /// Mechanics the final board must contain at least one of (used for tutorial boards).
    pub require: AllowSet,
    /// Force any disappear-line tiles to a single sweep axis (for pure row/col tutorials).
    pub line_sweep: Option<Sweep>,
    pub seed: u64,
    /// Annealing iterations (solver evaluations).
    pub iters: usize,
    /// Reject boards with fewer greens than this (avoids trivial/degenerate levels).
    pub greens_min: usize,
}

impl GenSpec {
    pub fn new(cols: usize, rows: usize, target: f64, allow: AllowSet, seed: u64) -> Self {
        GenSpec {
            cols,
            rows,
            target,
            allow,
            require: AllowSet::none(),
            line_sweep: None,
            seed,
            iters: 500,
            greens_min: 3,
        }
    }
}

pub struct GenOutcome {
    pub level: Level,
    pub result: SolveResult,
    pub difficulty: f64,
    pub seed: u64,
    pub target: f64,
    pub allow: AllowSet,
}

impl GenOutcome {
    pub fn to_record(&self) -> LevelRecord {
        let band = difficulty::band(Some(self.difficulty)).to_string();
        LevelRecord {
            name: format!(
                "gen-{}x{}-{}-s{}",
                self.level.cols, self.level.rows, band, self.seed
            ),
            seed: self.seed,
            layout: encode_layout(&self.level),
            request: Some(GenRequest {
                target_difficulty: self.target,
                allow: self.allow.to_tokens(),
                cols: self.level.cols,
                rows: self.level.rows,
            }),
            solutions: self.result.solutions.clone(),
            solution_count: self.result.solution_count,
            reachable_states: self.result.reachable_states,
            dead_end_states: self.result.dead_end_states,
            difficulty: Some(self.difficulty),
            band,
            exact: self.result.exact,
        }
    }
}

fn neighbors(cols: usize, rows: usize, idx: usize) -> Vec<usize> {
    let c = idx % cols;
    let r = idx / cols;
    let mut v = Vec::with_capacity(4);
    if c + 1 < cols {
        v.push(idx + 1);
    }
    if c > 0 {
        v.push(idx - 1);
    }
    if r + 1 < rows {
        v.push(idx + cols);
    }
    if r > 0 {
        v.push(idx - cols);
    }
    v
}

fn adjacent(cols: usize, rows: usize, a: usize, b: usize) -> bool {
    neighbors(cols, rows, a).contains(&b)
}

/// Backtracking random self-avoiding loop through `base`. Returns the ordered cycle cells.
/// Grid graphs are bipartite, so a cycle has an even cell count — enforced at close.
fn build_loop(
    cols: usize,
    rows: usize,
    base: usize,
    min_len: usize,
    max_len: usize,
    rng: &mut ChaCha8Rng,
) -> Option<Vec<usize>> {
    fn dfs(
        cols: usize,
        rows: usize,
        base: usize,
        min: usize,
        max: usize,
        path: &mut Vec<usize>,
        visited: &mut [bool],
        rng: &mut ChaCha8Rng,
        budget: &mut i64,
    ) -> bool {
        if *budget <= 0 {
            return false;
        }
        *budget -= 1;
        let cur = *path.last().unwrap();
        let len = path.len();
        let can_close = len >= min && len % 2 == 0 && adjacent(cols, rows, cur, base);
        if can_close && (len >= max || rng.gen::<f64>() < 0.25) {
            return true;
        }
        if len < max {
            let mut nbs = neighbors(cols, rows, cur);
            nbs.shuffle(rng);
            for nb in nbs {
                if nb == base || visited[nb] {
                    continue;
                }
                visited[nb] = true;
                path.push(nb);
                if dfs(cols, rows, base, min, max, path, visited, rng, budget) {
                    return true;
                }
                path.pop();
                visited[nb] = false;
            }
        }
        can_close
    }

    let mut path = vec![base];
    let mut visited = vec![false; cols * rows];
    visited[base] = true;
    let mut budget: i64 = 200_000;
    if dfs(
        cols, rows, base, min_len, max_len, &mut path, &mut visited, rng, &mut budget,
    ) {
        Some(path)
    } else {
        None
    }
}

fn round_even(x: usize) -> usize {
    if x % 2 == 0 {
        x
    } else {
        x + 1
    }
}

/// Build the Phase-A backbone level (base + a loop of greens, everything else a hole).
fn backbone(spec: &GenSpec, rng: &mut ChaCha8Rng) -> Option<Level> {
    let cols = spec.cols;
    let rows = spec.rows;
    let cells = cols * rows;
    if cells < 4 {
        return None;
    }
    // Bias loop size up with the target so harder requests start from a roomier board.
    let want = ((0.35 + 0.45 * spec.target) * cells as f64) as usize;
    let min_len = round_even(want.clamp(4, cells)).max(4);
    let max_len = round_even(cells.min(min_len + cells / 2)).max(min_len);

    for _ in 0..40 {
        // Try a handful of base positions / loops.
        let base = rng.gen_range(0..cells);
        if let Some(loop_cells) = build_loop(cols, rows, base, min_len, max_len, rng) {
            let mut cells_vec = vec![None; cells];
            for &c in &loop_cells {
                cells_vec[c] = Some(TileKind::Green);
            }
            cells_vec[base] = Some(TileKind::Base);
            if let Ok(level) = Level::new(cols, rows, cells_vec) {
                return Some(level);
            }
        }
    }
    None
}

fn used_shift_ids(level: &Level) -> Vec<u8> {
    let mut ids: Vec<u8> = level
        .cells
        .iter()
        .filter_map(|c| match c {
            Some(TileKind::Shift(p)) => Some(*p),
            _ => None,
        })
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn green_indices(level: &Level) -> Vec<usize> {
    level
        .cells
        .iter()
        .enumerate()
        .filter(|(_, c)| matches!(c, Some(TileKind::Green)))
        .map(|(i, _)| i)
        .collect()
}

fn special_indices(level: &Level) -> Vec<usize> {
    level
        .cells
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            matches!(
                c,
                Some(TileKind::Arrow(_))
                    | Some(TileKind::Shift(_))
                    | Some(TileKind::Line(_))
                    | Some(TileKind::Explosive)
            )
        })
        .map(|(i, _)| i)
        .collect()
}

fn random_special(
    allow: &AllowSet,
    line_sweep: Option<Sweep>,
    rng: &mut ChaCha8Rng,
) -> Option<TileKind> {
    let mut opts: Vec<TileKind> = Vec::new();
    if allow.arrow {
        let dirs = [
            Direction::Right,
            Direction::Left,
            Direction::Forward,
            Direction::Back,
        ];
        opts.push(TileKind::Arrow(*dirs.choose(rng).unwrap()));
    }
    if allow.line {
        let sweep = line_sweep.unwrap_or(if rng.gen::<bool>() {
            Sweep::Row
        } else {
            Sweep::Col
        });
        opts.push(TileKind::Line(sweep));
    }
    if allow.explosive {
        opts.push(TileKind::Explosive);
    }
    // Shift handled as a pair elsewhere.
    opts.choose(rng).copied()
}

/// Apply one random mutation to a clone of `level`. Returns `None` if the chosen op doesn't apply.
fn mutate(level: &Level, spec: &GenSpec, rng: &mut ChaCha8Rng) -> Option<Level> {
    let allow = &spec.allow;
    let cols = level.cols;
    let rows = level.rows;
    let mut next = level.clone();
    let op = rng.gen_range(0..6);
    match op {
        // 0: add a green on a hole adjacent to an existing tile (keeps the board connected).
        0 => {
            let holes: Vec<usize> = (0..cols * rows)
                .filter(|&i| next.cells[i].is_none())
                .filter(|&i| neighbors(cols, rows, i).iter().any(|&n| next.cells[n].is_some()))
                .collect();
            let &h = holes.choose(rng)?;
            next.cells[h] = Some(TileKind::Green);
        }
        // 1: remove a green (turn to hole).
        1 => {
            let g = green_indices(&next);
            let &c = g.choose(rng)?;
            next.cells[c] = None;
        }
        // 2: retype a green into an allowed single-cell special.
        2 => {
            if !(allow.arrow || allow.line || allow.explosive) {
                return None;
            }
            let g = green_indices(&next);
            let &c = g.choose(rng)?;
            next.cells[c] = Some(random_special(allow, spec.line_sweep, rng)?);
        }
        // 3: turn a special back into a green.
        3 => {
            let sp = special_indices(&next);
            let &c = sp.choose(rng)?;
            next.cells[c] = Some(TileKind::Green);
        }
        // 4: add a shift pair (two greens become a fresh teleport pair).
        4 => {
            if !allow.shift {
                return None;
            }
            let used = used_shift_ids(&next);
            let pid = (1u8..=9).find(|p| !used.contains(p))?;
            let g = green_indices(&next);
            if g.len() < 2 {
                return None;
            }
            let picks: Vec<usize> = g.choose_multiple(rng, 2).copied().collect();
            next.cells[picks[0]] = Some(TileKind::Shift(pid));
            next.cells[picks[1]] = Some(TileKind::Shift(pid));
        }
        // 5: flip an arrow's direction.
        _ => {
            let arrows: Vec<usize> = (0..cols * rows)
                .filter(|&i| matches!(next.cells[i], Some(TileKind::Arrow(_))))
                .collect();
            let &c = arrows.choose(rng)?;
            let dirs = [
                Direction::Right,
                Direction::Left,
                Direction::Forward,
                Direction::Back,
            ];
            next.cells[c] = Some(TileKind::Arrow(*dirs.choose(rng).unwrap()));
        }
    }
    // Base must survive every mutation.
    if next.cells[next.base] != Some(TileKind::Base) {
        return None;
    }
    Some(next)
}

fn evaluate(level: &Level, scfg: &SolveConfig, dcfg: &DifficultyConfig) -> (SolveResult, f64) {
    let res = solve(level, scfg);
    let diff = difficulty::score(&res, dcfg).unwrap_or(f64::NAN);
    (res, diff)
}

/// How many required mechanics the board is missing (shift needs a working pair, i.e. ≥2 cells).
fn missing_required(level: &Level, require: &AllowSet) -> u32 {
    let count = |pred: &dyn Fn(&TileKind) -> bool| {
        level
            .cells
            .iter()
            .filter(|c| matches!(c, Some(k) if pred(k)))
            .count()
    };
    let mut missing = 0;
    if require.arrow && count(&|k| matches!(k, TileKind::Arrow(_))) == 0 {
        missing += 1;
    }
    if require.shift && count(&|k| matches!(k, TileKind::Shift(_))) < 2 {
        missing += 1;
    }
    if require.line && count(&|k| matches!(k, TileKind::Line(_))) == 0 {
        missing += 1;
    }
    if require.explosive && count(&|k| matches!(k, TileKind::Explosive)) == 0 {
        missing += 1;
    }
    missing
}

/// Cost to minimise: distance to the target difficulty (+ a penalty for missing required
/// mechanics); infinite for invalid boards.
fn cost(level: &Level, res: &SolveResult, diff: f64, spec: &GenSpec) -> f64 {
    if !res.solvable || level.green_count() < spec.greens_min as u32 || diff.is_nan() {
        f64::INFINITY
    } else {
        (diff - spec.target).abs() + 0.5 * missing_required(level, &spec.require) as f64
    }
}

/// Generate one board for `spec`. Returns the best board found (always solvable), or `None` if no
/// solvable backbone could be built.
pub fn generate(spec: &GenSpec, dcfg: &DifficultyConfig, scfg: &SolveConfig) -> Option<GenOutcome> {
    let mut rng = ChaCha8Rng::seed_from_u64(spec.seed);

    // Phase A: a solvable backbone.
    let mut cur = backbone(spec, &mut rng)?;
    let (mut cur_res, mut cur_diff) = evaluate(&cur, scfg, dcfg);
    let mut cur_cost = cost(&cur, &cur_res, cur_diff, spec);
    // If even the backbone is somehow invalid, bail.
    if !cur_cost.is_finite() {
        // Backbone should be solvable; if greens_min not met, still keep it as best-effort.
        if !cur_res.solvable {
            return None;
        }
    }

    let mut best = cur.clone();
    let mut best_res = cur_res.clone();
    let mut best_diff = cur_diff;
    let mut best_cost = cur_cost;

    for step in 0..spec.iters {
        let temp = anneal::temperature(step, spec.iters, 0.20, 0.005);
        let cand = match mutate(&cur, spec, &mut rng) {
            Some(l) => l,
            None => continue,
        };
        let (cand_res, cand_diff) = evaluate(&cand, scfg, dcfg);
        let cand_cost = cost(&cand, &cand_res, cand_diff, spec);
        if !cand_cost.is_finite() {
            continue; // never accept an unsolvable / degenerate board
        }
        let delta = cand_cost - cur_cost;
        if delta <= 0.0 || (cur_cost.is_finite() && anneal::accept(delta, temp, &mut rng)) {
            cur = cand;
            cur_res = cand_res;
            cur_diff = cand_diff;
            cur_cost = cand_cost;
            if cand_cost < best_cost {
                best = cur.clone();
                best_res = cur_res.clone();
                best_diff = cur_diff;
                best_cost = cand_cost;
            }
        }
        if best_cost < 0.01 {
            break;
        }
    }

    if !best_res.solvable {
        return None;
    }
    Some(GenOutcome {
        level: best,
        result: best_res,
        difficulty: best_diff,
        seed: spec.seed,
        target: spec.target,
        allow: spec.allow,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backbone_is_always_solvable() {
        let dcfg = DifficultyConfig::default();
        let scfg = SolveConfig::default();
        for seed in 0..12u64 {
            let spec = GenSpec::new(5, 5, 0.3, AllowSet::none(), seed);
            if let Some(level) = backbone(&spec, &mut ChaCha8Rng::seed_from_u64(seed)) {
                let (res, _) = evaluate(&level, &scfg, &dcfg);
                assert!(res.solvable, "backbone seed {} unsolvable", seed);
            }
        }
    }

    #[test]
    fn generate_is_deterministic() {
        let dcfg = DifficultyConfig::default();
        let mut scfg = SolveConfig::default();
        scfg.max_states = 60_000;
        let spec = GenSpec {
            iters: 120,
            ..GenSpec::new(5, 5, 0.3, AllowSet::all(), 7)
        };
        let a = generate(&spec, &dcfg, &scfg).unwrap();
        let b = generate(&spec, &dcfg, &scfg).unwrap();
        assert_eq!(encode_layout(&a.level), encode_layout(&b.level));
        assert!(a.result.solvable);
    }
}
