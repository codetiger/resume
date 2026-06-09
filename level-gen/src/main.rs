//! CLI entry point: `solve`, `selftest`, `gen` (single or `--batch`), and `curate`.

use clap::{Parser, Subcommand};
use level_gen::campaign::{self, CampaignCfg};
use level_gen::curate::{self};
use level_gen::difficulty::{self, DifficultyConfig};
use level_gen::generate::{generate, AllowSet, GenSpec};
use level_gen::io::{encode_layout, parse_game_levels, parse_layout, LevelRecord};
use level_gen::model::{Direction, Level, TileKind};
use level_gen::solver::{solve, solve_default, SolveConfig, SolveResult};
use level_gen::topk;
use rayon::prelude::*;
use std::path::Path;

// The campaign workload is allocator-bound: millions of solves each churn a fresh state
// map + per-state adjacency Vecs (profile shows ~40-50% of self-time in the system malloc).
// mimalloc is far faster for small-object churn and scales better across the rayon workers.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(name = "level-gen", about = "Solver / generator / curator for the rolling-cube game")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Solve a board (JSON file with a `layout` array) and print raw data + difficulty.
    Solve { path: String },
    /// Run solver self-tests: DEMO_LAYOUT + every board in src/game/levels.json.
    Selftest,
    /// Generate one board (or a `--batch`) and write JSON records to `--out`.
    Gen {
        #[arg(long, default_value_t = 5)]
        cols: usize,
        #[arg(long, default_value_t = 5)]
        rows: usize,
        #[arg(long, default_value_t = 0.4)]
        difficulty: f64,
        /// Comma-separated allowed tiles, e.g. `n,arrow,shift,line,explosive`.
        #[arg(long, default_value = "n,arrow,shift,line,explosive")]
        allow: String,
        #[arg(long, default_value_t = 1)]
        seed: u64,
        #[arg(long, default_value_t = 600)]
        iters: usize,
        /// Generate this many boards across a spread of sizes / tile-sets / targets instead of one.
        #[arg(long)]
        batch: Option<usize>,
        /// Batch profile: `ramp` (default) or `spread` (large pool tuned for initial-32 curation).
        #[arg(long, default_value = "ramp")]
        profile: String,
        #[arg(long, default_value = "../levels")]
        out: String,
    },
    /// Curate a pool of generated boards into a ladder.
    Curate {
        #[arg(default_value = "../levels")]
        dir: String,
        #[arg(long, default_value = "../levels/ladder.json")]
        out: String,
        /// Cap the ladder length (tutorial block + an evenly difficulty-spaced ramp).
        #[arg(long)]
        count: Option<usize>,
        /// Selection profile: `ramp` (default even-spaced), `initial32`, or `initial64` (6 tutorial + steep ramp).
        #[arg(long, default_value = "ramp")]
        profile: String,
        /// Read the pool from a campaign (`<root>/<name>/pool.json`) instead of `dir`.
        #[arg(long)]
        from_campaign: Option<String>,
        #[arg(long, default_value = "../levels/campaigns")]
        root: String,
    },
    /// Run (or resume) a streaming generation campaign that collects the best boards over time.
    Campaign {
        #[arg(long, default_value = "run1")]
        name: String,
        #[arg(long, default_value = "../levels/campaigns")]
        root: String,
        /// Wall-clock budget, e.g. `60m`, `1h`, `3600s`, or a bare number of seconds.
        #[arg(long, default_value = "60m")]
        duration: String,
        #[arg(long, default_value_t = 0)]
        threads: usize,
        /// Best boards kept per (size × mechanic × band) bucket.
        #[arg(long, default_value_t = 64)]
        topk: usize,
        /// Annealing iterations per combined board.
        #[arg(long, default_value_t = 140)]
        iters: usize,
        #[arg(long, default_value_t = 1)]
        seed_base: u64,
        /// Largest board edge the sampler may request (≤ 8 keeps boards playable).
        #[arg(long, default_value_t = 8)]
        max_size: usize,
        /// Reject a combined board a random player wins more often than this.
        #[arg(long, default_value_t = 0.15)]
        max_random: f64,
        /// Resume from an existing campaign directory.
        #[arg(long)]
        resume: bool,
    },
    /// Print a campaign's manifest + best buckets.
    CampaignStatus {
        #[arg(long, default_value = "run1")]
        name: String,
        #[arg(long, default_value = "../levels/campaigns")]
        root: String,
    },
    /// Write a browsable, per-bucket ranked report (markdown) from a campaign pool.
    Rank {
        #[arg(long, default_value = "run1")]
        name: String,
        #[arg(long, default_value = "../levels/campaigns")]
        root: String,
        #[arg(long, default_value = "../levels/report.md")]
        out: String,
        /// Boards to show per bucket.
        #[arg(long, default_value_t = 8)]
        per_bucket: usize,
    },
}

