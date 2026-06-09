//! Player-behaviour quality metrics — the heart of the "needs a plan" model.
//!
//! These are **exact graph computations** over the reachable state graph that `solver::solve`
//! already builds (`adj`, `is_win`, `dist`, `can_win`, plus the `death_moves` and `dist_to_win`
//! it now also records). No Monte-Carlo is needed: a uniform-random player is an absorbing Markov
//! chain over the same graph, so its exact win probability is one linear solve.
//!
//! The signals, and what each is trying to catch (see `PROPOSAL.md` and the design notes):
//!  1. `random_solve_prob` / `greedy_solves` — does a thoughtless player stumble onto the win?
//!     (the headline "solvable in 2-3 attempts" complaint).
//!  2. `commitment` + `max_doom_delay` — how early does a wrong move doom you, and how long do you
//!     keep rolling, oblivious, before forced death (the "needs a plan" / point-of-no-return feel).
//!  3. `optimal_path_fraction` — how sharp is the needle in the haystack.
//!  4. `decision` + `forced_fraction` — genuine choices where most choices are traps vs. corridors.
//!  5. spectacle is computed in `solver` (it needs the `Level` to replay activations), not here.

use std::collections::VecDeque;

/// Raw, un-weighted quality signals for one solvable board. Combined into a score in `difficulty`.
#[derive(Clone, Debug, Default)]
pub struct QualityRaw {
    /// Exact probability a uniform-random player reaches a win. Low = resists trial-and-error.
    pub random_solve_prob: f64,
    /// Does a naive progress-greedy player solve it on the first deterministic try? (gate)
    pub greedy_solves: bool,
    /// Mean fraction of keypresses along the optimal path that doom you (delayed or instant).
    pub commitment: f64,
    /// Longest run of surviving moves possible after a wrong (doomed) move off the optimal path.
    pub max_doom_delay: u32,
    /// Fraction of can-win states lying on a near-optimal path (small = sharp needle).
    pub optimal_path_fraction: f64,
    /// Mean "fraction of plausible moves that are traps" at genuine decision points.
    pub decision: f64,
    /// Fraction of can-win states with exactly one safe move (corridor detector).
    pub forced_fraction: f64,
    /// Special-tile activations along the shortest solution, normalised (filled by solver).
    pub spectacle: f64,
    /// Winning is impossible without engaging a line/blast/teleport (filled by solver).
    pub spectacle_required: bool,
}

/// Exact probability that a uniform-random keypress player, starting at `start`, eventually wins.
///
/// Model: at each non-win state the player presses one of `legal_keys(s) = adj[s].len() +
/// death_moves[s]` keys uniformly. Surviving keys advance along `adj`; the rest are absorbing
/// death (contribute 0). Solve `P[s] = (1/keys)·Σ P[t]` (P[win]=1) by Gauss-Seidel value iteration.
pub fn random_solve_prob(
    adj: &[Vec<(char, u32)>],
    death_moves: &[u8],
    is_win: &[bool],
    start: usize,
) -> f64 {
    let n = adj.len();
    if n == 0 {
        return 0.0;
    }
    let mut p = vec![0.0f64; n];
    for i in 0..n {
        if is_win[i] {
            p[i] = 1.0;
        }
    }
    for _ in 0..256 {
        let mut max_delta = 0.0f64;
        for s in 0..n {
            if is_win[s] {
                continue;
            }
            let keys = (adj[s].len() as u32 + death_moves[s] as u32).max(1) as f64;
            let mut acc = 0.0;
            for &(_, t) in &adj[s] {
                acc += p[t as usize];
            }
            let np = acc / keys;
            let d = (np - p[s]).abs();
            if d > max_delta {
                max_delta = d;
            }
            p[s] = np;
        }
        if max_delta < 1e-7 {
            break;
        }
    }
    p[start]
}

/// A naive "progress-greedy" player: at each step take the surviving move that most reduces the
/// heuristic `greedy_h` (remaining win-tiles, then distance to base). It does **not** know which
/// states are doomed, so it can walk into a trap. Returns whether it reaches a win.
///
/// Used as a hard rejection gate: a board a thoughtless progress-seeker solves first try is easy.
pub fn greedy_solves(
    adj: &[Vec<(char, u32)>],
    greedy_h: &[f64],
    is_win: &[bool],
    start: usize,
) -> bool {
    let n = adj.len();
    if n == 0 {
        return false;
    }
    let mut s = start;
    let mut seen = vec![false; n];
    loop {
        if is_win[s] {
            return true;
        }
        if seen[s] {
            return false; // looped without winning → greedy fails
        }
        seen[s] = true;
        // Pick the successor with the smallest heuristic; ties broken by glyph for determinism.
        let next = adj[s]
            .iter()
            .min_by(|a, b| {
                greedy_h[a.1 as usize]
                    .partial_cmp(&greedy_h[b.1 as usize])
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(a.0.cmp(&b.0))
            })
            .map(|&(_, t)| t as usize);
        match next {
            Some(t) => s = t,
            None => return false, // stuck: every move dies
        }
    }
}

