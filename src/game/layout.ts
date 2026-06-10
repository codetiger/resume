import type { Direction, TileKind } from '../core';

// Pure board-layout types + parsing, kept free of any Three.js / canvas imports so
// they can be unit-tested headlessly (grid.ts, which builds the meshes, re-exports
// what it needs from here).

export interface CellDef {
  kind: TileKind;
  /** Arrow tiles: direction the cube is forced to slide. */
  dir?: Direction;
  /** Shift tiles: paired cells share the same shiftId and act as portals. */
  shiftId?: number;
  /** Disappear-line tiles: whether to wipe the row or column. Defaults to 'row'. */
  sweepDir?: 'row' | 'col';
}

export type LevelLayout = (CellDef | null)[][];

/** Parse a compact string layout into CellDef[][].
 *  'r' = disappear-line row, 'c' = disappear-line col, 'x' = explosive, 'i' = info.
 *  Arrows: 'a'/'>' right, '<' left, '^' back (up a row), 'v' forward (down a row).
 *  Teleports: 't' is pair 1; digits '1'–'9' are paired by the digit (two cells per id). */
export function parseLayout(rows: string[]): LevelLayout {
  return rows.map((r) =>
    r.split('').map((ch): CellDef | null => {
      if (ch === '.') return null;
      if (ch === 'b') return { kind: 'base' };
      if (ch === 'n') return { kind: 'disappear-normal' };
      if (ch === 'r') return { kind: 'disappear-line', sweepDir: 'row' };
      if (ch === 'c') return { kind: 'disappear-line', sweepDir: 'col' };
      if (ch === 'x') return { kind: 'explosive' };
      if (ch === 'a' || ch === '>') return { kind: 'arrow', dir: 'right' };
      if (ch === '<') return { kind: 'arrow', dir: 'left' };
      if (ch === '^') return { kind: 'arrow', dir: 'back' };
      if (ch === 'v') return { kind: 'arrow', dir: 'forward' };
      if (ch === 't') return { kind: 'shift', shiftId: 1 };
      if (ch >= '1' && ch <= '9') return { kind: 'shift', shiftId: Number(ch) };
      if (ch === 'i') return { kind: 'info' };
      throw new Error(`Unknown layout char: "${ch}"`);
    }),
  );
}

/** Validate a compact layout's shape, throwing on anything malformed so a corrupt
 *  levels.json fails loudly at load instead of producing a broken board. Glyph
 *  validity is enforced separately by parseLayout; this covers structure: the grid
 *  must be non-empty, rectangular, and have exactly one base ('b') to start on. */
export function validateLayout(rows: string[]): void {
  if (rows.length === 0) throw new Error('layout has no rows');
  const width = rows[0].length;
  rows.forEach((row, i) => {
    if (row.length !== width) {
      throw new Error(`layout row ${i} is ragged (${row.length} ≠ ${width})`);
    }
  });
  const bases = rows.reduce((n, row) => n + [...row].filter((ch) => ch === 'b').length, 0);
  if (bases !== 1) {
    throw new Error(`layout must have exactly one base ('b'), found ${bases}`);
  }
}