/// Parse a duration string (`60m`, `1h`, `3600s`, or bare seconds) into seconds.
fn parse_duration(s: &str) -> u64 {
    let s = s.trim();
    let (num, mult) = if let Some(n) = s.strip_suffix('h') {
        (n, 3600)
    } else if let Some(n) = s.strip_suffix('m') {
        (n, 60)
    } else if let Some(n) = s.strip_suffix('s') {
        (n, 1)
    } else {
        (s, 1)
    };
    num.trim().parse::<u64>().unwrap_or(0).saturating_mul(mult)
}

/// DEMO_LAYOUT from `src/game/grid.ts` (the lone arrow is overridden to slide "back").
fn demo_level() -> Level {
    let mut level = parse_layout(
        &["nrxnn", "nctnn", "nbnna", "nntnn", "nrncn"]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let i = level.idx(4, 2); // DEMO_LAYOUT[row=2][col=4].dir = 'back'
    level.cells[i] = Some(TileKind::Arrow(Direction::Back));
    level
}

fn print_report(name: &str, level: &Level, r: &SolveResult) {
    let dcfg = DifficultyConfig::default();
    let d = difficulty::score(r, &dcfg);
    println!("── {} ({}×{}) ──", name, level.cols, level.rows);
    for row in encode_layout(level) {
        println!("   {}", row);
    }
    println!(
        "   solvable={} shortest={:?} solutions={} reachable={} deadEnds={} exact={}",
        r.solvable, r.shortest_path, r.solution_count, r.reachable_states, r.dead_end_states, r.exact
    );
    println!(
        "   greens={} specials={} deadTiles={} unpairedShifts={} landsOnInfo={}",
        level.green_count(),
        level.special_count(),
        r.dead_tiles,
        level.unpaired_shift_count(),
        r.lands_on_info,
    );
    println!(
        "   difficulty={} band={}",
        d.map(|x| format!("{:.3}", x)).unwrap_or_else(|| "—".into()),
        difficulty::band(r, &dcfg)
    );
    if let Some(b) = difficulty::breakdown(r, &dcfg) {
        println!(
            "   resist={:.2} plan={:.2} uniq={:.2} branch={:.2} spectacle={:.2}",
            b.resistance, b.planning, b.uniqueness, b.branching, b.spectacle
        );
    }
    if let Some(q) = &r.quality {
        println!(
            "   randomSolve={:.4} greedySolves={} commitment={:.2} doomDelay={} specReq={}",
            q.random_solve_prob, q.greedy_solves, q.commitment, q.max_doom_delay, q.spectacle_required
        );
    }
    if !r.solutions.is_empty() {
        let sample: Vec<&String> = r.solutions.iter().take(4).collect();
        println!("   e.g. {:?}", sample);
    }
}

/// Solve a level with the full config and assemble its JSON record.
fn record_for(level: &Level, name: String, seed: u64, target: f64, allow: &AllowSet) -> LevelRecord {
    let r = solve_default(level);
    let dcfg = DifficultyConfig::default();
    let diff = difficulty::score(&r, &dcfg);
    LevelRecord {
        name,
        seed,
        layout: encode_layout(level),
        request: Some(level_gen::io::GenRequest {
            target_difficulty: target,
            allow: allow.to_tokens(),
            cols: level.cols,
            rows: level.rows,
        }),
        solutions: r.solutions.clone(),
        solution_count: r.solution_count,
        reachable_states: r.reachable_states,
        dead_end_states: r.dead_end_states,
        difficulty: diff,
        band: difficulty::band(&r, &dcfg).to_string(),
        exact: r.exact,
        ..Default::default()
    }
    .with_quality(r.quality.as_ref())
}

fn write_record(out_dir: &str, rec: &LevelRecord) -> std::io::Result<()> {
    std::fs::create_dir_all(out_dir)?;
    let path = Path::new(out_dir).join(format!("{}.json", rec.name));
    let json = serde_json::to_string_pretty(rec).unwrap();
    std::fs::write(path, json)
}

/// A lighter solver config for the annealing inner loop (kept fast).
fn sa_solve_config() -> SolveConfig {
    SolveConfig {
        max_states: 80_000,
        count_cap: 4_000,
        visit_cap: 400_000,
        store_cap: 40,
        store_buffer: 600,
        enumerate: true,
    }
}

fn cmd_solve(path: &str) {
    let text = std::fs::read_to_string(path).expect("read input file");
    let v: serde_json::Value = serde_json::from_str(&text).expect("parse JSON");
    let layout: Vec<String> = v["layout"]
        .as_array()
        .expect("`layout` array")
        .iter()
        .map(|x| x.as_str().expect("layout row is a string").to_string())
        .collect();
    let level = parse_layout(&layout).expect("parse layout");
    let r = solve(&level, &SolveConfig::default());
    print_report(path, &level, &r);
}

/// Plan a batch. First ~half are small, single-mechanic, low-difficulty boards (each *requires*
/// its mechanic) so the curator's tutorial block has clean candidates; the rest are larger combined
/// boards whose targets sweep the difficulty range to feed the ramp.
fn batch_specs(n: usize, base_seed: u64, iters: usize) -> Vec<GenSpec> {
    // (allow, require) pairs for the single-mechanic tutorial boards.
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
    let tutorial: [(AllowSet, AllowSet); 5] = [
        (AllowSet::none(), AllowSet::none()), // movement only
        (line, line),
        (explosive, explosive),
        (shift, shift),
        (arrow, arrow),
    ];
    let small_sizes = [(4, 4), (4, 5), (5, 4), (5, 5)];
    let big_sizes = [(5, 5), (5, 6), (6, 5), (6, 6)];

    let tutorial_n = (n / 2).max(tutorial.len() * 2);
    (0..n)
        .map(|i| {
            let seed = base_seed.wrapping_add(i as u64);
            if i < tutorial_n {
                let (allow, require) = tutorial[i % tutorial.len()];
                let (cols, rows) = small_sizes[(i / tutorial.len()) % small_sizes.len()];
                // Low target; the require-penalty still forces the mechanic in.
                let target = 0.12 + 0.06 * ((i / tutorial.len()) % 3) as f64;
                GenSpec {
                    cols,
                    rows,
                    target,
                    allow,
                    require,
                    line_sweep: None,
                    seed,
                    iters,
                    greens_min: 3,
                }
            } else {
                let j = i - tutorial_n;
                let (cols, rows) = big_sizes[j % big_sizes.len()];
                let span = (n - tutorial_n).max(1);
                let target = (0.25 + 0.6 * (j as f64 / span as f64)).clamp(0.2, 0.9);
                GenSpec {
                    cols,
                    rows,
                    target,
                    allow: AllowSet::all(),
                    require: AllowSet::none(),
                    line_sweep: None,
                    seed,
                    iters,
                    greens_min: 4,
                }
            }
        })
        .collect()
}

/// The "spread" profile: a large pool tuned for the initial-32 curation. Three sub-pools —
/// minimal single-tile-type tutorial boards (incl. pure row/col lines), a mid range, and a
/// targeted very-hard tail — so every percentile band is well populated.
fn spread_specs(n: usize, base_seed: u64, iters: usize) -> Vec<GenSpec> {
    use level_gen::model::Sweep;
    let mut specs: Vec<GenSpec> = Vec::with_capacity(n);

    // Tutorial sub-pool (~40%): tiny boards, one tile type each, low target, mechanic required.
    let line = AllowSet { line: true, ..AllowSet::none() };
    let explosive = AllowSet { explosive: true, ..AllowSet::none() };
    let shift = AllowSet { shift: true, ..AllowSet::none() };
    let arrow = AllowSet { arrow: true, ..AllowSet::none() };
    // (allow, require, line_sweep)
    let kinds: [(AllowSet, AllowSet, Option<Sweep>); 6] = [
        (AllowSet::none(), AllowSet::none(), None),     // movement
        (line, line, Some(Sweep::Row)),                 // pure row line
        (line, line, Some(Sweep::Col)),                 // pure col line
        (explosive, explosive, None),
        (shift, shift, None),
        (arrow, arrow, None),
    ];
    let small_sizes = [(3, 3), (4, 3), (3, 4), (4, 4)];
    let tut_n = (n * 2) / 5;
    for i in 0..tut_n {
        let (allow, require, line_sweep) = kinds[i % kinds.len()];
        let (cols, rows) = small_sizes[(i / kinds.len()) % small_sizes.len()];
        specs.push(GenSpec {
            cols,
            rows,
            target: 0.08,
            allow,
            require,
            line_sweep,
            seed: base_seed.wrapping_add(i as u64),
            iters,
            greens_min: 3,
        });
    }

    // Mid + hard sub-pools (~60%): combined mechanics, targets sweeping into the hard tail.
    let mid_sizes = [(4, 4), (5, 4), (4, 5), (5, 5), (5, 6), (6, 5), (6, 6)];
    for i in tut_n..n {
        let j = i - tut_n;
        let frac = j as f64 / (n - tut_n).max(1) as f64;
        // Bias the back third toward large boards + very-hard targets to stock the top band.
        let hard = frac > 0.66;
        let (cols, rows) = if hard {
            [(5, 6), (6, 5), (6, 6)][j % 3]
        } else {
            mid_sizes[j % mid_sizes.len()]
        };
        let target = if hard {
            (0.78 + 0.18 * ((frac - 0.66) / 0.34)).clamp(0.7, 0.96)
        } else {
            (0.2 + 0.6 * (frac / 0.66)).clamp(0.18, 0.8)
        };
        specs.push(GenSpec {
            cols,
            rows,
            target,
            allow: AllowSet::all(),
            require: AllowSet::none(),
            line_sweep: None,
            seed: base_seed.wrapping_add(i as u64),
            iters,
            greens_min: 4,
        });
    }
    specs
}

/// Generate one board from a spec and return its fully-solved record (stable name included).
fn generate_record(
    spec: &GenSpec,
    dcfg: &DifficultyConfig,
    scfg: &SolveConfig,
) -> Option<LevelRecord> {
    let outcome = generate(spec, dcfg, scfg)?;
    let rec = record_for(&outcome.level, String::new(), spec.seed, spec.target, &spec.allow);
    let name = format!(
        "gen-{}x{}-{}-s{}",
        outcome.level.cols, outcome.level.rows, rec.band, spec.seed
    );
    Some(LevelRecord { name, ..rec })
}

fn cmd_gen(
    cols: usize,
    rows: usize,
    difficulty_target: f64,
    allow_str: &str,
    seed: u64,
    iters: usize,
    batch: Option<usize>,
    profile: &str,
    out: &str,
) {
    let dcfg = DifficultyConfig::default();
    let scfg = sa_solve_config();

    let specs: Vec<GenSpec> = match batch {
        Some(n) => match profile {
            "spread" => spread_specs(n, seed, iters),
            _ => batch_specs(n, seed, iters),
        },
        None => {
            let allow = AllowSet::from_tokens(
                &allow_str.split(',').map(|s| s.trim().to_string()).collect::<Vec<_>>(),
            );
            vec![GenSpec {
                cols,
                rows,
                target: difficulty_target,
                allow,
                require: AllowSet::none(),
                line_sweep: None,
                seed,
                iters,
                greens_min: 4,
            }]
        }
    };

    let total = specs.len();
    println!("Generating {} boards (profile={}) across {} cores…", total, profile, rayon::current_num_threads());

    // Generation is pure per seed → run the whole batch in parallel; collect preserves order.
    let records: Vec<LevelRecord> = specs
        .par_iter()
        .filter_map(|spec| generate_record(spec, &dcfg, &scfg))
        .collect();

    let mut written = 0;
    let mut bands = std::collections::BTreeMap::<String, usize>::new();
    for rec in &records {
        if write_record(out, rec).is_ok() {
            written += 1;
            *bands.entry(rec.band.clone()).or_insert(0) += 1;
        }
    }

    if total == 1 {
        if let Some(rec) = records.first() {
            let level = parse_layout(&rec.layout).unwrap();
            print_report(&rec.name, &level, &solve_default(&level));
        } else {
            eprintln!("seed {} produced no solvable board", seed);
        }
    }
    println!("\nWrote {}/{} boards to {}/", written, total, out);
    if !bands.is_empty() {
        println!("Bands: {:?}", bands);
    }
}

fn load_pool(dir: &str, out: &str, from_campaign: Option<&str>, root: &str) -> Vec<LevelRecord> {
    if let Some(name) = from_campaign {
        let cdir = format!("{}/{}", root, name);
        let pool = campaign::load_pool(&cdir);
        println!("Loaded {} boards from campaign {}/pool.json", pool.len(), cdir);
        return pool;
    }
    let mut pool: Vec<LevelRecord> = Vec::new();
    let out_name = Path::new(out).file_name().and_then(|x| x.to_str());
    let entries = std::fs::read_dir(dir).expect("read pool dir");
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        // Don't fold a previously-written ladder back into the pool.
        let fname = path.file_name().and_then(|x| x.to_str());
        if fname == Some("ladder.json") || fname == out_name {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(rec) = serde_json::from_str::<LevelRecord>(&text) {
                pool.push(rec);
            }
        }
    }
    println!("Loaded {} boards from {}/", pool.len(), dir);
    pool
}

