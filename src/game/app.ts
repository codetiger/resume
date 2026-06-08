import * as THREE from 'three';
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

  function mount(screen: Screen): void {
    if (current) {
      scene.remove(current.group);
      current.dispose();
    }
    current = screen;
    scene.add(screen.group);
  }

  const app: App = {
    goHome() {
      document.body.classList.remove('screen-level');
      document.body.classList.add('screen-home');
      player.group.visible = false;
      mount(createHomeScreen({
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
      mount(createLevelScreen({
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
        // Ignore clicks on DOM UI (overlay buttons, labels handle their own clicks).
        if ((e.target as HTMLElement)?.closest('button, .level-label')) return;
        const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
        const ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
        current.onPointerDown(ndcX, ndcY);
      });

      const clock = new THREE.Clock();
      let last = 0;
      const frame = () => {
        const elapsed = clock.getElapsedTime();
        const dt = elapsed - last;
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
