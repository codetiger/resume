//! Layout (string-grid) encoding/decoding and the JSON record written to `levels/`.
//!
//! The layout notation matches `src/game/levels.json` for the shared chars and adds a small,
//! backward-compatible extension (direction arrows + digit teleport pairs). See `PROPOSAL.md` §9.

use crate::model::{Direction, Level, Sweep, TileKind};
use serde::{Deserialize, Serialize};

/// Max cells: a `u128` bitset backs the solver state, so 128 cells (e.g. 11×11) is the ceiling.
pub const MAX_CELLS: usize = 128;

/// Parse a single layout char into a cell (`None` = hole).
fn parse_char(ch: char) -> Result<Option<TileKind>, String> {
    Ok(match ch {
        '.' => None,
        'b' => Some(TileKind::Base),
        'n' => Some(TileKind::Green),
        'i' => Some(TileKind::Info),
        'x' => Some(TileKind::Explosive),
        'r' => Some(TileKind::Line(Sweep::Row)),
        'c' => Some(TileKind::Line(Sweep::Col)),
        't' => Some(TileKind::Shift(1)), // default teleport pair
        '1'..='9' => Some(TileKind::Shift(ch as u8 - b'0')),
        'a' => Some(TileKind::Arrow(Direction::Right)), // legacy alias for '>'
        '>' | '<' | '^' | 'v' => Some(TileKind::Arrow(Direction::from_glyph(ch).unwrap())),
        other => return Err(format!("unknown layout char {:?}", other)),
    })
}

/// Map a cell back to its canonical layout char.
fn encode_char(cell: &Option<TileKind>) -> char {
    match cell {
        None => '.',
        Some(TileKind::Base) => 'b',
        Some(TileKind::Green) => 'n',
        Some(TileKind::Info) => 'i',
        Some(TileKind::Explosive) => 'x',
        Some(TileKind::Line(Sweep::Row)) => 'r',
        Some(TileKind::Line(Sweep::Col)) => 'c',
        Some(TileKind::Shift(pid)) => (b'0' + *pid) as char,
        Some(TileKind::Arrow(d)) => d.glyph(),
    }
}

/// Parse a layout (array of equal-length rows) into a `Level`.
pub fn parse_layout(rows: &[String]) -> Result<Level, String> {
    if rows.is_empty() {
        return Err("empty layout".into());
    }
    let cols = rows[0].chars().count();
    let nrows = rows.len();
    if cols == 0 {
        return Err("zero-width layout".into());
    }
    if cols * nrows > MAX_CELLS {
        return Err(format!(
            "{}x{} = {} cells exceeds MAX_CELLS {}",
            cols,
            nrows,
            cols * nrows,
            MAX_CELLS
        ));
    }
    let mut cells = Vec::with_capacity(cols * nrows);
    for (r, row) in rows.iter().enumerate() {
        let line: Vec<char> = row.chars().collect();
        if line.len() != cols {
            return Err(format!(
                "row {} has width {} (expected {})",
                r,
                line.len(),
                cols
            ));
        }
        for ch in line {
            cells.push(parse_char(ch)?);
        }
    }
    Level::new(cols, nrows, cells)
}

/// Encode a `Level` back into a layout (array of row strings).
pub fn encode_layout(level: &Level) -> Vec<String> {
    (0..level.rows)
        .map(|r| {
            (0..level.cols)
                .map(|c| encode_char(&level.cells[level.idx(c, r)]))
                .collect()
        })
        .collect()
}

/// The request that produced a generated level (echoed into the record for provenance).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenRequest {
    pub target_difficulty: f64,
    /// Tile kinds the generator was allowed to use, e.g. `["n","arrow","shift"]`.
    pub allow: Vec<String>,
    pub cols: usize,
    pub rows: usize,
}

/// One generated/solved board as stored in `levels/*.json` — simple `layout` + raw solution data.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelRecord {
    pub name: String,
    pub seed: u64,
    pub layout: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub request: Option<GenRequest>,
    /// Raw winning move strings (deduped; no exact-reverse pairs). The headline artifact.
    pub solutions: Vec<String>,
    /// Total distinct (canonical) solutions found; `>= solutions.len()` when sampled.
    pub solution_count: u32,
    pub reachable_states: u32,
    pub dead_end_states: u32,
    /// Difficulty in `[0,1]`; `None` if unsolvable.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub difficulty: Option<f64>,
    pub band: String,
    /// `false` when solution enumeration / state exploration was capped.
    pub exact: bool,
}

/// A minimal view of `src/game/levels.json` for self-tests (we only need name + layout).
#[derive(Debug, Deserialize)]
pub struct GameLevel {
    pub name: String,
    pub layout: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct GameLevels {
    pub levels: Vec<GameLevel>,
}

/// Parse the game's `levels.json` text into name+layout pairs.
pub fn parse_game_levels(json: &str) -> Result<Vec<GameLevel>, String> {
    let parsed: GameLevels = serde_json::from_str(json).map_err(|e| e.to_string())?;
    Ok(parsed.levels)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_is_semantic() {
        // Mixed board: base, greens, both arrow notations, two teleport pairs, line, explosive.
        let rows: Vec<String> = ["b>n1", "nxn1", "2c.2", "vnn^"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let level = parse_layout(&rows).unwrap();
        let again = parse_layout(&encode_layout(&level)).unwrap();
        assert_eq!(level.cells, again.cells);
        assert_eq!(level.base, again.base);
    }

    #[test]
    fn info_counts_for_win_not_as_green() {
        let level = parse_layout(&["bi".to_string(), "nn".to_string()]).unwrap();
        assert_eq!(level.green_count(), 2); // just the two 'n'
        assert_eq!(level.win_count(), 3); // greens + info all must be cleared
    }

    #[test]
    fn rejects_multiple_bases() {
        assert!(parse_layout(&["bb".to_string()]).is_err());
    }
}
