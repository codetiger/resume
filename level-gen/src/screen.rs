//! Tier-1 screen: cheap simulated-player filters that kill the ~most boards before any expensive
//! full solve. A board that a thoughtless greedy player cracks, or that a uniform-random player
//! wins too often, is exactly the "solvable in 2-3 attempts" board we want to throw away.
//!
//! These simulate the *same* move resolution as the solver (`solver::try_action`) but build no
//! state graph — each rollout is O(path length), microseconds — so they're far cheaper than the
//! deep solve they gate.

use crate::model::Level;
use crate::solver::{self, SolveConfig};
use rand::Rng;
use rustc_hash::FxHashSet;

/// Outcome of screening a candidate board.
pub struct ScreenStats {
    pub reachable: u32,
    pub shortest: u32,
}

/// Deterministic naive-greedy playthrough: each step take the surviving move that most reduces the
/// progress heuristic (clear win-tiles, then head to base). Returns whether it reaches a win.
pub fn greedy_solves(level: &Level) -> bool {
    let mut state = solver::start_state(level);
    let mut seen: FxHashSet<solver::State> = FxHashSet::default();
    let guard = 8 * level.cells.len() + 16;
    for _ in 0..guard {
        if solver::state_is_win(level, &state) {
            return true;
        }
        if !seen.insert(state.clone()) {
            return false; // looped without winning
        }
        // Legal actions are enumerated in a fixed order; strict `<` keeps the first on ties.
        let mut best_h = f64::INFINITY;
        let mut best_ns: Option<solver::State> = None;
        for action in solver::legal_actions(&state) {
            if let Some(ns) = solver::try_action(level, &state, action) {
                let h = solver::greedy_heuristic(level, &ns);
                if h < best_h {
                    best_h = h;
                    best_ns = Some(ns);
                }
            }
        }
        match best_ns {
            Some(ns) => state = ns,
            None => return false, // stuck: every move dies
        }
    }
    false
}

/// One uniform-random rollout: press legal keys (including fatal ones) until a win, a death, or the
/// step cap. Returns whether it reached a win.
fn random_rollout_wins<R: Rng>(level: &Level, step_cap: usize, rng: &mut R) -> bool {
    let mut state = solver::start_state(level);
    for _ in 0..step_cap {
        if solver::state_is_win(level, &state) {
            return true;
        }
        let actions = solver::legal_actions(&state);
        let pick = actions[rng.gen_range(0..actions.len())];
        match solver::try_action(level, &state, pick) {
            Some(ns) => state = ns,
            None => return false, // pressed a key that kills → this attempt fails
        }
    }
    false
}

/// Estimate the uniform-random player's win rate over `trials` rollouts. At each step the player
/// presses one of the legal keys uniformly — including keys that kill — mirroring real fumbling.
pub fn random_rate<R: Rng>(level: &Level, trials: u32, rng: &mut R) -> f64 {
    if trials == 0 {
        return 0.0;
    }
    let step_cap = 6 * level.cells.len() + 24;
    let mut wins = 0u32;
    for _ in 0..trials {
        if random_rollout_wins(level, step_cap, rng) {
            wins += 1;
        }
    }
    wins as f64 / trials as f64
}

/// Decision-identical to `random_rate(level, trials, rng) > max_rate`, but stops the moment the
/// verdict is sealed: once wins exceed the reject count it can only stay rejected, and once even
/// every remaining trial winning couldn't reach it the board has already passed. Saves rollouts on
/// the common easy boards (reject fast) and on the hard boards that proceed (accept fast).
fn random_player_wins_too_often<R: Rng>(
    level: &Level,
    trials: u32,
    max_rate: f64,
    rng: &mut R,
) -> bool {
    if trials == 0 {
        return false; // matches random_rate == 0.0, which is never > max_rate (≥ 0)
    }
    let step_cap = 6 * level.cells.len() + 24;
    // Use the *same* `wins/trials > max_rate` comparison `random_rate` does, so the verdict is
    // bit-identical (not merely mathematically equal). wins only grows; remaining can add at most
    // `remaining` more, so the final rate is bracketed and often decided early.
    let t = trials as f64;
    let mut wins = 0u32;
    for k in 0..trials {
        if random_rollout_wins(level, step_cap, rng) {
            wins += 1;
        }
        if (wins as f64 / t) > max_rate {
            return true; // already over → final rate ≥ this → reject
        }
        let remaining = trials - 1 - k;
        if ((wins + remaining) as f64 / t) <= max_rate {
            return false; // even all-remaining-wins stays ≤ threshold → never rejected
        }
    }
    (wins as f64 / t) > max_rate
}

/// Run the full screen. `max_random` rejects boards a random player beats too often; `min_states`
/// / `min_path` reject boards too small to require planning. Returns `None` if the board is
/// rejected (trivial, unsolvable, or too small) — only survivors proceed to the deep solve.
pub fn screen<R: Rng>(
    level: &Level,
    trials: u32,
    max_random: f64,
    min_states: u32,
    min_path: u32,
    rng: &mut R,
) -> Option<ScreenStats> {
    // 1. A board a naive greedy player solves first try needs no plan.
    if greedy_solves(level) {
        return None;
    }
    // 2. A board random fumbling wins too often is the "2-3 attempts" board. Early-exits the moment
    //    the win-rate verdict is sealed (decision-identical to `random_rate > max_random`).
    if random_player_wins_too_often(level, trials, max_random, rng) {
        return None;
    }
    // 3. Cheap capped BFS: confirm solvable + a real-sized state space and planning depth.
    let r = solver::solve(level, &SolveConfig::screen());
    if !r.solvable || r.reachable_states < min_states || r.shortest_path.unwrap_or(0) < min_path {
        return None;
    }
    Some(ScreenStats {
        reachable: r.reachable_states,
        shortest: r.shortest_path.unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generate::{backbone, mutate, AllowSet, GenSpec};
    use rand::SeedableRng;
    use rand_chacha::ChaCha8Rng;

    /// Build a varied "combined"-style board for a seed (no anneal — just backbone + a mutation
    /// burst), mirroring how the campaign produces screen inputs.
    fn sample_board(seed: u64) -> Option<Level> {
        let spec = GenSpec::new(6, 6, 0.7, AllowSet::all(), seed);
        let mut rng = ChaCha8Rng::seed_from_u64(seed ^ 0x9E37_79B9_7F4A_7C15);
        let mut level = backbone(&spec, &mut rng)?;
        let bursts = 3 + (seed as usize % 9);
        for _ in 0..bursts {
            if let Some(m) = mutate(&level, &spec, &mut rng) {
                level = m;
            }
        }
        Some(level)
    }

    /// #1: the early-exit reject verdict matches the full `random_rate > max` decision exactly,
    /// rollout-for-rollout (same rng seed feeds both).
    #[test]
    fn random_early_exit_matches_full_rate() {
        for seed in 0..400u64 {
            let Some(level) = sample_board(seed) else {
                continue;
            };
            for &trials in &[12u32, 48, 100] {
                for &maxr in &[0.05f64, 0.15, 0.5] {
                    let mut r1 = ChaCha8Rng::seed_from_u64(seed * 1_000_003 + 17);
                    let full = random_rate(&level, trials, &mut r1) > maxr;
                    let mut r2 = ChaCha8Rng::seed_from_u64(seed * 1_000_003 + 17);
                    let fast = random_player_wins_too_often(&level, trials, maxr, &mut r2);
                    assert_eq!(full, fast, "seed={seed} trials={trials} maxr={maxr}");
                }
            }
        }
    }
}
