import * as THREE from 'three';
import { DIRECTION_DELTA, PALETTE, type Direction } from './core';
import { createEngine } from './engine/scene';
import { loadPlatformModel, loadPlayerModel } from './engine/models';
import { createPlayer, TELEPORT_SHRINK } from './game/player';
import { buildLevel, DEMO_LAYOUT, TILE_SIZE, CUBE_SIZE, type TileAction } from './game/grid';

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

const player = createPlayer({ model: playerModel, tileHeight, cubeSize: CUBE_SIZE });
scene.add(player.group);

// ─── game state ─────────────────────────────────────────────────────────────
// playerCol/Row: where the cube currently rests. prevCol/Row: captured the moment
// a move is accepted (used to guard shift tiles from teleporting straight back).
const state = {
  playerCol: 0,
  playerRow: 0,
  prevCol: 0,
  prevRow: 0,
  wasMoving: false,
  won: false,
  gameOver: false,
};

// Place the player on the base tile.
const baseEntry = [...level.tiles.entries()].find(([, t]) => t.userData.kind === 'base');
if (baseEntry) {
  const [col, row] = baseEntry[0].split(',').map(Number);
  state.playerCol = col;
  state.playerRow = row;
  player.setRestingAt(level.cellToWorld(col, row));
}
state.prevCol = state.playerCol;
state.prevRow = state.playerRow;

// ─── HUD ──────────────────────────────────────────────────────────────────────
const remainingEl = document.getElementById('hud-remaining');
const winOverlay = document.getElementById('win-overlay');
const winRestartBtn = document.getElementById('win-restart');
const gameOverOverlay = document.getElementById('game-over-overlay');
const gameOverRestartBtn = document.getElementById('gameover-restart');

function updateHUD(): void {
  if (remainingEl) remainingEl.textContent = String(level.remaining());
}
updateHUD();

function showWin(): void {
  state.won = true;
  if (winOverlay) winOverlay.style.display = 'flex';
}

function showGameOver(): void {
  state.gameOver = true;
  if (gameOverOverlay) gameOverOverlay.style.display = 'flex';
}

winRestartBtn?.addEventListener('click', () => window.location.reload());
gameOverRestartBtn?.addEventListener('click', () => window.location.reload());

// ─── input ────────────────────────────────────────────────────────────────────

const KEY_MAP: Record<string, Direction> = {
  ArrowRight: 'right', KeyD: 'right',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowDown: 'forward', KeyS: 'forward',
  ArrowUp: 'back', KeyW: 'back',
};

window.addEventListener('keydown', (event) => {
  const dir = KEY_MAP[event.code];
  if (!dir || state.won || state.gameOver || player.isMoving()) return;
  event.preventDefault();

  const [dCol, dRow] = DIRECTION_DELTA[dir];
  const nextCol = state.playerCol + dCol;
  const nextRow = state.playerRow + dRow;

  // No platform ahead — roll into the void and fall off the edge.
  if (!level.isTraversable(nextCol, nextRow)) {
    player.fall(dir);
    return;
  }

  state.prevCol = state.playerCol;
  state.prevRow = state.playerRow;
  state.playerCol = nextCol;
  state.playerRow = nextRow;
  player.move(dir);
});

// ─── parallax ────────────────────────────────────────────────────────────────

const targetTilt = new THREE.Vector2();
const currentTilt = new THREE.Vector2();
window.addEventListener('pointermove', (event) => {
  targetTilt.set(
    (event.clientX / window.innerWidth) * 2 - 1,
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
    state.prevCol = state.playerCol;
    state.prevRow = state.playerRow;
    state.playerCol = action.toCol;
    state.playerRow = action.toRow;
    player.move(action.dir);

  } else if (action.type === 'teleport') {
    state.prevCol = state.playerCol;                 // origin shift tile — guards re-teleport back
    state.prevRow = state.playerRow;
    const fromW = level.cellToWorld(state.playerCol, state.playerRow);
    state.playerCol = action.toCol;
    state.playerRow = action.toRow;
    const toW = level.cellToWorld(state.playerCol, state.playerRow);
    fromW.y = SWIRL_Y;
    toW.y = SWIRL_Y;

    // Swirl consumes the block at the origin, then a second swirl releases it at
    // the destination as it grows back. The follow-up landing is resolved by the
    // frame loop once player.isMoving() goes false.
    const swirlColor = PALETTE.effect.teleportSwirl;
    level.effects.spawnSwirl({ pos: fromW, color: swirlColor, startTime: elapsed });
    level.effects.spawnSwirl({ pos: toW, color: swirlColor, startTime: elapsed + TELEPORT_SHRINK });
    player.teleport(level.cellToWorld(state.playerCol, state.playerRow));
  }
}

// ─── game loop ────────────────────────────────────────────────────────────────

const clock = new THREE.Clock();

function frame(): void {
  const elapsed = clock.getElapsedTime();
  const moving = player.isMoving();

  if (state.wasMoving && !moving && !state.won && !state.gameOver) {
    if (player.hasFallen()) {
      showGameOver();
    } else {
      const action = level.onPlayerLand(state.playerCol, state.playerRow, state.prevCol, state.prevRow, elapsed);
      applyAction(action, elapsed);
      updateHUD();

      if (!player.isMoving() && level.isWon(state.playerCol, state.playerRow)) {
        showWin();
      }
    }
  }
  state.wasMoving = moving;

  player.update(elapsed);
  level.update(elapsed, `${state.playerCol},${state.playerRow}`);

  currentTilt.x += (targetTilt.x - currentTilt.x) * 0.05;
  currentTilt.y += (targetTilt.y - currentTilt.y) * 0.05;
  applyParallax(currentTilt.x, currentTilt.y);

  render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
