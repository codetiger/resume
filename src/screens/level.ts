import * as THREE from 'three';
import { DIRECTION_DELTA, PALETTE, type Direction } from '../core';
import type { Engine } from '../engine/scene';
import type { Player } from '../game/player';
import { TELEPORT_SHRINK } from '../game/player';
import { buildLevel, CUBE_SIZE, type TileAction } from '../game/grid';
import type { LevelDef } from '../game/levels';
import type { Screen } from '../game/app';

const KEY_MAP: Record<string, Direction> = {
  ArrowRight: 'right', KeyD: 'right',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowDown: 'forward', KeyS: 'forward',
  ArrowUp: 'back', KeyW: 'back',
};

export interface LevelScreenOptions {
  engine: Engine;
  assets: { template: THREE.Group; tileHeight: number };
  player: Player;
  def: LevelDef;
  index: number;
  total: number;
  onComplete: () => void;
  onNext: () => void;
  onHome: () => void;
  onRetry: () => void;
}

const pad3 = (n: number) => String(n).padStart(3, '0');

export function createLevelScreen(opts: LevelScreenOptions): Screen {
  const { assets, player, def, index, total } = opts;

  const level = buildLevel(def.layout, assets.template, assets.tileHeight);
  const SWIRL_Y = assets.tileHeight / 2 + CUBE_SIZE / 2;

  // A blast that reaches the cube's tile destroys the ground under it.
  level.setOnPlayerLost(() => player.drop());

  const state = {
    playerCol: 0, playerRow: 0,
    prevCol: 0, prevRow: 0,
    wasMoving: false,
    won: false, gameOver: false,
    paused: false, // info card open
  };

  // Place the player on the base tile.
  const baseEntry = [...level.tiles.entries()].find(([, t]) => t.userData.kind === 'base');
  if (baseEntry) {
    const [col, row] = baseEntry[0].split(',').map(Number);
    state.playerCol = col;
    state.playerRow = row;
  }
  state.prevCol = state.playerCol;
  state.prevRow = state.playerRow;
  player.setRestingAt(level.cellToWorld(state.playerCol, state.playerRow));

  // ─── DOM ─────────────────────────────────────────────────────────────────────
  const $ = (id: string) => document.getElementById(id);
  const levelNameEl = $('hud-levelname');
  const remainingEl = $('hud-remaining');

  const infoOverlay = $('info-overlay');
  const infoCard = $('info-card');
  const infoNum = $('info-num');
  const infoHeading = $('info-heading');
  const infoPeriod = $('info-period');
  const infoSub = $('info-sub');
  const infoBullets = $('info-bullets');
  const infoContinue = $('info-continue');

  const winOverlay = $('win-overlay');
  const winSub = $('win-sub');
  const winNext = $('win-next');
  const winHome = $('win-home');

  const gameOverOverlay = $('game-over-overlay');
  const gameOverRetry = $('gameover-retry');
  const gameOverHome = $('gameover-home');

  if (levelNameEl) levelNameEl.textContent = `${pad3(def.number)} · ${def.name}`;
  const updateRemaining = () => { if (remainingEl) remainingEl.textContent = String(level.remaining()); };
  updateRemaining();

  const hideOverlay = (el: HTMLElement | null) => { if (el) el.style.display = 'none'; };
  const showOverlay = (el: HTMLElement | null) => { if (el) el.style.display = 'flex'; };

  function showInfo(): void {
    const c = def.content;
    if (infoCard) infoCard.classList.toggle('meta', c.tag === 'meta');
    if (infoNum) infoNum.textContent = pad3(def.number);
    if (infoHeading) infoHeading.textContent = c.heading;
    if (infoPeriod) { infoPeriod.textContent = c.period ?? ''; infoPeriod.style.display = c.period ? '' : 'none'; }
    if (infoSub) { infoSub.textContent = c.subheading ?? ''; infoSub.style.display = c.subheading ? '' : 'none'; }
    if (infoBullets) {
      infoBullets.innerHTML = '';
      for (const b of c.bullets) {
        const li = document.createElement('li');
        li.textContent = b;
        infoBullets.appendChild(li);
      }
    }
    state.paused = true;
    showOverlay(infoOverlay);
  }

  function dismissInfo(): void {
    state.paused = false;
    hideOverlay(infoOverlay);
  }

  function showWin(): void {
    if (state.won) return;
    state.won = true;
    opts.onComplete();
    const hasNext = index + 1 < total;
    if (winSub) winSub.textContent = hasNext
      ? `Level ${pad3(def.number)} cleared — ${def.name}.`
      : `That's the last level — you've seen the whole story.`;
    if (winNext) winNext.style.display = hasNext ? '' : 'none';
    showOverlay(winOverlay);
  }

  function showGameOver(): void {
    if (state.gameOver) return;
    state.gameOver = true;
    showOverlay(gameOverOverlay);
  }

  // Buttons (onclick replaces any prior handler, so screens never stack listeners).
  if (infoContinue) infoContinue.onclick = dismissInfo;
  // Also dismiss by clicking the dimmed backdrop outside the card, as a fallback
  // if the button is ever awkward to hit.
  if (infoOverlay) infoOverlay.onclick = (e) => { if (e.target === infoOverlay) dismissInfo(); };
  if (winNext) winNext.onclick = opts.onNext;
  if (winHome) winHome.onclick = opts.onHome;
  if (gameOverRetry) gameOverRetry.onclick = opts.onRetry;
  if (gameOverHome) gameOverHome.onclick = opts.onHome;

  // ─── tile-action dispatch ──────────────────────────────────────────────────────
  function applyAction(action: TileAction, elapsed: number): void {
    if (action.type === 'slide') {
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
      state.prevCol = state.playerCol;
      state.prevRow = state.playerRow;
      const fromW = level.cellToWorld(state.playerCol, state.playerRow);
      state.playerCol = action.toCol;
      state.playerRow = action.toRow;
      const toW = level.cellToWorld(state.playerCol, state.playerRow);
      fromW.y = SWIRL_Y;
      toW.y = SWIRL_Y;
      const swirlColor = PALETTE.effect.teleportSwirl;
      level.effects.spawnSwirl({ pos: fromW, color: swirlColor, startTime: elapsed });
      level.effects.spawnSwirl({ pos: toW, color: swirlColor, startTime: elapsed + TELEPORT_SHRINK });
      player.teleport(level.cellToWorld(state.playerCol, state.playerRow));

    } else if (action.type === 'info') {
      showInfo();
    }
  }

  function tryMove(dir: Direction): void {
    if (player.isMoving()) return;
    const [dCol, dRow] = DIRECTION_DELTA[dir];
    const nextCol = state.playerCol + dCol;
    const nextRow = state.playerRow + dRow;
    if (!level.isTraversable(nextCol, nextRow)) {
      player.fall(dir);
      return;
    }
    state.prevCol = state.playerCol;
    state.prevRow = state.playerRow;
    state.playerCol = nextCol;
    state.playerRow = nextRow;
    player.move(dir);
  }

  return {
    group: level.group,

    onKey(code: string) {
      // While the info card is open, any confirm key dismisses it; ignore moves.
      if (state.paused) {
        if (code === 'Enter' || code === 'Space' || code === 'Escape') dismissInfo();
        return;
      }
      if (state.won) { if (code === 'Enter') (index + 1 < total ? opts.onNext : opts.onHome)(); return; }
      if (state.gameOver) { if (code === 'Enter') opts.onRetry(); return; }
      const dir = KEY_MAP[code];
      if (dir) tryMove(dir);
    },

    tick(elapsed: number) {
      const moving = player.isMoving();

      if (state.wasMoving && !moving && !state.won && !state.gameOver) {
        if (player.hasFallen()) {
          showGameOver();
        } else {
          const action = level.onPlayerLand(state.playerCol, state.playerRow, state.prevCol, state.prevRow, elapsed);
          applyAction(action, elapsed);
          updateRemaining();
          if (!player.isMoving() && level.isWon(state.playerCol, state.playerRow)) {
            showWin();
          }
        }
      }
      state.wasMoving = moving;

      player.update(elapsed);
      level.update(elapsed, `${state.playerCol},${state.playerRow}`);
    },

    dispose() {
      hideOverlay(infoOverlay);
      hideOverlay(winOverlay);
      hideOverlay(gameOverOverlay);
      if (infoContinue) infoContinue.onclick = null;
      if (infoOverlay) infoOverlay.onclick = null;
      if (winNext) winNext.onclick = null;
      if (winHome) winHome.onclick = null;
      if (gameOverRetry) gameOverRetry.onclick = null;
      if (gameOverHome) gameOverHome.onclick = null;

      level.effects.dispose();
      // Dispose the per-tile and decoration materials this level created. Geometry
      // is shared with the platform template (clones share geometry) so it is left
      // intact for the next level.
      level.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) m?.dispose?.();
        }
      });
    },
  };
}
