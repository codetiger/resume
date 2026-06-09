import * as THREE from 'three';
import { PALETTE, clamp } from '../core';
import type { Engine } from '../engine/scene';
import { createTile } from '../game/tile';
import { createNumberDisplay } from '../game/decoration';
import type { LevelDef } from '../game/levels';
import type { Screen } from '../game/app';

// The level select is a paginated grid: at most VISIBLE_ROWS rows of platforms
// fill the screen at once. Scrolling pages through the rows — a row leaving the
// view tumbles away (gravity fall, like a destroyed in-level tile) and the row
// entering drops in from the opposite edge (the reverse fall). Column count and
// platform size adapt to the viewport so the screen is fully used on any device.
const VISIBLE_ROWS = 3;
const DROP = 2.6;          // how far an off-band row floats above / sinks below
const SPIN = 1.5;          // tumble (radians) at the edge of the band
const FALL_VANISH = 0.8;   // off-band distance (rows) at which a falling row is hidden
const EASE = 0.18;         // scroll easing per frame
const WHEEL_STEP = 90;     // wheel delta needed to page one row
const FOCUS_LIFT = 0.32;   // how high the selected tile rises above its row
const FOCUS_SCALE = 1.32;  // and how much bigger it swells

const columnsForWidth = (w: number) => clamp(Math.round(w / 180), 2, 8);

export interface HomeScreenOptions {
  engine: Engine;
  assets: { template: THREE.Group };
  levels: LevelDef[];
  completed: Set<number>;
  onSelect: (index: number) => void;
}

interface Tile {
  wrapper: THREE.Group;
  levelIndex: number;
  /** Recolour / restore the tile's 3 materials to mark it as the current selection. */
  setSelected: (on: boolean) => void;
}

// A focused tile reads as "live" — the design system's cyan-vivid (#00ccff), the
// same colour as the player cube and the progress rail's "now" segment. Earlier
// it used a light cyan driven to emissive 0.95, which blew out to a bleached
// white under ACES tone mapping; these values keep the glow rich and on-brand
// (the lift + scale do the rest of the "selected" signalling). One per material role.
type TileRole = 'body' | 'trim' | 'digits';
const SELECTED: Record<TileRole, { color: number; emissive: number; intensity: number }> = {
  body:   { color: 0x00ccff, emissive: 0x00ccff, intensity: 0.55 }, // cyan-vivid, glowing but not clipped
  trim:   { color: 0x0f1d2e, emissive: 0x0891b2, intensity: 0.35 }, // raised-card dark with a cyan-shift rim
  digits: { color: 0xe8f3ff, emissive: 0x8cdcff, intensity: 0.45 }, // ice-white (tx-0) with a soft cyan halo
};
interface Row {
  group: THREE.Group;
  tiles: Tile[];
}

// A flat name plate laid on the platform surface, just in front of (below, on
// screen) the odometer number. The text is drawn to a canvas and mapped onto a
// plane rotated flat so it reads from above — part of the world, not a floating
// DOM label. It shares the UI's type + colour language: the name in Space Grotesk
// ice-white (tx-0), the year in JetBrains Mono gold (the "time / date" accent).
// Returns the mesh; its texture/material are disposed in dispose().
const LABEL_DISPLAY = "'Space Grotesk', system-ui, -apple-system, sans-serif";
const LABEL_MONO = "'JetBrains Mono', 'SF Mono', monospace";
const LABEL_NAME = '#e8f3ff'; // tx-0
const LABEL_YEAR = '#ffd166'; // gold — dates / time
// Canvas paints with whatever font is ready at draw time, so we draw immediately
// (system fallback) and force-load the brand faces; createNameLabel redraws once
// they resolve. Shared so the dozens of labels trigger a single load.
const LABEL_FONTS_READY: Promise<unknown> = document.fonts?.load
  ? Promise.all([
      document.fonts.load('600 60px "Space Grotesk"'),
      document.fonts.load('500 44px "JetBrains Mono"'),
    ]).catch(() => undefined)
  : Promise.resolve();

