import * as THREE from 'three';
import type { Direction } from '../core';

// Animated decorations sit on top of each tile: an 8×8 grid of small cubes that
// rise and sink frame by frame to spell out a looping motif (arrows, pulses,
// portals, fuses). All kinds share one animator and one cube-grid builder; only
// their frame data differs.

const GRID = 8;
const STEP = 0.075;
const CUBE_W = 0.055;
const BASE_Y = 0.06;
// One per-frame duration shared by every decoration so they animate in step.
const FRAME_DURATION = 0.5;

// Cubes sit RISE_HEIGHT above BASE_Y when fully "up", giving visible travel
// before they sink back below the platform surface.
const RISE_HEIGHT = 0.03;
const TOP_Y = BASE_Y + RISE_HEIGHT;     // fully raised
const BOTTOM_Y = BASE_Y - 0.04;         // hidden under the platform

// Fraction of each frame spent rising/sinking; the rest is a dwell at the target
// height. The dwell stops a cube lit for a single frame from instantly reversing.
const TRANSITION_FRAC = 0.5;

/** A decoration frame: GRID×GRID of 0/1 marking which cubes are raised. */
type Frame = number[][];

const BASE: Frame = [
  [1, 0, 0, 0, 1, 0, 0, 0],
  [0, 1, 0, 0, 0, 1, 0, 0],
  [0, 0, 1, 0, 0, 0, 1, 0],
  [0, 0, 0, 1, 0, 0, 0, 1],
  [0, 0, 0, 1, 0, 0, 0, 1],
  [0, 0, 1, 0, 0, 0, 1, 0],
  [0, 1, 0, 0, 0, 1, 0, 0],
  [1, 0, 0, 0, 1, 0, 0, 0],
];

const shiftRight = (f: Frame, k: number): Frame =>
  f.map((row) => row.map((_, c) => row[(c - k + GRID) % GRID]));

const rot90cw = (f: Frame): Frame =>
  Array.from({ length: GRID }, (_, r) =>
    Array.from({ length: GRID }, (_, c) => f[GRID - 1 - c][r]),
  );

const RIGHT_FRAMES: Frame[] = [0, 1, 2, 3].map((k) => shiftRight(BASE, k));
const FWD_FRAMES = RIGHT_FRAMES.map(rot90cw);
const LEFT_FRAMES = FWD_FRAMES.map(rot90cw);
const BACK_FRAMES = LEFT_FRAMES.map(rot90cw);

const ALL_FRAMES: Record<Direction, Frame[]> = {
  right: RIGHT_FRAMES,
  forward: FWD_FRAMES,
  left: LEFT_FRAMES,
  back: BACK_FRAMES,
};

function cubeY(inPrev: boolean, inCur: boolean, t: number): number {
  if (inPrev && inCur) return TOP_Y;                          // stable
  if (inPrev && !inCur) return TOP_Y + (BOTTOM_Y - TOP_Y) * t; // sinking
  if (!inPrev && inCur) return BOTTOM_Y + (TOP_Y - BOTTOM_Y) * t; // rising
  return BOTTOM_Y;                                            // fully sunk
}

/** Build the shared 8×8 cube grid into `group`, returning the meshes by [row][col]. */
function buildCubeGrid(group: THREE.Group, material: THREE.Material): THREE.Mesh[][] {
  const geo = new THREE.BoxGeometry(CUBE_W, CUBE_W, CUBE_W);
  return Array.from({ length: GRID }, (_, r) =>
    Array.from({ length: GRID }, (_, c) => {
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set((c - (GRID - 1) / 2) * STEP, BOTTOM_Y, (r - (GRID - 1) / 2) * STEP);
      mesh.visible = false;
      group.add(mesh);
      return mesh;
    }),
  );
}

export interface Decoration {
  group: THREE.Group;
  update: (elapsed: number) => void;
}

