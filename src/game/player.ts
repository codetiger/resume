import * as THREE from 'three';
import type { Direction } from '../core';

const ROLL_DURATION = 0.18;             // seconds for one 90° roll
const ROLLS_PER_MOVE = 2;               // two rolls land the cube on the next tile

// Falling off the edge: the roll into the void carries the cube most of the way
// over (FALL_TIP_ANGLE — 3/4 of the roll, so it is well clear of the source
// platform); past there it lets go and drops under gravity, tumbling about the
// roll axis and drifting in the roll direction so it clears the edge cleanly.
const FALL_GRAVITY = 30;                // world units / s² downward acceleration
const FALL_SPIN = 9;                    // rad / s tumble while falling
const FALL_FLOOR = -8;                  // world Y at which the cube is gone from view
const FALL_TIP_ANGLE = (3 / 4) * (Math.PI / 2); // let go after 3/4 of the roll (67.5°), once it's over the next tile
const FALL_DRIFT = 2.4;                 // horizontal drift (× cubeSize / s) carrying it clear of the edge

// Shift teleport: the block spins and scales down into a swirl at the origin,
// snaps to the destination, then spins back up out of a swirl there.
export const TELEPORT_SHRINK = 0.22;    // s to shrink away at the origin
export const TELEPORT_GROW = 0.22;      // s to grow back at the destination
const TELEPORT_SPIN = 24;               // rad / s spin during the whole transit

export interface PlayerOptions {
  model: THREE.Group;
  tileHeight: number;
  cubeSize: number;
}

export interface Player {
  group: THREE.Group;
  update: (elapsed: number) => void;
  /** Queue a move in the given direction. Each move is two consecutive rolls. */
  move: (dir: Direction) => void;
  /** Roll once into the given direction, then fall off the edge (no platform ahead). */
  fall: (dir: Direction) => void;
  /** Drop straight down — the tile was destroyed under the cube (caught in a blast). */
  drop: () => void;
  isMoving: () => boolean;
  /** True once the cube has fallen off the edge and dropped out of view. */
  hasFallen: () => boolean;
  /** Snap resting position to a world point on tile-top. Resets accumulated rotation. */
  setRestingAt: (worldPos: THREE.Vector3) => void;
  /** Play the shift-teleport: shrink away here, then grow back at `dest`. */
  teleport: (dest: THREE.Vector3) => void;
}

