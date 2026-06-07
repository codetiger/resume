import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const CAMERA_FOV = 38;
const CAMERA_DISTANCE = 10;
const CAMERA_ELEVATION_DEG = 35;

export interface Engine {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  render: () => void;
  cameraTarget: THREE.Vector3;
  cameraBasePosition: THREE.Vector3;
  applyParallax: (tiltX: number, tiltY: number) => void;
  dispose: () => void;
}

export function createEngine(canvas: HTMLCanvasElement): Engine {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07140e);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const camera = new THREE.PerspectiveCamera(
    CAMERA_FOV,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
  );

  const elevRad = (CAMERA_ELEVATION_DEG * Math.PI) / 180;
  const cameraBasePosition = new THREE.Vector3(
    0,
    CAMERA_DISTANCE * Math.sin(elevRad),
    CAMERA_DISTANCE * Math.cos(elevRad),
  );
  camera.position.copy(cameraBasePosition);
  const cameraTarget = new THREE.Vector3(0, 0, 0);
  camera.lookAt(cameraTarget);

  // IBL environment — gives every surface normal ambient specular regardless of directional light angle.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.2;
  pmrem.dispose();

  // Ambient — lifts shadows just enough to keep dark faces readable.
  scene.add(new THREE.AmbientLight(0xffffff, 0.15));

  // Key light — angled from above-front-right, main source of depth shading.
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(6, 10, 8);
  key.castShadow = true;
  key.shadow.mapSize.setScalar(2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 40;
  key.shadow.camera.left   = -8;
  key.shadow.camera.right  =  8;
  key.shadow.camera.top    =  8;
  key.shadow.camera.bottom = -8;
  key.shadow.camera.updateProjectionMatrix();   // must call after changing ortho bounds
  key.shadow.bias = -0.001;
  scene.add(key);
  scene.add(key.target);   // target must be in the scene for shadow camera to orient correctly

  // Soft fill from the opposite side — prevents pure-black shadow faces.
  const fill = new THREE.DirectionalLight(0xaad4ff, 0.35);
  fill.position.set(-5, 4, -6);
  scene.add(fill);

  const onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };
  onResize();
  window.addEventListener("resize", onResize);

  const tmp = new THREE.Vector3();
  const applyParallax = (tiltX: number, tiltY: number) => {
    tmp.copy(cameraBasePosition);
    tmp.x += tiltX * 0.35;
    tmp.y += -tiltY * 0.25;
    camera.position.copy(tmp);
    camera.lookAt(cameraTarget);
  };

  return {
    scene,
    camera,
    renderer,
    render: () => renderer.render(scene, camera),
    cameraTarget,
    cameraBasePosition,
    applyParallax,
    dispose: () => {
      window.removeEventListener("resize", onResize);
      renderer.dispose();
    },
  };
}
