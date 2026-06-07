import * as THREE from 'three';
import { PALETTE } from '../core';

export type TileKind =
  | 'base'
  | 'disappear-normal'
  | 'disappear-line'
  | 'arrow'
  | 'shift'
  | 'explosive';

export interface TileOptions {
  kind: TileKind;
  template: THREE.Group;
}

export function createTile({ kind, template }: TileOptions): THREE.Group {
  const group = template.clone();
  group.userData.kind = kind;

  const bodyColor = PALETTE.tileBody[kind];
  // Neon-edged trim: emissive so it reads as a glowing border.
  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor,
    roughness: 0.45,
    metalness: 0.05,
    emissive: new THREE.Color(bodyColor),
    emissiveIntensity: 0.35,
  });
  // Dark panel body: brushed-metal feel with low roughness.
  const trimMat = new THREE.MeshStandardMaterial({
    color: PALETTE.tileTrim,
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
