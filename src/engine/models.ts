import * as THREE from 'three';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

/**
 * Load the player mesh (OBJ + MTL), scale it uniformly so its bounding box
 * fits within `cubeSize`, and centre it at the local origin.
 */
export async function loadPlayerModel(cubeSize: number): Promise<THREE.Group> {
  const mtlLoader = new MTLLoader();
  mtlLoader.setPath('/models/');
  const materials = await mtlLoader.loadAsync('player.mtl');
  materials.preload();

  const objLoader = new OBJLoader();
  objLoader.setMaterials(materials);
  const raw = await objLoader.loadAsync('/models/player.obj');

  // Upgrade player materials to neon-glow PBR, matching the platform emissive approach.
  const neonCyan = new THREE.Color(0x00ccff);
  raw.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;
    child.receiveShadow = true;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    const upgraded = mats.map((mat) => {
      if (mat.name === 'White') {
        return new THREE.MeshStandardMaterial({
          name: 'White',
          color: neonCyan,
          roughness: 0.35,
          metalness: 0.3,
        });
      }
      // Dark structural parts: same roughness/metalness as platform trim for consistent specular.
      const baseMat = mat as THREE.MeshPhongMaterial;
      return new THREE.MeshStandardMaterial({
        name: mat.name,
        color: baseMat.color ?? new THREE.Color(0x334455),
        roughness: 0.35,
        metalness: 0.4,
      });
    });
    child.material = Array.isArray(child.material) ? upgraded : upgraded[0];
  });

  raw.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(raw);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const scale = cubeSize / Math.max(size.x, size.y, size.z);
  raw.scale.setScalar(scale);
  raw.position.set(-center.x * scale, -center.y * scale, -center.z * scale);

  const group = new THREE.Group();
  group.add(raw);
  return group;
}

export interface PlatformModel {
  /** Normalised pivot template — clone this for each tile. */
  template: THREE.Group;
  /**
   * Height of the tile after uniform scaling (world units).
   * The geometric centre of the mesh sits at Y=0 in the pivot's local space,
   * so the top surface is at +tileHeight/2 — matching player.ts convention.
   */
  tileHeight: number;
}

/**
 * Load the shared platform mesh (OBJ + MTL), scale it so its XZ extent
 * equals `tileSize`, and centre it on the pivot origin.
 *
 * Loading with MTLLoader guarantees that each child Mesh carries a properly
 * named MeshPhongMaterial so tile.ts can identify body (Material2, white)
 * vs trim (Material, black) by material colour.
 */
export async function loadPlatformModel(tileSize: number): Promise<PlatformModel> {
  // Load MTL first — without it, OBJLoader creates anonymous materials and
  // we cannot distinguish body from trim faces.
  const mtlLoader = new MTLLoader();
  mtlLoader.setPath('/models/');
  const materials = await mtlLoader.loadAsync('platforms.mtl');
  materials.preload();

  const objLoader = new OBJLoader();
  objLoader.setMaterials(materials);
  const raw = await objLoader.loadAsync('/models/platform.obj');

  // Force world-matrix propagation so Box3.setFromObject works before render.
  raw.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(raw);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // Uniform scale: fit the larger horizontal extent to tileSize.
  const scale = tileSize / Math.max(size.x, size.z);

  // Wrap in a pivot so we can position each tile independently.
  // Offset `raw` inside the pivot so its bounding-box centre sits at (0,0,0).
  raw.scale.setScalar(scale);
  raw.position.set(
    -center.x * scale,
    -center.y * scale,
    -center.z * scale,
  );

  raw.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;
    child.receiveShadow = true;
  });

  const pivot = new THREE.Group();
  pivot.add(raw);

  // After centering: top surface = +tileHeight/2  (matches player.ts yFloor convention).
  const tileHeight = size.y * scale;

  return { template: pivot, tileHeight };
}