/** A free-running decoration cycling through `frames` at FRAME_DURATION each. */
function makeDecoration(frames: Frame[], color: number): Decoration {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1 });
  const cubes = buildCubeGrid(group, material);

  // Random phase so decorations of the same kind don't animate in lock-step.
  const phase = Math.random() * FRAME_DURATION * frames.length;
  // prevFrameIdx/curFrameIdx start at -1; on the first update we set prev = cur
  // so the opening frame appears stable rather than rising from nowhere.
  let prevFrameIdx = -1;
  let curFrameIdx = -1;

  return {
    group,
    update(elapsed: number) {
      const frameFloat = (elapsed + phase) / FRAME_DURATION;
      const fi = Math.floor(frameFloat) % frames.length;
      const ramp = Math.min(1, (frameFloat - Math.floor(frameFloat)) / TRANSITION_FRAC);

      if (fi !== curFrameIdx) {
        prevFrameIdx = curFrameIdx === -1 ? fi : curFrameIdx;
        curFrameIdx = fi;
      }

      const cur = frames[curFrameIdx];
      const prev = frames[prevFrameIdx];
      for (let r = 0; r < GRID; r++) {
        for (let c = 0; c < GRID; c++) {
          const y = cubeY(prev[r]?.[c] === 1, cur[r]?.[c] === 1, ramp);
          const mesh = cubes[r][c];
          mesh.position.y = y;
          mesh.visible = y > BOTTOM_Y + 0.001;
        }
      }
    },
  };
}

export function createArrowDecoration(dir: Direction, color: number): Decoration {
  return makeDecoration(ALL_FRAMES[dir], color);
}

export function createBaseDecoration(color: number): Decoration {
  return makeDecoration(
    [
      [
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ],
      [
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 1, 1, 1, 1, 0, 0],
        [0, 0, 1, 1, 1, 1, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ],
      [
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 1, 1, 1, 1, 1, 1, 0],
        [0, 1, 1, 1, 1, 1, 1, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ],
      [
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [1, 1, 1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1, 1, 1],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
      ],
    ],
    color,
  );
}

export function createDisappearNormalDecoration(color: number): Decoration {
  // Concentric square "radar" pulse: a ring rises at the centre and travels
  // outward to the edge, then repeats — a calm, even pulse for a plain tile.
  const CENTER = (GRID - 1) / 2;
  const ring = (r: number, c: number) =>
    Math.round(Math.max(Math.abs(r - CENTER), Math.abs(c - CENTER)) - 0.5);
  const frames = Array.from({ length: 4 }, (_, k) =>
    Array.from({ length: GRID }, (_, r) =>
      Array.from({ length: GRID }, (_, c) => (ring(r, c) === k ? 1 : 0)),
    ),
  );
  return makeDecoration(frames, color);
}

// Two lines closing in from opposite edges then bouncing back out, looping.
export function createDisappearLineDecoration(sweepDir: 'row' | 'col', color: number): Decoration {
  const R = [1, 1, 1, 1, 1, 1, 1, 1];
  const E = [0, 0, 0, 0, 0, 0, 0, 0];

  if (sweepDir === 'row') {
    return makeDecoration(
      [
        [R, E, E, E, E, E, E, R],
        [E, R, E, E, E, E, R, E],
        [E, E, R, E, E, R, E, E],
        [E, E, E, R, R, E, E, E],
        [E, E, R, E, E, R, E, E],
        [E, R, E, E, E, E, R, E],
      ],
      color,
    );
  }
  return makeDecoration(
    [
      Array.from({ length: GRID }, () => [1, 0, 0, 0, 0, 0, 0, 1]),
      Array.from({ length: GRID }, () => [0, 1, 0, 0, 0, 0, 1, 0]),
      Array.from({ length: GRID }, () => [0, 0, 1, 0, 0, 1, 0, 0]),
      Array.from({ length: GRID }, () => [0, 0, 0, 1, 1, 0, 0, 0]),
      Array.from({ length: GRID }, () => [0, 0, 1, 0, 0, 1, 0, 0]),
      Array.from({ length: GRID }, () => [0, 1, 0, 0, 0, 0, 1, 0]),
    ],
    color,
  );
}

