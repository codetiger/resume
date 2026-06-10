import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createPlayer, type Player } from './player';

const TILE_HEIGHT = 1;
const CUBE_SIZE = 0.7;
const REST_Y = TILE_HEIGHT / 2 + CUBE_SIZE / 2; // 0.85
// One move is two 90° rolls, so the cube advances 2 × cubeSize — which is exactly
// the grid step (TILE_SIZE + TILE_GAP) the board is laid out on.
const MOVE_STEP = 2 * CUBE_SIZE; // 1.4

function makePlayer(): Player {
  return createPlayer({ model: new THREE.Group(), tileHeight: TILE_HEIGHT, cubeSize: CUBE_SIZE });
}

/** Drive update() over `seconds` of simulated time at 60 fps. */
function run(player: Player, seconds: number): void {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i <= steps; i++) player.update(i / 60);
}

describe('player movement', () => {
  it('starts at rest', () => {
    const p = makePlayer();
    expect(p.isMoving()).toBe(false);
    expect(p.hasFallen()).toBe(false);
  });

  it('advances exactly one tile per move', () => {
    const p = makePlayer();
    p.move('right');
    expect(p.isMoving()).toBe(true);
    run(p, 1);
    expect(p.isMoving()).toBe(false);
    expect(p.group.position.x).toBeCloseTo(MOVE_STEP, 4); // advanced one full grid step
    expect(p.group.position.y).toBeCloseTo(REST_Y, 4);
    expect(p.group.position.z).toBeCloseTo(0, 6);
  });

  it('ignores a new move while one is queued', () => {
    const p = makePlayer();
    p.move('right');
    p.move('left'); // dropped: a move is already in flight
    run(p, 1);
    expect(p.group.position.x).toBeCloseTo(MOVE_STEP, 4);
    expect(p.group.position.z).toBeCloseTo(0, 6);
  });

  it('falls off the edge and drops out of view', () => {
    const p = makePlayer();
    p.fall('right');
    expect(p.hasFallen()).toBe(false);
    run(p, 2);
    expect(p.hasFallen()).toBe(true);
    expect(p.group.visible).toBe(false);
  });
});

describe('player teleport / reset', () => {
  it('teleports to the destination and restores scale', () => {
    const p = makePlayer();
    p.teleport(new THREE.Vector3(2, 0, -3));
    expect(p.isMoving()).toBe(true);
    run(p, 1);
    expect(p.isMoving()).toBe(false);
    expect(p.group.position.x).toBeCloseTo(2, 5);
    expect(p.group.position.z).toBeCloseTo(-3, 5);
    expect(p.group.scale.x).toBeCloseTo(1, 5);
  });

  it('setRestingAt snaps to tile-top and cancels motion', () => {
    const p = makePlayer();
    p.move('right');
    p.setRestingAt(new THREE.Vector3(4, 999, -2));
    expect(p.isMoving()).toBe(false);
    p.update(0);
    expect(p.group.position.x).toBeCloseTo(4, 5);
    expect(p.group.position.y).toBeCloseTo(REST_Y, 5); // resting Y, not the passed 999
    expect(p.group.position.z).toBeCloseTo(-2, 5);
  });
});
