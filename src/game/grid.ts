import * as THREE from 'three';
import type { TileKind } from './tile';
import { createTile } from './tile';
import { createEffects, type Effects, type ReachTarget } from './effects';
import {
  createArrowDecoration,
  createBaseDecoration,
  createDisappearNormalDecoration,
  createDisappearLineDecoration,
  createShiftDecoration,
  createExplosiveDecoration,
  createCountdownDecoration,
  type Countdown,
} from './decoration';

export const TILE_SIZE = 1.0;
export const CUBE_SIZE = 0.7;
export const TILE_GAP = CUBE_SIZE * 2 - TILE_SIZE; // = 0.4

// A removed tile drops away under gravity (tumbling) instead of squashing in place.
const TILE_FALL_GRAVITY = 26;   // world units / s² downward acceleration
const TILE_FALL_FLOOR = -6;     // world Y at which the tile is gone from view

// Blast countdown: a triggered blast counts BLAST_COUNT_FROM…1 before detonating.
// Tune these to change the countdown — e.g. a faster fuse or more steps.
export const BLAST_COUNT_FROM = 3;        // numbers shown before it blows (3,2,1)
export const BLAST_COUNT_INTERVAL = 0.6;  // seconds each number stays on screen

export type Direction = 'right' | 'left' | 'forward' | 'back';

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

export type TileAction =
  | { type: 'none' }
  | { type: 'slide'; dir: Direction; toCol: number; toRow: number }
  | { type: 'teleport'; toCol: number; toRow: number };

type TileState = 'active' | 'gone';

interface DisappearAnim {
  tile: THREE.Group;
  startTime: number;
  baseY: number;
  spinX: number;
  spinZ: number;
}

interface TileBob {
  group: THREE.Group;
  baseY: number;
  phase: number;
  freq: number;
  amp: number;
}

export interface Level {
  group: THREE.Group;
  effects: Effects;
  tiles: Map<string, THREE.Group>;
  cols: number;
  rows: number;
  cellDefs: Map<string, CellDef>;
  cellToWorld: (col: number, row: number) => THREE.Vector3;
  update: (elapsed: number, activeKey: string | null) => void;
  isTraversable: (col: number, row: number) => boolean;
  onPlayerLand: (
    col: number,
    row: number,
    fromCol: number,
    fromRow: number,
    elapsed: number,
  ) => TileAction;
  isBase: (col: number, row: number) => boolean;
  isWon: (playerCol: number, playerRow: number) => boolean;
  remaining: () => number;
}

