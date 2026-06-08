import * as THREE from 'three';

// Transient visual effects: glowing spheres that fly out of triggered tiles
// (removing tiles as they arrive) and the swirl vortex that consumes / releases
// the player block on a shift teleport. Everything is time-based off the same
// elapsed clock as the rest of the game; the manager derives its own dt.

const SPHERE_RADIUS = 0.11;
const SPHERE_SPEED = 9;          // world units / s
const SPHERE_FADE = 0.12;        // s to fade a sphere once its last tile is reached
const SWIRL_SPIN = 7;            // rad/s the orbiting swirl lines rotate
const SWIRL_DURATION = 0.44;     // s a teleport vortex lives (≈ shrink + grow)
const DT_CLAMP = 0.1;            // ignore huge gaps (tab refocus) so nothing teleports

// Shared, app-lifetime resources. createEffects() runs once per level, so these
// must outlive any single level's dispose() and are intentionally never freed.
const sphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS, 18, 18);
const ringGeo = new THREE.TorusGeometry(SPHERE_RADIUS * 1.7, 0.012, 8, 40);
const vortexRingGeo = new THREE.TorusGeometry(0.32, 0.03, 10, 48);

// Soft radial-gradient halo, tinted per instance via SpriteMaterial.color.
function makeHaloTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const haloTex = makeHaloTexture();

/** Any material we fade by ramping opacity to zero before disposal. */
type FadeMaterial = THREE.Material & { opacity: number };

function additiveMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

