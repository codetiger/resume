//! Exhaustive timed solver — mirrors the move resolution and chain semantics of
//! `src/game/grid.ts` (`onPlayerLand`, `activateLine`, `igniteBlast`, `detonateBlast`).
//!
//! It explores the full reachable state graph and emits the **raw** data the difficulty model
//! consumes: the deduped list of winning move strings plus reachable/dead-end state counts.
//! `solvable`, `shortestPath` and the solution count all derive from this. See `PROPOSAL.md` §3.

use crate::metrics::{self, QualityRaw};
use crate::model::{Direction, Level, Sweep, TileKind};
use rustc_hash::{FxHashMap, FxHashSet};
use smallvec::SmallVec;
use std::collections::VecDeque;

/// Doomed-loiter cap (move-ticks) for the delay metric — a doomed cycle can wander forever.
const DELAY_CAP: u32 = 40;
/// Special activations along the shortest solution that saturate the spectacle term.
const SPECTACLE_REF: f64 = 3.0;

/// Fuse length in move-ticks. Game: 1.8 s ÷ 0.36 s/move ≈ 5 (see `grid.ts:468`).
pub const FUSE_TICKS: u8 = 5;

#[derive(Clone, Debug)]
pub struct SolveConfig {
    /// Abort exploration past this many states (mark result inexact).
    pub max_states: usize,
    /// Stop counting solutions past this (mark inexact / truncated).
    pub count_cap: u32,
    /// Hard cap on DFS node visits during enumeration.
    pub visit_cap: u64,
    /// How many representative solutions to keep in the record.
    pub store_cap: usize,
    /// Buffer of solutions to retain before trimming to the shortest `store_cap`.
    pub store_buffer: usize,
    /// Enumerate solutions (DFS) and compute the full quality model. The cheap screen pass turns
    /// this off: it only needs solvability + a size proxy from the BFS, which is far faster.
    pub enumerate: bool,
}

impl Default for SolveConfig {
    fn default() -> Self {
        SolveConfig {
            max_states: 400_000,
            count_cap: 20_000,
            visit_cap: 2_000_000,
            store_cap: 40,
            store_buffer: 1_000,
            enumerate: true,
        }
    }
}

