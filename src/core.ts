import type { TileKind } from './game/tile';

// Shared primitives used across the engine and game modules: the cardinal
// movement direction, its grid delta, a deterministic noise hash, and the
// colour palette. Keeping these in one place avoids the three duplicate
// `Direction` unions and the scattered magic hex literals the modules grew.

export type Direction = 'right' | 'left' | 'forward' | 'back';

/** Grid step for each direction, as [dCol, dRow]. */
export const DIRECTION_DELTA: Record<Direction, [number, number]> = {
  right: [1, 0],
  left: [-1, 0],
  forward: [0, 1],
  back: [0, -1],
};

/** Deterministic pseudo-random in [0, 1) from a seed — stable per-tile jitter. */
export function noise(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Clamp `v` into the inclusive range [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

/** Smooth ease accelerating then decelerating; input and output both in [0, 1]. */
export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// Grid cells are keyed by "col,row" strings across the level state maps. These two
// helpers are the single place that format/parse that key, so the format lives in
// one spot instead of being re-spelled (and re-split) at every call site.
export const cellKey = (col: number, row: number): string => `${col},${row}`;
export const parseCellKey = (key: string): [number, number] => {
  const [col, row] = key.split(',').map(Number);
  return [col, row];
};

export const PALETTE = {
  /** Platform-mesh body colour per tile kind (neon-edged trim glow). */
  tileBody: {
    base: 0xf1f5f9, // off-white   — start / finish
    'disappear-normal': 0x16a34a, // green       — standard disappear
    'disappear-line': 0xea580c, // deep orange — row/col wipe
    arrow: 0xfacc15, // yellow      — forced slide rail
    shift: 0x0891b2, // cyan        — teleport portal
    explosive: 0xdc2626, // red         — blast radius
    info: 0xffd166, // gold        — the goal marker (reveals résumé)
  } satisfies Record<TileKind, number>,
  /** Dark panel body — reads as PBR depth rather than flat black. */
  tileTrim: 0x1a3352,

  /** Animated cube-grid overlay colour per tile kind. */
  decoration: {
    base: 0xe2e8f0,
    'disappear-normal': 0x4ade80,
    'disappear-line': 0xfb923c,
    arrow: 0xfde047,
    shift: 0x22d3ee,
    explosive: 0xf87171,
    countdown: 0xfff1b8,
    info: 0xffe39a, // pale gold — the "i" beacon glyph
  },

  /** Travelling effect spheres / swirl. */
  effect: {
    lineSphere: 0xea580c,
    blastSphere: 0xdc2626,
    teleportSwirl: 0x22d3ee,
  },

  /** Player cube materials. */
  player: {
    body: 0x00ccff, // neon cyan
    dark: 0x334455, // structural parts fallback
  },
} as const;
