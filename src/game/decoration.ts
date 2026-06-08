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

// 8×8 bitmaps for every digit, in the same cube-grid language. The blast
// countdown uses 1–3; the level-select odometer (createNumberDisplay) uses all
// ten. A 2-cell stroke keeps each glyph legible at this resolution.
const DIGITS: Record<number, Frame> = {
  0: [
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
  ],
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
  4: [
    [0, 0, 0, 0, 1, 1, 0, 0],
    [0, 0, 0, 1, 1, 1, 0, 0],
    [0, 0, 1, 1, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 0, 0, 0, 1, 1, 0],
    [0, 0, 0, 0, 0, 1, 1, 0],
    [0, 0, 0, 0, 0, 1, 1, 0],
  ],
  5: [
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 1, 0, 0, 0, 0, 0],
    [0, 1, 1, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 1, 0, 0],
    [0, 0, 0, 0, 0, 1, 1, 0],
    [0, 0, 0, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
  ],
  6: [
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
  ],
  7: [
    [0, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 0, 0, 0, 1, 1, 0],
    [0, 0, 0, 0, 1, 1, 0, 0],
    [0, 0, 0, 1, 1, 0, 0, 0],
    [0, 0, 0, 1, 1, 0, 0, 0],
    [0, 0, 0, 1, 1, 0, 0, 0],
    [0, 0, 0, 1, 1, 0, 0, 0],
    [0, 0, 0, 1, 1, 0, 0, 0],
  ],
  8: [
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
  ],
  9: [
    [0, 0, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 1, 0],
    [0, 0, 0, 0, 0, 1, 1, 0],
    [0, 1, 1, 0, 0, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 0, 0],
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
    show: (n: number) => render(DIGITS[n] ?? null),
    hide: () => render(null),
  };
}

// ─── info beacon ────────────────────────────────────────────────────────────────
// A tile that holds hidden content looks like an ordinary green tile; its only
// tell is this beacon, which stands a real 3D lowercase "i" upright on the
// platform with a small swirl of cubes orbiting it. The swirl spins and the
// glyph bobs gently so the marker reads in 3D and draws the eye to "land here".
export function createInfoDecoration(color: number): Decoration {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.3,
    metalness: 0.15,
    emissive: color,
    emissiveIntensity: 0.8,
  });

  // The "i": a tall stem with a separate dot floating above it.
  const STEM_W = 0.05;
  const STEM_H = 0.16;
  const stemBaseY = BASE_Y + STEM_H / 2;
  const dotBaseY = BASE_Y + STEM_H + STEM_W * 1.5;

  const stem = new THREE.Mesh(new THREE.BoxGeometry(STEM_W, STEM_H, STEM_W), material);
  stem.castShadow = true;
  group.add(stem);

  const dot = new THREE.Mesh(new THREE.BoxGeometry(STEM_W, STEM_W, STEM_W), material);
  dot.castShadow = true;
  group.add(dot);

  // The swirl: a handful of cubes set on a tilted ring around the stem, tapering
  // comet-like. Spinning the ring on Y sweeps them around the "i".
  const swirl = new THREE.Group();
  swirl.rotation.z = 0.35;                       // tilt the orbit so it reads in 3D
  swirl.position.y = BASE_Y + STEM_H * 0.55;
  group.add(swirl);

  const SWIRL_COUNT = 7;
  const ORBIT_R = 0.12;
  for (let i = 0; i < SWIRL_COUNT; i++) {
    const t = i / SWIRL_COUNT;
    const s = 0.026 * (1 - t) + 0.006;           // trailing cubes shrink
    const cube = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), material);
    const a = t * Math.PI * 2;
    cube.position.set(Math.cos(a) * ORBIT_R, (t - 0.5) * 0.09, Math.sin(a) * ORBIT_R);
    swirl.add(cube);
  }

  return {
    group,
    update(elapsed: number) {
      swirl.rotation.y = elapsed * 2.2;
      const bob = Math.sin(elapsed * 2.4) * 0.012;
      stem.position.y = stemBaseY + bob;
      dot.position.y = dotBaseY + bob;
    },
  };
}

// ─── level-select odometer ──────────────────────────────────────────────────────
// A 3-digit number (000–999) rendered as raised cubes on a platform, used by the
// home-page level grid. Each digit is its own 8×8 cell; changed digits roll
// vertically like a mechanical counter. Designed to fit a single 1.0 tile.

