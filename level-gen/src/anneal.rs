//! Simulated-annealing primitives used by the generator: a geometric temperature schedule and
//! the Metropolis acceptance test. Kept generic and tiny so the generator owns the move set.

use rand::Rng;

/// Geometric temperature decay from `t0` (start) to `t1` (end) over `total` steps.
pub fn temperature(step: usize, total: usize, t0: f64, t1: f64) -> f64 {
    let frac = step as f64 / total.max(1) as f64;
    t0 * (t1 / t0).powf(frac)
}

/// Metropolis acceptance: always accept improvements; accept a worsening move with
/// probability `exp(-Δ/T)`.
pub fn accept<R: Rng>(delta_cost: f64, temp: f64, rng: &mut R) -> bool {
    if delta_cost <= 0.0 {
        true
    } else if temp <= 1e-9 {
        false
    } else {
        rng.gen::<f64>() < (-delta_cost / temp).exp()
    }
}
