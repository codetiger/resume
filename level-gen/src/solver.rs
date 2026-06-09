//! Exhaustive timed solver — mirrors the move resolution and chain semantics of
//! `src/game/grid.ts` (`onPlayerLand`, `activateLine`, `igniteBlast`, `detonateBlast`).
//!
//! It explores the full reachable state graph and emits the **raw** data the difficulty model
//! consumes: the deduped list of winning move strings plus reachable/dead-end state counts.
//! `solvable`, `shortestPath` and the solution count all derive from this. See `PROPOSAL.md` §3.

use crate::model::{Direction, Level, Sweep, TileKind};
use std::collections::{HashMap, HashSet, VecDeque};

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
}

impl Default for SolveConfig {
    fn default() -> Self {
        SolveConfig {
            max_states: 400_000,
            count_cap: 20_000,
            visit_cap: 2_000_000,
            store_cap: 40,
            store_buffer: 1_000,
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
}

/// A hashable game state. `present`/`line_fired` are bitsets over cell indices (≤128).
#[derive(Clone, PartialEq, Eq, Hash)]
struct State {
    pos: u16,
    present: u128,
    line_fired: u128,
    /// Active explosive fuses, sorted by cell index for a canonical hash.
    fuses: Vec<(u16, u8)>,
}

/// Mutable working copy used to resolve a single player action and its cascades.
struct Sim<'a> {
    level: &'a Level,
    pos: usize,
    present: u128,
    line_fired: u128,
    fuses: Vec<(usize, u8)>,
    lost: bool,
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
            if j != idx && matches!(cell, Some(TileKind::Shift(p)) if *p == pid) && self.present(j) {
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
                        from = to;
                        to = n;
                        self.pos = n;
                    }
                    _ => return Err(()), // slides off an edge / into a hole → fall
                },
                Some(TileKind::Shift(pid)) => {
                    if let Some(p) = self.find_active_partner(to, pid) {
                        if p != from {
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

    /// What a line sphere does on arrival (mirrors `reachTile`): clears greens, ignites
    /// explosives, chains other lines. Notably does **not** kill the player.
    fn reach_tile(&mut self, k: usize) {
        match self.level.cells[k] {
            Some(TileKind::Green) => self.remove_tile(k),
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
        let due: Vec<usize> = self
            .fuses
            .iter()
            .filter(|(_, t)| *t == 0)
            .map(|(c, _)| *c)
            .collect();
        if due.is_empty() {
            return;
        }
        self.fuses.retain(|(_, t)| *t > 0);
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
    /// explosives, fires lines. Base is indestructible. Kills the player if it clears their tile.
    fn blast_hit(&mut self, nb: usize) {
        match self.level.cells[nb] {
            // Base and info are blast-immune (info content is protected, like in the game).
            Some(TileKind::Base) | Some(TileKind::Info) => {}
            Some(TileKind::Explosive) => self.ignite(nb),
            Some(TileKind::Line(s)) => {
                self.activate_line(nb, s);
                self.remove_tile(nb);
                if nb == self.pos {
                    self.lost = true;
                }
            }
            Some(TileKind::Green) | Some(TileKind::Arrow(_)) | Some(TileKind::Shift(_)) => {
                self.remove_tile(nb);
                if nb == self.pos {
                    self.lost = true;
                }
            }
            None => {}
        }
    }

    fn to_state(&self) -> State {
        let mut fuses: Vec<(u16, u8)> = self.fuses.iter().map(|(c, t)| (*c as u16, *t)).collect();
        fuses.sort_unstable();
        State {
            pos: self.pos as u16,
            present: self.present,
            line_fired: self.line_fired,
            fuses,
        }
    }
}

/// Apply one action (`Some(dir)` move, or `None` wait) to a state. Returns the next state, or
/// `None` if the cube is lost (fall or destroyed).
fn try_action(level: &Level, state: &State, action: Option<Direction>) -> Option<State> {
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
    Some(sim.to_state())
}

fn action_glyph(action: Option<Direction>) -> char {
    match action {
        Some(d) => d.glyph(),
        None => '-',
    }
}

fn is_win_state(s: &State, base: u16, win_mask: u128) -> bool {
    s.pos == base && (s.present & win_mask) == 0
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
    adj: &'a [Vec<(char, u32)>],
    is_win: &'a [bool],
    can_win: &'a [bool],
    on_path: Vec<bool>,
    path: String,
    canon: HashSet<String>,
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
            let sol = self.path.clone();
            let key = canonical(&sol);
            if self.canon.insert(key) {
                self.count += 1;
                if self.stored.len() < self.cfg.store_buffer {
                    self.stored.push(sol);
                }
            }
            return;
        }
        let row = self.adj[s as usize].clone();
        for (g, t) in row {
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

    let mut index: HashMap<State, u32> = HashMap::new();
    let mut states: Vec<State> = Vec::new();
    let mut adj: Vec<Vec<(char, u32)>> = Vec::new();
    let mut is_win: Vec<bool> = Vec::new();
    let mut dist: Vec<u32> = Vec::new();

    let start = State {
        pos: base,
        present: level.present_mask(),
        line_fired: 0,
        fuses: Vec::new(),
    };

    // Intern the start.
    let start_win = is_win_state(&start, base, win_mask);
    index.insert(start.clone(), 0);
    states.push(start);
    adj.push(Vec::new());
    is_win.push(start_win);
    dist.push(0);

    let mut capped = false;
    let mut q: VecDeque<u32> = VecDeque::new();
    q.push_back(0);

    while let Some(si) = q.pop_front() {
        if states.len() > cfg.max_states {
            capped = true;
            break;
        }
        if is_win[si as usize] {
            continue; // win states are absorbing
        }
        let cur = states[si as usize].clone();

        // Available actions: the 4 moves, plus `wait` only when a fuse is burning.
        let mut actions: Vec<Option<Direction>> = Direction::ALL.iter().map(|d| Some(*d)).collect();
        if !cur.fuses.is_empty() {
            actions.push(None);
        }

        for action in actions {
            if let Some(ns) = try_action(level, &cur, action) {
                let ni = match index.get(&ns) {
                    Some(&i) => i,
                    None => {
                        let i = states.len() as u32;
                        let win = is_win_state(&ns, base, win_mask);
                        index.insert(ns.clone(), i);
                        states.push(ns);
                        adj.push(Vec::new());
                        is_win.push(win);
                        dist.push(dist[si as usize] + 1);
                        if !win {
                            q.push_back(i);
                        }
                        i
                    }
                };
                adj[si as usize].push((action_glyph(action), ni));
            }
        }
    }

    let n = states.len();
    let win_indices: Vec<u32> = (0..n as u32).filter(|&i| is_win[i as usize]).collect();

    // Reverse reachability: which states can reach a win?
    let mut rev: Vec<Vec<u32>> = vec![Vec::new(); n];
    for (s, row) in adj.iter().enumerate() {
        for &(_, t) in row {
            rev[t as usize].push(s as u32);
        }
    }
    let mut can_win = vec![false; n];
    let mut rq: VecDeque<u32> = VecDeque::new();
    for &w in &win_indices {
        if !can_win[w as usize] {
            can_win[w as usize] = true;
            rq.push_back(w);
        }
    }
    while let Some(s) = rq.pop_front() {
        for &p in &rev[s as usize] {
            if !can_win[p as usize] {
                can_win[p as usize] = true;
                rq.push_back(p);
            }
        }
    }

    let solvable = can_win.get(0).copied().unwrap_or(false);
    let shortest_path = win_indices.iter().map(|&w| dist[w as usize]).min();
    let dead_end_states = (n - can_win.iter().filter(|b| **b).count()) as u32;

    // Enumerate solutions through can-win states only (no repeated state per path).
    let (mut solutions, solution_count, truncated) = if solvable && shortest_path != Some(0) {
        let mut en = Enumerator {
            adj: &adj,
            is_win: &is_win,
            can_win: &can_win,
            on_path: vec![false; n],
            path: String::new(),
            canon: HashSet::new(),
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

    SolveResult {
        solvable,
        shortest_path,
        solutions,
        solution_count,
        reachable_states: n as u32,
        dead_end_states,
        exact: !capped && !truncated,
        greens,
    }
}

pub fn solve_default(level: &Level) -> SolveResult {
    solve(level, &SolveConfig::default())
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