function makeHalo(color: number, scale: number): { sprite: THREE.Sprite; material: THREE.SpriteMaterial } {
  const material = new THREE.SpriteMaterial({
    map: haloTex,
    color,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(scale);
  return { sprite, material };
}

export interface ReachTarget {
  pos: THREE.Vector3;
  onReach: () => void;
}

export interface SpawnProjectileOptions {
  origin: THREE.Vector3;
  color: number;
  targets: ReachTarget[];
  startTime: number;
  speed?: number;
}

export interface SpawnSwirlOptions {
  pos: THREE.Vector3;
  color: number;
  startTime: number;
}

export interface Effects {
  group: THREE.Group;
  /** A glowing sphere that travels origin→targets, firing each onReach as it passes. */
  spawnProjectile(opts: SpawnProjectileOptions): void;
  /** A large swirl vortex that grows, spins, and fades at a point. */
  spawnSwirl(opts: SpawnSwirlOptions): void;
  update(elapsed: number): void;
  dispose(): void;
}

interface Projectile {
  mesh: THREE.Group;          // sphere + halo + swirl child
  swirl: THREE.Group;         // orbiting lines (spun each frame)
  mats: FadeMaterial[];       // per-instance materials to fade then dispose
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  startTime: number;
  speed: number;
  distance: number;           // travelled so far
  totalDist: number;          // distance to the final target
  targets: { cumDist: number; onReach: () => void }[];
  nextIdx: number;
  fadeAge: number;            // >0 once travelling is done
  started: boolean;
}

interface Swirl {
  mesh: THREE.Group;
  mats: FadeMaterial[];
  startTime: number;
}

export function createEffects(): Effects {
  const group = new THREE.Group();
  const projectiles: Projectile[] = [];
  const swirls: Swirl[] = [];
  let lastElapsed: number | null = null;

  function buildSphere(color: number): { mesh: THREE.Group; swirl: THREE.Group; mats: FadeMaterial[] } {
    const mesh = new THREE.Group();

    const coreMat = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color),
      emissiveIntensity: 2.2,
      roughness: 0.3,
      metalness: 0.0,
      transparent: true,
    });
    mesh.add(new THREE.Mesh(sphereGeo, coreMat));

    const halo = makeHalo(color, SPHERE_RADIUS * 6);
    mesh.add(halo.sprite);

    // Two tilted rings parented to a child group that spins → swirl lines.
    const swirl = new THREE.Group();
    const ringMat = additiveMaterial(color);
    const ringA = new THREE.Mesh(ringGeo, ringMat);
    ringA.rotation.set(Math.PI / 2.3, 0, 0);
    const ringB = new THREE.Mesh(ringGeo, ringMat);
    ringB.rotation.set(Math.PI / 2.3, 0, Math.PI / 2);
    swirl.add(ringA, ringB);
    mesh.add(swirl);

    return { mesh, swirl, mats: [coreMat, halo.material, ringMat] };
  }

  function spawnProjectile(opts: SpawnProjectileOptions): void {
    if (opts.targets.length === 0) return;
    const last = opts.targets[opts.targets.length - 1].pos;
    const dir = last.clone().sub(opts.origin);
    const totalDist = dir.length();
    if (totalDist < 1e-4) {
      // Degenerate (target on top of origin): just fire callbacks immediately.
      for (const t of opts.targets) t.onReach();
      return;
    }
    dir.normalize();

    const { mesh, swirl, mats } = buildSphere(opts.color);
    mesh.position.copy(opts.origin);
    mesh.visible = false;
    group.add(mesh);

    projectiles.push({
      mesh, swirl, mats,
      origin: opts.origin.clone(),
      dir,
      startTime: opts.startTime,
      speed: opts.speed ?? SPHERE_SPEED,
      distance: 0,
      totalDist,
      targets: opts.targets.map((t) => ({ cumDist: t.pos.clone().sub(opts.origin).dot(dir), onReach: t.onReach })),
      nextIdx: 0,
      fadeAge: 0,
      started: false,
    });
  }

  function spawnSwirl(opts: SpawnSwirlOptions): void {
    const mesh = new THREE.Group();
    mesh.position.copy(opts.pos);
    mesh.visible = false;

    const ringMat = additiveMaterial(opts.color);
    const ringA = new THREE.Mesh(vortexRingGeo, ringMat);
    ringA.rotation.x = Math.PI / 2;             // lie flat over the tile
    const ringB = new THREE.Mesh(vortexRingGeo, ringMat);
    ringB.rotation.x = Math.PI / 2;
    ringB.scale.setScalar(0.6);
    mesh.add(ringA, ringB);

    const halo = makeHalo(opts.color, 1.1);
    mesh.add(halo.sprite);

    group.add(mesh);
    swirls.push({ mesh, mats: [ringMat, halo.material], startTime: opts.startTime });
  }

  function disposeNode(mesh: THREE.Group, mats: FadeMaterial[]): void {
    group.remove(mesh);
    for (const m of mats) m.dispose();
  }

  function update(elapsed: number): void {
    const dt = lastElapsed === null ? 0 : Math.min(DT_CLAMP, Math.max(0, elapsed - lastElapsed));
    lastElapsed = elapsed;

    // ── projectiles ──
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      if (elapsed < p.startTime) continue;
      if (!p.started) { p.started = true; p.mesh.visible = true; }

      p.swirl.rotation.y += dt * SWIRL_SPIN;

      if (p.fadeAge === 0) {
        p.distance += p.speed * dt;
        // Fire every target the sphere has now reached (handles big dt steps).
        while (p.nextIdx < p.targets.length && p.targets[p.nextIdx].cumDist <= p.distance) {
          p.targets[p.nextIdx].onReach();
          p.nextIdx++;
        }
        const d = Math.min(p.distance, p.totalDist);
        p.mesh.position.copy(p.origin).addScaledVector(p.dir, d);
        if (p.distance >= p.totalDist) p.fadeAge = 1e-6;  // begin fading next frame
      } else {
        p.fadeAge += dt;
        const k = Math.max(0, 1 - p.fadeAge / SPHERE_FADE);
        p.mesh.scale.setScalar(k);
        for (const m of p.mats) m.opacity = k;
        if (p.fadeAge >= SPHERE_FADE) {
          disposeNode(p.mesh, p.mats);
          projectiles.splice(i, 1);
        }
      }
    }

    // ── swirls ──
    for (let i = swirls.length - 1; i >= 0; i--) {
      const s = swirls[i];
      const age = elapsed - s.startTime;
      if (age < 0) continue;
      s.mesh.visible = true;
      const t = age / SWIRL_DURATION;
      if (t >= 1) {
        disposeNode(s.mesh, s.mats);
        swirls.splice(i, 1);
        continue;
      }
      // Grow 0.3→1.3, opacity ramps in then out, fast spin.
      s.mesh.scale.setScalar(0.3 + t * 1.0);
      s.mesh.rotation.y += dt * SWIRL_SPIN * 1.6;
      const opacity = Math.sin(t * Math.PI);   // 0→1→0
      for (const m of s.mats) m.opacity = opacity;
    }
  }

  function dispose(): void {
    // Free this level's in-flight nodes and their per-instance materials. The
    // shared sphere/ring/halo geometry + texture are app-lifetime and reused by
    // the next level's Effects, so they are deliberately left intact — disposing
    // them here would pull GPU buffers out from under the following level.
    for (let i = projectiles.length - 1; i >= 0; i--) disposeNode(projectiles[i].mesh, projectiles[i].mats);
    for (let i = swirls.length - 1; i >= 0; i--) disposeNode(swirls[i].mesh, swirls[i].mats);
    projectiles.length = 0;
    swirls.length = 0;
  }

  return { group, spawnProjectile, spawnSwirl, update, dispose };
}
