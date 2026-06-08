import * as THREE from 'three';
import type { Direction } from '../core';
import type { Engine } from '../engine/scene';
import { createPlayer } from './player';
import { CUBE_SIZE } from './grid';
import { LEVELS } from './levels';
import { createHomeScreen } from '../screens/home';
import { createLevelScreen } from '../screens/level';

export interface LoadedAssets {
  template: THREE.Group;
  tileHeight: number;
  playerModel: THREE.Group;
}

/** A mounted page (home / level). The app drives one at a time. */
export interface Screen {
  group: THREE.Group;
  tick: (elapsed: number, dt: number) => void;
  onKey?: (code: string) => void;
  onPointerDown?: (ndcX: number, ndcY: number) => void;
  /** A directional swipe / d-pad press. Only the level screen reacts; home keeps
   *  its own swipe-to-scroll, so it leaves this undefined. */
  onSwipe?: (dir: Direction) => void;
  dispose: () => void;
}

export interface App {
  goHome: () => void;
  goLevel: (index: number) => void;
  start: () => void;
}

const STORAGE_KEY = 'resume.completed';

function loadCompleted(): Set<number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw) as number[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveCompleted(set: Set<number>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* storage unavailable — completion is cosmetic, so ignore */
  }
}

// One persistent engine + render loop + player; screens are swapped in and out of
// the scene by mounting/unmounting a single root group.
export function createApp(engine: Engine, assets: LoadedAssets): App {
  const { scene, render } = engine;

  const player = createPlayer({ model: assets.playerModel, tileHeight: assets.tileHeight, cubeSize: CUBE_SIZE });
  scene.add(player.group);
  player.group.visible = false;

  const completed = loadCompleted();

  let current: Screen | null = null;

  // Build the next screen via a factory so the OLD screen is torn down first. The
  // overlay buttons are shared DOM that each level screen wires (onclick) on build
  // and un-wires (onclick = null) on dispose; building the new screen before the
  // old one's dispose ran would let that dispose null out the freshly-wired
  // buttons, leaving Retry/Next/Home dead to the mouse after a level→level switch.
  function mount(makeScreen: () => Screen): void {
    if (current) {
      scene.remove(current.group);
      current.dispose();
    }
    current = makeScreen();
    scene.add(current.group);
  }

  const app: App = {
    goHome() {
      document.body.classList.remove('screen-level');
      document.body.classList.add('screen-home');
      player.group.visible = false;
      mount(() => createHomeScreen({
        engine,
        assets,
        levels: LEVELS,
        completed,
        onSelect: (i) => app.goLevel(i),
      }));
    },

    goLevel(index) {
      if (index < 0 || index >= LEVELS.length) { app.goHome(); return; }
      document.body.classList.remove('screen-home');
      document.body.classList.add('screen-level');
      player.group.visible = true;
      mount(() => createLevelScreen({
        engine,
        assets,
        player,
        def: LEVELS[index],
        index,
        total: LEVELS.length,
        onComplete: () => { completed.add(LEVELS[index].number); saveCompleted(completed); },
        onNext: () => app.goLevel(index + 1),
        onHome: () => app.goHome(),
        onRetry: () => app.goLevel(index),
      }));
    },

    start() {
      window.addEventListener('keydown', (e) => {
        current?.onKey?.(e.code);
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
          e.preventDefault();
        }
      });

      window.addEventListener('pointerdown', (e) => {
        if (!current?.onPointerDown) return;
        // Ignore clicks on DOM UI (overlay buttons handle their own clicks).
        if ((e.target as HTMLElement)?.closest('button')) return;
        const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
        const ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
        current.onPointerDown(ndcX, ndcY);
      });

      // Touch: a swipe on the play canvas rolls the cube. Only the level screen
      // implements onSwipe, so on the home screen this is a no-op and its own
      // swipe-to-scroll keeps working. #stage sets touch-action:none so the
      // browser won't pan/zoom while playing.
      const canvas = engine.renderer.domElement;
      const SWIPE_MIN = 30;       // px of travel for a gesture to count as a swipe
      const SWIPE_MAX_MS = 600;   // slower drags aren't treated as swipes
      let sx = 0, sy = 0, st = 0, tracking = false;
      canvas.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        if (!t) return;
        sx = t.clientX; sy = t.clientY; st = performance.now(); tracking = true;
      }, { passive: true });
      canvas.addEventListener('touchend', (e) => {
        if (!tracking || !current?.onSwipe) return;
        tracking = false;
        const t = e.changedTouches[0];
        if (!t || performance.now() - st > SWIPE_MAX_MS) return;
        const dx = t.clientX - sx, dy = t.clientY - sy;
        if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return;
        const dir: Direction = Math.abs(dx) > Math.abs(dy)
          ? (dx > 0 ? 'right' : 'left')
          : (dy > 0 ? 'forward' : 'back');   // screen-down (dy>0) rolls "forward", matching ArrowDown
        current.onSwipe(dir);
      }, { passive: true });

      // On-screen d-pad (shown only on coarse-pointer devices via CSS). Each pad
      // button drives the same onSwipe path as a gesture.
      const DPAD: Record<string, Direction> = {
        'dpad-up': 'back', 'dpad-down': 'forward', 'dpad-left': 'left', 'dpad-right': 'right',
      };
      for (const [id, dir] of Object.entries(DPAD)) {
        document.getElementById(id)?.addEventListener('click', () => current?.onSwipe?.(dir));
      }

      const clock = new THREE.Clock();
      let last = 0;
      const frame = () => {
        const elapsed = clock.getElapsedTime();
        // Clamp dt so a long tab-away (which jumps the clock) can't integrate one
        // giant physics step and shoot the cube through a gap.
        const dt = Math.min(elapsed - last, 0.05);
        last = elapsed;

        current?.tick(elapsed, dt);

        render();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
  };

  return app;
}
