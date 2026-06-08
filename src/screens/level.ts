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

  const state = {
    playerCol: 0, playerRow: 0,
    prevCol: 0, prevRow: 0,
    // A move is in flight whose landing hasn't been resolved yet. Driven by the
    // physics, not a frame-boundary edge, so the landing can never be skipped by
    // a new move queued in the gap between the roll finishing and the next tick.
    arrivalPending: false,
    won: false, gameOver: false,
    paused: false,     // info card open
    pauseMenu: false,  // Esc pause menu open
  };

  // A blast that reaches the cube's tile destroys the ground under it: the cube
  // drops, and that drop owes a landing (resolved into a game-over).
  level.setOnPlayerLost(() => { player.drop(); state.arrivalPending = true; });

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

  const pauseOverlay = $('pause-overlay');
  const pauseRetry = $('pause-retry');
  const pauseHome = $('pause-home');

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

  // Esc pause menu. Only opens during active play (not over another overlay); the
  // pending-landing logic is frozen while it's up (see settleIfLanded) so nothing
  // resolves behind the blur, and Esc / backdrop click resume exactly where you were.
  function openPause(): void {
    if (state.won || state.gameOver || state.paused || state.pauseMenu) return;
    state.pauseMenu = true;
    showOverlay(pauseOverlay);
  }

  function resume(): void {
    state.pauseMenu = false;
    hideOverlay(pauseOverlay);
  }

  // Each overlay button binds a click and one or more keys to the SAME action, so
  // mouse and keyboard always stay in parity and no button can be left half-wired.
  // onKey() dispatches a press against the active overlay's button set (below).
  interface OverlayButton { el: HTMLElement | null; action: () => void; keys: string[]; }
  const infoButtons: OverlayButton[] = [
    { el: infoContinue, action: dismissInfo, keys: ['Enter', 'Space', 'Escape'] },
  ];
  const winButtons: OverlayButton[] = [
    { el: winNext, action: opts.onNext, keys: ['Enter', 'KeyN'] },
    // Enter falls through to Home only when Next is hidden (last level), since
    // dispatchKey() skips hidden buttons and returns on the first match.
    { el: winHome, action: opts.onHome, keys: ['Enter', 'KeyH'] },
  ];
  const gameOverButtons: OverlayButton[] = [
    { el: gameOverRetry, action: opts.onRetry, keys: ['Enter', 'KeyR'] },
    { el: gameOverHome, action: opts.onHome, keys: ['KeyH'] },
  ];
  const pauseButtons: OverlayButton[] = [
    { el: pauseRetry, action: opts.onRetry, keys: ['KeyR'] },
    { el: pauseHome, action: opts.onHome, keys: ['KeyH'] },
  ];
  const allButtons = [...infoButtons, ...winButtons, ...gameOverButtons, ...pauseButtons];

  // onclick replaces any prior handler, so screens never stack listeners.
  for (const b of allButtons) if (b.el) b.el.onclick = b.action;
  // Also dismiss the info card by clicking the dimmed backdrop outside it, as a
  // fallback if the button is ever awkward to hit. Win/game-over keep no backdrop
  // action — their two choices have no single obvious default.
  if (infoOverlay) infoOverlay.onclick = (e) => { if (e.target === infoOverlay) dismissInfo(); };
  // Clicking the dimmed backdrop outside the pause card resumes play.
  if (pauseOverlay) pauseOverlay.onclick = (e) => { if (e.target === pauseOverlay) resume(); };

  // Run the first visible button whose key set contains the press.
  const dispatchKey = (buttons: OverlayButton[], code: string): void => {
    for (const b of buttons) {
      if (!b.el || b.el.style.display === 'none') continue;
      if (b.keys.includes(code)) { b.action(); return; }
    }
  };

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

  // Latest tick time, so a landing flushed from input (tryMove) can start a tile's
  // fall/effects at very nearly the right moment without waiting for the next tick.
  let lastElapsed = 0;

  // Resolve the move that just finished: crumble the tile stepped off, apply the
  // landed-on tile's effect, then check win. A slide/teleport started here owes a
  // further landing, so arrivalPending tracks whatever motion is now in flight.
  function processLanding(elapsed: number): void {
    if (player.hasFallen()) { state.arrivalPending = false; showGameOver(); return; }
    const action = level.onPlayerLand(state.playerCol, state.playerRow, state.prevCol, state.prevRow, elapsed);
    applyAction(action, elapsed);
    updateRemaining();
    state.arrivalPending = player.isMoving();
    if (!player.isMoving() && level.isWon(state.playerCol, state.playerRow)) showWin();
  }

  // Flush a pending landing the instant the cube comes to rest. Safe to call any
  // time; it is the single gate through which every landing is processed.
  function settleIfLanded(elapsed: number): void {
    if (state.won || state.gameOver || state.pauseMenu) return;
    if (state.arrivalPending && !player.isMoving()) processLanding(elapsed);
  }

  function tryMove(dir: Direction): void {
    // Resolve the previous tile's landing before moving on, so a fast second press
    // in the gap after a roll can never skip a crumble (and orphan a green tile).
    settleIfLanded(lastElapsed);
    if (player.isMoving()) return;
    const [dCol, dRow] = DIRECTION_DELTA[dir];
    const nextCol = state.playerCol + dCol;
    const nextRow = state.playerRow + dRow;
    if (!level.isTraversable(nextCol, nextRow)) {
      player.fall(dir);
      state.arrivalPending = true;
      return;
    }
    state.prevCol = state.playerCol;
    state.prevRow = state.playerRow;
    state.playerCol = nextCol;
    state.playerRow = nextRow;
    player.move(dir);
    state.arrivalPending = true;
  }

  return {
    group: level.group,

    onKey(code: string) {
      // An open overlay captures keys (confirm/navigation); movement is ignored.
      if (state.paused) { dispatchKey(infoButtons, code); return; }
      if (state.pauseMenu) {
        if (code === 'Escape') resume();   // Esc toggles the pause menu back off
        else dispatchKey(pauseButtons, code);
        return;
      }
      if (state.won) { dispatchKey(winButtons, code); return; }
      if (state.gameOver) { dispatchKey(gameOverButtons, code); return; }
      if (code === 'Escape') { openPause(); return; }
      const dir = KEY_MAP[code];
      if (dir) tryMove(dir);
    },

    tick(elapsed: number) {
      lastElapsed = elapsed;
      settleIfLanded(elapsed);

      player.update(elapsed);
      level.update(elapsed, `${state.playerCol},${state.playerRow}`);
    },

    dispose() {
      hideOverlay(infoOverlay);
      hideOverlay(winOverlay);
      hideOverlay(gameOverOverlay);
      hideOverlay(pauseOverlay);
      for (const b of allButtons) if (b.el) b.el.onclick = null;
      if (infoOverlay) infoOverlay.onclick = null;
      if (pauseOverlay) pauseOverlay.onclick = null;

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
