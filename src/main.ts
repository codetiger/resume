import * as THREE from 'three';
import { createEngine } from './engine/scene';
import { loadPlatformModel, loadPlayerModel } from './engine/models';
import { createPlayer, TELEPORT_SHRINK, type RollDirection } from './game/player';
import {
  buildLevel,
  DEMO_LAYOUT,
  TILE_SIZE,
  CUBE_SIZE,
  type TileAction,
} from './game/grid';

const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
if (!canvas) throw new Error('canvas#stage not found');

const engine = createEngine(canvas);
const { scene, render, applyParallax } = engine;

// Load assets in parallel.
const [{ template, tileHeight }, playerModel] = await Promise.all([
  loadPlatformModel(TILE_SIZE),
  loadPlayerModel(CUBE_SIZE),
]);

const level = buildLevel(DEMO_LAYOUT, template, tileHeight);
scene.add(level.group);

// Teleport swirls sit at the player block's centre height.
const SWIRL_Y = tileHeight / 2 + CUBE_SIZE / 2;

const player = createPlayer({
  model: playerModel,
  tileHeight,
  cubeSize: CUBE_SIZE,
});
scene.add(player.group);

// Place player on the base tile.
let cubeCol = 0;
let cubeRow = 0;
{
  const baseEntry = [...level.tiles.entries()].find(([, t]) => t.userData.kind === 'base');
  if (baseEntry) {
    const [key] = baseEntry;
    [cubeCol, cubeRow] = key.split(',').map(Number);
    player.setRestingAt(level.cellToWorld(cubeCol, cubeRow));
  }
}

// Previous position — captured at the moment a move is accepted.
let prevCol = cubeCol;
let prevRow = cubeRow;
let wasMoving = false;
let won = false;
let gameOver = false;

// ─── HUD ──────────────────────────────────────────────────────────────────────
const remainingEl  = document.getElementById('hud-remaining');
const winOverlay   = document.getElementById('win-overlay');
const winRestartBtn = document.getElementById('win-restart');
const gameOverOverlay   = document.getElementById('game-over-overlay');
const gameOverRestartBtn = document.getElementById('gameover-restart');

function updateHUD() {
  if (remainingEl) remainingEl.textContent = String(level.remaining());
}
updateHUD();

function showWin(): void {
  won = true;
  if (winOverlay) winOverlay.style.display = 'flex';
}

function showGameOver(): void {
  gameOver = true;
  if (gameOverOverlay) gameOverOverlay.style.display = 'flex';
}

if (winRestartBtn) {
  winRestartBtn.addEventListener('click', () => window.location.reload());
}
if (gameOverRestartBtn) {
  gameOverRestartBtn.addEventListener('click', () => window.location.reload());
}

// ─── input ────────────────────────────────────────────────────────────────────

const KEY_MAP: Record<string, { dir: RollDirection; dCol: number; dRow: number }> = {
  ArrowRight: { dir: 'right',   dCol:  1, dRow:  0 },
  KeyD:       { dir: 'right',   dCol:  1, dRow:  0 },
  ArrowLeft:  { dir: 'left',    dCol: -1, dRow:  0 },
  KeyA:       { dir: 'left',    dCol: -1, dRow:  0 },
  ArrowDown:  { dir: 'forward', dCol:  0, dRow:  1 },
  KeyS:       { dir: 'forward', dCol:  0, dRow:  1 },
  ArrowUp:    { dir: 'back',    dCol:  0, dRow: -1 },
  KeyW:       { dir: 'back',    dCol:  0, dRow: -1 },
};

window.addEventListener('keydown', (event) => {
  const m = KEY_MAP[event.code];
  if (!m || won || gameOver || player.isMoving()) return;
  event.preventDefault();

  const nextCol = cubeCol + m.dCol;
  const nextRow = cubeRow + m.dRow;

  // No platform ahead — roll into the void and fall off the edge.
  if (!level.isTraversable(nextCol, nextRow)) {
    player.fall(m.dir);
    return;
  }

  prevCol = cubeCol;
  prevRow = cubeRow;
  cubeCol = nextCol;
  cubeRow = nextRow;
  player.move(m.dir);
});

// ─── parallax ────────────────────────────────────────────────────────────────

const targetTilt  = new THREE.Vector2();
const currentTilt = new THREE.Vector2();
window.addEventListener('pointermove', (event) => {
  targetTilt.set(
    (event.clientX / window.innerWidth)  * 2 - 1,
    (event.clientY / window.innerHeight) * 2 - 1,
  );
});

// ─── tile-action dispatch ─────────────────────────────────────────────────────

function applyAction(action: TileAction, elapsed: number): void {
  if (action.type === 'slide') {
    // Arrow pushed toward empty space — the cube rolls off and falls.
    if (!level.isTraversable(action.toCol, action.toRow)) {
      player.fall(action.dir);
      return;
    }
    prevCol = cubeCol;
    prevRow = cubeRow;
    cubeCol = action.toCol;
    cubeRow = action.toRow;
    player.move(action.dir);

  } else if (action.type === 'teleport') {
    prevCol = cubeCol;                 // origin shift tile — guards re-teleport back
    prevRow = cubeRow;
    const fromW = level.cellToWorld(cubeCol, cubeRow);
    cubeCol = action.toCol;
    cubeRow = action.toRow;
    const toW = level.cellToWorld(cubeCol, cubeRow);
    fromW.y = SWIRL_Y;
    toW.y = SWIRL_Y;

    // Swirl consumes the block at the origin, then a second swirl releases it at
    // the destination as it grows back. The follow-up landing is resolved by the
    // frame loop once player.isMoving() goes false.
    level.effects.spawnSwirl({ pos: fromW, color: 0x22d3ee, startTime: elapsed });
    level.effects.spawnSwirl({ pos: toW, color: 0x22d3ee, startTime: elapsed + TELEPORT_SHRINK });
    player.teleport(level.cellToWorld(cubeCol, cubeRow));
  }
}

// ─── game loop ────────────────────────────────────────────────────────────────

const clock = new THREE.Clock();

function frame() {
  const t = clock.getElapsedTime();
  const moving = player.isMoving();

  if (wasMoving && !moving && !won && !gameOver) {
    if (player.hasFallen()) {
      showGameOver();
    } else {
      const action = level.onPlayerLand(cubeCol, cubeRow, prevCol, prevRow, t);
      applyAction(action, t);
      updateHUD();

      if (!player.isMoving() && level.isWon(cubeCol, cubeRow)) {
        showWin();
      }
    }
  }
  wasMoving = moving;

  player.update(t);
  level.update(t, `${cubeCol},${cubeRow}`);

  currentTilt.x += (targetTilt.x - currentTilt.x) * 0.05;
  currentTilt.y += (targetTilt.y - currentTilt.y) * 0.05;
  applyParallax(currentTilt.x, currentTilt.y);

  render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