export function createShiftDecoration(color: number): Decoration {
  return makeDecoration(
    [
      [
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 1, 1],
        [0, 0, 0, 0, 0, 0, 1, 1],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ],
      [
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 1, 1],
        [0, 0, 0, 0, 0, 0, 1, 1],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
      ],
      [
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [1, 1, 0, 0, 0, 0, 0, 0],
        [1, 1, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
      ],
      [
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [1, 1, 0, 0, 0, 0, 0, 0],
        [1, 1, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ],
    ],
    color,
  );
}

export function createExplosiveDecoration(color: number): Decoration {
  return makeDecoration(
    [
      [
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [1, 1, 1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1, 1, 1],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
      ],
      [
        [1, 0, 0, 1, 1, 0, 0, 1],
        [0, 1, 0, 1, 1, 0, 1, 0],
        [0, 0, 1, 1, 1, 1, 0, 0],
        [1, 1, 1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1, 1, 1],
        [0, 0, 1, 1, 1, 1, 0, 0],
        [0, 1, 0, 1, 1, 0, 1, 0],
        [1, 0, 0, 1, 1, 0, 0, 1],
      ],
      [
        [1, 0, 0, 0, 0, 0, 0, 1],
        [0, 1, 0, 0, 0, 0, 1, 0],
        [0, 0, 1, 0, 0, 1, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 0, 1, 1, 0, 0, 0],
        [0, 0, 1, 0, 0, 1, 0, 0],
        [0, 1, 0, 0, 0, 0, 1, 0],
        [1, 0, 0, 0, 0, 0, 0, 1],
      ],
      [
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ],
    ],
    color,
  );
}

// 8×8 bitmaps for the blast countdown digits, in the same cube-grid language.
const COUNTDOWN_DIGITS: Record<number, Frame> = {
  3: [
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 0, 0, 0, 0, 1, 1, 0],
    [0, 0, 0, 1, 1, 1, 0, 0],
    [0, 0, 0, 1, 1, 1, 0, 0],
    [0, 0, 0, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
  ],
  2: [
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 0, 0, 0, 0, 1, 1, 0],
    [0, 0, 0, 0, 1, 1, 0, 0],
    [0, 0, 0, 1, 1, 0, 0, 0],
    [0, 0, 1, 1, 0, 0, 0, 0],
    [0, 1, 1, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 0],
  ],
  1: [
    [0, 0, 0, 1, 1, 0, 0, 0],
    [0, 0, 1, 1, 1, 0, 0, 0],
    [0, 1, 1, 1, 1, 0, 0, 0],
    [0, 0, 0, 1, 1, 0, 0, 0],
    [0, 0, 0, 1, 1, 0, 0, 0],
    [0, 0, 0, 1, 1, 0, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 1, 1, 1, 1, 1, 0],
  ],
};

export interface Countdown {
  group: THREE.Group;
  /** Show the digit for n (1..3); any other value hides the countdown. */
  show: (n: number) => void;
  hide: () => void;
}

// A state-driven decoration (not free-running): shows a raised digit on demand
// while a blast counts down, then hides on detonation.
export function createCountdownDecoration(color: number): Countdown {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.35,
    metalness: 0.1,
    emissive: color,
    emissiveIntensity: 0.7,
  });
  const cubes = buildCubeGrid(group, material);

  const render = (frame: Frame | null): void => {
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const on = !!frame && frame[r][c] === 1;
        const mesh = cubes[r][c];
        mesh.visible = on;
        mesh.position.y = on ? TOP_Y : BOTTOM_Y;
      }
    }
  };

  return {
    group,
    show: (n: number) => render(COUNTDOWN_DIGITS[n] ?? null),
    hide: () => render(null),
  };
}
