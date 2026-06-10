//! Streaming, resumable level-generation campaign — the "run it for an hour and collect" engine.
//!
//! Worker threads pull seeds from a shared counter, anneal one quality-maximised board per seed
//! (`generate`), gate out anything a thoughtless player could crack, and stream survivors to a
//! coordinator that keeps a bucketed top-K (`topk`). The whole run is a pure function of the seed
//! range, so stopping (Ctrl-C / `--duration`) and resuming loses nothing: we persist the seed
//! cursor + the kept pool and continue.

use crate::difficulty::{self, DifficultyConfig};
use crate::generate::{backbone, generate, mutate, AllowSet, GenOutcome, GenSpec};
use crate::io::LevelRecord;
use crate::model::{Level, Sweep};
use crate::screen;
use crate::solver::{solve, SolveConfig};
use crate::topk::TopK;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// What the seed sampler decides a board is *for* — controls the acceptance gate.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tier {
    /// Small, single-mechanic, intentionally learnable (the first six ladder rungs).
    Tutorial,
    /// Combined mechanics that must genuinely resist trial-and-error.
    Combined,
}

#[derive(Clone, Debug)]
pub struct CampaignCfg {
    pub name: String,
    pub dir: String,
    pub duration_secs: u64,
    pub topk: usize,
    pub iters: usize,
    pub tut_iters: usize,
    pub seed_base: u64,
    pub flush_secs: u64,
    pub threads: usize,
    /// Reject a combined board a random player wins more often than this.
    pub max_random: f64,
    /// Largest board edge the sampler may request (≤ 8 keeps boards playable).
    pub max_size: usize,
    /// Random-player rollouts in the cheap screen (higher = more accurate, slightly slower).
    pub screen_trials: u32,
}

impl Default for CampaignCfg {
    fn default() -> Self {
        CampaignCfg {
            name: "run1".into(),
            dir: "../levels/campaigns/run1".into(),
            duration_secs: 3600,
            topk: 64,
            iters: 140,
            tut_iters: 120,
            seed_base: 1,
            flush_secs: 15,
            threads: 0, // 0 = auto
            max_random: 0.15,
            max_size: 8,
            screen_trials: 48,
        }
    }
}

