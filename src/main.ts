import { createEngine } from './engine/scene';
import { loadPlatformModel, loadPlayerModel } from './engine/models';
import { TILE_SIZE, CUBE_SIZE } from './game/grid';
import { createApp } from './game/app';

const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
if (!canvas) throw new Error('canvas#stage not found');

const engine = createEngine(canvas);

// Load the shared meshes once; every level reuses them.
const [{ template, tileHeight }, playerModel] = await Promise.all([
  loadPlatformModel(TILE_SIZE),
  loadPlayerModel(CUBE_SIZE),
]);

const app = createApp(engine, { template, tileHeight, playerModel });
app.goHome();
app.start();
