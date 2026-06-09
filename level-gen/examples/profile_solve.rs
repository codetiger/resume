//! Focused timing harness for the deep solve.
//! Loads real generated boards from a campaign pool.json and runs `solve()` with the
//! campaign's *deep* config in a tight single-threaded loop — handy for `samply`/`sample`.
//!
//!   cargo build --release --example profile_solve
//!   ./target/release/examples/profile_solve ../levels/campaigns/<name>/pool.json 40

use level_gen::io::parse_layout;
use level_gen::solver::{solve, SolveConfig};
use std::time::Instant;

// Match the real binary's allocator so allocator self-time is realistic under a profiler.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn deep() -> SolveConfig {
    // Mirror campaign::deep_config().
    SolveConfig {
        max_states: 160_000,
        count_cap: 4_000,
        visit_cap: 800_000,
        store_cap: 40,
        store_buffer: 600,
        enumerate: true,
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .unwrap_or_else(|| "../levels/campaigns/run1/pool.json".to_string());
    let reps: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(40);

    let data = std::fs::read_to_string(&path).expect("read pool.json");
    let v: serde_json::Value = serde_json::from_str(&data).expect("parse pool.json");
    let arr = v.as_array().expect("pool is an array");

    let mut levels = Vec::new();
    for rec in arr {
        let layout: Vec<String> = rec["layout"]
            .as_array()
            .expect("layout array")
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        if let Ok(lv) = parse_layout(&layout) {
            levels.push(lv);
        }
    }
    eprintln!("loaded {} boards · {} reps", levels.len(), reps);

    let cfg = deep();
    let mut total_states = 0u64;
    // Per-field checksums over ONE pass — behavior-preserving changes must keep these identical.
    let q = |x: f64| (x * 1e9).round() as i64; // quantize floats to compare deterministically
    let (mut c_states, mut c_solcount, mut c_deadend, mut c_deadtiles) = (0i64, 0i64, 0i64, 0i64);
    let (mut c_rsp, mut c_commit, mut c_optpath, mut c_decision, mut c_forced, mut c_spec) =
        (0i64, 0i64, 0i64, 0i64, 0i64, 0i64);
    let (mut c_greedy, mut c_doom, mut c_specreq) = (0i64, 0i64, 0i64);
    {
        for lv in &levels {
            let r = solve(lv, &cfg);
            c_states += r.reachable_states as i64;
            c_solcount += r.solution_count as i64;
            c_deadend += r.dead_end_states as i64;
            c_deadtiles += r.dead_tiles as i64;
            if let Some(ql) = &r.quality {
                c_rsp += q(ql.random_solve_prob);
                c_commit += q(ql.commitment);
                c_optpath += q(ql.optimal_path_fraction);
                c_decision += q(ql.decision);
                c_forced += q(ql.forced_fraction);
                c_spec += q(ql.spectacle);
                c_greedy += ql.greedy_solves as i64;
                c_doom += ql.max_doom_delay as i64;
                c_specreq += ql.spectacle_required as i64;
            }
        }
    }

    let t = Instant::now();
    for _ in 0..reps {
        for lv in &levels {
            let r = solve(lv, &cfg);
            total_states += r.reachable_states as u64;
        }
    }
    let dt = t.elapsed();
    let n = (reps * levels.len()) as f64;
    eprintln!(
        "solved {} boards in {:?}  =  {:.1} us/board · {:.0} solves/s · {:.0} states/board",
        n as u64,
        dt,
        dt.as_secs_f64() * 1e6 / n,
        n / dt.as_secs_f64(),
        total_states as f64 / n,
    );
    eprintln!(
        "CHECKSUMS struct[states={} sol={} deadend={} deadtiles={}]  qual[rsp={} commit={} optpath={} decision={} forced={} spec={} greedy={} doom={} specreq={}]",
        c_states, c_solcount, c_deadend, c_deadtiles,
        c_rsp, c_commit, c_optpath, c_decision, c_forced, c_spec, c_greedy, c_doom, c_specreq
    );
}