fn cmd_curate(dir: &str, out: &str, count: Option<usize>, profile: &str, from_campaign: Option<&str>, root: &str) {
    let pool = load_pool(dir, out, from_campaign, root);
    let ladder = match profile {
        "initial32" => curate::curate_initial(&pool),
        "initial64" => curate::curate_initial_n(&pool, 64),
        _ => curate::curate(&pool, count),
    };
    let json = serde_json::to_string_pretty(&ladder).unwrap();
    std::fs::write(out, json).expect("write ladder");
    println!("Curated ladder of {} levels → {}", ladder.levels.len(), out);
    for l in &ladder.levels {
        let tut = curate::tutorial_type_of(&l.layout);
        println!(
            "  {:>2}. {:<26} band={:<7} diff={}  {}",
            l.number,
            l.name,
            l.band,
            l.difficulty.map(|x| format!("{:.2}", x)).unwrap_or_default(),
            tut.map(|t| format!("[{:?}]", t)).unwrap_or_default(),
        );
    }
}

fn cmd_campaign(
    name: &str,
    root: &str,
    duration: &str,
    threads: usize,
    topk: usize,
    iters: usize,
    seed_base: u64,
    max_size: usize,
    max_random: f64,
    resume: bool,
) {
    let cfg = CampaignCfg {
        name: name.to_string(),
        dir: format!("{}/{}", root, name),
        duration_secs: parse_duration(duration),
        topk,
        iters,
        tut_iters: 120,
        seed_base,
        flush_secs: 15,
        threads,
        max_random,
        max_size,
        screen_trials: 48,
    };
    campaign::run(cfg, resume);
}

