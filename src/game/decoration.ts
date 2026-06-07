import * as THREE from "three";

type Direction = "right" | "left" | "forward" | "back";

const GRID = 8;
const STEP = 0.075;
const CUBE_W = 0.055;
const BASE_Y = 0.06;
// Single per-frame duration shared by every decoration kind so they all animate
// at the same speed.
const FRAME_DURATION = 0.5;

// Cubes sit RISE_HEIGHT above BASE_Y when fully "up"; this gives visible travel
// distance before they disappear below the platform surface.
const RISE_HEIGHT = 0.03; // 0.15 / 4
const TOP_Y = BASE_Y + RISE_HEIGHT; // 0.1275 — fully raised
const BOTTOM_Y = BASE_Y - 0.04; //  0.060 — hidden under platform (raised slightly)

// Fraction of each frame spent rising/sinking; the rest is a dwell at the target
// height. The dwell prevents cubes lit for a single frame from rising and
// instantly reversing (a visible bounce). Applies to every decoration kind.
const TRANSITION_FRAC = 0.5;

type Row8 = [0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1];
type Frame = readonly [Row8, Row8, Row8, Row8, Row8, Row8, Row8, Row8];

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

function shiftRight(f: Frame, k: number): Frame {
  return f.map(
    (row) => row.map((_, c) => row[(c - k + GRID) % GRID]) as unknown as Row8,
  ) as unknown as Frame;
}

const RIGHT_FRAMES: readonly Frame[] = [0, 1, 2, 3].map((k) =>
  shiftRight(BASE, k),
);

function rot90cw(f: Frame): Frame {
  return Array.from({ length: GRID }, (_, r) =>
    Array.from({ length: GRID }, (_, c) => f[GRID - 1 - c][r] as 0 | 1),
  ) as unknown as Frame;
}

function rotateFrameSet(fs: readonly Frame[]): Frame[] {
  return fs.map(rot90cw);
}

const FWD_FRAMES = rotateFrameSet(RIGHT_FRAMES);
const LEFT_FRAMES = rotateFrameSet(FWD_FRAMES);
const BACK_FRAMES = rotateFrameSet(LEFT_FRAMES);

const ALL_FRAMES: Record<Direction, readonly Frame[]> = {
  right: RIGHT_FRAMES,
  forward: FWD_FRAMES,
  left: LEFT_FRAMES,
  back: BACK_FRAMES,
};

function cubeY(inPrev: boolean, inCur: boolean, t: number): number {
  if (inPrev && inCur) return TOP_Y; // stable
  if (inPrev && !inCur) return TOP_Y + (BOTTOM_Y - TOP_Y) * t; // sinking
  if (!inPrev && inCur) return BOTTOM_Y + (TOP_Y - BOTTOM_Y) * t; // rising
  return BOTTOM_Y; // fully sunk
}

function makeDecoration(frames: number[][][], color: number): Decoration {
  const group = new THREE.Group();
  // Random phase so decorations of the same kind don't animate in lock-step.
  const phase = Math.random() * FRAME_DURATION * frames.length;
  const geo = new THREE.BoxGeometry(CUBE_W, CUBE_W, CUBE_W);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.5,
    metalness: 0.1,
  });

  const cubes: THREE.Mesh[][] = Array.from({ length: GRID }, (_, r) =>
    Array.from({ length: GRID }, (_, c) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      m.position.set(
        (c - (GRID - 1) / 2) * STEP,
        BOTTOM_Y,
        (r - (GRID - 1) / 2) * STEP,
      );
      m.visible = false;
      group.add(m);
      return m;
    }),
  );

  // prevFrameIdx tracks which frame was active before the last switch.
  // Initialised to -1; on first update we set prev = cur so the first frame
  // appears stable (no rising animation from nowhere).
  let prevFrameIdx = -1;
  let curFrameIdx = -1;

  return {
    group,
    update(elapsed: number) {
      const frameFloat = (elapsed + phase) / FRAME_DURATION;
      const fi = Math.floor(frameFloat) % frames.length;
      const t = frameFloat - Math.floor(frameFloat); // 0 → 1 within current frame
      const ramp = Math.min(1, t / TRANSITION_FRAC); // rise/sink, then dwell

      if (fi !== curFrameIdx) {
        prevFrameIdx = curFrameIdx === -1 ? fi : curFrameIdx;
        curFrameIdx = fi;
      }

      const cur = frames[curFrameIdx];
      const prev = frames[prevFrameIdx];

      for (let r = 0; r < GRID; r++) {
        for (let c = 0; c < GRID; c++) {
          const inCur = !!cur[r]?.[c];
          const inPrev = !!prev[r]?.[c];
          const y = cubeY(inPrev, inCur, ramp);
          const m = cubes[r][c];
          m.position.y = y;
          m.visible = y > BOTTOM_Y + 0.001;
        }
      }
    },
  };
}

