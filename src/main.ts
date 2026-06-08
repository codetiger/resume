import { createEngine } from './engine/scene';
import { loadPlatformModel, loadPlayerModel } from './engine/models';
import { TILE_SIZE, CUBE_SIZE } from './game/grid';
import { createApp } from './game/app';

const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
if (!canvas) throw new Error('canvas#stage not found');

const engine = createEngine(canvas);

// If the 3D assets can't be fetched/parsed (offline, missing file, no WebGL),
// don't leave a blank dark canvas — point the visitor at the static résumé.
function showLoadError(): void {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;z-index:99;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;gap:1rem;padding:2rem;text-align:center;' +
    'background:#050a12;color:#e6f1ff;font-family:system-ui,sans-serif;';
  el.innerHTML =
    '<p style="max-width:28rem;line-height:1.6">The interactive résumé couldn\'t load. ' +
    'You can read the full résumé here instead.</p>' +
    '<a href="./public/" style="color:#8fd4ff">Open the static résumé ▸</a>';
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