/// Write a per-bucket markdown leaderboard (with ASCII board art) for eyeballing campaign picks.
fn cmd_rank(name: &str, root: &str, out: &str, per_bucket: usize) {
    use std::cmp::Ordering::Equal;
    use std::collections::BTreeMap;
    let cdir = format!("{}/{}", root, name);
    let pool = campaign::load_pool(&cdir);
    if pool.is_empty() {
        eprintln!("Empty / missing pool at {}/pool.json", cdir);
        return;
    }
    let mut buckets: BTreeMap<String, Vec<&LevelRecord>> = BTreeMap::new();
    for r in &pool {
        buckets.entry(topk::bucket_key(r)).or_default().push(r);
    }
    let mut keys: Vec<(String, f64)> = buckets
        .iter()
        .map(|(k, v)| {
            let best = v.iter().filter_map(|r| r.difficulty).fold(f64::NEG_INFINITY, f64::max);
            (k.clone(), best)
        })
        .collect();
    keys.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Equal));

    let mut md = String::new();
    md.push_str(&format!(
        "# Level campaign report — {}\n\n{} boards across {} buckets, ranked by quality.\n\n",
        name,
        pool.len(),
        buckets.len()
    ));
    for (key, best) in &keys {
        let mut v = buckets[key].clone();
        v.sort_by(|a, b| b.difficulty.partial_cmp(&a.difficulty).unwrap_or(Equal));
        md.push_str(&format!("## {} — best {:.3} ({} boards)\n\n", key, best, v.len()));
        for r in v.iter().take(per_bucket) {
            md.push_str(&format!(
                "- **{}** · quality {:.3} · randomSolve {:.4} · shortest {} · solutions {} · states {} · doomDelay {} · specReq {}\n",
                r.name,
                r.difficulty.unwrap_or(0.0),
                r.random_solve_prob.unwrap_or(1.0),
                r.solutions.first().map(|s| s.len()).unwrap_or(0),
                r.solution_count,
                r.reachable_states,
                r.max_doom_delay.unwrap_or(0),
                r.spectacle_required.unwrap_or(false),
            ));
            md.push_str("\n```\n");
            for row in &r.layout {
                md.push_str(row);
                md.push('\n');
            }
            md.push_str("```\n\n");
        }
    }
    std::fs::write(out, md).expect("write report");
    println!("Wrote ranked report ({} buckets) → {}", buckets.len(), out);
}