export function buildLevel(layout: LevelLayout, template: THREE.Group, tileHeight: number): Level {
  const rows = layout.length;
  const cols = Math.max(...layout.map((r) => r.length));

  const group = new THREE.Group();
  const effects = createEffects();
  group.add(effects.group);
  // The latest elapsed time, refreshed at the top of update(). Sphere onReach
  // callbacks read this so a removed tile's fall starts exactly when the sphere
  // arrives, not when the sequence was first triggered.
  let frameElapsed = 0;

  const tiles = new Map<string, THREE.Group>();
  const cellDefs = new Map<string, CellDef>();
  const tileStates = new Map<string, TileState>();
  const bobs = new Map<string, TileBob>();
  const anims: DisappearAnim[] = [];
  const decorationUpdaters: Array<(t: number) => void> = [];

  // Blast bookkeeping: per-explosive visuals (pulse + countdown digit), the set
  // of blasts currently counting down, and line tiles that have already fired.
  const explosiveVisuals = new Map<string, { normal: THREE.Group; countdown: Countdown }>();
  const blastTimers = new Map<string, { startTime: number }>();
  const triggeredLines = new Set<string>();

  const step = TILE_SIZE + TILE_GAP;
  const offsetX = -((cols - 1) * step) / 2;
  const offsetZ = -((rows - 1) * step) / 2;

  const cellToWorld = (col: number, row: number) =>
    new THREE.Vector3(offsetX + col * step, 0, offsetZ + row * step);

  // Spheres float a little above the tile tops as they travel.
  const SPHERE_Y = tileHeight / 2 + 0.18;
  const sphereOrigin = (col: number, row: number) => {
    const v = cellToWorld(col, row);
    v.y = SPHERE_Y;
    return v;
  };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < layout[row].length; col++) {
      const cell = layout[row][col];
      if (!cell) continue;
      const { kind } = cell;
      const tile = createTile({ kind, template });
      const pos = cellToWorld(col, row);
      tile.position.copy(pos);
      group.add(tile);
      const key = `${col},${row}`;
      tiles.set(key, tile);
      cellDefs.set(key, cell);
      tileStates.set(key, 'active');
      bobs.set(key, {
        group: tile,
        baseY: pos.y,
        phase: det(col * 17 + row * 31) * Math.PI * 2,
        freq: 2.0 + det(col * 13 + row * 7) * 1.5,
        amp: 0.008 + det(col * 23 + row * 11) * 0.012,
      });

      if (kind === 'explosive') {
        // Blast tiles carry a free-running pulse plus a hidden countdown overlay
        // that only appears once the blast is armed.
        const normal = createExplosiveDecoration(0xf87171);
        const countdown = createCountdownDecoration(0xfff1b8);
        tile.add(normal.group);
        tile.add(countdown.group);
        decorationUpdaters.push(normal.update);
        explosiveVisuals.set(key, { normal: normal.group, countdown });
      } else {
        const dec = (() => {
          switch (kind) {
            case 'arrow':            return cell.dir ? createArrowDecoration(cell.dir, 0xfde047) : null;
            case 'base':             return createBaseDecoration(0xe2e8f0);
            case 'disappear-normal': return createDisappearNormalDecoration(0x4ade80);
            case 'disappear-line':   return createDisappearLineDecoration(cell.sweepDir ?? 'row', 0xfb923c);
            case 'shift':            return createShiftDecoration(0x22d3ee);
            default:                 return null;
          }
        })();
        if (dec) {
          tile.add(dec.group);
          decorationUpdaters.push(dec.update);
        }
      }
    }
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  function removeTile(key: string, elapsed: number, delay = 0): void {
    const def = cellDefs.get(key);
    if (!def || def.kind === 'base') return;
    if (tileStates.get(key) !== 'active') return;
    tileStates.set(key, 'gone');
    const tile = tiles.get(key)!;
    const bob = bobs.get(key)!;
    // Deterministic per-tile tumble so falling tiles don't drop in lock-step.
    const spinX = (det(key.length + bob.phase) - 0.5) * 5;
    const spinZ = (det(bob.freq * 7 + bob.amp) - 0.5) * 5;
    anims.push({ tile, startTime: elapsed + delay, baseY: bob.baseY, spinX, spinZ });
  }

  // ── Chain reaction: blasts (delayed) and lines (immediate) trigger each other ─
  //
  // Arming a blast starts a 3-2-1 countdown (driven in update()); when it
  // detonates it removes the green tiles around it, falls itself, and triggers
  // neighbouring special tiles. A disappear-line removes the normal tiles in its
  // line at once and triggers any blast/line tiles sharing that line. Blasts and
  // lines set each other off, so effects cascade across the board.

  // Light a blast's fuse: starts the 3-2-1 countdown driven in update(). Called
  // when the cube steps OFF a blast (landmine) or when a chain reaches one.
  function igniteBlast(key: string, elapsed: number): void {
    if (tileStates.get(key) !== 'active') return;   // already gone
    if (blastTimers.has(key)) return;               // already counting down
    const vis = explosiveVisuals.get(key);
    if (vis) vis.normal.visible = false;            // swap the pulse for the digits
    blastTimers.set(key, { startTime: elapsed });
  }

  // The effect a travelling sphere applies the instant it reaches `key`. Mirrors
  // the original per-cell switch; runs at frameElapsed (the sphere's arrival).
  function reachTile(key: string): void {
    const def = cellDefs.get(key);
    if (!def) return;
    if (def.kind === 'disappear-normal') removeTile(key, frameElapsed);
    else if (def.kind === 'explosive') igniteBlast(key, frameElapsed);
    else if (def.kind === 'disappear-line') activateLine(key, frameElapsed);
    // arrow / shift / base: left untouched
  }

  function activateLine(startKey: string, elapsed: number): void {
    if (triggeredLines.has(startKey)) return;   // the line tile persists; it fires once
    triggeredLines.add(startKey);
    const def = cellDefs.get(startKey);
    if (!def) return;
    const [col, row] = startKey.split(',').map(Number);
    const sweepDir = def.sweepDir ?? 'row';
    const origin = sphereOrigin(col, row);

    // Two orange spheres fly out from the trigger, one each way along the line,
    // clearing every tile they pass. Recursion into another line tile spawns its
    // own perpendicular spheres, so chains still cascade across the board.
    const sides: [number, number][] = sweepDir === 'row' ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    for (const [dc, dr] of sides) {
      const targets: ReachTarget[] = [];
      let c = col + dc;
      let r = row + dr;
      while (c >= 0 && c < cols && r >= 0 && r < rows) {
        const k = `${c},${r}`;
        if (cellDefs.has(k)) targets.push({ pos: sphereOrigin(c, r), onReach: () => reachTile(k) });
        c += dc;
        r += dr;
      }
      if (targets.length) effects.spawnProjectile({ origin, color: 0xea580c, targets, startTime: elapsed });
    }
  }

  function detonateBlast(key: string, elapsed: number): void {
    blastTimers.delete(key);
    explosiveVisuals.get(key)?.countdown.hide();
    removeTile(key, elapsed);             // the blast falls itself

    // A red sphere flies to each of the four neighbours, removing the green tiles
    // and lighting any neighbouring fuse / line as it arrives.
    const [col, row] = key.split(',').map(Number);
    const origin = sphereOrigin(col, row);
    const neighbours: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dc, dr] of neighbours) {
      const c = col + dc;
      const r = row + dr;
      const k = `${c},${r}`;
      if (!cellDefs.has(k)) continue;
      effects.spawnProjectile({
        origin,
        color: 0xdc2626,
        targets: [{ pos: sphereOrigin(c, r), onReach: () => reachTile(k) }],
        startTime: elapsed,
      });
    }
  }

  function isTraversable(col: number, row: number): boolean {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return false;
    return tileStates.get(`${col},${row}`) === 'active';
  }

  function isBase(col: number, row: number): boolean {
    return cellDefs.get(`${col},${row}`)?.kind === 'base';
  }

  function isWon(playerCol: number, playerRow: number): boolean {
    if (!isBase(playerCol, playerRow)) return false;
    for (const [key, state] of tileStates) {
      if (cellDefs.get(key)!.kind === 'disappear-normal' && state !== 'gone') return false;
    }
    return true;
  }

  function remaining(): number {
    let count = 0;
    tileStates.forEach((state, key) => {
      if (cellDefs.get(key)!.kind === 'disappear-normal' && state === 'active') count++;
    });
    return count;
  }

  // ─── per-tile behaviours ────────────────────────────────────────────────────

  function onPlayerLand(
    col: number,
    row: number,
    fromCol: number,
    fromRow: number,
    elapsed: number,
  ): TileAction {
    const fromKey = `${fromCol},${fromRow}`;
    const toKey = `${col},${row}`;
    const fromDef = cellDefs.get(fromKey);
    const toDef = cellDefs.get(toKey);

    // Stepping off a tile: disappear-normal tiles crumble away; a blast behaves
    // like a landmine — armed while the cube sits on it, fuse lit once it leaves.
    // Arrow / shift / disappear-line tiles persist (reusable / triggered).
    if (fromDef && fromDef.kind === 'disappear-normal') {
      removeTile(fromKey, elapsed);
    } else if (fromDef && fromDef.kind === 'explosive') {
      igniteBlast(fromKey, elapsed);
    }

    if (!toDef) return { type: 'none' };

    switch (toDef.kind) {

      // Landing on a blast only arms it (like pressing a landmine); the fuse is
      // lit when the cube steps off — handled in the step-off block above.

      case 'disappear-line':
        activateLine(toKey, elapsed);
        break;

      case 'arrow': {
        if (!toDef.dir) break;
        const D: Record<Direction, [number, number]> = {
          right: [1, 0], left: [-1, 0], forward: [0, 1], back: [0, -1],
        };
        const [dc, dr] = D[toDef.dir];
        // Always push in the arrow's direction. The caller decides whether the
        // target is solid ground (a move) or empty space (a fall off the edge).
        return { type: 'slide', dir: toDef.dir, toCol: col + dc, toRow: row + dr };
      }

      case 'shift': {
        if (toDef.shiftId === undefined) break;
        let partnerKey: string | null = null;
        cellDefs.forEach((def, key) => {
          if (!partnerKey && key !== toKey && def.kind === 'shift' && def.shiftId === toDef.shiftId) {
            if (tileStates.get(key) === 'active') partnerKey = key;
          }
        });
        // Don't teleport back if we just arrived from the partner (would infinite-loop).
        if (partnerKey && partnerKey !== fromKey) {
          const [pc, pr] = (partnerKey as string).split(',').map(Number);
          return { type: 'teleport', toCol: pc, toRow: pr };
        }
        break;
      }

      default:
        break;
    }

    return { type: 'none' };
  }

  // ─── level object ───────────────────────────────────────────────────────────

  return {
    group,
    effects,
    tiles,
    cols,
    rows,
    cellDefs,
    cellToWorld,
    isTraversable,
    onPlayerLand,
    isBase,
    isWon,
    remaining,

    update(elapsed: number, activeKey: string | null) {
      frameElapsed = elapsed;

      bobs.forEach((b, key) => {
        if (tileStates.get(key) === 'gone') return;
        b.group.position.y =
          key === activeKey
            ? b.baseY
            : b.baseY + Math.sin(elapsed * b.freq + b.phase) * b.amp;
      });

      for (let i = anims.length - 1; i >= 0; i--) {
        const a = anims[i];
        const age = elapsed - a.startTime;
        if (age < 0) continue;
        const y = a.baseY - 0.5 * TILE_FALL_GRAVITY * age * age;
        a.tile.position.y = y;
        a.tile.rotation.x = a.spinX * age;
        a.tile.rotation.z = a.spinZ * age;
        if (y < TILE_FALL_FLOOR) {
          a.tile.visible = false;
          anims.splice(i, 1);
        }
      }

      // Advance any blast countdowns: show 3→2→1, then detonate.
      if (blastTimers.size > 0) {
        const due: string[] = [];
        blastTimers.forEach((timer, key) => {
          const since = elapsed - timer.startTime;
          if (since >= BLAST_COUNT_FROM * BLAST_COUNT_INTERVAL) {
            due.push(key);
          } else {
            const n = BLAST_COUNT_FROM - Math.floor(since / BLAST_COUNT_INTERVAL);
            explosiveVisuals.get(key)?.countdown.show(n);
          }
        });
        for (const key of due) detonateBlast(key, elapsed);
      }

      for (const upd of decorationUpdaters) upd(elapsed);

      effects.update(elapsed);
    },
  };
}

