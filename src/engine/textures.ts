import * as THREE from 'three';

export interface TextureRegistry {
  player: THREE.Texture;
  dispose: () => void;
}

const PLAYER_PATH = '/textures/texture_player.png';

export async function loadTextures(renderer: THREE.WebGLRenderer): Promise<TextureRegistry> {
  const loader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const player = await new Promise<THREE.Texture>((resolve, reject) => {
    loader.load(PLAYER_PATH, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(maxAniso, 8);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      resolve(tex);
    }, undefined, reject);
  });

  return {
    player,
    dispose: () => player.dispose(),
  };
}
