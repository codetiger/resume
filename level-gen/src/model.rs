//! Core board model — the puzzle primitives, mirrored from `src/core.ts` and `src/game/grid.ts`.

use serde::{Deserialize, Serialize};

/// The four cardinal move directions. Grid step `(dcol, drow)` matches `DIRECTION_DELTA`
/// in `src/core.ts`: forward is +row (visually "down" the grid), back is -row ("up").
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub enum Direction {
    Right,
    Left,
    Forward,
    Back,
}

impl Direction {
    pub const ALL: [Direction; 4] = [
        Direction::Right,
        Direction::Left,
        Direction::Forward,
        Direction::Back,
    ];

    /// `(dcol, drow)` grid step.
    pub fn delta(self) -> (i32, i32) {
        match self {
            Direction::Right => (1, 0),
            Direction::Left => (-1, 0),
            Direction::Forward => (0, 1),
            Direction::Back => (0, -1),
        }
    }

    /// The single-char glyph used in layouts and solution strings.
    /// `>` right, `<` left, `^` back (up a row), `v` forward (down a row).
    pub fn glyph(self) -> char {
        match self {
            Direction::Right => '>',
            Direction::Left => '<',
            Direction::Back => '^',
            Direction::Forward => 'v',
        }
    }

    pub fn from_glyph(c: char) -> Option<Direction> {
        match c {
            '>' => Some(Direction::Right),
            '<' => Some(Direction::Left),
            '^' => Some(Direction::Back),
            'v' => Some(Direction::Forward),
            _ => None,
        }
    }

    /// The reverse heading — used when canonicalising a solution against its mirror.
    pub fn invert(self) -> Direction {
        match self {
            Direction::Right => Direction::Left,
            Direction::Left => Direction::Right,
            Direction::Forward => Direction::Back,
            Direction::Back => Direction::Forward,
        }
    }
}

/// Which axis a disappear-line tile sweeps when triggered.
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub enum Sweep {
    Row,
    Col,
}

/// A standing tile.
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub enum TileKind {
    /// Start = finish. Indestructible.
    Base,
    /// `disappear-normal`. Crumbles on step-off; all must be cleared to win.
    Green,
    /// Content tile. Behaves exactly like `Green` for destruction — crumbles on step-off and is
    /// cleared by blasts/lines (mirrors the game) — and counts toward the win the same way. It
    /// additionally reveals its résumé content when the cube lands on it.
    Info,
    /// Forces a one-tile slide in `dir` on landing (chains through consecutive arrows).
    Arrow(Direction),
    /// Teleports to the active partner sharing this pair id.
    Shift(u8),
    /// One-shot row/col sweep that clears greens and chains explosives/lines.
    Line(Sweep),
    /// Landmine: arms on landing, lights a fuse on step-off, detonates after a delay.
    Explosive,
}

/// A board: a `cols × rows` grid of cells (each a `TileKind` or a hole), with one base.
#[derive(Clone, Debug)]
pub struct Level {
    pub cols: usize,
    pub rows: usize,
    /// Row-major, length `cols * rows`. `None` = hole.
    pub cells: Vec<Option<TileKind>>,
    /// Index of the (unique) base cell.
    pub base: usize,
}

impl Level {
    pub fn new(cols: usize, rows: usize, cells: Vec<Option<TileKind>>) -> Result<Level, String> {
        if cells.len() != cols * rows {
            return Err(format!(
                "cell count {} != cols*rows {}",
                cells.len(),
                cols * rows
            ));
        }
        let bases: Vec<usize> = cells
            .iter()
            .enumerate()
            .filter(|(_, c)| matches!(c, Some(TileKind::Base)))
            .map(|(i, _)| i)
            .collect();
        match bases.len() {
            1 => Ok(Level {
                cols,
                rows,
                cells,
                base: bases[0],
            }),
            n => Err(format!("expected exactly 1 base, found {}", n)),
        }
    }

    #[inline]
    pub fn idx(&self, col: usize, row: usize) -> usize {
        row * self.cols + col
    }

    #[inline]
    pub fn coords(&self, idx: usize) -> (usize, usize) {
        (idx % self.cols, idx / self.cols)
    }

    /// `(dcol, drow)` neighbour of `idx`, or `None` if off-grid.
    pub fn neighbor(&self, idx: usize, dir: Direction) -> Option<usize> {
        let (c, r) = self.coords(idx);
        let (dc, dr) = dir.delta();
        let nc = c as i32 + dc;
        let nr = r as i32 + dr;
        if nc < 0 || nr < 0 || nc >= self.cols as i32 || nr >= self.rows as i32 {
            None
        } else {
            Some(self.idx(nc as usize, nr as usize))
        }
    }

    pub fn green_count(&self) -> u32 {
        self.cells
            .iter()
            .filter(|c| matches!(c, Some(TileKind::Green)))
            .count() as u32
    }

