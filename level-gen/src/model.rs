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
    /// Content tile. Counts toward the win exactly like `Green` and crumbles on step-off, but is
    /// **immune to blasts/lines** (mirrors the game): so it can only be cleared by stepping on it,
    /// which guarantees the player lands on it and sees the content.
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