fn cmd_selftest() {
    let mut failures = 0;
    let demo = demo_level();
    let r = solve_default(&demo);
    print_report("DEMO_LAYOUT", &demo, &r);

    let levels_json = include_str!("../../src/game/levels.json");
    let games = parse_game_levels(levels_json).expect("parse levels.json");
    println!("\nChecking {} shipped levels…", games.len());
    for g in &games {
        let level = match parse_layout(&g.layout) {
            Ok(l) => l,
            Err(e) => {
                println!("  ✗ {:<18} parse error: {}", g.name, e);
                failures += 1;
                continue;
            }
        };
        let r = solve_default(&level);
        let dead = r.dead_tiles;
        let unpaired = level.unpaired_shift_count();
        let useless = level.useless_special_count();
        let mut flags: Vec<String> = Vec::new();
        if !r.solvable {
            flags.push("UNSOLVABLE".into());
        }
        if dead > 0 {
            flags.push(format!("{} DEAD-TILES", dead));
        }
        if unpaired > 0 {
            flags.push(format!("{} UNPAIRED-SHIFT", unpaired));
        }
        if useless > 0 {
            flags.push(format!("{} USELESS-SPECIAL", useless));
        }
        let status = if flags.is_empty() { "✓".to_string() } else { format!("✗ {}", flags.join(", ")) };
        if !flags.is_empty() {
            failures += 1;
        }
        let dcfg = DifficultyConfig::default();
        let d = difficulty::score(&r, &dcfg);
        let rsp = r
            .quality
            .as_ref()
            .map(|q| format!("{:.3}", q.random_solve_prob))
            .unwrap_or_else(|| "—".into());
        println!(
            "  {} {:<18} grn={:<2} spc={:<2} L={:<3?} states={:<6} rndSolve={:<6} diff={} band={}",
            status,
            g.name,
            level.green_count(),
            level.special_count(),
            r.shortest_path,
            r.reachable_states,
            rsp,
            d.map(|x| format!("{:.2}", x)).unwrap_or_else(|| "—".into()),
            difficulty::band(&r, &dcfg),
        );
    }

    if failures == 0 {
        println!("\nAll self-tests passed.");
    } else {
        eprintln!("\n{} self-test failure(s).", failures);
        std::process::exit(1);
    }
}

fn main() {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Solve { path } => cmd_solve(&path),
        Cmd::Selftest => cmd_selftest(),
        Cmd::Gen {
            cols,
            rows,
            difficulty,
            allow,
            seed,
            iters,
            batch,
            profile,
            out,
        } => cmd_gen(cols, rows, difficulty, &allow, seed, iters, batch, &profile, &out),
        Cmd::Curate {
            dir,
            out,
            count,
            profile,
            from_campaign,
            root,
        } => cmd_curate(&dir, &out, count, &profile, from_campaign.as_deref(), &root),
        Cmd::Campaign {
            name,
            root,
            duration,
            threads,
            topk,
            iters,
            seed_base,
            max_size,
            max_random,
            resume,
        } => cmd_campaign(
            &name, &root, &duration, threads, topk, iters, seed_base, max_size, max_random, resume,
        ),
        Cmd::CampaignStatus { name, root } => campaign::status(&format!("{}/{}", root, name)),
        Cmd::Rank {
            name,
            root,
            out,
            per_bucket,
        } => cmd_rank(&name, &root, &out, per_bucket),
    }
}
