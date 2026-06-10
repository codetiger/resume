//! Band-equality check: solve every board in a pool with the CURRENT code and compare the computed
//! difficulty band to the `band` the pool was generated with. Zero mismatches ⇒ no ladder drift.
//!
//!   cargo run --release --example check_bands -- ../levels/campaigns/<name>/pool.json

use level_gen::difficulty::{band, DifficultyConfig};
use level_gen::io::parse_layout;
use level_gen::solver::{solve, SolveConfig};

fn deep() -> SolveConfig {
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
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "../levels/campaigns/speedtest/pool.json".to_string());
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let cfg = deep();
    let dcfg = DifficultyConfig::default();
    let (mut checked, mut mismatch) = (0u32, 0u32);
    for rec in v.as_array().unwrap() {
        let layout: Vec<String> = rec["layout"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        let stored = rec["band"].as_str().unwrap_or("?");
        let lv = match parse_layout(&layout) {
            Ok(l) => l,
            Err(_) => continue,
        };
        let r = solve(&lv, &cfg);
        let now = band(&r, &dcfg);
        checked += 1;
        if now != stored {
            mismatch += 1;
            if mismatch <= 10 {
                eprintln!(
                    "  MISMATCH seed={} stored={} now={}",
                    rec["seed"], stored, now
                );
            }
        }
    }
    eprintln!("checked {} boards · {} band mismatches", checked, mismatch);
}
