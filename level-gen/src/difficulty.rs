//! Quality as a pure function of the solver's raw player-behaviour metrics. Transparent and
//! re-tunable: a whole pool can be re-ranked instantly by changing the weights, with no re-solving.
//!
//! The model selects for levels that **need a plan**, not levels that are merely large. The terms,
//! in weight order:
//!  - **resistance** — `1 − random_solve_prob`: a thoughtless player almost never stumbles in.
//!    This is the headline fix for "solvable in 2-3 attempts" (also a hard gate in `generate`).
//!  - **planning** — commitment (wrong moves doom you) + delay (you stay alive long after the
//!    mistake): the point-of-no-return feel.
//!  - **uniqueness** — `1 − optimal_path_fraction`: a sharp needle in a large can-win haystack.
//!  - **branching** — genuine decision points where most plausible moves are traps (not a corridor).
//!  - **spectacle** — the solution actually triggers lines/blasts/teleports ("interesting to watch").
//!
//! Structural symmetry ("recognizable patterns") is applied at curation (`curate::symmetry`), not
//! here, so this score stays a pure function of solver data.

use crate::metrics::QualityRaw;
use crate::solver::SolveResult;

#[derive(Clone, Debug)]
pub struct DifficultyConfig {
    pub w_random: f64,
    pub w_planning: f64,
    pub w_uniqueness: f64,
    pub w_branching: f64,
    pub w_spectacle: f64,
    /// Doomed-wander length (move-ticks) that saturates the delay half of the planning term.
    pub delay_ref: f64,
}

impl Default for DifficultyConfig {
    fn default() -> Self {
        DifficultyConfig {
            w_random: 0.35,
            w_planning: 0.25,
            w_uniqueness: 0.15,
            w_branching: 0.10,
            w_spectacle: 0.15,
            delay_ref: 6.0,
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
    /// Trial-and-error resistance, `1 − random_solve_prob`.
    pub resistance: f64,
    /// Planning pressure: commitment + delayed consequence.
    pub planning: f64,
    /// Solution sharpness, `1 − optimal_path_fraction`.
    pub uniqueness: f64,
    /// Genuine-decision quality, damped by corridor fraction.
    pub branching: f64,
    /// Watchability: activations along the solution + whether they're required.
    pub spectacle: f64,
    pub score: f64,
}

fn breakdown_from(q: &QualityRaw, cfg: &DifficultyConfig) -> DifficultyBreakdown {
    let resistance = clamp01(1.0 - q.random_solve_prob);
    let delay = sat(q.max_doom_delay as f64 / cfg.delay_ref);
    let planning = clamp01(0.6 * q.commitment + 0.4 * delay);
    let uniqueness = clamp01(1.0 - q.optimal_path_fraction);
    let branching = clamp01(q.decision * (1.0 - 0.5 * q.forced_fraction));
    let spectacle = clamp01(0.5 * q.spectacle + 0.5 * if q.spectacle_required { 1.0 } else { 0.0 });

    let score = clamp01(
        cfg.w_random * resistance
            + cfg.w_planning * planning
            + cfg.w_uniqueness * uniqueness
            + cfg.w_branching * branching
            + cfg.w_spectacle * spectacle,
    );

    DifficultyBreakdown {
        resistance,
        planning,
        uniqueness,
        branching,
        spectacle,
        score,
    }
}

pub fn breakdown(r: &SolveResult, cfg: &DifficultyConfig) -> Option<DifficultyBreakdown> {
    if !r.solvable {
        return None;
    }
    r.quality.as_ref().map(|q| breakdown_from(q, cfg))
}

/// Quality in `[0,1]`, or `None` if unsolvable / quality not computed (screen pass).
pub fn score(r: &SolveResult, cfg: &DifficultyConfig) -> Option<f64> {
    breakdown(r, cfg).map(|b| b.score)
}

/// Difficulty band, derived from behavioural **gates** (not arbitrary score thresholds), so the
/// labels mean what they say: an "easy" board is one a thoughtless player can crack; "expert"
/// resists random play almost entirely and punishes nearly every misstep.
pub fn band(r: &SolveResult, cfg: &DifficultyConfig) -> &'static str {
    if !r.solvable {
        return "unsolvable";
    }
    let q = match &r.quality {
        Some(q) => q,
        // No quality computed (screen pass): fall back to a coarse score-only banding.
        None => {
            return match score(r, cfg) {
                Some(x) if x < 0.20 => "easy",
                Some(x) if x < 0.45 => "medium",
                Some(x) if x < 0.70 => "hard",
                Some(_) => "expert",
                None => "easy",
            }
        }
    };
    let rsp = q.random_solve_prob;
    let commit = q.commitment;
    let sp = r.shortest_path.unwrap_or(0);

    if q.greedy_solves || rsp > 0.30 || sp < 4 {
        "easy"
    } else if rsp <= 0.01 && commit >= 0.50 {
        "expert"
    } else if rsp <= 0.05 && commit >= 0.35 {
        "hard"
    } else {
        "medium"
    }
}