impl CampaignCfg {
    /// Reject self-contradictory configs before doing any work — e.g. an
    /// acceptance rate outside [0, 1] (which could never admit, or never reject,
    /// a board) or a zero duration/budget that would run forever-or-never.
    pub fn validate(&self) -> Result<(), String> {
        if !(0.0..=1.0).contains(&self.max_random) {
            return Err(format!(
                "max_random must be in [0, 1], got {}",
                self.max_random
            ));
        }
        if self.duration_secs == 0 {
            return Err("duration_secs must be greater than zero".into());
        }
        if self.topk == 0 {
            return Err("topk must be greater than zero".into());
        }
        if self.iters == 0 {
            return Err("iters must be greater than zero".into());
        }
        if self.screen_trials == 0 {
            return Err("screen_trials must be greater than zero".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub name: String,
    pub seed_base: u64,
    pub next_seed: u64,
    pub generated: u64,
    pub kept: u64,
    pub elapsed_secs: u64,
    pub topk: usize,
}

fn manifest_path(dir: &str) -> PathBuf {
    Path::new(dir).join("manifest.json")
}

fn pool_path(dir: &str) -> PathBuf {
    Path::new(dir).join("pool.json")
}

/// Atomic write: serialise to `<path>.tmp` then rename, so a crash never leaves a half file.
fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

pub fn load_manifest(dir: &str) -> Option<Manifest> {
    let text = std::fs::read_to_string(manifest_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn load_pool(dir: &str) -> Vec<LevelRecord> {
    match std::fs::read_to_string(pool_path(dir)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// The campaign deep-solve config: thorough enough to score quality, capped so a pathological
/// explosive board can't pin a worker forever.
fn deep_config() -> SolveConfig {
    SolveConfig {
        max_states: 160_000,
        count_cap: 4_000,
        visit_cap: 800_000,
        store_cap: 40,
        store_buffer: 600,
        enumerate: true,
    }
}

/// Deterministically map a seed to a generation spec + tier. ~18% of seeds are tutorial boards
/// (one per mechanic) so the curator always has clean first-six candidates; the rest are combined
/// boards across a spread of sizes (up to `max_size`) annealed toward high quality.
fn spec_for_seed(seed: u64, cfg: &CampaignCfg) -> (GenSpec, Tier) {
    let bucket = seed % 100;
    if bucket < 18 {
        // Tutorial: tiny board, single mechanic required, low quality target (stays learnable).
        let line = AllowSet {
            line: true,
            ..AllowSet::none()
        };
        let explosive = AllowSet {
            explosive: true,
            ..AllowSet::none()
        };
        let shift = AllowSet {
            shift: true,
            ..AllowSet::none()
        };
        let arrow = AllowSet {
            arrow: true,
            ..AllowSet::none()
        };
        let kinds: [(AllowSet, AllowSet, Option<Sweep>); 6] = [
            (AllowSet::none(), AllowSet::none(), None),
            (line, line, Some(Sweep::Row)),
            (line, line, Some(Sweep::Col)),
            (explosive, explosive, None),
            (shift, shift, None),
            (arrow, arrow, None),
        ];
        let small = [(4, 4), (4, 5), (5, 4), (5, 5), (4, 4), (4, 5)];
        let (allow, require, line_sweep) = kinds[(seed / 100 % 6) as usize];
        let (cols, rows) = small[(seed / 600 % 6) as usize];
        (
            GenSpec {
                cols,
                rows,
                target: 0.1,
                allow,
                require,
                line_sweep,
                seed,
                iters: cfg.tut_iters,
                greens_min: 3,
            },
            Tier::Tutorial,
        )
    } else {
        // Combined: spread of sizes biased toward mid, with a long tail up to `max_size`.
        let sizes: [(usize, usize); 11] = [
            (4, 4),
            (5, 5),
            (5, 6),
            (6, 5),
            (6, 6),
            (6, 7),
            (7, 6),
            (7, 7),
            (7, 8),
            (8, 7),
            (8, 8),
        ];
        // Keep only sizes within the requested cap.
        let allowed: Vec<(usize, usize)> = sizes
            .iter()
            .copied()
            .filter(|&(c, r)| c.max(r) <= cfg.max_size)
            .collect();
        let (cols, rows) = allowed[(seed / 100 % allowed.len() as u64) as usize];
        // Target sweeps the upper quality range so the anneal pushes toward genuine hardness.
        let t = (seed / 7 % 1000) as f64 / 1000.0;
        let target = 0.6 + 0.35 * t;
        (
            GenSpec {
                cols,
                rows,
                target,
                allow: AllowSet::all(),
                require: AllowSet::none(),
                line_sweep: None,
                seed,
                iters: cfg.iters,
                greens_min: 4,
            },
            Tier::Combined,
        )
    }
}

/// The most specials a board may carry: ≤ 30% of standing tiles, but always at least 2 so a shift
/// pair fits on a small board. Keeps every board "mostly green" (Rule 3).
fn max_specials(level: &Level) -> u32 {
    (level.tile_count() * 30 / 100).max(2)
}

/// A combined board must expose at least this many reachable states; below it the
/// puzzle is too small to demand a plan. The cheap screen pre-checks this bar and
/// the deep solve confirms it, so both call sites share the constant.
const MIN_REACHABLE_STATES: u32 = 150;
/// ...and its shortest solution must run at least this many moves.
const MIN_SOLUTION_LEN: u32 = 5;

/// Does this annealed board clear the acceptance bar for its tier?
fn passes_gate(tier: Tier, rec: &LevelRecord, cfg: &CampaignCfg) -> bool {
    match tier {
        // Tutorial boards are *meant* to be learnable; only require they be solvable + sized.
        Tier::Tutorial => rec.difficulty.is_some(),
        Tier::Combined => {
            let greedy = rec.greedy_solves.unwrap_or(true);
            let rsp = rec.random_solve_prob.unwrap_or(1.0);
            !greedy
                && rsp <= cfg.max_random
                && rec.reachable_states >= MIN_REACHABLE_STATES
                && rec.solutions.first().map(|s| s.len()).unwrap_or(0) >= MIN_SOLUTION_LEN as usize
        }
    }
}

/// Generate + gate one seed; `Some(record)` if it's worth keeping.
///
/// Two paths: tutorial seeds *anneal* a small board (the require-penalty reliably forces the lone
/// mechanic in, and tiny boards are cheap). Combined seeds use the fast **two-tier** path — build a
/// random board, kill it cheaply at the screen (`screen.rs`) if a thoughtless player cracks it, and
/// only pay for a full deep solve on survivors. That's what makes hundreds of thousands/hour viable.
fn try_seed(
    seed: u64,
    cfg: &CampaignCfg,
    dcfg: &DifficultyConfig,
    scfg: &SolveConfig,
) -> Option<LevelRecord> {
    let (spec, tier) = spec_for_seed(seed, cfg);
    match tier {
        Tier::Tutorial => {
            let outcome = generate(&spec, dcfg, scfg)?;
            // Keep tutorials mostly green too: allow only the minimal mechanic (a shift pair needs
            // 2), so a tutorial is a field of greens with one teaching instance of its tile.
            if outcome.level.special_count() > max_specials(&outcome.level) {
                return None;
            }
            // Must have a landable green so a résumé info tile can be placed + reached.
            if !outcome.result.rests_on_green {
                return None;
            }
            let rec = outcome.to_record();
            passes_gate(tier, &rec, cfg).then_some(rec)
        }
        Tier::Combined => {
            // Tier 0: a random board — backbone ring + a burst of mutations (specials, pits, greens).
            let mut rng = ChaCha8Rng::seed_from_u64(seed ^ 0x9E37_79B9_7F4A_7C15);
            let mut level = backbone(&spec, &mut rng)?;
            let cells = level.cells.len();
            let nmut = rng.gen_range(3..=(cells / 2).max(4));
            for _ in 0..nmut {
                if let Some(m) = mutate(&level, &spec, &mut rng) {
                    level = m;
                }
            }
            // Rule 3 — mostly green: specials must stay a minority (≤ 30% of standing tiles).
            if level.special_count() > max_specials(&level) {
                return None;
            }
            // No useless specials: a line must have a green in its line, a mine a green neighbour.
            if level.useless_special_count() > 0 {
                return None;
            }
            // Tier 1: cheap screen — rejects trivial / unsolvable / too-small boards without a deep solve.
            screen::screen(
                &level,
                cfg.screen_trials,
                cfg.max_random,
                MIN_REACHABLE_STATES,
                MIN_SOLUTION_LEN,
                &mut rng,
            )?;
            // Tier 2: full solve + quality, only for survivors.
            let res = solve(&level, scfg);
            // Only keep boards we fully analysed — otherwise dead_tiles / quality aren't trustworthy
            // (a capped solve can't prove a tile is reachable).
            if !res.exact {
                return None;
            }
            // Rule 1 — no useless tiles: every standing tile must be reachable or cleared in play.
            if res.dead_tiles > 0 {
                return None;
            }
            // Must have a landable green (so a résumé info tile, if placed here, can be reached).
            if !res.rests_on_green {
                return None;
            }
            let diff = difficulty::score(&res, dcfg)?;
            let outcome = GenOutcome {
                level,
                result: res,
                difficulty: diff,
                seed,
                target: spec.target,
                allow: spec.allow,
            };
            let rec = outcome.to_record();
            passes_gate(tier, &rec, cfg).then_some(rec)
        }
    }
}

fn flush(dir: &str, topk: &TopK, manifest: &Manifest) {
    let pool = topk.all();
    if let Ok(json) = serde_json::to_string(&pool) {
        let _ = write_atomic(&pool_path(dir), &json);
    }
    if let Ok(json) = serde_json::to_string_pretty(manifest) {
        let _ = write_atomic(&manifest_path(dir), &json);
    }
}

fn fmt_hms(secs: u64) -> String {
    format!(
        "{:02}:{:02}:{:02}",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

/// Run (or resume) a campaign until its duration elapses or Ctrl-C is pressed.
pub fn run(mut cfg: CampaignCfg, resume: bool) {
    if let Err(e) = cfg.validate() {
        eprintln!("error: invalid campaign config: {e}");
        std::process::exit(2);
    }
    std::fs::create_dir_all(&cfg.dir).expect("create campaign dir");

    // Resume: pick up the seed cursor + the already-kept pool.
    let (start_seed, prior_generated, mut topk) = if resume {
        match load_manifest(&cfg.dir) {
            Some(m) => {
                println!(
                    "Resuming campaign '{}' from seed {} ({} kept, {} generated so far).",
                    m.name, m.next_seed, m.kept, m.generated
                );
                cfg.topk = m.topk;
                (
                    m.next_seed,
                    m.generated,
                    TopK::from_records(load_pool(&cfg.dir), m.topk),
                )
            }
            None => {
                eprintln!("--resume: no manifest in {} — starting fresh.", cfg.dir);
                (cfg.seed_base, 0, TopK::new(cfg.topk))
            }
        }
    } else {
        (cfg.seed_base, 0, TopK::new(cfg.topk))
    };

    let n_threads = if cfg.threads == 0 {
        std::thread::available_parallelism()
            .map(|n| n.get().saturating_sub(1).max(1))
            .unwrap_or(4)
    } else {
        cfg.threads
    };

    let stop = Arc::new(AtomicBool::new(false));
    let counter = Arc::new(AtomicU64::new(start_seed));
    let generated = Arc::new(AtomicU64::new(0));

    // Ctrl-C requests a clean stop (final flush happens below).
    {
        let stop = stop.clone();
        let _ = ctrlc::set_handler(move || {
            eprintln!("\nStopping campaign (finishing in-flight boards, flushing)…");
            stop.store(true, Ordering::SeqCst);
        });
    }

    let (tx, rx) = mpsc::channel::<LevelRecord>();
    let cfg = Arc::new(cfg);
    let dcfg = DifficultyConfig::default();
    let scfg = deep_config();

    println!(
        "Campaign '{}' · {} threads · {} · topk={} · sizes ≤ {}×{}",
        cfg.name,
        n_threads,
        fmt_hms(cfg.duration_secs),
        cfg.topk,
        cfg.max_size,
        cfg.max_size
    );

    let start = Instant::now();
    let mut handles = Vec::new();
    for _ in 0..n_threads {
        let stop = stop.clone();
        let counter = counter.clone();
        let generated = generated.clone();
        let cfg = cfg.clone();
        let dcfg = dcfg.clone();
        let scfg = scfg.clone();
        let tx = tx.clone();
        handles.push(std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let seed = counter.fetch_add(1, Ordering::Relaxed);
                let kept = try_seed(seed, &cfg, &dcfg, &scfg);
                generated.fetch_add(1, Ordering::Relaxed);
                if let Some(rec) = kept {
                    if tx.send(rec).is_err() {
                        break;
                    }
                }
            }
        }));
    }
    drop(tx); // workers hold their own clones; this lets recv end after they exit

    // Coordinator: collect survivors, flush periodically, watch the clock.
    let mk = |next_seed: u64, gen_total: u64, kept: u64| Manifest {
        name: cfg.name.clone(),
        seed_base: cfg.seed_base,
        next_seed,
        generated: gen_total,
        kept,
        elapsed_secs: start.elapsed().as_secs(),
        topk: cfg.topk,
    };
    let mut last_flush = Instant::now();

    loop {
        match rx.recv_timeout(Duration::from_millis(400)) {
            Ok(rec) => topk.offer(rec),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        let elapsed = start.elapsed().as_secs();
        if elapsed >= cfg.duration_secs {
            stop.store(true, Ordering::SeqCst);
        }

        if last_flush.elapsed().as_secs() >= cfg.flush_secs {
            let gen_total = prior_generated + generated.load(Ordering::Relaxed);
            let next_seed = counter.load(Ordering::Relaxed);
            flush(
                &cfg.dir,
                &topk,
                &mk(next_seed, gen_total, topk.len() as u64),
            );
            let rate = if elapsed > 0 {
                gen_total as f64 / elapsed as f64
            } else {
                0.0
            };
            println!(
                "[t={}] generated {} ({:.0}/s) · kept {} · buckets {}",
                fmt_hms(elapsed),
                gen_total,
                rate,
                topk.len(),
                topk.summary().len()
            );
            last_flush = Instant::now();
        }
    }

    for h in handles {
        let _ = h.join();
    }

    // Final flush with the true cursor.
    let gen_total = prior_generated + generated.load(Ordering::Relaxed);
    let next_seed = counter.load(Ordering::Relaxed);
    flush(
        &cfg.dir,
        &topk,
        &mk(next_seed, gen_total, topk.len() as u64),
    );

    println!(
        "\nCampaign '{}' done: generated {}, kept {} → {}",
        cfg.name,
        gen_total,
        topk.len(),
        pool_path(&cfg.dir).display()
    );
    print_top_buckets(&topk);
}

fn print_top_buckets(topk: &TopK) {
    let rows = topk.summary();
    println!("Top buckets by best quality:");
    for (key, count, best) in rows.into_iter().take(12) {
        println!("  {:<28} n={:<3} best={:.3}", key, count, best);
    }
}

/// One-shot status read of a (running or stopped) campaign's manifest.
pub fn status(dir: &str) {
    match load_manifest(dir) {
        Some(m) => {
            let pool = load_pool(dir);
            println!("Campaign '{}' @ {}", m.name, dir);
            println!(
                "  next_seed={} generated={} kept={} elapsed={}",
                m.next_seed,
                m.generated,
                m.kept,
                fmt_hms(m.elapsed_secs)
            );
            let topk = TopK::from_records(pool, m.topk);
            print_top_buckets(&topk);
        }
        None => eprintln!("No manifest found in {}", dir),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_valid() {
        assert!(CampaignCfg::default().validate().is_ok());
    }

    #[test]
    fn rejects_out_of_range_max_random() {
        let bad = CampaignCfg {
            max_random: 1.5,
            ..CampaignCfg::default()
        };
        assert!(bad.validate().is_err());
        let neg = CampaignCfg {
            max_random: -0.1,
            ..CampaignCfg::default()
        };
        assert!(neg.validate().is_err());
    }

    #[test]
    fn rejects_zero_budgets() {
        for cfg in [
            CampaignCfg {
                duration_secs: 0,
                ..CampaignCfg::default()
            },
            CampaignCfg {
                topk: 0,
                ..CampaignCfg::default()
            },
            CampaignCfg {
                iters: 0,
                ..CampaignCfg::default()
            },
            CampaignCfg {
                screen_trials: 0,
                ..CampaignCfg::default()
            },
        ] {
            assert!(cfg.validate().is_err());
        }
    }
}