impl SolveConfig {
    /// Cheap screening config: small state cap, no solution enumeration / quality model. Used to
    /// confirm solvability and a rough size/length for the fast first-tier gate.
    pub fn screen() -> Self {
        SolveConfig {
            max_states: 12_000,
            count_cap: 0,
            visit_cap: 0,
            store_cap: 0,
            store_buffer: 0,
            enumerate: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SolveResult {
    pub solvable: bool,
    pub shortest_path: Option<u32>,
    pub solutions: Vec<String>,
    pub solution_count: u32,
    pub reachable_states: u32,
    pub dead_end_states: u32,
    /// `false` when state exploration or solution counting was capped.
    pub exact: bool,
    /// Number of green tiles on the board (used by the difficulty model).
    pub greens: u32,
    /// Standing tiles the cube can never reach and that are never cleared (useless/hanging tiles).
    /// 0 on a clean board; not computed (0) when exploration was capped.
    pub dead_tiles: u32,
    /// Whether a *winning* line of play exists in which the cube actually lands on the info tile
    /// (so its content can be revealed). `true` when there's no info tile (N/A).
    pub lands_on_info: bool,
    /// Whether the cube rests on at least one green tile on a winning line. A board with this
    /// property always has a place to put a landable info tile (so it can carry résumé content).
    pub rests_on_green: bool,
    /// Player-behaviour quality signals; `None` when unsolvable or not computed (screen pass).
    pub quality: Option<QualityRaw>,
}

/// Visual events triggered while resolving one action — fuels the "interesting to watch" metric.
#[derive(Clone, Copy, Debug, Default)]
pub struct ActEvents {
    pub lines: u32,
    pub blasts: u32,
    pub teleports: u32,
    pub arrows: u32,
}

impl ActEvents {
    /// The "spectacle" specials (chain reactions + teleports); arrows are passive rails, excluded.
    pub fn specials(&self) -> u32 {
        self.lines + self.blasts + self.teleports
    }
}

/// A hashable game state. `present`/`line_fired` are bitsets over cell indices (≤128).
#[derive(Clone, PartialEq, Eq, Hash)]
pub(crate) struct State {
    pub(crate) pos: u16,
    pub(crate) present: u128,
    line_fired: u128,
    /// Active explosive fuses, sorted by cell index for a canonical hash. Inline-stored: a state
    /// almost never has more than a couple of live fuses, so this avoids a heap alloc per state.
    fuses: SmallVec<[(u16, u8); 4]>,
}

impl State {
    pub(crate) fn has_fuse(&self) -> bool {
        !self.fuses.is_empty()
    }
}

/// The opening state: cube on the base, every tile standing, no fuses lit.
pub(crate) fn start_state(level: &Level) -> State {
    State {
        pos: level.base as u16,
        present: level.present_mask(),
        line_fired: 0,
        fuses: SmallVec::new(),
    }
}

/// The actions a player can take from `state`: the four rolls, plus `wait` only while a fuse burns.
pub(crate) fn legal_actions(state: &State) -> SmallVec<[Option<Direction>; 5]> {
    let mut actions: SmallVec<[Option<Direction>; 5]> =
        Direction::ALL.iter().map(|d| Some(*d)).collect();
    if state.has_fuse() {
        actions.push(None);
    }
    actions
}

/// Mutable working copy used to resolve a single player action and its cascades.
struct Sim<'a> {
    level: &'a Level,
    pos: usize,
    present: u128,
    line_fired: u128,
    fuses: SmallVec<[(usize, u8); 4]>,
    lost: bool,
    events: ActEvents,
    /// Cells the cube occupies while resolving this action (landing + every arrow/shift hop) —
    /// fuels the reachability ("no dead tiles") check.
    touched: u128,
}

impl<'a> Sim<'a> {
    fn from_state(level: &'a Level, s: &State) -> Self {
        Sim {
            level,
            pos: s.pos as usize,
            present: s.present,
            line_fired: s.line_fired,
            fuses: s.fuses.iter().map(|(c, t)| (*c as usize, *t)).collect(),
            lost: false,
            events: ActEvents::default(),
            touched: 0,
        }
    }

    #[inline]
    fn present(&self, idx: usize) -> bool {
        (self.present >> idx) & 1 == 1
    }

    #[inline]
    fn remove_tile(&mut self, idx: usize) {
        self.present &= !(1u128 << idx);
    }

    fn ignite(&mut self, idx: usize) {
        if self.present(idx) && !self.fuses.iter().any(|(c, _)| *c == idx) {
            self.fuses.push((idx, FUSE_TICKS));
        }
    }

    /// Step-off effects on the tile being left: greens/info crumble, explosives light their fuse.
    fn step_off(&mut self, idx: usize) {
        match self.level.cells[idx] {
            Some(TileKind::Green) | Some(TileKind::Info) => self.remove_tile(idx),
            Some(TileKind::Explosive) => self.ignite(idx),
            _ => {}
        }
    }

    fn find_active_partner(&self, idx: usize, pid: u8) -> Option<usize> {
        for (j, cell) in self.level.cells.iter().enumerate() {
            if j != idx && matches!(cell, Some(TileKind::Shift(p)) if *p == pid) && self.present(j)
            {
                return Some(j);
            }
        }
        None
    }

    /// Resolve a landing on `to` (arrived from `from`), iterating forced slides/teleports.
    /// Returns `Err` if the cube falls (lose).
    fn resolve_landing(&mut self, mut from: usize, mut to: usize) -> Result<(), ()> {
        let guard = 4 * self.level.cells.len() + 8;
        for _ in 0..guard {
            self.touched |= 1u128 << to; // the cube occupies `to` (landing or a slide/teleport hop)
            self.step_off(from);
            match self.level.cells[to] {
                Some(TileKind::Line(s)) => {
                    self.activate_line(to, s);
                    return Ok(());
                }
                Some(TileKind::Explosive)
                | Some(TileKind::Green)
                | Some(TileKind::Info)
                | Some(TileKind::Base) => {
                    return Ok(());
                }
                Some(TileKind::Arrow(d)) => match self.level.neighbor(to, d) {
                    Some(n) if self.present(n) => {
                        self.events.arrows += 1;
                        from = to;
                        to = n;
                        self.pos = n;
                    }
                    _ => return Err(()), // slides off an edge / into a hole → fall
                },
                Some(TileKind::Shift(pid)) => {
                    if let Some(p) = self.find_active_partner(to, pid) {
                        if p != from {
                            self.events.teleports += 1;
                            from = to;
                            to = p;
                            self.pos = p;
                            continue;
                        }
                    }
                    return Ok(());
                }
                None => return Ok(()),
            }
        }
        Err(()) // unresolved infinite slide (e.g. arrows facing each other) → treat as a trap
    }

    /// Fire a disappear-line: two sweeps clear greens and chain explosives/lines along the axis.
    fn activate_line(&mut self, start: usize, sweep: Sweep) {
        if (self.line_fired >> start) & 1 == 1 {
            return;
        }
        self.line_fired |= 1u128 << start;
        self.events.lines += 1;
        let (sc, sr) = self.level.coords(start);
        let dirs: [(i32, i32); 2] = match sweep {
            Sweep::Row => [(1, 0), (-1, 0)],
            Sweep::Col => [(0, 1), (0, -1)],
        };
        for (dc, dr) in dirs {
            let mut c = sc as i32 + dc;
            let mut r = sr as i32 + dr;
            while c >= 0 && r >= 0 && c < self.level.cols as i32 && r < self.level.rows as i32 {
                let k = self.level.idx(c as usize, r as usize);
                if self.level.cells[k].is_some() {
                    self.reach_tile(k);
                }
                c += dc;
                r += dr;
            }
        }
    }

    /// What a line sphere does on arrival (mirrors `reachTile`): clears greens **and info**,
    /// ignites explosives, chains other lines. If it clears the tile under the cube, the cube
    /// drops with it (loss) — same as a blast.
    fn reach_tile(&mut self, k: usize) {
        match self.level.cells[k] {
            Some(TileKind::Green) | Some(TileKind::Info) => {
                self.remove_tile(k);
                if k == self.pos {
                    self.lost = true;
                }
            }
            Some(TileKind::Explosive) => self.ignite(k),
            Some(TileKind::Line(s)) => self.activate_line(k, s),
            _ => {}
        }
    }

    /// Advance time one tick: burn fuses, detonate any that reach zero (simultaneously).
    fn tick(&mut self) {
        if self.fuses.is_empty() {
            return;
        }
        for f in self.fuses.iter_mut() {
            f.1 -= 1;
        }
        let due: SmallVec<[usize; 4]> = self
            .fuses
            .iter()
            .filter(|(_, t)| *t == 0)
            .map(|(c, _)| *c)
            .collect();
        if due.is_empty() {
            return;
        }
        self.fuses.retain(|(_, t)| *t > 0);
        self.events.blasts += due.len() as u32;
        // All due explosives fall together first, so a blast cannot re-arm a co-detonating one.
        for &c in &due {
            self.remove_tile(c);
            if c == self.pos {
                self.lost = true;
            }
        }
        for &c in &due {
            for d in Direction::ALL {
                if let Some(nb) = self.level.neighbor(c, d) {
                    if self.level.cells[nb].is_some() {
                        self.blast_hit(nb);
                    }
                }
            }
        }
    }

    /// What a blast sphere does on arrival (mirrors `blastHit`): destroys most tiles, chains
    /// explosives, fires lines. Only the base is indestructible. Kills the player if it clears
    /// their tile.
    fn blast_hit(&mut self, nb: usize) {
        match self.level.cells[nb] {
            // Only the base survives a blast.
            Some(TileKind::Base) => {}
            Some(TileKind::Explosive) => self.ignite(nb),
            Some(TileKind::Line(s)) => {
                self.activate_line(nb, s);
                self.remove_tile(nb);
                if nb == self.pos {
                    self.lost = true;
                }
            }
            Some(TileKind::Green)
            | Some(TileKind::Info)
            | Some(TileKind::Arrow(_))
            | Some(TileKind::Shift(_)) => {
                self.remove_tile(nb);
                if nb == self.pos {
                    self.lost = true;
                }
            }
            None => {}
        }
    }

    fn to_state(&self) -> State {
        let mut fuses: SmallVec<[(u16, u8); 4]> =
            self.fuses.iter().map(|(c, t)| (*c as u16, *t)).collect();
        fuses.sort_unstable();
        State {
            pos: self.pos as u16,
            present: self.present,
            line_fired: self.line_fired,
            fuses,
        }
    }
}

/// Apply one action (`Some(dir)` move, or `None` wait) to a state. Returns the next state and the
/// visual events fired while resolving it, or `None` if the cube is lost (fall or destroyed).
fn apply_action(
    level: &Level,
    state: &State,
    action: Option<Direction>,
) -> Option<(State, ActEvents, u128)> {
    let mut sim = Sim::from_state(level, state);
    if let Some(dir) = action {
        let from = sim.pos;
        match level.neighbor(from, dir) {
            Some(to) if sim.present(to) => {
                sim.pos = to;
                if sim.resolve_landing(from, to).is_err() {
                    return None;
                }
            }
            _ => return None, // rolled off the board / onto a hole → fall
        }
    }
    sim.tick();
    if sim.lost {
        return None;
    }
    let events = sim.events;
    let touched = sim.touched;
    Some((sim.to_state(), events, touched))
}

/// Apply one action; returns the next state or `None` if the cube is lost. Exposed for the
/// Monte-Carlo screen player (`screen.rs`).
pub(crate) fn try_action(level: &Level, state: &State, action: Option<Direction>) -> Option<State> {
    apply_action(level, state, action).map(|(s, _, _)| s)
}

fn action_glyph(action: Option<Direction>) -> char {
    match action {
        Some(d) => d.glyph(),
        None => '-',
    }
}

pub(crate) fn is_win_state(s: &State, base: u16, win_mask: u128) -> bool {
    s.pos == base && (s.present & win_mask) == 0
}

/// Win check against the level directly (for the screen player, which has no precomputed masks).
pub(crate) fn state_is_win(level: &Level, s: &State) -> bool {
    is_win_state(s, level.base as u16, level.win_mask())
}

/// Naive progress heuristic a greedy player minimises: clear win-tiles first, then head to base.
pub(crate) fn greedy_heuristic(level: &Level, s: &State) -> f64 {
    let remaining = (s.present & level.win_mask()).count_ones() as f64;
    let (pc, pr) = level.coords(s.pos as usize);
    let (bc, br) = level.coords(level.base);
    let manhattan = ((pc as i64 - bc as i64).abs() + (pr as i64 - br as i64).abs()) as f64;
    remaining * 1000.0 + manhattan
}

/// Reverse a solution string into its mirror: reverse the order and invert every heading.
fn mirror(s: &str) -> String {
    s.chars()
        .rev()
        .map(|c| match c {
            '>' => '<',
            '<' => '>',
            '^' => 'v',
            'v' => '^',
            other => other, // '-' (wait) is self-inverse
        })
        .collect()
}

/// Canonical key: the lexicographically smaller of a solution and its mirror.
fn canonical(s: &str) -> String {
    let m = mirror(s);
    if m.as_str() < s {
        m
    } else {
        s.to_string()
    }
}

struct Enumerator<'a> {
    adj: &'a [metrics::AdjRow],
    is_win: &'a [bool],
    can_win: &'a [bool],
    on_path: Vec<bool>,
    path: String,
    canon: FxHashSet<String>,
    stored: Vec<String>,
    count: u32,
    visits: u64,
    truncated: bool,
    cfg: SolveConfig,
}

impl<'a> Enumerator<'a> {
    fn dfs(&mut self, s: u32) {
        if self.count >= self.cfg.count_cap || self.visits >= self.cfg.visit_cap {
            self.truncated = true;
            return;
        }
        self.visits += 1;
        if self.is_win[s as usize] {
            // Only materialise a solution string when it's a new canonical form (and only clone it
            // again if we're still storing representatives).
            let key = canonical(&self.path);
            if self.canon.insert(key) {
                self.count += 1;
                if self.stored.len() < self.cfg.store_buffer {
                    self.stored.push(self.path.clone());
                }
            }
            return;
        }
        // `adj` is a borrow with the enumerator's own lifetime, independent of `&mut self`, so bind
        // it to a local and iterate directly — no per-node row clone.
        let adj = self.adj;
        for &(g, t) in &adj[s as usize] {
            let t = t as usize;
            if !self.can_win[t] || self.on_path[t] {
                continue;
            }
            self.on_path[t] = true;
            self.path.push(g);
            self.dfs(t as u32);
            self.path.pop();
            self.on_path[t] = false;
            if self.truncated {
                return;
            }
        }
    }
}

/// Solve a level: explore the reachable state graph and produce the raw solution data.
pub fn solve(level: &Level, cfg: &SolveConfig) -> SolveResult {
    let base = level.base as u16;
    let win_mask = level.win_mask();
    let greens = level.win_count();

    // Pre-size the per-solve containers: starting from empty makes the state map rehash and the
    // parallel Vecs reallocate repeatedly as the graph grows (the profile showed ~570 samples in
    // `reserve_rehash` alone). Most boards stay well under a couple thousand states, so a modest
    // hint (capped at `max_states`) covers the common case without over-allocating the rare giants.
    let cap = cfg.max_states.min(2048);
    let mut index: FxHashMap<State, u32> =
        FxHashMap::with_capacity_and_hasher(cap, Default::default());
    let mut states: Vec<State> = Vec::with_capacity(cap);
    let mut adj: Vec<metrics::AdjRow> = Vec::with_capacity(cap);
    let mut is_win: Vec<bool> = Vec::with_capacity(cap);
    let mut dist: Vec<u32> = Vec::with_capacity(cap);
    // Count of keypresses that kill from each state (fall / blast) — they leave no edge in `adj`,
    // but a real player can still press them, so they're the denominator of the random-walk model.
    let mut death_moves: Vec<u8> = Vec::with_capacity(cap);

    let start = start_state(level);

    // Intern the start.
    let start_win = is_win_state(&start, base, win_mask);
    index.insert(start.clone(), 0);
    states.push(start);
    adj.push(metrics::AdjRow::new());
    is_win.push(start_win);
    dist.push(0);
    death_moves.push(0);

    let mut capped = false;
    let mut q: VecDeque<u32> = VecDeque::new();
    q.push_back(0);

    // Reachability accounting for the "no dead tiles" rule: `visited` = every cell the cube ever
    // occupies (incl. arrow/shift slide-throughs); `cleared` = every cell ever removed.
    let mut visited: u128 = 1u128 << base;
    let mut cleared: u128 = 0;

    while let Some(si) = q.pop_front() {
        if states.len() > cfg.max_states {
            capped = true;
            break;
        }
        if is_win[si as usize] {
            continue; // win states are absorbing
        }
        let cur = states[si as usize].clone();

        let actions = legal_actions(&cur);
        let mut deaths = 0u8;
        for action in actions {
            if let Some((ns, _, touched)) = apply_action(level, &cur, action) {
                visited |= touched;
                cleared |= cur.present & !ns.present;
                let ni = match index.get(&ns) {
                    Some(&i) => i,
                    None => {
                        let i = states.len() as u32;
                        let win = is_win_state(&ns, base, win_mask);
                        index.insert(ns.clone(), i);
                        states.push(ns);
                        adj.push(metrics::AdjRow::new());
                        is_win.push(win);
                        dist.push(dist[si as usize] + 1);
                        death_moves.push(0);
                        if !win {
                            q.push_back(i);
                        }
                        i
                    }
                };
                adj[si as usize].push((action_glyph(action), ni));
            } else {
                deaths += 1;
            }
        }
        death_moves[si as usize] = deaths;
    }

    // A standing tile is "dead" if the cube can never occupy it and it's never cleared — a useless,
    // hanging tile. (Only meaningful when exploration was exhaustive.)
    let dead_tiles = if capped {
        0
    } else {
        (level.present_mask() & !(visited | cleared)).count_ones()
    };

    let n = states.len();
    let win_indices: Vec<u32> = (0..n as u32).filter(|&i| is_win[i as usize]).collect();

    // Reverse reachability: which states can reach a win? Build the reverse adjacency as CSR
    // (count in-degrees → prefix-sum offsets → fill one flat edge buffer) instead of `n` small
    // heap Vecs — same traversal, no per-state allocation.
    let mut rev_off = vec![0u32; n + 1];
    for row in adj.iter() {
        for &(_, t) in row {
            rev_off[t as usize + 1] += 1;
        }
    }
    for i in 0..n {
        rev_off[i + 1] += rev_off[i];
    }
    let mut rev_flat = vec![0u32; rev_off[n] as usize];
    let mut cursor = rev_off.clone();
    for (s, row) in adj.iter().enumerate() {
        for &(_, t) in row {
            let slot = cursor[t as usize] as usize;
            rev_flat[slot] = s as u32;
            cursor[t as usize] += 1;
        }
    }
    let rev_of = |s: usize| &rev_flat[rev_off[s] as usize..rev_off[s + 1] as usize];

    let mut can_win = vec![false; n];
    // `dist_to_win[s]` = fewest forward moves from `s` to any win (u32::MAX if it can't reach one).
    let mut dist_to_win = vec![u32::MAX; n];
    let mut rq: VecDeque<u32> = VecDeque::new();
    for &w in &win_indices {
        if !can_win[w as usize] {
            can_win[w as usize] = true;
            dist_to_win[w as usize] = 0;
            rq.push_back(w);
        }
    }
    while let Some(s) = rq.pop_front() {
        let ds = dist_to_win[s as usize];
        for &p in rev_of(s as usize) {
            if !can_win[p as usize] {
                can_win[p as usize] = true;
                dist_to_win[p as usize] = ds + 1;
                rq.push_back(p);
            }
        }
    }

    let solvable = can_win.first().copied().unwrap_or(false);
    let shortest_path = win_indices.iter().map(|&w| dist[w as usize]).min();
    let dead_end_states = (n - can_win.iter().filter(|b| **b).count()) as u32;

    // Can the cube actually land on the info tile on a winning line of play? (So its content can be
    // revealed.) True when there's a can-win state resting on the info cell; N/A → true.
    let info_cell = level
        .cells
        .iter()
        .position(|c| matches!(c, Some(TileKind::Info)));
    let lands_on_info = match info_cell {
        Some(ic) => (0..n).any(|i| can_win[i] && states[i].pos as usize == ic),
        None => true,
    };
    // Does the cube rest on a green on a winning line? Such a green is a valid landable info spot.
    let green_mask = level.green_mask();
    let rests_on_green = (0..n).any(|i| can_win[i] && (green_mask >> states[i].pos) & 1 == 1);

    // Enumerate solutions through can-win states only (no repeated state per path).
    let (mut solutions, solution_count, truncated) =
        if cfg.enumerate && solvable && shortest_path != Some(0) {
            let mut en = Enumerator {
                adj: &adj,
                is_win: &is_win,
                can_win: &can_win,
                on_path: vec![false; n],
                path: String::new(),
                canon: FxHashSet::default(),
                stored: Vec::new(),
                count: 0,
                visits: 0,
                truncated: false,
                cfg: cfg.clone(),
            };
            en.on_path[0] = true;
            en.dfs(0);
            (en.stored, en.count, en.truncated)
        } else if shortest_path == Some(0) {
            // Degenerate: no greens, already won.
            (vec![String::new()], 1, false)
        } else {
            (Vec::new(), 0, false)
        };

    // Keep the shortest representatives.
    solutions.sort_by_key(|s| (s.len(), s.clone()));
    solutions.truncate(cfg.store_cap);

    // Full quality model — only at the deep tier (`enumerate`); the screen pass skips it.
    let quality = if cfg.enumerate && solvable {
        let sp = shortest_path.unwrap_or(0);
        let (commitment, max_doom_delay) = metrics::commitment_and_delay(
            &adj,
            &death_moves,
            &can_win,
            &dist_to_win,
            &is_win,
            0,
            DELAY_CAP,
        );
        let (decision, forced_fraction) = metrics::decision_branching(&adj, &can_win, &is_win);
        let (spectacle, spectacle_required) = spectacle_of(level, &solutions);
        Some(QualityRaw {
            random_solve_prob: metrics::random_solve_prob(&adj, &death_moves, &is_win, 0),
            // Heuristic evaluated lazily per state the greedy walk visits (was an O(N) Vec).
            greedy_solves: metrics::greedy_solves(
                &adj,
                |i| greedy_heuristic(level, &states[i]),
                &is_win,
                0,
            ),
            commitment,
            max_doom_delay,
            optimal_path_fraction: metrics::optimal_path_fraction(
                &dist,
                &dist_to_win,
                &can_win,
                sp,
            ),
            decision,
            forced_fraction,
            spectacle,
            spectacle_required,
        })
    } else {
        None
    };

    SolveResult {
        solvable,
        shortest_path,
        solutions,
        solution_count,
        reachable_states: n as u32,
        dead_end_states,
        exact: !capped && !truncated,
        greens,
        dead_tiles,
        lands_on_info,
        rests_on_green,
        quality,
    }
}

pub fn solve_default(level: &Level) -> SolveResult {
    solve(level, &SolveConfig::default())
}

/// Replay a solution string from the start, accumulating the visual events it fires.
fn replay_events(level: &Level, sol: &str) -> ActEvents {
    let mut state = start_state(level);
    let mut total = ActEvents::default();
    for ch in sol.chars() {
        let action = if ch == '-' {
            None
        } else {
            Direction::from_glyph(ch)
        };
        match apply_action(level, &state, action) {
            Some((ns, ev, _)) => {
                state = ns;
                total.lines += ev.lines;
                total.blasts += ev.blasts;
                total.teleports += ev.teleports;
                total.arrows += ev.arrows;
            }
            None => break, // a stored solution should always replay; bail defensively
        }
    }
    total
}

/// Spectacle ("interesting to watch"): activations along the shortest solution, and whether
/// winning *requires* engaging a line/blast/teleport (no special-free solution exists).
fn spectacle_of(level: &Level, solutions: &[String]) -> (f64, bool) {
    if solutions.is_empty() {
        return (0.0, false);
    }
    // `solutions` is sorted shortest-first: index 0 is the path a player most likely walks.
    let head = replay_events(level, &solutions[0]);
    let raw = 1.5 * head.blasts as f64
        + head.lines as f64
        + head.teleports as f64
        + 0.3 * head.arrows as f64;
    let x = raw / SPECTACLE_REF;
    let spectacle = x / (1.0 + x);
    let required = !solutions
        .iter()
        .any(|s| replay_events(level, s).specials() == 0);
    (spectacle, required)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::parse_layout;

    fn lvl(rows: &[&str]) -> Level {
        parse_layout(&rows.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn tiny_ring_is_solvable() {
        // base + a green: roll out and back.
        let r = solve_default(&lvl(&["bn"]));
        assert!(r.solvable);
        // ">" onto the green, "<" back to base clears it. Shortest = 2 moves.
        assert_eq!(r.shortest_path, Some(2));
        assert!(r.solution_count >= 1);
    }

    #[test]
    fn falling_off_is_not_a_solution() {
        // Single base, no greens elsewhere but a hole around: degenerate win (no greens).
        let r = solve_default(&lvl(&["b."]));
        assert!(r.solvable);
        assert_eq!(r.shortest_path, Some(0));
    }

    #[test]
    fn mirror_dedup_collapses_reverse() {
        assert_eq!(canonical(">>"), "<<");
        assert_eq!(canonical("><"), "><"); // mirror of "><" is "><"
        assert_eq!(mirror(">v<"), ">^<");
    }
}
