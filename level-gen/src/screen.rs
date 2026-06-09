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

/// Estimate the uniform-random player's win rate over `trials` rollouts. At each step the player
/// presses one of the legal keys uniformly — including keys that kill — mirroring real fumbling.
pub fn random_rate<R: Rng>(level: &Level, trials: u32, rng: &mut R) -> f64 {
    if trials == 0 {
        return 0.0;
    }
    let step_cap = 6 * level.cells.len() + 24;
    let mut wins = 0u32;
    for _ in 0..trials {
        let mut state = solver::start_state(level);
        let mut won = false;
        for _ in 0..step_cap {
            if solver::state_is_win(level, &state) {
                won = true;
                break;
            }
            let actions = solver::legal_actions(&state);
            let pick = actions[rng.gen_range(0..actions.len())];
            match solver::try_action(level, &state, pick) {
                Some(ns) => state = ns,
                None => break, // pressed a key that kills → this attempt fails
            }
        }
        if won {
            wins += 1;
        }
    }
    wins as f64 / trials as f64
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
    // 2. A board random fumbling wins too often is the "2-3 attempts" board.
    if random_rate(level, trials, rng) > max_random {
        return None;
    }
    // 3. Cheap capped BFS: confirm solvable + a real-sized state space and planning depth.
    let r = solver::solve(level, &SolveConfig::screen());
    if !r.solvable {
        return None;
    }
    if r.reachable_states < min_states {
        return None;
    }
    if r.shortest_path.unwrap_or(0) < min_path {
        return None;
    }
    Some(ScreenStats {
        reachable: r.reachable_states,
        shortest: r.shortest_path.unwrap_or(0),
    })
}
