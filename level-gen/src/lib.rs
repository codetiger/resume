//! `level_gen` — solver, generator and curator for the rolling-cube résumé puzzle.
//!
//! The game itself lives in `../src` (Three.js + TypeScript). This crate is a standalone
//! offline tool: it reasons about the *same* tile mechanics (mirrored from `src/game/grid.ts`)
//! to (A) solve a board and emit raw solution data, (B) generate boards at a target difficulty,
//! and (C) curate hundreds of boards into a tutorial-first, gradually-harder ladder.
//!
//! See `PROPOSAL.md` for the full design.

pub mod anneal;
pub mod campaign;
pub mod curate;
pub mod difficulty;
pub mod generate;
pub mod io;
pub mod metrics;
pub mod model;
pub mod screen;
pub mod solver;
pub mod topk;
