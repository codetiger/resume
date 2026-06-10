import * as THREE from 'three';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PALETTE } from '../core';

interface NormalizedModel {
  /** The loaded OBJ, uniformly scaled and centred on the local origin. */
  root: THREE.Object3D;
  /** Bounding-box size of the mesh *before* scaling. */
  size: THREE.Vector3;
  scale: number;
}

/**
 * Load an OBJ + its MTL from the deploy-relative models/ dir, then scale it (via
 * `fit`, which receives
 * the raw bounding-box size and returns a uniform scale factor) and centre its
 * bounding box on the origin so it can be used as a pivot template.
 *
 * Loading the MTL first guarantees each child Mesh carries a properly named
 * material, so callers can distinguish body vs trim faces by name.
 */
async function loadNormalizedModel(
  mtlFile: string,
  objFile: string,
  fit: (size: THREE.Vector3) => number,
): Promise<NormalizedModel> {
  // Base-relative so models resolve under the GitHub Pages project path
  // (BASE_URL is "/" in dev, "/resume/" in the production build).
  const modelsDir = `${import.meta.env.BASE_URL}models/`;
  const mtlLoader = new MTLLoader();
  mtlLoader.setPath(modelsDir);
  const materials = await mtlLoader.loadAsync(mtlFile);
  materials.preload();

  const objLoader = new OBJLoader();
  objLoader.setMaterials(materials);
  const root = await objLoader.loadAsync(`${modelsDir}${objFile}`);

  // Force world-matrix propagation so Box3.setFromObject works before render.
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const scale = fit(size);
  root.scale.setScalar(scale);
  root.position.set(-center.x * scale, -center.y * scale, -center.z * scale);

  return { root, size, scale };
}

function enableShadows(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

/** Load the player mesh, fit it within `cubeSize`, and upgrade it to neon PBR. */
export async function loadPlayerModel(cubeSize: number): Promise<THREE.Group> {
  const { root } = await loadNormalizedModel(
    'player.mtl',
    'player.obj',
    (s) => cubeSize / Math.max(s.x, s.y, s.z),
  );

  // Upgrade loaded materials to PBR, matching the platform emissive approach.
  const neonCyan = new THREE.Color(PALETTE.player.body);
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    const upgraded = mats.map((mat) =>
      mat.name === 'White'
        ? new THREE.MeshStandardMaterial({
            name: 'White',
            color: neonCyan,
            roughness: 0.35,
            metalness: 0.3,
          })
        : new THREE.MeshStandardMaterial({
            name: mat.name,
            color: (mat as THREE.MeshPhongMaterial).color ?? new THREE.Color(PALETTE.player.dark),
            roughness: 0.35,
            metalness: 0.4,
          }),
    );
    child.material = Array.isArray(child.material) ? upgraded : upgraded[0];
  });
  enableShadows(root);

  const group = new THREE.Group();
  group.add(root);
  return group;
}

export interface PlatformModel {
  /** Normalised pivot template — clone this for each tile. */
  template: THREE.Group;
  /**
   * Height of the tile after scaling (world units). The mesh centre sits at Y=0
   * in the pivot's local space, so the top surface is at +tileHeight/2 — matching
   * player.ts's resting convention.
   */
  tileHeight: number;
}

/** Load the shared platform mesh and fit its XZ extent to `tileSize`. */
export async function loadPlatformModel(tileSize: number): Promise<PlatformModel> {
  const { root, size, scale } = await loadNormalizedModel(
    'platforms.mtl',
    'platform.obj',
    (s) => tileSize / Math.max(s.x, s.z),
  );
  enableShadows(root);

  const pivot = new THREE.Group();
  pivot.add(root);
  return { template: pivot, tileHeight: size.y * scale };
}
