import * as THREE from 'three';

export type TileKind =
  | 'base'
  | 'disappear-normal'
  | 'disappear-line'
  | 'arrow'
  | 'shift'
  | 'explosive';

const BODY_COLORS: Record<TileKind, number> = {
  'base':             0xf1f5f9,  // off-white  — start / finish
  'disappear-normal': 0x16a34a,  // green      — standard disappear
  'disappear-line':   0xea580c,  // deep orange — row/col wipe
  'arrow':            0xfacc15,  // yellow     — forced slide rail
  'shift':            0x0891b2,  // cyan       — teleport portal
  'explosive':        0xdc2626,  // red        — blast radius
};

const TRIM_COLOR = 0x1a3352;  // deep ocean blue — shows PBR depth rather than reading as black

export interface TileOptions {
  kind: TileKind;
  template: THREE.Group;
}

export function createTile({ kind, template }: TileOptions): THREE.Group {
  const group = template.clone();
  group.userData.kind = kind;

  const neonColor = BODY_COLORS[kind];
  // Neon-edged trim: emissive so it reads as a glowing border.
  const bodyMat = new THREE.MeshStandardMaterial({
    color: neonColor,
    roughness: 0.45,
    metalness: 0.05,
    emissive: new THREE.Color(neonColor),
    emissiveIntensity: 0.35,
  });
  // Dark panel body: brushed-metal feel with low roughness.
  const trimMat = new THREE.MeshStandardMaterial({
    color: TRIM_COLOR,
    roughness: 0.35,
    metalness: 0.4,
  });

  const pick = (src: THREE.Material): THREE.MeshStandardMaterial =>
    src.name === 'Material2' ? bodyMat : trimMat;

  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;
    child.receiveShadow = true;
    child.material = Array.isArray(child.material)
      ? child.material.map(pick)
      : pick(child.material as THREE.Material);
  });

  return group;
}