const NUM_STEP = 0.028;                       // cube spacing within a digit cell
const NUM_CUBE = 0.022;                       // small cube size
const NUM_DIGIT_PITCH = 0.255;                // X distance between digit centres
const NUM_BOTTOM_Y = BASE_Y - 0.03;           // hidden under the surface
const NUM_TOP_Y = BASE_Y + 0.02;              // raised
const NUM_ROLL_DURATION = 0.5;                // seconds for one digit to roll over

// One geometry shared by every odometer cube across every display — the level
// grid can show a dozen displays at once, so per-cube allocation is avoided.
const NUMBER_CUBE_GEO = new THREE.BoxGeometry(NUM_CUBE, NUM_CUBE, NUM_CUBE);

export interface NumberDisplay {
  group: THREE.Group;
  /** Show n (0…10^maxDigits − 1) — no leading zeros, centred on the platform. */
  set: (n: number) => void;
  /** Drive the roll animation; call each frame with absolute elapsed seconds. */
  update: (elapsed: number) => void;
}

interface DigitCell {
  group: THREE.Group;
  cubes: THREE.Mesh[][];
  shown: number | null;  // null = inactive (leading-zero slot, hidden)
  from: number;          // digit rolling out the top
  to: number;            // digit rolling in / currently shown
  rollStart: number | null;
}

export function createNumberDisplay(color: number, maxDigits = 3): NumberDisplay {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.4,
    metalness: 0.1,
    emissive: color,
    emissiveIntensity: 0.55,
  });

  const cells: DigitCell[] = Array.from({ length: maxDigits }, () => {
    const cellGroup = new THREE.Group();
    cellGroup.visible = false;
    group.add(cellGroup);
    const cubes = Array.from({ length: GRID }, (_, r) =>
      Array.from({ length: GRID }, (_, c) => {
        const mesh = new THREE.Mesh(NUMBER_CUBE_GEO, material);
        // No shadows: many displays animate at once and they read fine lit.
        mesh.position.set((c - (GRID - 1) / 2) * NUM_STEP, NUM_BOTTOM_Y, (r - (GRID - 1) / 2) * NUM_STEP);
        mesh.visible = false;
        cellGroup.add(mesh);
        return mesh;
      }),
    );
    return { group: cellGroup, cubes, shown: null, from: 0, to: 0, rollStart: null };
  });

  let lastElapsed = 0;

  // Render a cell from its `from` glyph rolling up into its `to` glyph at progress
  // p∈[0,1]. A 16-row virtual strip (from on top of to) slides up by p·GRID rows.
  const renderCell = (cell: DigitCell, p: number): void => {
    const from = DIGITS[cell.from] ?? DIGITS[0];
    const to = DIGITS[cell.to] ?? DIGITS[0];
    const shift = p * GRID;
    for (let r = 0; r < GRID; r++) {
      const src = Math.round(r + shift); // 0…GRID = from, GRID…2·GRID = to
      const frame = src < GRID ? from : to;
      const fr = src < GRID ? src : src - GRID;
      for (let c = 0; c < GRID; c++) {
        const on = !!frame[fr] && frame[fr][c] === 1;
        const mesh = cell.cubes[r][c];
        mesh.visible = on;
        mesh.position.y = on ? NUM_TOP_Y : NUM_BOTTOM_Y;
      }
    }
  };

  const renderStatic = (cell: DigitCell): void => {
    cell.from = cell.to;
    renderCell(cell, 0);
  };

  return {
    group,
    set(n: number) {
      const clamped = Math.max(0, Math.min(Math.round(n), 10 ** maxDigits - 1));
      const str = String(clamped);               // significant digits, no padding
      const len = str.length;
      cells.forEach((cell, i) => {
        if (i < len) {
          // Centre the significant digits across the platform.
          cell.group.position.x = (i - (len - 1) / 2) * NUM_DIGIT_PITCH;
          cell.group.visible = true;
          const d = Number(str[i]);
          if (cell.shown === null) { cell.from = 0; cell.to = d; cell.rollStart = lastElapsed; }
          else if (d !== cell.shown) { cell.from = cell.shown; cell.to = d; cell.rollStart = lastElapsed; }
          cell.shown = d;
        } else {
          cell.group.visible = false;
          cell.shown = null;
          cell.rollStart = null;
        }
      });
    },
    update(elapsed: number) {
      lastElapsed = elapsed;
      for (const cell of cells) {
        if (cell.rollStart === null) continue;
        const p = (elapsed - cell.rollStart) / NUM_ROLL_DURATION;
        if (p >= 1) {
          cell.rollStart = null;
          renderStatic(cell);
        } else {
          renderCell(cell, p);
        }
      }
    },
  };
}