export interface Decoration {
  group: THREE.Group;
  update: (elapsed: number) => void;
}

export function createArrowDecoration(
  dir: Direction,
  color: number,
): Decoration {
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(CUBE_W, CUBE_W, CUBE_W);
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.5,
    metalness: 0.1,
  });

  const cubes: THREE.Mesh[][] = Array.from({ length: GRID }, (_, r) =>
    Array.from({ length: GRID }, (_, c) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(
        (c - (GRID - 1) / 2) * STEP,
        BOTTOM_Y,
        (r - (GRID - 1) / 2) * STEP,
      );
      mesh.visible = false;
      group.add(mesh);
      return mesh;
    }),
  );

  const frames = ALL_FRAMES[dir];
  // Random phase so arrows don't animate in lock-step.
  const phase = Math.random() * FRAME_DURATION * frames.length;
  let prevFrameIdx = -1;
  let curFrameIdx = -1;

  return {
    group,
    update(elapsed: number) {
      const frameFloat = (elapsed + phase) / FRAME_DURATION;
      const fi = Math.floor(frameFloat) % frames.length;
      const t = frameFloat - Math.floor(frameFloat);
      const ramp = Math.min(1, t / TRANSITION_FRAC); // rise/sink, then dwell

      if (fi !== curFrameIdx) {
        prevFrameIdx = curFrameIdx === -1 ? fi : curFrameIdx;
        curFrameIdx = fi;
      }

      const cur = frames[curFrameIdx];
      const prev = frames[prevFrameIdx];

      for (let r = 0; r < GRID; r++) {
        for (let c = 0; c < GRID; c++) {
          const inCur = cur[r][c] === 1;
          const inPrev = prev[r][c] === 1;
          const y = cubeY(inPrev, inCur, ramp);
          const mesh = cubes[r][c];
          mesh.position.y = y;
          mesh.visible = y > BOTTOM_Y + 0.001;
        }
      }
    },
  };
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
  // Concentric square "radar" pulse: a ring rises from the centre and travels
  // outward to the edge, then repeats. Reads as a calm, even pulse — much more
  // fitting for a plain tile than scrolling diagonals.
  const CENTER = (GRID - 1) / 2; // 3.5
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
export function createDisappearLineDecoration(
  sweepDir: "row" | "col",
  color: number,
): Decoration {
  const R = [1, 1, 1, 1, 1, 1, 1, 1];
  const E = [0, 0, 0, 0, 0, 0, 0, 0];

  if (sweepDir === "row") {
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
  } else {
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

// 8×8 bitmaps for the blast countdown digits, rendered in the same cube-grid
// language as the other decorations.
const COUNTDOWN_DIGITS: Record<number, number[][]> = {
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

// A state-driven decoration (not free-running): the grid shows a raised digit on
// demand while a blast counts down, then hides on detonation.
export function createCountdownDecoration(color: number): Countdown {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(CUBE_W, CUBE_W, CUBE_W);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.35,
    metalness: 0.1,
    emissive: color,
    emissiveIntensity: 0.7,
  });

  const cubes: THREE.Mesh[][] = Array.from({ length: GRID }, (_, r) =>
    Array.from({ length: GRID }, (_, c) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      m.position.set(
        (c - (GRID - 1) / 2) * STEP,
        BOTTOM_Y,
        (r - (GRID - 1) / 2) * STEP,
      );
      m.visible = false;
      group.add(m);
      return m;
    }),
  );

  const render = (frame: number[][] | null): void => {
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const on = !!frame && frame[r][c] === 1;
        const m = cubes[r][c];
        m.visible = on;
        m.position.y = on ? TOP_Y : BOTTOM_Y;
      }
    }
  };

  return {
    group,
    show: (n: number) => render(COUNTDOWN_DIGITS[n] ?? null),
    hide: () => render(null),
  };
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
