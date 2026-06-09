import * as THREE from 'three';
import { DIRECTION_DELTA, PALETTE, cellKey, parseCellKey, type Direction } from '../core';
import type { Engine } from '../engine/scene';
import type { Player } from '../game/player';
import { TELEPORT_SHRINK } from '../game/player';
import { buildLevel, CUBE_SIZE, type TileAction } from '../game/grid';
import type { LevelDef } from '../game/levels';
import type { Screen } from '../game/app';
// Obfuscated phone (e.g. "0x…"), provided by the resume-refs Vite plugin. Decoded
// only here, only after the player finishes the whole game — never stored or
// shipped as plain text.
import contact from 'virtual:contact';

/** Decode the obfuscated phone ("0x2507B120E" → "+91 99401 77422"). */
function decodePhone(encoded: string): string {
  const n = Number(encoded);
  if (!Number.isFinite(n) || n <= 0) return '';
  const local = String(n).replace(/(\d{5})(\d{5})$/, '$1 $2');
  return `+91 ${local}`;
}

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
const pad2 = (n: number) => String(n).padStart(2, '0');
/** Strip protocol / www / trailing slash to a bare host for link labels. */
const hostOf = (u: string) => u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

export function createLevelScreen(opts: LevelScreenOptions): Screen {
  const { assets, player, def, index, total } = opts;

  const level = buildLevel(def.layout, assets.template, assets.tileHeight);
  // Frame the camera to this board's size so larger (up to 8×8) levels stay fully in view.
  opts.engine.frameBoard(Math.max(level.cols, level.rows));
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
    const [col, row] = parseCellKey(baseEntry[0]);
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
  const infoChapterLabel = $('info-chapter-label');
  const infoRail = $('info-rail');
  const infoHeading = $('info-heading');
  const infoPeriod = $('info-period');
  const infoSub = $('info-sub');
  const infoSummary = $('info-summary');
  const infoBullets = $('info-bullets');
  const infoContact = $('info-contact');
  const infoAwards = $('info-awards');
  const infoTags = $('info-tags');
  const infoCta = $('info-cta');
  const infoLock = $('info-lock');
  const infoLink = $('info-link');
  const infoContinue = $('info-continue');

  const winOverlay = $('win-overlay');
  const winSub = $('win-sub');
  const winUnlock = $('win-unlock');
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

  // Accessibility: when a dialog opens, move focus to its first visible button so
  // keyboard / screen-reader users land inside it; when it closes, release focus so
  // it never lingers on a now-hidden control.
  const focusFirst = (...buttons: (HTMLElement | null)[]) =>
    buttons.find((b) => b && b.style.display !== 'none')?.focus();
  const releaseFocus = () => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); };

  function showInfo(): void {
    const c = def.content;
    // Per-chapter accent: an awards level reads gold, a behind-the-scenes (meta)
    // level reads mint, everything else (jobs, intro, education, contact) reads
    // cyan — matching the design system's job / award / meta popup variants.
    const variant = c.awards && c.awards.length ? 'award' : c.tag === 'meta' ? 'meta' : 'job';
    if (infoCard) infoCard.className = `info-card ${variant}`;
    if (infoNum) infoNum.textContent = pad3(def.number);
    // Chapter label + progress rail: one segment per level, filled up to here.
    if (infoChapterLabel) infoChapterLabel.textContent = `Chapter ${pad2(index + 1)} / ${pad2(total)}`;
    if (infoRail) {
      infoRail.innerHTML = '';
      for (let i = 0; i < total; i++) {
        const seg = document.createElement('i');
        if (i < index) seg.className = 'done';
        else if (i === index) seg.className = 'now';
        infoRail.appendChild(seg);
      }
    }
    if (infoHeading) infoHeading.textContent = c.heading;
    if (infoSub) { infoSub.textContent = c.subheading ?? ''; infoSub.style.display = c.subheading ? '' : 'none'; }
    if (infoPeriod) { infoPeriod.textContent = c.period ?? ''; infoPeriod.style.display = c.period ? '' : 'none'; }
    if (infoSummary) { infoSummary.textContent = c.summary ?? ''; infoSummary.style.display = c.summary ? '' : 'none'; }
    if (infoBullets) {
      infoBullets.innerHTML = '';
      infoBullets.style.display = c.bullets.length ? '' : 'none';
      for (const b of c.bullets) {
        const li = document.createElement('li');
        li.textContent = b;
        infoBullets.appendChild(li);
      }
    }
    if (infoContact) {
      infoContact.innerHTML = '';
      const rows: HTMLElement[] = [];
      // Each row is a key/value pair: a muted accent key and a gold value.
      const kv = (parent: HTMLElement, key: string, value: string, valueClass?: string) => {
        const k = document.createElement('span');
        k.className = 'k';
        k.textContent = key;
        const v = document.createElement('span');
        if (valueClass) v.className = valueClass;
        v.textContent = value;
        parent.append(k, v);
      };
      if (c.email) {
        const a = document.createElement('a');
        a.className = 'contact-link';
        a.href = `mailto:${c.email}`;
        kv(a, 'email', c.email, 'v');
        rows.push(a);
      }
      for (const link of c.links ?? []) {
        const a = document.createElement('a');
        a.className = 'contact-link';
        a.href = link.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        kv(a, link.label.toLowerCase(), hostOf(link.url), 'v');
        rows.push(a);
      }
      if (c.location) {
        const s = document.createElement('span');
        s.className = 'contact-loc';
        kv(s, 'based in', c.location);
        rows.push(s);
      }
      infoContact.style.display = rows.length ? '' : 'none';
      rows.forEach((el) => infoContact.appendChild(el));
    }
    if (infoAwards) {
      infoAwards.innerHTML = '';
      const awards = c.awards ?? [];
      infoAwards.style.display = awards.length ? '' : 'none';
      for (const a of awards) {
        const item = document.createElement('div');
        item.className = 'award';

        const title = document.createElement('div');
        title.className = 'award-title';
        title.textContent = a.title;
        item.appendChild(title);

        const meta = [a.awarder, a.date].filter(Boolean).join(' · ');
        if (meta) {
          const metaEl = document.createElement('div');
          metaEl.className = 'award-meta';
          metaEl.textContent = meta;
          item.appendChild(metaEl);
        }

        const desc = document.createElement('div');
        desc.className = 'award-desc';
        desc.textContent = a.summary;
        item.appendChild(desc);

        infoAwards.appendChild(item);
      }
    }
    if (infoTags) {
      infoTags.innerHTML = '';
      const tags = c.tags ?? [];
      infoTags.style.display = tags.length ? '' : 'none';
      for (const t of tags) {
        const s = document.createElement('span');
        s.textContent = t;
        infoTags.appendChild(s);
      }
    }
    const isMeta = c.tag === 'meta';
    // Meta (social) chapters get a big single-link CTA; everything else keeps the
    // small contextual link in the foot. The two are mutually exclusive.
    if (infoCta instanceof HTMLAnchorElement) {
      if (isMeta && c.url) {
        infoCta.href = c.url;
        infoCta.innerHTML = '';
        const u = document.createElement('span');
        u.className = 'u';
        u.textContent = hostOf(c.url);
        const arr = document.createElement('span');
        arr.className = 'arr';
        arr.textContent = '↗';
        infoCta.append(u, arr);
        infoCta.style.display = '';
      } else {
        infoCta.removeAttribute('href');
        infoCta.style.display = 'none';
      }
    }
    if (infoLink instanceof HTMLAnchorElement) {
      if (!isMeta && c.url) {
        infoLink.href = c.url;
        infoLink.textContent = `${c.linkLabel ?? hostOf(c.url)} ↗`;
        infoLink.style.display = '';
      } else {
        infoLink.removeAttribute('href');
        infoLink.style.display = 'none';
      }
    }
    // The final Contact chapter teases the locked phone number, unlocked by
    // finishing the game (revealed on the win overlay).
    if (infoLock) {
      const showLock = !!c.email;
      infoLock.style.display = showLock ? '' : 'none';
      infoLock.innerHTML = '';
      if (showLock) {
        const ico = document.createElement('span');
        ico.className = 'ico';
        ico.textContent = '⬡';
        const txt = document.createElement('span');
        txt.textContent =
          'Clear this final level and roll back to the start tile to unlock my phone number.';
        infoLock.append(ico, txt);
      }
    }
    state.paused = true;
    showOverlay(infoOverlay);
    focusFirst(infoContinue);
  }

  function dismissInfo(): void {
    state.paused = false;
    hideOverlay(infoOverlay);
    releaseFocus();
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
    // Finishing the final level unlocks the phone number — the reward for playing.
    if (winUnlock) {
      const phone = !hasNext ? decodePhone(contact.phone) : '';
      winUnlock.textContent = phone ? `Unlocked — call me: ${phone}` : '';
      winUnlock.style.display = phone ? '' : 'none';
    }
    showOverlay(winOverlay);
    focusFirst(winNext, winHome);
  }

  function showGameOver(): void {
    if (state.gameOver) return;
    state.gameOver = true;
    showOverlay(gameOverOverlay);
    focusFirst(gameOverRetry);
  }

  // Esc pause menu. Only opens during active play (not over another overlay); the
  // pending-landing logic is frozen while it's up (see settleIfLanded) so nothing
  // resolves behind the blur, and Esc / backdrop click resume exactly where you were.
  function openPause(): void {
    if (state.won || state.gameOver || state.paused || state.pauseMenu) return;
    state.pauseMenu = true;
    showOverlay(pauseOverlay);
    focusFirst(pauseRetry);
  }

  function resume(): void {
    state.pauseMenu = false;
    hideOverlay(pauseOverlay);
    releaseFocus();
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
      if (code === 'KeyR') { opts.onRetry(); return; }  // quick restart mid-play
      const dir = KEY_MAP[code];
      if (dir) tryMove(dir);
    },

    // A touch swipe / d-pad press, routed through the same move gate as the keys.
    // Ignored while any overlay is up so a stray swipe can't move behind a dialog.
    onSwipe(dir: Direction) {
      if (state.paused || state.pauseMenu || state.won || state.gameOver) return;
      tryMove(dir);
    },

    tick(elapsed: number) {
      lastElapsed = elapsed;
      settleIfLanded(elapsed);

      player.update(elapsed);
      level.update(elapsed, cellKey(state.playerCol, state.playerRow));

      // A delayed blast (3-2-1 fuse) or a chain reaction can clear the final tiles *after* the cube
      // is already at rest on the base — the landing-time check in processLanding misses that. Keep
      // the counter live and re-check the win once motion + chains have settled.
      if (!state.won && !state.gameOver) {
        updateRemaining();
        if (
          !state.arrivalPending &&
          !player.isMoving() &&
          !player.hasFallen() &&
          level.isWon(state.playerCol, state.playerRow)
        ) {
          showWin();
        }
      }
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
