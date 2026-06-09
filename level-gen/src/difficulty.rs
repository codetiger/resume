//! Difficulty as a pure function of the solver's raw data. Transparent and re-tunable: a whole
//! pool can be re-ranked instantly by changing the weights, with no re-solving. See `PROPOSAL.md` §4.
//!
//! The headline term is the **needle**: hardness from "many places to explore, few of them solve".
//! Crucially it needs *both* a large reachable space *and* few solutions — a tiny board with one
//! solution is easy (constrained), not hard. The other terms are planning depth (shortest path) and
//! unforgiveness (dead-end fraction).

use crate::solver::SolveResult;

#[derive(Clone, Debug)]
pub struct DifficultyConfig {
    pub w_needle: f64,
    pub w_len: f64,
    pub w_trap: f64,
    /// Reachable-state count below which a board counts as "trivially small" (needle → 0).
    pub s_min: f64,
    /// Reachable-state count that saturates the "big space" factor.
    pub s_ref: f64,
    /// Solutions softening constant: fewness = k_rare / (N + k_rare).
    pub k_rare: f64,
    /// Shortest-path length that saturates the planning-depth term.
    pub l_ref: f64,
}

impl Default for DifficultyConfig {
    fn default() -> Self {
        DifficultyConfig {
            w_needle: 0.45,
            w_len: 0.25,
            w_trap: 0.30,
            s_min: 40.0,
            s_ref: 50_000.0,
            k_rare: 6.0,
            l_ref: 40.0,
        }
    }
}

#[inline]
fn sat(x: f64) -> f64 {
    x / (1.0 + x)
}

#[inline]
fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

/// Component terms, exposed for calibration/inspection.
#[derive(Clone, Debug)]
pub struct DifficultyBreakdown {
    /// "Big explorable space" factor in [0,1].
    pub bigspace: f64,
    /// "Few solutions" factor in [0,1].
    pub fewness: f64,
    /// needle = bigspace × fewness.
    pub needle: f64,
    /// Planning depth (shortest path) in [0,1].
    pub depth: f64,
    /// Dead-end fraction in [0,1].
    pub trap: f64,
    pub score: f64,
}

pub fn breakdown(r: &SolveResult, cfg: &DifficultyConfig) -> Option<DifficultyBreakdown> {
    if !r.solvable {
        return None;
    }
    let l = r.shortest_path.unwrap_or(0) as f64;
    let n = r.solution_count as f64;
    let s = r.reachable_states as f64;
    let t = r.dead_end_states as f64;

    // Big space: 0 below s_min, ramps to 1 at s_ref (log scale).
    let bigspace = clamp01(
        ((s + 1.0).ln() - cfg.s_min.ln()) / (cfg.s_ref.ln() - cfg.s_min.ln()),
    );
    // Few solutions: 1 when N→0, decays as solutions multiply.
    let fewness = cfg.k_rare / (n + cfg.k_rare);
    let needle = bigspace * fewness;

    let depth = sat(l / cfg.l_ref);
    let trap = t / s.max(1.0);

    let score = clamp01(cfg.w_needle * needle + cfg.w_len * depth + cfg.w_trap * trap);

    Some(DifficultyBreakdown {
        bigspace,
        fewness,
        needle,
        depth,
        trap,
        score,
    })
}

/// Difficulty in `[0,1]`, or `None` if unsolvable.
pub fn score(r: &SolveResult, cfg: &DifficultyConfig) -> Option<f64> {
    breakdown(r, cfg).map(|b| b.score)
}

pub fn band(score: Option<f64>) -> &'static str {
    match score {
        None => "unsolvable",
        Some(x) if x < 0.20 => "easy",
        Some(x) if x < 0.45 => "medium",
        Some(x) if x < 0.70 => "hard",
        Some(_) => "expert",
    }
}