/// Reconstruct one shortest solution path (state indices) by following decreasing `dist_to_win`.
fn optimal_path(
    adj: &[Vec<(char, u32)>],
    dist_to_win: &[u32],
    is_win: &[bool],
    start: usize,
) -> Vec<usize> {
    let mut path = vec![start];
    let mut s = start;
    let guard = adj.len() + 2;
    for _ in 0..guard {
        if is_win[s] {
            break;
        }
        let target = dist_to_win[s];
        if target == u32::MAX || target == 0 {
            break;
        }
        let next = adj[s]
            .iter()
            .filter(|&&(_, t)| dist_to_win[t as usize] == target - 1)
            .min_by(|a, b| a.0.cmp(&b.0))
            .map(|&(_, t)| t as usize);
        match next {
            Some(t) => {
                path.push(t);
                s = t;
            }
            None => break,
        }
    }
    path
}

/// Longest run of surviving moves a player can make starting from each **doomed** state before
/// being forced into a dead end (no surviving move). States inside a doomed cycle can loiter
/// indefinitely → capped at `cap`. Computed bottom-up on the doomed subgraph (Kahn, no recursion).
fn doom_survive_depths(adj: &[Vec<(char, u32)>], can_win: &[bool], cap: u32) -> Vec<u32> {
    let n = adj.len();
    let doomed = |s: usize| !can_win[s];
    let mut outdeg = vec![0u32; n];
    let mut rev: Vec<Vec<u32>> = vec![Vec::new(); n];
    for s in 0..n {
        if !doomed(s) {
            continue;
        }
        for &(_, t) in &adj[s] {
            let t = t as usize;
            if doomed(t) {
                outdeg[s] += 1;
                rev[t].push(s as u32);
            }
        }
    }
    let mut longest = vec![0u32; n];
    let mut finalized = vec![false; n];
    let mut q: VecDeque<u32> = VecDeque::new();
    for s in 0..n {
        if doomed(s) && outdeg[s] == 0 {
            finalized[s] = true;
            q.push_back(s as u32);
        }
    }
    while let Some(s) = q.pop_front() {
        let ls = longest[s as usize];
        for &p in &rev[s as usize] {
            let p = p as usize;
            longest[p] = longest[p].max(1 + ls).min(cap);
            outdeg[p] -= 1;
            if outdeg[p] == 0 && !finalized[p] {
                finalized[p] = true;
                q.push_back(p as u32);
            }
        }
    }
    // Anything left unfinalised is in (or feeds) a doomed cycle → can loiter, treat as cap.
    for s in 0..n {
        if doomed(s) && !finalized[s] {
            longest[s] = cap;
        }
    }
    longest
}

/// Commitment + delay along the optimal path. `commitment`: mean fraction of keypresses at each
/// on-path state that lead to a doomed/dead outcome (you must plan each step). `max_doom_delay`:
/// the longest oblivious wander a single wrong move off the path buys before forced death.
pub fn commitment_and_delay(
    adj: &[Vec<(char, u32)>],
    death_moves: &[u8],
    can_win: &[bool],
    dist_to_win: &[u32],
    is_win: &[bool],
    start: usize,
    delay_cap: u32,
) -> (f64, u32) {
    let path = optimal_path(adj, dist_to_win, is_win, start);
    let survive = doom_survive_depths(adj, can_win, delay_cap);
    let mut commit_sum = 0.0;
    let mut commit_n = 0u32;
    let mut max_delay = 0u32;
    for &s in &path {
        if is_win[s] {
            continue;
        }
        let surviving = adj[s].len();
        let legal = surviving as u32 + death_moves[s] as u32;
        if legal == 0 {
            continue;
        }
        let mut bad = death_moves[s] as u32; // every death key is "doomed"
        for &(_, t) in &adj[s] {
            if !can_win[t as usize] {
                bad += 1;
                // entering this doomed successor: how long can you keep rolling before death?
                max_delay = max_delay.max(survive[t as usize] + 1);
            }
        }
        commit_sum += bad as f64 / legal as f64;
        commit_n += 1;
    }
    let commitment = if commit_n > 0 {
        commit_sum / commit_n as f64
    } else {
        0.0
    };
    (commitment, max_delay.min(delay_cap))
}