export function createPlayer({ model, tileHeight, cubeSize }: PlayerOptions): Player {
  const S = cubeSize;
  const yFloor = tileHeight / 2;        // world Y of tile top
  const restY = yFloor + S / 2;         // world Y of cube centre when at rest

  // Per-direction roll geometry. A roll tips the cube 90° about its leading
  // bottom edge:
  //   pivotOffset = vector from the cube centre to that edge (e.g. right edge,
  //                 floor level → (+S/2, -S/2, 0) for 'right');
  //   axis        = world rotation axis (right-hand rule);
  //   delta       = net world translation after one full 90° roll.
  const ROLL: Record<Direction, { pivotOffset: THREE.Vector3; axis: THREE.Vector3; delta: THREE.Vector3 }> = {
    right:   { pivotOffset: new THREE.Vector3( S/2, -S/2,  0  ), axis: new THREE.Vector3( 0, 0,-1), delta: new THREE.Vector3( S, 0, 0) },
    left:    { pivotOffset: new THREE.Vector3(-S/2, -S/2,  0  ), axis: new THREE.Vector3( 0, 0, 1), delta: new THREE.Vector3(-S, 0, 0) },
    forward: { pivotOffset: new THREE.Vector3( 0,  -S/2,  S/2 ), axis: new THREE.Vector3( 1, 0, 0), delta: new THREE.Vector3( 0, 0, S) },
    back:    { pivotOffset: new THREE.Vector3( 0,  -S/2, -S/2 ), axis: new THREE.Vector3(-1, 0, 0), delta: new THREE.Vector3( 0, 0,-S) },
  };

  const group = new THREE.Group();
  group.add(model);

  // Resting state — what the cube returns to between rolls.
  const restPos = new THREE.Vector3(0, restY, 0);
  const restQuat = new THREE.Quaternion();
  group.position.copy(restPos);

  const queue: Direction[] = [];
  let active: Direction | null = null;
  let activeStart = 0;

  // Falling state. `pendingFall` marks that the queued roll should drop into a fall
  // when it finishes; `falling` is the gravity-drop phase; `fell` is the terminal flag.
  let pendingFall: Direction | null = null;
  // `pendingDrop` marks a straight-down drop (tile destroyed under the cube),
  // resolved in update() into the shared `falling` gravity phase.
  let pendingDrop = false;
  let falling = false;
  let fallStart = 0;
  let fell = false;
  const fallBase = new THREE.Vector3();   // cube centre at the moment it lets go
  const fallQuat = new THREE.Quaternion(); // orientation at that moment (continued by the tumble)
  const fallDir = new THREE.Vector3();     // unit horizontal drift direction
  let fallAxis: THREE.Vector3 = ROLL.right.axis;

  // Teleport state. `pendingTeleport` queues the request (resolved in update like
  // a move); `teleporting` is the shrink→snap→grow phase.
  let pendingTeleport: THREE.Vector3 | null = null;
  let teleporting = false;
  let teleportStart = 0;
  let teleportSnapped = false;
  const teleportDest = new THREE.Vector3();

  const tmpQuat = new THREE.Quaternion();
  const tmpVec = new THREE.Vector3();
  const tmpOffset = new THREE.Vector3();

  function easeInOutQuad(t: number): number {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function applyRest(): void {
    group.position.copy(restPos);
    group.quaternion.copy(restQuat);
  }

  return {
    group,
    update(elapsed: number) {
      // ── teleport: takes over position, scale and spin while it runs ──
      if (pendingTeleport && !teleporting && !active && queue.length === 0 && !falling) {
        teleporting = true;
        teleportStart = elapsed;
        teleportSnapped = false;
        teleportDest.copy(pendingTeleport);
        pendingTeleport = null;
      }
      if (teleporting) {
        const age = elapsed - teleportStart;
        group.rotation.y = age * TELEPORT_SPIN;
        if (age < TELEPORT_SHRINK) {
          group.position.copy(restPos);
          group.scale.setScalar(1 - easeInOutQuad(age / TELEPORT_SHRINK));
        } else if (age < TELEPORT_SHRINK + TELEPORT_GROW) {
          if (!teleportSnapped) {
            restPos.set(teleportDest.x, restY, teleportDest.z);
            teleportSnapped = true;
          }
          group.position.copy(restPos);
          group.scale.setScalar(easeInOutQuad((age - TELEPORT_SHRINK) / TELEPORT_GROW));
        } else {
          if (!teleportSnapped) restPos.set(teleportDest.x, restY, teleportDest.z);
          teleporting = false;
          group.scale.setScalar(1);
          group.rotation.y = 0;
          restQuat.identity();
          applyRest();
        }
        return;
      }

      // The ground was destroyed under the cube: let go and drop straight down,
      // with a little tumble, reusing the gravity phase below.
      if (pendingDrop && !falling && !active && queue.length === 0 && !teleporting) {
        falling = true;
        fallStart = elapsed;
        fallBase.copy(group.position);
        fallQuat.copy(group.quaternion);
        fallDir.set(0, 0, 0);            // no horizontal drift — it falls in place
        fallAxis = ROLL.right.axis;
        pendingDrop = false;
      }

      if (!falling && !active && queue.length > 0) {
        active = queue.shift()!;
        activeStart = elapsed;
      }

      if (active) {
        const params = ROLL[active];
        const t = Math.min(1, (elapsed - activeStart) / ROLL_DURATION);
        const alpha = easeInOutQuad(t) * Math.PI / 2;

        // Pivot in world space.
        tmpVec.copy(restPos).add(params.pivotOffset);
        // Vector pivot→cube-centre at the start of this roll, rotated by alpha.
        tmpOffset.copy(params.pivotOffset).negate();
        tmpQuat.setFromAxisAngle(params.axis, alpha);
        tmpOffset.applyQuaternion(tmpQuat);

        group.position.copy(tmpVec).add(tmpOffset);
        group.quaternion.copy(restQuat).premultiply(tmpQuat);

        if (pendingFall && alpha >= FALL_TIP_ANGLE) {
          // Rolled past the balance point over an edge with no platform: the cube
          // has lost support, so let go here and fall — instead of completing the
          // full roll onto empty space, which leaves it hovering at tile height.
          falling = true;
          fallStart = elapsed;
          fallBase.copy(group.position);
          fallQuat.copy(group.quaternion);
          fallDir.copy(params.delta).normalize();
          fallAxis = params.axis;
          active = null;
          pendingFall = null;
        } else if (t >= 1) {
          // Bake roll into resting state.
          restPos.add(params.delta);
          tmpQuat.setFromAxisAngle(params.axis, Math.PI / 2);
          restQuat.premultiply(tmpQuat);
          applyRest();
          active = null;
        }
      } else if (falling) {
        const age = elapsed - fallStart;
        const y = fallBase.y - 0.5 * FALL_GRAVITY * age * age;
        // Drift in the roll direction as it drops so the cube clears the platform
        // edge rather than sliding straight down against it.
        const drift = FALL_DRIFT * S * age;
        group.position.set(
          fallBase.x + fallDir.x * drift,
          y,
          fallBase.z + fallDir.z * drift,
        );
        // Keep tumbling about the roll axis, continuing the orientation it let go at.
        tmpQuat.setFromAxisAngle(fallAxis, age * FALL_SPIN);
        group.quaternion.copy(fallQuat).premultiply(tmpQuat);

        if (y < FALL_FLOOR) {
          falling = false;
          fell = true;
          group.visible = false;
        }
      } else {
        applyRest();
      }
    },
    move(dir) {
      // Ignore new presses while a move is in progress (no buffering for now).
      if (active || queue.length > 0 || falling || fell) return;
      for (let i = 0; i < ROLLS_PER_MOVE; i++) queue.push(dir);
    },
    fall(dir) {
      if (active || queue.length > 0 || falling || fell) return;
      queue.push(dir);          // a single roll tips the cube over the edge…
      pendingFall = dir;        // …then it drops out of view.
    },
    drop() {
      if (active || queue.length > 0 || falling || fell || teleporting || pendingTeleport) return;
      pendingDrop = true;
    },
    isMoving() {
      return active !== null || queue.length > 0 || falling || teleporting || pendingTeleport !== null || pendingDrop;
    },
    hasFallen() {
      return fell;
    },
    setRestingAt(worldPos) {
      restPos.set(worldPos.x, restY, worldPos.z);
      restQuat.identity();
      queue.length = 0;
      active = null;
      pendingFall = null;
      pendingDrop = false;
      falling = false;
      fell = false;
      pendingTeleport = null;
      teleporting = false;
      group.scale.setScalar(1);
      group.rotation.y = 0;
      group.visible = true;
      applyRest();
    },
    teleport(dest) {
      if (active || queue.length > 0 || falling || fell || teleporting || pendingTeleport) return;
      pendingTeleport = dest.clone();
    },
  };
}
