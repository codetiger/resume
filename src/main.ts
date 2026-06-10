import { createEngine } from './engine/scene';
import { loadPlatformModel, loadPlayerModel } from './engine/models';
import { TILE_SIZE, CUBE_SIZE } from './game/grid';
import { createApp } from './game/app';

const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
if (!canvas) throw new Error('canvas#stage not found');

// Point the home avatar at the deploy-relative asset (BASE_URL is "/" in dev,
// "/resume/" in the Pages build) instead of a hardcoded absolute path.
const homeAvatar = document.getElementById('home-avatar') as HTMLImageElement | null;
if (homeAvatar) homeAvatar.src = `${import.meta.env.BASE_URL}harishankar.jpeg`;

// "How to play" popup, shown on the home screen. Auto-opens on a visitor's first
// time (remembered in localStorage); the home-screen button reopens it anytime.
const INTRO_SEEN_KEY = 'resume-game:intro-seen';
function setupExplorePopup(): void {
  const overlay = document.getElementById('explore-overlay');
  if (!overlay) return;
  const openBtn = document.getElementById('explore-open');
  const closeBtn = document.getElementById('explore-close');
  let isOpen = false;
  const open = (): void => {
    isOpen = true;
    overlay.style.display = 'flex';
    (closeBtn as HTMLElement | null)?.focus();
  };
  const close = (): void => {
    isOpen = false;
    overlay.style.display = 'none';
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener('keydown', (e) => {
    if (isOpen && e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  // First visit: show it once, then remember. If storage is unavailable
  // (private mode), just show it — better than silently skipping the intro.
  let seen = false;
  try {
    seen = localStorage.getItem(INTRO_SEEN_KEY) === '1';
  } catch {
    /* keep the default: show the intro */
  }
  if (!seen) {
    open();
    try {
      localStorage.setItem(INTRO_SEEN_KEY, '1');
    } catch {
      /* ignore */
    }
  }
}
setupExplorePopup();

const engine = createEngine(canvas);

// If the 3D assets can't be fetched/parsed (offline, missing file, no WebGL),
// don't leave a blank dark canvas — point the visitor at the static résumé.
function showLoadError(): void {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;z-index:99;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:1rem;padding:2rem;text-align:center;' +
    'background:#05090f;color:#e8f3ff;font-family:system-ui,sans-serif;';
  el.innerHTML =
    '<p style="max-width:28rem;line-height:1.6">The interactive résumé couldn\'t load. ' +
    'You can read the full résumé here instead.</p>' +
    '<a href="resume.html" style="color:#8cdcff">Open the static résumé ▸</a>';
  document.body.appendChild(el);
}

try {
  // Load the shared meshes once; every level reuses them.
  const [{ template, tileHeight }, playerModel] = await Promise.all([
    loadPlatformModel(TILE_SIZE),
    loadPlayerModel(CUBE_SIZE),
  ]);

  const app = createApp(engine, { template, tileHeight, playerModel });
  app.goHome();
  app.start();
} catch (err) {
  console.error('Failed to load game assets', err);
  showLoadError();
}