// ─── layout helpers ────────────────────────────────────────────────────────────

/** Parse a compact string layout into CellDef[][].
 *  'r' = disappear-line row, 'c' = disappear-line col.
 *  Arrow tiles default to dir:'right'; all shift tiles share shiftId 1. */
export function parseLayout(rows: string[]): LevelLayout {
  return rows.map((r) =>
    r.split('').map((ch): CellDef | null => {
      if (ch === '.') return null;
      if (ch === 'b') return { kind: 'base' };
      if (ch === 'n') return { kind: 'disappear-normal' };
      if (ch === 'r') return { kind: 'disappear-line', sweepDir: 'row' };
      if (ch === 'c') return { kind: 'disappear-line', sweepDir: 'col' };
      if (ch === 'x') return { kind: 'explosive' };
      if (ch === 'a') return { kind: 'arrow', dir: 'right' };
      if (ch === 't') return { kind: 'shift', shiftId: 1 };
      throw new Error(`Unknown layout char: "${ch}"`);
    }),
  );
}

// Demo level: 5×5 board demonstrating every tile kind.
// Base at (1,2). Row-wipe at (1,0) clears its row; col-wipe at (1,1) clears its column.
//
//   col:  0        1        2        3        4
//  row 0: n        r        x        n        n
//  row 1: n        c        t₁       n        n
//  row 2: n        B        n        n        a→back
//  row 3: n        n        t₁       n        n
//  row 4: n        r        n        c        n
//
// Shift pair t₁: (2,1) ↔ (2,3)
// Arrow at (4,2) slides the cube to (4,1) (dir:'back')
export const DEMO_LAYOUT: LevelLayout = [
  /* row 0 */
  [
    { kind: 'disappear-normal' },
    { kind: 'disappear-line', sweepDir: 'row' },
    { kind: 'explosive' },
    { kind: 'disappear-normal' },
    { kind: 'disappear-normal' },
  ],
  /* row 1 */
  [
    { kind: 'disappear-normal' },
    { kind: 'disappear-line', sweepDir: 'col' },
    { kind: 'shift', shiftId: 1 },
    { kind: 'disappear-normal' },
    { kind: 'disappear-normal' },
  ],
  /* row 2 */
  [
    { kind: 'disappear-normal' },
    { kind: 'base' },
    { kind: 'disappear-normal' },
    { kind: 'disappear-normal' },
    { kind: 'arrow', dir: 'back' },
  ],
  /* row 3 */
  [
    { kind: 'disappear-normal' },
    { kind: 'disappear-normal' },
    { kind: 'shift', shiftId: 1 },
    { kind: 'disappear-normal' },
    { kind: 'disappear-normal' },
  ],
  /* row 4 */
  [
    { kind: 'disappear-normal' },
    { kind: 'disappear-line', sweepDir: 'row' },
    { kind: 'disappear-normal' },
    { kind: 'disappear-line', sweepDir: 'col' },
    { kind: 'disappear-normal' },
  ],
];

function det(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
