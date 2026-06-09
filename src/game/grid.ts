import * as THREE from 'three';
import { DIRECTION_DELTA, PALETTE, noise, cellKey, parseCellKey, type Direction } from '../core';
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
  createInfoDecoration,
  type Decoration,
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
  | { type: 'teleport'; toCol: number; toRow: number }
  | { type: 'info' };   // cube settled on the highlighted goal tile — reveal content

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
  /** Register a callback fired once when a blast destroys the tile under the player. */
  setOnPlayerLost: (fn: () => void) => void;
}

/** The free-running cube-grid decoration for a tile kind (blast handled separately). */
function makeDecorationForKind(cell: CellDef): Decoration | null {
  switch (cell.kind) {
    case 'arrow':            return cell.dir ? createArrowDecoration(cell.dir, PALETTE.decoration.arrow) : null;
    case 'base':             return createBaseDecoration(PALETTE.decoration.base);
    case 'disappear-normal': return createDisappearNormalDecoration(PALETTE.decoration['disappear-normal']);
    case 'disappear-line':   return createDisappearLineDecoration(cell.sweepDir ?? 'row', PALETTE.decoration['disappear-line']);
    case 'shift':            return createShiftDecoration(PALETTE.decoration.shift);
    // Info tiles look like a plain green tile (same radar pulse); the 3D "i"
    // beacon is added separately on top in the build loop.
    case 'info':             return createDisappearNormalDecoration(PALETTE.decoration['disappear-normal']);
    default:                 return null;
  }
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

  // Player tracking so a detonating blast can tell when the cube is caught in it.
  // playerKey is refreshed each frame from update()'s activeKey; onPlayerLost is
  // wired up by main.ts and fired (once) the moment a blast destroys the cube's tile.
  let playerKey: string | null = null;
  let playerLost = false;
  let onPlayerLost: (() => void) | null = null;

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
      // Info tiles are disguised as ordinary green tiles; the only hint that one
      // holds hidden content is the 3D "i" beacon added on top below.
      const visualKind: TileKind = cell.kind === 'info' ? 'disappear-normal' : cell.kind;
      const tile = createTile({ kind: visualKind, template });
      const pos = cellToWorld(col, row);
      tile.position.copy(pos);
      group.add(tile);

      const key = cellKey(col, row);
      tiles.set(key, tile);
      cellDefs.set(key, cell);
      tileStates.set(key, 'active');
      bobs.set(key, {
        group: tile,
        baseY: pos.y,
        phase: noise(col * 17 + row * 31) * Math.PI * 2,
        freq: 2.0 + noise(col * 13 + row * 7) * 1.5,
        amp: 0.008 + noise(col * 23 + row * 11) * 0.012,
      });

      if (cell.kind === 'explosive') {
        // Blast tiles carry a free-running pulse plus a hidden countdown overlay
        // that only appears once the blast is armed.
        const pulse = createExplosiveDecoration(PALETTE.decoration.explosive);
        const countdown = createCountdownDecoration(PALETTE.decoration.countdown);
        tile.add(pulse.group, countdown.group);
        decorationUpdaters.push(pulse.update);
        explosiveVisuals.set(key, { normal: pulse.group, countdown });
      } else {
        const dec = makeDecorationForKind(cell);
        if (dec) {
          tile.add(dec.group);
          decorationUpdaters.push(dec.update);
        }
        // The hidden-content marker: a standing 3D "i" with a swirl orbiting it,
        // sitting on top of the otherwise-normal green platform.
        if (cell.kind === 'info') {
          const beacon = createInfoDecoration(PALETTE.decoration.info);
          tile.add(beacon.group);
          decorationUpdaters.push(beacon.update);
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
    const spinX = (noise(key.length + bob.phase) - 0.5) * 5;
    const spinZ = (noise(bob.freq * 7 + bob.amp) - 0.5) * 5;
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
    // A line sweep clears greens and info alike; if it clears the tile under the cube, the cube
    // drops with it (loss), exactly like a blast.
    if (def.kind === 'disappear-normal' || def.kind === 'info') {
      removeTile(key, frameElapsed);
      losePlayerIfOn(key);
    } else if (def.kind === 'explosive') igniteBlast(key, frameElapsed);
    else if (def.kind === 'disappear-line') activateLine(key, frameElapsed);
    // arrow / shift / base: left untouched
  }

  function activateLine(startKey: string, elapsed: number): void {
    if (triggeredLines.has(startKey)) return;   // the line tile persists; it fires once
    triggeredLines.add(startKey);
    const def = cellDefs.get(startKey);
    if (!def) return;
    const [col, row] = parseCellKey(startKey);
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
        const k = cellKey(c, r);
        if (cellDefs.has(k)) targets.push({ pos: sphereOrigin(c, r), onReach: () => reachTile(k) });
        c += dc;
        r += dr;
      }
      if (targets.length) effects.spawnProjectile({ origin, color: PALETTE.effect.lineSphere, targets, startTime: elapsed });
    }
  }

  // Fire the player-lost callback once if the cube is sitting on `key` as it goes.
  function losePlayerIfOn(key: string): void {
    if (playerLost || key !== playerKey) return;
    playerLost = true;
    onPlayerLost?.();
  }

  // What a blast does to a neighbouring tile when its sphere arrives. Unlike a
  // line sphere (reachTile), a blast destroys whatever it touches — green tiles,
  // info tiles, arrows, shift portals and spent line tiles all fall away. Explosives
  // chain (their own fuse lights instead) and line tiles fire their sweep before
  // collapsing. Only the base is indestructible. If the cube is on the tile, it drops.
  function blastHit(key: string): void {
    const def = cellDefs.get(key);
    if (!def || def.kind === 'base') return;
    if (def.kind === 'explosive') { igniteBlast(key, frameElapsed); return; }
    if (def.kind === 'disappear-line') activateLine(key, frameElapsed);
    removeTile(key, frameElapsed);
    losePlayerIfOn(key);
  }

  function detonateBlast(key: string, elapsed: number): void {
    blastTimers.delete(key);
    explosiveVisuals.get(key)?.countdown.hide();
    removeTile(key, elapsed);             // the blast falls itself
    losePlayerIfOn(key);                  // armed and still stood on: cube drops with it

    // A red sphere flies to each of the four neighbours, destroying whatever tile
    // it finds and lighting any neighbouring fuse / line as it arrives.
    const [col, row] = parseCellKey(key);
    const origin = sphereOrigin(col, row);
    const neighbours: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dc, dr] of neighbours) {
      const c = col + dc;
      const r = row + dr;
      const k = cellKey(c, r);
      if (!cellDefs.has(k)) continue;
      effects.spawnProjectile({
        origin,
        color: PALETTE.effect.blastSphere,
        targets: [{ pos: sphereOrigin(c, r), onReach: () => blastHit(k) }],
        startTime: elapsed,
      });
    }
  }

  function isTraversable(col: number, row: number): boolean {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return false;
    return tileStates.get(cellKey(col, row)) === 'active';
  }

  function isBase(col: number, row: number): boolean {
    return cellDefs.get(cellKey(col, row))?.kind === 'base';
  }

  // 'info' tiles count toward completion exactly like 'disappear-normal' greens: the level
  // isn't done until the cube has cleared (stepped off) the info tile too — which guarantees
  // the player lands on it and sees the content.
  function countsForWin(kind: TileKind): boolean {
    return kind === 'disappear-normal' || kind === 'info';
  }

  function isWon(playerCol: number, playerRow: number): boolean {
    if (!isBase(playerCol, playerRow)) return false;
    for (const [key, state] of tileStates) {
      if (countsForWin(cellDefs.get(key)!.kind) && state !== 'gone') return false;
    }
    return true;
  }

  function remaining(): number {
    let count = 0;
    tileStates.forEach((state, key) => {
      if (countsForWin(cellDefs.get(key)!.kind) && state === 'active') count++;
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
    const fromKey = cellKey(fromCol, fromRow);
    const toKey = cellKey(col, row);
    const fromDef = cellDefs.get(fromKey);
    const toDef = cellDefs.get(toKey);

    // Stepping off a tile: disappear-normal and info tiles crumble away (info
    // tiles look like green tiles and are consumed once their content has been
    // revealed on landing); a blast behaves like a landmine — armed while the
    // cube sits on it, fuse lit once it leaves. Arrow / shift / disappear-line
    // tiles persist (reusable / triggered).
    if (fromDef && (fromDef.kind === 'disappear-normal' || fromDef.kind === 'info')) {
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
        const [dc, dr] = DIRECTION_DELTA[toDef.dir];
        // Always push in the arrow's direction. The caller decides whether the
        // target is solid ground (a move) or empty space (a fall off the edge).
        return { type: 'slide', dir: toDef.dir, toCol: col + dc, toRow: row + dr };
      }

      case 'info':
        // Landing reveals the tile's content; the tile itself crumbles like a
        // normal green tile once the cube rolls off (handled in the step-off block).
        return { type: 'info' };

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
          const [pc, pr] = parseCellKey(partnerKey as string);
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

    setOnPlayerLost(fn: () => void) {
      onPlayerLost = fn;
    },

    update(elapsed: number, activeKey: string | null) {
      frameElapsed = elapsed;
      playerKey = activeKey;

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

// Demo level: 5×5 board demonstrating every tile kind. Base at (1,2); row-wipe
// at (1,0), col-wipe at (1,1); shift pair (2,1)↔(2,3). See parseLayout for chars.
//
//   col:  0  1  2  3  4
//  row 0: n  r  x  n  n
//  row 1: n  c  t  n  n
//  row 2: n  b  n  n  a   ← arrow forced to 'back'
//  row 3: n  n  t  n  n
//  row 4: n  r  n  c  n
export const DEMO_LAYOUT: LevelLayout = parseLayout([
  'nrxnn',
  'nctnn',
  'nbnna',
  'nntnn',
  'nrncn',
]);
// The lone arrow slides the cube back toward base rather than the parser default.
DEMO_LAYOUT[2][4]!.dir = 'back';