/// Fraction of can-win states lying on a path within `(1+eps)` of optimal length. Small = the
/// solution is a sharp needle in a large can-win haystack; large = many routes, little planning.
pub fn optimal_path_fraction(
    dist: &[u32],
    dist_to_win: &[u32],
    can_win: &[bool],
    shortest_path: u32,
) -> f64 {
    let eps = 0.15;
    let thresh = (shortest_path as f64 * (1.0 + eps)).floor() as u32;
    let mut near = 0u32;
    let mut canwin = 0u32;
    for s in 0..dist.len() {
        if !can_win[s] {
            continue;
        }
        canwin += 1;
        if dist[s] != u32::MAX
            && dist_to_win[s] != u32::MAX
            && dist[s].saturating_add(dist_to_win[s]) <= thresh
        {
            near += 1;
        }
    }
    if canwin == 0 {
        0.0
    } else {
        near as f64 / canwin as f64
    }
}

/// Decision quality over can-win states. `decision`: at points with ≥2 surviving moves, the mean
/// fraction of those plausible moves that are actually traps ("looks like a choice, but it's
/// wrong"). `forced_fraction`: share of can-win states with exactly one safe move (a corridor).
pub fn decision_branching(
    adj: &[Vec<(char, u32)>],
    can_win: &[bool],
    is_win: &[bool],
) -> (f64, f64) {
    let mut dec_sum = 0.0;
    let mut dec_n = 0u32;
    let mut forced = 0u32;
    let mut total = 0u32;
    for s in 0..adj.len() {
        if !can_win[s] || is_win[s] {
            continue;
        }
        let surviving = adj[s].len();
        if surviving == 0 {
            continue;
        }
        let safe = adj[s]
            .iter()
            .filter(|&&(_, t)| can_win[t as usize])
            .count();
        total += 1;
        if safe == 1 {
            forced += 1;
        }
        if surviving >= 2 {
            dec_sum += (surviving - safe) as f64 / surviving as f64;
            dec_n += 1;
        }
    }
    let decision = if dec_n > 0 {
        dec_sum / dec_n as f64
    } else {
        0.0
    };
    let forced_fraction = if total > 0 {
        forced as f64 / total as f64
    } else {
        0.0
    };
    (decision, forced_fraction)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Build a tiny explicit graph: a linear chain 0->1->2 where 2 is the win.
    // No death moves, single path. Random player walks straight in → prob 1.
    #[test]
    fn linear_chain_is_certain_for_random() {
        let adj = vec![vec![('>', 1u32)], vec![('>', 2u32)], vec![]];
        let death = vec![0u8, 0, 0];
        let is_win = vec![false, false, true];
        let p = random_solve_prob(&adj, &death, &is_win, 0);
        assert!((p - 1.0).abs() < 1e-6, "got {}", p);
    }

    // From the start there are two surviving moves: one to the win, one to a dead branch with
    // three further death-only states. Random success should be well below 1.
    #[test]
    fn fork_with_trap_lowers_random_prob() {
        // 0 -> {1 (win), 2}; 2 -> {3}; 3 has only death moves (dead end).
        let adj = vec![
            vec![('>', 1u32), ('v', 2u32)],
            vec![],
            vec![('v', 3u32)],
            vec![],
        ];
        // state 3: 4 keys all die. state 0: 2 surviving + assume 2 death keys.
        let death = vec![2u8, 0, 0, 4];
        let is_win = vec![false, true, false, false];
        let p = random_solve_prob(&adj, &death, &is_win, 0);
        assert!(p < 0.9 && p > 0.0, "expected a middling prob, got {}", p);
    }

    #[test]
    fn greedy_follows_heuristic_downhill() {
        // 0 -> {1, 2}; lower h wins. Make state 1 the win with the lowest h.
        let adj = vec![vec![('>', 1u32), ('v', 2u32)], vec![], vec![]];
        let is_win = vec![false, true, false];
        let h = vec![2.0, 0.0, 5.0];
        assert!(greedy_solves(&adj, &h, &is_win, 0));
        // If the greedy heuristic points at the dead branch instead, greedy fails.
        let h2 = vec![2.0, 5.0, 0.0];
        assert!(!greedy_solves(&adj, &h2, &is_win, 0));
    }

    #[test]
    fn doom_depths_cap_cycles() {
        // 1 and 2 form a doomed cycle; 0 (also doomed) feeds it. can_win all false.
        let adj = vec![vec![('>', 1u32)], vec![('>', 2u32)], vec![('>', 1u32)]];
        let can_win = vec![false, false, false];
        let d = doom_survive_depths(&adj, &can_win, 50);
        assert_eq!(d[1], 50);
        assert_eq!(d[2], 50);
        assert_eq!(d[0], 50);
    }
}