function createNameLabel(name: string, year: string): THREE.Mesh {
  const W = 512, H = 200;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const maxW = W - 40;
  const fit = (text: string, weight: number, font: string, start: number) => {
    let px = start;
    do { ctx.font = `${weight} ${px}px ${font}`; if (ctx.measureText(text).width <= maxW) break; px -= 2; } while (px > 18);
    return px;
  };

  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    if (year) {
      ctx.font = `600 ${fit(name, 600, LABEL_DISPLAY, 60)}px ${LABEL_DISPLAY}`;
      ctx.fillStyle = LABEL_NAME;
      ctx.fillText(name, W / 2, 76);
      ctx.font = `500 ${fit(year, 500, LABEL_MONO, 44)}px ${LABEL_MONO}`;
      ctx.fillStyle = LABEL_YEAR;
      ctx.fillText(year, W / 2, 140);
    } else {
      ctx.font = `600 ${fit(name, 600, LABEL_DISPLAY, 66)}px ${LABEL_DISPLAY}`;
      ctx.fillStyle = LABEL_NAME;
      ctx.fillText(name, W / 2, H / 2);
    }
  };
  draw();

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  // Repaint with the real brand fonts the moment they're available.
  LABEL_FONTS_READY.then(() => { draw(); tex.needsUpdate = true; });

  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.36), mat);
  mesh.rotation.x = -Math.PI / 2;       // lie flat on the platform, readable from above
  mesh.position.set(0, 0.1, 0.30);      // hover just over the surface, in front of the number
  mesh.renderOrder = 2;
  return mesh;
}

// The rolling "This is …" word reserves the widest label's width by default, so
// shorter words sit off-centre. Measure each word with the roller's own font and
// feed the widths into the CSS width-animation (keyframes rollw) as --w0…--wN, so
// the clip box tracks the visible word and the line stays centred. Re-runnable on
// resize, since the font size shifts at the mobile breakpoint.
function syncRollerWidths(): void {
  const roller = document.querySelector<HTMLElement>('#home-hud .roller');
  const words = roller ? Array.from(roller.querySelectorAll<HTMLElement>('.roller-track > span')) : [];
  if (!roller || !words.length) return;

  const cs = getComputedStyle(words[0]);
  const probe = document.createElement('span');
  Object.assign(probe.style, {
    position: 'absolute',
    visibility: 'hidden',
    whiteSpace: 'nowrap',
    fontWeight: cs.fontWeight,
    fontSize: cs.fontSize,
    fontFamily: cs.fontFamily,
    letterSpacing: cs.letterSpacing,
  });
  document.body.appendChild(probe);
  words.forEach((w, i) => {
    probe.textContent = w.textContent;
    roller.style.setProperty(`--w${i}`, `${Math.ceil(probe.getBoundingClientRect().width)}px`);
  });
  probe.remove();
}