    /// Count of special (non-green, non-base, non-info) tiles: arrows, shifts, lines, explosives.
    pub fn special_count(&self) -> u32 {
        self.cells
            .iter()
            .filter(|c| {
                matches!(
                    c,
                    Some(TileKind::Arrow(_))
                        | Some(TileKind::Shift(_))
                        | Some(TileKind::Line(_))
                        | Some(TileKind::Explosive)
                )
            })
            .count() as u32
    }

    /// Is this cell a green-like tile a sweep/blast can clear (green or info)?
    fn is_clearable(&self, idx: usize) -> bool {
        matches!(
            self.cells[idx],
            Some(TileKind::Green) | Some(TileKind::Info)
        )
    }

    /// Count of specials that can't actually clear a green when triggered: a line whose row/column
    /// holds no green/info, or an explosive with no green/info among its four neighbours. Such a
    /// tile fires uselessly, so the generator rejects boards that contain any.
    pub fn useless_special_count(&self) -> u32 {
        let mut count = 0;
        for (i, cell) in self.cells.iter().enumerate() {
            match cell {
                Some(TileKind::Line(Sweep::Row)) => {
                    let (_, r) = self.coords(i);
                    let has = (0..self.cols).any(|c| {
                        let k = self.idx(c, r);
                        k != i && self.is_clearable(k)
                    });
                    if !has {
                        count += 1;
                    }
                }
                Some(TileKind::Line(Sweep::Col)) => {
                    let (c, _) = self.coords(i);
                    let has = (0..self.rows).any(|r| {
                        let k = self.idx(c, r);
                        k != i && self.is_clearable(k)
                    });
                    if !has {
                        count += 1;
                    }
                }
                Some(TileKind::Explosive) => {
                    let has = Direction::ALL
                        .iter()
                        .any(|&d| self.neighbor(i, d).is_some_and(|nb| self.is_clearable(nb)));
                    if !has {
                        count += 1;
                    }
                }
                _ => {}
            }
        }
        count
    }

    /// Number of teleport ids that don't form a clean pair (a lone shift, or 3+ sharing an id).
    pub fn unpaired_shift_count(&self) -> u32 {
        let mut by_id: std::collections::HashMap<u8, u32> = std::collections::HashMap::new();
        for c in &self.cells {
            if let Some(TileKind::Shift(p)) = c {
                *by_id.entry(*p).or_insert(0) += 1;
            }
        }
        by_id.values().filter(|&&n| n != 2).count() as u32
    }

    /// Make every teleport id a clean pair: a lone shift becomes a green; for 3+ sharing an id,
    /// keep the two lowest cells and green the rest. Keeps boards valid after any mutation.
    pub fn normalize_shifts(&mut self) {
        let mut by_id: std::collections::HashMap<u8, Vec<usize>> = std::collections::HashMap::new();
        for (i, c) in self.cells.iter().enumerate() {
            if let Some(TileKind::Shift(p)) = c {
                by_id.entry(*p).or_default().push(i);
            }
        }
        for idxs in by_id.values() {
            for (k, &i) in idxs.iter().enumerate() {
                // Keep the first two cells of a ≥2 group; green everything else.
                if idxs.len() >= 2 && k < 2 {
                    continue;
                }
                self.cells[i] = Some(TileKind::Green);
            }
        }
    }

    /// Tiles that must be cleared to win: greens + info.
    pub fn win_count(&self) -> u32 {
        self.cells
            .iter()
            .filter(|c| matches!(c, Some(TileKind::Green) | Some(TileKind::Info)))
            .count() as u32
    }

    /// Bitmask of cells that must be cleared to win (greens + info).
    pub fn win_mask(&self) -> u128 {
        let mut m = 0u128;
        for (i, c) in self.cells.iter().enumerate() {
            if matches!(c, Some(TileKind::Green) | Some(TileKind::Info)) {
                m |= 1u128 << i;
            }
        }
        m
    }

    /// Count of standing (non-hole) cells.
    pub fn tile_count(&self) -> u32 {
        self.cells.iter().filter(|c| c.is_some()).count() as u32
    }

    /// Bitmask of green cell indices (boards are ≤ 11×11 so a u128 suffices).
    pub fn green_mask(&self) -> u128 {
        let mut m = 0u128;
        for (i, c) in self.cells.iter().enumerate() {
            if matches!(c, Some(TileKind::Green)) {
                m |= 1u128 << i;
            }
        }
        m
    }

    /// Bitmask of initially-present (non-hole) cells.
    pub fn present_mask(&self) -> u128 {
        let mut m = 0u128;
        for (i, c) in self.cells.iter().enumerate() {
            if c.is_some() {
                m |= 1u128 << i;
            }
        }
        m
    }
}