export function createHomeScreen(opts: HomeScreenOptions): Screen {
  const { engine, assets, levels, completed, onSelect } = opts;
  // Restore the default framing (a level screen may have pulled the camera back for a big board).
  engine.frameBoard(6);
  const group = new THREE.Group();
  syncRollerWidths();

  // Sequential unlock: a level is playable only once the previous one is cleared.
  // The first level — and any already-completed level — is always open.
  const isUnlocked = (i: number): boolean =>
    i === 0 || completed.has(levels[i].number) || completed.has(levels[i - 1].number);
  const select = (i: number): void => { if (isUnlocked(i)) onSelect(i); };

  // When the visitor prefers reduced motion, page instantly and drop the row
  // tumble (the CSS roller/pulse are already stilled by a media query).
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  // Responsive layout: columns from width, then size the platforms to fill the
  // visible world width at the grid's depth (which scales with viewport aspect).
  const aspect = window.innerWidth / window.innerHeight;
  const COLS = columnsForWidth(window.innerWidth);
  const usableW = clamp(5.4 * aspect, 2.4, 11);
  const COL_DX = usableW / COLS;
  // Platforms sit at 3/4 of the column pitch so there's clear air between tiles.
  const SCALE = clamp(COL_DX * 0.8, 0.3, 1.15) * 0.75;
  // A platform spans ~SCALE world units (the template is normalised to TILE_SIZE =
  // 1.0), so the empty gap between neighbours is (pitch − SCALE). Tighten that gap to
  // 3/4 — the columns pull inward, which also leaves breathing room at the borders.
  const COL_PITCH = SCALE + (COL_DX - SCALE) * 0.75;

  // On tall (portrait) screens the same world depth projects lower, so raise and
  // tighten the rows to keep all three on-screen and fill the space.
  const portrait = aspect < 0.85;
  const Z_TOP = portrait ? -0.3 : 0.4;   // smaller = higher on screen
  const ROW_GAP = portrait ? 1.35 : 1.5; // Z pitch between rows before tightening
  const ROW_DZ = SCALE + (ROW_GAP - SCALE) * 0.75; // tighten the row gap to 3/4 too

  const totalRows = Math.ceil(levels.length / COLS);
  const maxTop = Math.max(0, totalRows - VISIBLE_ROWS);

  const rows: Row[] = [];
  for (let r = 0; r < totalRows; r++) {
    const rowGroup = new THREE.Group();
    group.add(rowGroup);
    const start = r * COLS;
    const count = Math.min(COLS, levels.length - start);
    const tiles: Tile[] = [];
    for (let c = 0; c < count; c++) {
      const i = start + c;
      const def = levels[i];

      const wrapper = new THREE.Group();
      wrapper.position.x = (c - (count - 1) / 2) * COL_PITCH;
      wrapper.scale.setScalar(SCALE);
      wrapper.userData.levelIndex = i;

      const tile = createTile({ kind: completed.has(def.number) ? 'info' : 'base', template: assets.template });
      wrapper.add(tile);

      const number = createNumberDisplay(PALETTE.decoration.shift);
      if (isUnlocked(i)) number.set(def.number);
      else number.lock();
      // Sit the odometer toward the back (up on screen) so the name plate below it
      // gets clear room on the platform's surface.
      number.group.position.z = -0.16;
      wrapper.add(number.group);
      rowGroup.add(wrapper);

      // Capture this tile's 3 unique materials and tag each by role so selection
      // can recolour them to the cyan-focus palette and restore them after. The
      // odometer digits live under number.group; of the two platform materials,
      // the glowing one (non-black emissive) is the body and the other the trim.
      const numberMats = new Set<THREE.Material>();
      number.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => numberMats.add(m));
        }
      });
      const seen = new Set<THREE.Material>();
      const mats: { m: THREE.MeshStandardMaterial; color: number; emissive: number; intensity: number; sel: typeof SELECTED[TileRole] }[] = [];
      wrapper.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of list) {
          if (!(m instanceof THREE.MeshStandardMaterial) || seen.has(m)) continue;
          seen.add(m);
          const role: TileRole = numberMats.has(m)
            ? 'digits'
            : m.emissive.getHex() === 0 ? 'trim' : 'body';
          mats.push({
            m,
            color: m.color.getHex(),
            emissive: m.emissive.getHex(),
            intensity: m.emissiveIntensity,
            sel: SELECTED[role],
          });
        }
      });
      const setSelected = (on: boolean) => {
        for (const s of mats) {
          if (on) {
            s.m.color.setHex(s.sel.color);
            s.m.emissive.setHex(s.sel.emissive);
            s.m.emissiveIntensity = s.sel.intensity;
          } else {
            s.m.color.setHex(s.color);
            s.m.emissive.setHex(s.emissive);
            s.m.emissiveIntensity = s.intensity;
          }
        }
      };

      const [main, ...rest] = def.name.split('·');
      const year = rest.join('·').trim();
      wrapper.add(createNameLabel(main.trim(), year));

      tiles.push({ wrapper, levelIndex: i, setSelected });
    }
    rows.push({ group: rowGroup, tiles });
  }

  const tileByIndex = new Map<number, Tile>();
  rows.forEach((row) => row.tiles.forEach((t) => tileByIndex.set(t.levelIndex, t)));

  let focus = 0;
  let appliedFocus = -1; // which tile currently carries the inverted "selected" look
  let targetTop = 0;
  let view = 0;

  const clampTop = (t: number) => clamp(t, 0, maxTop);
  const scrollBy = (d: number) => {
    targetTop = clampTop(targetTop + d);
    // Keep keyboard focus within the visible rows so Enter launches a level you see.
    const fr = Math.floor(focus / COLS);
    if (fr < targetTop) focus = clamp(targetTop * COLS, 0, levels.length - 1);
    else if (fr > targetTop + VISIBLE_ROWS - 1) focus = clamp((targetTop + VISIBLE_ROWS - 1) * COLS, 0, levels.length - 1);
  };

  const ensureFocusVisible = () => {
    const fr = Math.floor(focus / COLS);
    if (fr < targetTop) targetTop = clampTop(fr);
    else if (fr > targetTop + VISIBLE_ROWS - 1) targetTop = clampTop(fr - VISIBLE_ROWS + 1);
  };
  const setFocus = (i: number) => {
    focus = clamp(i, 0, levels.length - 1);
    ensureFocusVisible();
  };

  // ── scroll input (wheel + touch) ────────────────────────────────────────────
  let wheelAccum = 0;
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    wheelAccum += e.deltaY;
    while (wheelAccum >= WHEEL_STEP) { scrollBy(1); wheelAccum -= WHEEL_STEP; }
    while (wheelAccum <= -WHEEL_STEP) { scrollBy(-1); wheelAccum += WHEEL_STEP; }
  };
  let touchY = 0;
  const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? 0; };
  const onTouchMove = (e: TouchEvent) => {
    const y = e.touches[0]?.clientY ?? touchY;
    const dy = y - touchY;
    if (Math.abs(dy) > 55) { scrollBy(dy < 0 ? 1 : -1); touchY = y; e.preventDefault(); }
  };
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('resize', syncRollerWidths);

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  // Spatial → fall distance. Squared term gives a gravity-like acceleration.
  const fall = (u: number) => u * (1 + 0.55 * u);

  return {
    group,

    onKey(code: string) {
      if (code === 'ArrowRight' || code === 'KeyD') setFocus(focus + 1);
      else if (code === 'ArrowLeft' || code === 'KeyA') setFocus(focus - 1);
      else if (code === 'ArrowDown' || code === 'KeyS') setFocus(focus + COLS);
      else if (code === 'ArrowUp' || code === 'KeyW') setFocus(focus - COLS);
      else if (code === 'Enter' || code === 'Space') select(focus);
    },

    onPointerDown(ndcX: number, ndcY: number) {
      ndc.set(ndcX, ndcY);
      raycaster.setFromCamera(ndc, engine.camera);
      const candidates = rows.filter((r) => r.group.visible).map((r) => r.group);
      const hits = raycaster.intersectObjects(candidates, true);
      for (const hit of hits) {
        let o: THREE.Object3D | null = hit.object;
        while (o && o.userData.levelIndex === undefined) o = o.parent;
        if (o) { select(o.userData.levelIndex as number); return; }
      }
    },

    tick() {
      view += (targetTop - view) * (reduceMotion ? 1 : EASE);
      if (Math.abs(targetTop - view) < 0.0015) view = targetTop;

      // Move the inverted "selected" look only when the focus actually changes.
      if (focus !== appliedFocus) {
        tileByIndex.get(appliedFocus)?.setSelected(false);
        tileByIndex.get(focus)?.setSelected(true);
        appliedFocus = focus;
      }

      const loSlot = -1.35;
      const hiSlot = VISIBLE_ROWS - 1 + 1.35;

      rows.forEach((row, r) => {
        const slot = r - view;

        // Off-band rows (above the top slot or below the bottom slot) detach and
        // fall straight DOWN with a gravity tumble — both edges drop downward, so
        // a leaving row always sinks away and an entering row drops up into place.
        let u = 0;
        if (slot < 0) u = -slot;
        else if (slot > VISIBLE_ROWS - 1) u = slot - (VISIBLE_ROWS - 1);

        // Once a row has fallen past the vanish threshold, hide it completely so it
        // doesn't linger in the back of the scene as it sinks away.
        if (slot < loSlot || slot > hiSlot || u > FALL_VANISH) {
          row.group.visible = false;
          return;
        }
        row.group.visible = true;

        const yOff = u > 0 && !reduceMotion ? -DROP * fall(u) : 0;
        const rot = u > 0 && !reduceMotion ? u * SPIN : 0;

        // Keep off-band rows pinned at their edge slot's depth while they fall.
        const zSlot = clamp(slot, 0, VISIBLE_ROWS - 1);
        row.group.position.set(0, yOff, Z_TOP + zSlot * ROW_DZ);
        row.group.rotation.x = rot;

        row.tiles.forEach((t) => {
          const isFocus = t.levelIndex === focus;
          t.wrapper.scale.setScalar(isFocus ? SCALE * FOCUS_SCALE : SCALE);
          t.wrapper.position.y = isFocus ? FOCUS_LIFT : 0;
        });
      });
    },

    dispose() {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('resize', syncRollerWidths);
      rows.forEach((row) => row.tiles.forEach((t) => {
        t.wrapper.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
              // Name plates own a CanvasTexture; free it along with the material.
              const map = (m as THREE.MeshBasicMaterial | undefined)?.map;
              map?.dispose?.();
              m?.dispose?.();
            }
          }
        });
      }));
    },
  };
}
