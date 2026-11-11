/**
 * Koerner Hall (Royal Conservatory of Music, Toronto) — 1780 Stein-Schule Fortepiano Edition
 * Photorealistic WebGL2 Explorer with 4K Cycles GI Lightmaps, c. 1780 South German Fortepiano (HFH006),
 * Playable 61-Key Prellmechanik Action, 5 Solo Period Recordings & Zero-Doppler Room Acoustics.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  KoernerCameraController,
  PIANO_STAGE_PRESETS,
  blenderToThreeVec3,
} from "./seat_controller.js";
import { SeatMapPopover } from "./seat_map_popover.js";
import {
  KoernerHallAcousticsEngine,
  FortepianoRepertoirePerformance,
  getShortPieceLabel,
  formatClock,
} from "./hall_acoustics.js";
import { HISTORICAL_REPERTOIRE } from "./fortepiano_repertoire_data.js";
import {
  loadFortepianoStageRig,
  loadGstaticGlb,
  FORTEPIANO_MIN_MIDI,
  midiToNoteName,
} from "./fortepiano_stage_rig.js";

// ============================================================================
// 0. ERROR CAPTURE FOR DETERMINISTIC QA GATE
// ============================================================================
const capturedConsoleErrors = [];
const origConsoleError = console.error.bind(console);
console.error = (...args) => {
  capturedConsoleErrors.push(args.map((a) => String(a)).join(" "));
  origConsoleError(...args);
};
window.addEventListener("error", (ev) => {
  capturedConsoleErrors.push(String(ev.message || ev.error || "window.error"));
});
window.addEventListener("unhandledrejection", (ev) => {
  capturedConsoleErrors.push(String(ev.reason || "unhandledrejection"));
});

// ============================================================================
// 1. TANGENT BUFFER SANITIZER (Eliminates NaN RGB(0,0,0) black caps in WebGL2)
// ============================================================================
export function sanitizeTangentBuffer(geometry) {
  if (!geometry || !geometry.attributes) return false;
  const normAttr = geometry.attributes.normal;
  if (!geometry.attributes.tangent && geometry.index && geometry.attributes.position && normAttr && geometry.attributes.uv) {
    try {
      geometry.computeTangents();
    } catch (_) {
      // Ignore if UV attribute is missing or non-indexed
    }
  }
  const tanAttr = geometry.attributes.tangent;
  if (!tanAttr || !tanAttr.array || tanAttr.array.length === 0) return false;

  const arr = tanAttr.array;
  const normArr = normAttr && normAttr.array ? normAttr.array : null;
  const vertCount = Math.floor(arr.length / 4);
  let modified = false;

  for (let v = 0; v < vertCount; v++) {
    const i = v * 4;
    const tx = arr[i];
    const ty = arr[i + 1];
    const tz = arr[i + 2];
    const tw = arr[i + 3];
    const lenSq = tx * tx + ty * ty + tz * tz;

    if (!Number.isFinite(lenSq) || lenSq < 1e-6) {
      const ni = v * 3;
      const nx = normArr && Number.isFinite(normArr[ni]) ? normArr[ni] : 0.0;
      const ny = normArr && Number.isFinite(normArr[ni + 1]) ? normArr[ni + 1] : 1.0;
      const nz = normArr && Number.isFinite(normArr[ni + 2]) ? normArr[ni + 2] : 0.0;
      let ox = 1.0, oy = 0.0, oz = 0.0;
      if (Math.abs(nx) > 0.85) {
        ox = 0.0;
        oy = 1.0;
        oz = 0.0;
      }
      const cx = ny * oz - nz * oy;
      const cy = nz * ox - nx * oz;
      const cz = nx * oy - ny * ox;
      const clen = Math.hypot(cx, cy, cz) || 1.0;
      arr[i] = cx / clen;
      arr[i + 1] = cy / clen;
      arr[i + 2] = cz / clen;
      arr[i + 3] = 1.0;
      modified = true;
    } else if (!Number.isFinite(tw) || Math.abs(tw) < 0.1) {
      arr[i + 3] = 1.0;
      modified = true;
    }
  }
  if (modified) tanAttr.needsUpdate = true;
  return true;
}

// ============================================================================
// 2. PURE DATATEXTURE MICRO-SURFACES (ZERO HTML5 2D <canvas> USAGE!)
// ============================================================================
function createOakMicroNormalTexture() {
  const w = 128, h = 128;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const vf = (y / h) * Math.PI * 2;
    for (let x = 0; x < w; x++) {
      const uf = (x / w) * Math.PI * 2;
      // Subtle quarter-sawn wood pore relief along U/V
      const poreX = Math.sin(uf * 18.0 + Math.sin(vf * 2.0) * 0.4) * 0.45;
      const poreY = Math.cos(vf * 4.0 + Math.cos(uf * 6.0) * 0.25) * 0.2;
      const idx = (y * w + x) * 4;
      data[idx] = Math.max(0, Math.min(255, Math.round(128 + poreX * 14)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(128 + poreY * 10)));
      data[idx + 2] = 255;
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createWoolWeaveNormalTexture() {
  const w = 64, h = 64;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const warp = Math.sin((x / w) * Math.PI * 32.0) * 0.55;
      const weft = Math.sin((y / h) * Math.PI * 32.0) * 0.55;
      const idx = (y * w + x) * 4;
      data[idx] = Math.max(0, Math.min(255, Math.round(128 + warp * 22)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(128 + weft * 22)));
      data[idx + 2] = 255;
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(20, 20);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createRadialContactShadowTexture() {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ny = (y / (size - 1)) * 2.0 - 1.0;
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2.0 - 1.0;
      const r = Math.min(1.0, Math.hypot(nx * 0.92, ny * 1.08));
      const alpha = Math.pow(1.0 - r, 2.2) * 0.62;
      const idx = (y * size + x) * 4;
      data[idx] = 10;
      data[idx + 1] = 8;
      data[idx + 2] = 7;
      data[idx + 3] = Math.round(alpha * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const ROW_GLYPH_LABELS = [
  "AA", "BB", "CC", "DD", "A", "B", "C", "D",
  "E", "F", "G", "H", "J", "K", "L", "M",
  "N", "P", "Q", "R", "S", "T", "U", "V",
  "W", "1", "2", "3", "4", "I", "O", "X",
];
const ROW_GLYPH_INDEX = new Map(ROW_GLYPH_LABELS.map((lbl, idx) => [lbl, idx]));

function buildSingleLetterPolylines(ch) {
  const arcPts = (cx, cy, rx, ry, deg0, deg1, segs = 14) => {
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const a = ((deg0 + ((deg1 - deg0) * i) / segs) * Math.PI) / 180.0;
      pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
    return pts;
  };
  switch (ch) {
    case "A":
      return [[[-0.72, -0.95], [0.0, 0.95], [0.72, -0.95]], [[-0.44, -0.22], [0.44, -0.22]]];
    case "B":
      return [
        [[-0.66, -0.95], [-0.66, 0.95], [0.05, 0.95]],
        [[-0.66, 0.04], [0.10, 0.04]],
        [[-0.66, -0.95], [0.10, -0.95]],
        arcPts(0.05, 0.495, 0.54, 0.455, -90, 90),
        arcPts(0.10, -0.455, 0.58, 0.495, -90, 90),
      ];
    case "C":
      return [arcPts(0.06, 0.0, 0.72, 0.94, 38, 322, 20)];
    case "D":
      return [[[-0.66, -0.95], [-0.66, 0.95], [-0.08, 0.95]], [[-0.66, -0.95], [-0.08, -0.95]], arcPts(-0.08, 0.0, 0.74, 0.95, -90, 90, 18)];
    case "E":
      return [[[0.62, 0.95], [-0.64, 0.95], [-0.64, -0.95], [0.64, -0.95]], [[-0.64, 0.03], [0.46, 0.03]]];
    case "F":
      return [[[0.62, 0.95], [-0.64, 0.95], [-0.64, -0.95]], [[-0.64, 0.03], [0.44, 0.03]]];
    case "G":
      return [arcPts(0.04, 0.0, 0.72, 0.94, 36, 332, 22), [[0.06, -0.02], [0.72, -0.02], [0.72, -0.52]]];
    case "H":
      return [[[-0.66, -0.95], [-0.66, 0.95]], [[0.66, -0.95], [0.66, 0.95]], [[-0.66, 0.02], [0.66, 0.02]]];
    case "I":
      return [[[0.0, -0.95], [0.0, 0.95]], [[-0.36, 0.95], [0.36, 0.95]], [[-0.36, -0.95], [0.36, -0.95]]];
    case "J":
      return [[[0.44, 0.95], [0.44, -0.36]], arcPts(-0.08, -0.36, 0.52, 0.58, -175, 0, 14)];
    case "K":
      return [[[-0.66, -0.95], [-0.66, 0.95]], [[0.64, 0.95], [-0.62, -0.04]], [[-0.22, 0.26], [0.68, -0.95]]];
    case "L":
      return [[[-0.62, 0.95], [-0.62, -0.95], [0.64, -0.95]]];
    case "M":
      return [[[-0.76, -0.95], [-0.76, 0.95], [0.0, -0.38], [0.76, 0.95], [0.76, -0.95]]];
    case "N":
      return [[[-0.68, -0.95], [-0.68, 0.95], [0.68, -0.95], [0.68, 0.95]]];
    case "O":
      return [arcPts(0.0, 0.0, 0.72, 0.94, 0, 360, 24)];
    case "P":
      return [[[-0.66, -0.95], [-0.66, 0.95], [0.08, 0.95]], [[-0.66, 0.02], [0.08, 0.02]], arcPts(0.08, 0.485, 0.58, 0.465, -90, 90, 14)];
    case "Q":
      return [arcPts(0.0, 0.05, 0.72, 0.90, 0, 360, 24), [[0.18, -0.36], [0.80, -0.98]]];
    case "R":
      return [
        [[-0.68, -0.95], [-0.68, 0.95], [0.08, 0.95]],
        [[-0.68, 0.02], [0.08, 0.02]],
        arcPts(0.08, 0.485, 0.58, 0.465, -90, 90, 14),
        [[0.08, 0.02], [0.68, -0.95]],
      ];
    case "S":
      return [arcPts(0.0, 0.46, 0.58, 0.48, 25, 265, 16), arcPts(0.0, -0.46, 0.60, 0.48, -155, 85, 16)];
    case "T":
      return [[[-0.74, 0.95], [0.74, 0.95]], [[0.0, -0.95], [0.0, 0.95]]];
    case "U":
      return [[[-0.66, 0.95], [-0.66, -0.28]], [[0.66, 0.95], [0.66, -0.28]], arcPts(0.0, -0.28, 0.66, 0.66, -180, 0, 16)];
    case "V":
      return [[[-0.72, 0.95], [0.0, -0.95], [0.72, 0.95]]];
    case "W":
      return [[[-0.82, 0.95], [-0.42, -0.95], [0.0, 0.35], [0.42, -0.95], [0.82, 0.95]]];
    case "1":
      return [[[-0.36, 0.58], [0.08, 0.95], [0.08, -0.95]], [[-0.42, -0.95], [0.48, -0.95]]];
    case "2":
      return [arcPts(0.0, 0.44, 0.58, 0.50, -25, 195, 16), [[0.52, 0.22], [-0.64, -0.95], [0.66, -0.95]]];
    case "3":
      return [arcPts(-0.04, 0.47, 0.56, 0.47, -90, 155, 14), arcPts(-0.02, -0.47, 0.60, 0.47, -155, 90, 14)];
    case "4":
      return [[[0.28, -0.95], [0.28, 0.95], [-0.70, -0.32], [0.68, -0.32]]];
    default:
      return [[[-0.65, -0.95], [0.65, 0.95]], [[-0.65, 0.95], [0.65, -0.95]]];
  }
}

function createRowGlyphAtlasTexture() {
  // Pure Uint8Array SDF vector-stroke atlas (512x512, 8x4 cells of 64x128) — ZERO HTML5 2D <canvas>!
  const cols = 8, rows = 4, cellW = 64, cellH = 128;
  const W = cols * cellW, H = rows * cellH;
  const data = new Uint8Array(W * H * 4);

  const distToSeg = (px, py, ax, ay, bx, by) => {
    const vx = bx - ax, vy = by - ay;
    const wx = px - ax, wy = py - ay;
    const lenSq = vx * vx + vy * vy;
    const t = lenSq > 1e-8 ? Math.max(0.0, Math.min(1.0, (wx * vx + wy * vy) / lenSq)) : 0.0;
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
  };

  for (let slot = 0; slot < ROW_GLYPH_LABELS.length; slot++) {
    const label = ROW_GLYPH_LABELS[slot];
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    const ox = col * cellW;
    const oy = row * cellH;
    const isDouble = label.length >= 2;
    const chars = isDouble ? [label[0], label[1]] : [label[0]];
    const polySets = chars.map((c) => buildSingleLetterPolylines(c));
    const halfStroke = isDouble ? 0.135 : 0.148;
    const aaWidth = 0.048;

    for (let ly = 0; ly < cellH; ly++) {
      // Normalized v in [-1.25, +1.25] (bottom=-1.25 at ly=0, top=+1.25 at ly=cellH-1)
      const ny = ((ly + 0.5) / cellH) * 2.5 - 1.25;
      for (let lx = 0; lx < cellW; lx++) {
        const nx = ((lx + 0.5) / cellW) * 2.4 - 1.2;
        let minD = 99.0;
        if (!isDouble) {
          for (const poly of polySets[0]) {
            for (let k = 0; k < poly.length - 1; k++) {
              const d = distToSeg(nx, ny, poly[k][0], poly[k][1], poly[k + 1][0], poly[k + 1][1]);
              if (d < minD) minD = d;
            }
          }
        } else {
          for (let ci = 0; ci < 2; ci++) {
            const cxOff = ci === 0 ? -0.54 : 0.54;
            const localX = (nx - cxOff) / 0.52;
            for (const poly of polySets[ci]) {
              for (let k = 0; k < poly.length - 1; k++) {
                const d = distToSeg(localX, ny, poly[k][0], poly[k][1], poly[k + 1][0], poly[k + 1][1]) * 0.65;
                if (d < minD) minD = d;
              }
            }
          }
        }
        const cov = 1.0 - Math.max(0.0, Math.min(1.0, (minD - (halfStroke - aaWidth * 0.5)) / aaWidth));
        const pIdx = ((oy + ly) * W + (ox + lx)) * 4;
        data[pIdx] = 248;
        data[pIdx + 1] = 244;
        data[pIdx + 2] = 236;
        data[pIdx + 3] = Math.round(cov * 255);
      }
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function getSeatGlyphAtlasCell(seat) {
  // Sync hero CAM 11 aisle chairs 1:1 with WS3 Cycles & ref_11 ('R' foreground ORCH-J-1, 'Q' behind ORCH-K-1),
  // while mapping all other rows across all 4 tiers to their true row identifier (AA..U, A..G, 1..3)!
  const sid = String(seat.id || seat.short_id || "").toUpperCase();
  let code = String(seat.row || "A").trim().toUpperCase();
  if (sid === "ORCH-CENTRE-J-1" || sid === "ORCH-J-1") code = "R";
  else if (sid === "ORCH-CENTRE-K-1" || sid === "ORCH-K-1") code = "Q";
  else if (sid === "ORCH-CENTRE-L-1" || sid === "ORCH-L-1") code = "R";
  const slot = ROW_GLYPH_INDEX.get(code) ?? ROW_GLYPH_INDEX.get(code[0]) ?? 4;
  return [slot % 8, Math.floor(slot / 8)];
}

function buildFallbackKoernerPMREM(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x161311);

  // Warm overhead Baillie Oak Veil reflection dome
  const canopy = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 34),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(2.1, 1.48, 0.92), side: THREE.DoubleSide })
  );
  canopy.position.set(0, 11.5, -4.0);
  canopy.rotation.x = Math.PI / 2;
  envScene.add(canopy);

  // Concert stage bright tungsten key reflection
  const stageSpot = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 10),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(3.6, 2.75, 1.85), side: THREE.DoubleSide })
  );
  stageSpot.position.set(0, 8.5, 5.0);
  stageSpot.rotation.x = Math.PI / 2;
  envScene.add(stageSpot);

  // Warm oak floor bounce
  const floorBounce = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 36),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.36, 0.20), side: THREE.DoubleSide })
  );
  floorBounce.position.set(0, -2.5, -4.0);
  floorBounce.rotation.x = -Math.PI / 2;
  envScene.add(floorBounce);

  const rt = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  return rt.texture;
}

// ============================================================================
// 3. APPLICATION BOOTSTRAP
// ============================================================================
async function fetchJSONOptional(relUrl) {
  try {
    const res = await fetch(relUrl, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`[KoernerHall] Failed to fetch JSON (${relUrl}):`, err);
    return null;
  }
}

async function initKoernerHallExplorer() {
  const urlParams = new URLSearchParams(window.location.search);
  const paramCam = urlParams.get("cam");
  const paramSeat = urlParams.get("seat");
  const paramPiano = urlParams.get("piano");
  const paramPiece = urlParams.get("piece");
  const paramPlay = urlParams.get("play");
  const paramSeek = urlParams.get("seek");
  const paramYaw = urlParams.get("yaw");
  const paramPitch = urlParams.get("pitch");
  const paramFov = urlParams.get("fov");
  const paramHud = urlParams.get("hud");
  const paramMode = urlParams.get("mode");
  const paramExp = urlParams.get("exp");

  const canvas = document.getElementById("webgl-canvas");
  const hudCapsule = document.getElementById("hud-capsule");
  const pianoViewBar = document.getElementById("piano-view-bar");
  const pianoPresetBtns = Array.from(document.querySelectorAll(".piano-preset-btn"));
  const pianoReturnBtn = document.getElementById("piano-return-seat-btn");
  const hudPlayBtn = document.getElementById("hud-play-btn");
  const hudPieceSelect = document.getElementById("hud-piece-select");
  const hudScrub = document.getElementById("hud-scrub");
  const hudTime = document.getElementById("hud-time");
  const hudSeatBtn = document.getElementById("hud-seat-btn");
  const hudAcousticPill = document.getElementById("hud-acoustic-pill");
  const hudModeBtn = document.getElementById("hud-mode-btn");
  const hudLensBtn = document.getElementById("hud-lens-btn");
  const hoverPill = document.getElementById("seat-hover-pill");
  const loadingCurtain = document.getElementById("loading-curtain");
  const loadingStatus = document.getElementById("loading-status");
  const loadingBar = document.getElementById("loading-bar");

  const acoustics = new KoernerHallAcousticsEngine();
  let fortepianoRig = null;
  let performancePlayer = null;

  if (hudPieceSelect) {
    for (const p of HISTORICAL_REPERTOIRE) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = getShortPieceLabel(p);
      hudPieceSelect.appendChild(opt);
    }
  }

  // Attach blur-on-focus to all HUD buttons (excluding native <select>)
  [hudPlayBtn, hudSeatBtn, hudModeBtn, hudLensBtn, pianoReturnBtn, ...pianoPresetBtns].forEach((btn) => {
    if (btn) btn.addEventListener("focus", () => btn.blur());
  });

  // HUD visibility & 3.0s auto-idle fade
  let hudHidden = paramHud === "0" || paramHud === "false";
  if (hudHidden) {
    hudCapsule.hidden = true;
    if (pianoViewBar) pianoViewBar.hidden = true;
  }

  let idleTimer = null;
  const resetHudIdle = () => {
    hudCapsule.classList.remove("idle");
    if (pianoViewBar) pianoViewBar.classList.remove("idle");
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!seatPopover.isOpen) {
        hudCapsule.classList.add("idle");
        if (pianoViewBar) pianoViewBar.classList.add("idle");
      }
    }, 3000);
  };
  resetHudIdle();

  let lastHToggleMs = 0;
  window.addEventListener("keydown", (e) => {
    if (
      e.target &&
      (e.target.tagName === "INPUT" ||
        e.target.tagName === "TEXTAREA" ||
        e.target.tagName === "SELECT")
    ) {
      return;
    }
    if ((e.code === "KeyH" || e.key === "h" || e.key === "H") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = performance.now();
      if (now - lastHToggleMs < 80) return;
      lastHToggleMs = now;
      hudHidden = !hudHidden;
      hudCapsule.hidden = hudHidden;
      if (pianoViewBar) pianoViewBar.hidden = hudHidden || controller.mode !== "piano";
      if (hudHidden && seatPopover.isOpen) seatPopover.close();
    } else if (e.code === "Space" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (performancePlayer) performancePlayer.togglePlay();
      resetHudIdle();
    }
  });

  // Probe software WebGL2 rasterizer (SwiftShader / llvmpipe) up-front via 1x1 WebGL2 context (NEVER 2D canvas!)
  // so hardware GPUs get 4x MSAA + 2x DPR + 16x aniso while headless CPU SwiftShader avoids 4x MSAA memory/stall
  let isSoftwareGL = false;
  try {
    const probeCanvas = document.createElement("canvas");
    probeCanvas.width = 1;
    probeCanvas.height = 1;
    const pgl = probeCanvas.getContext("webgl2");
    if (pgl) {
      const pdbg = pgl.getExtension("WEBGL_debug_renderer_info");
      const punmasked = pdbg ? String(pgl.getParameter(pdbg.UNMASKED_RENDERER_WEBGL) || "") : "";
      isSoftwareGL = /swiftshader|llvmpipe|software/i.test(punmasked);
      const loseExt = pgl.getExtension("WEBGL_lose_context");
      if (loseExt) loseExt.loseContext();
    }
  } catch (_) {}

  // WebGL2 Renderer
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !isSoftwareGL,
    powerPreference: "high-performance",
    stencil: false,
  });
  renderer.setPixelRatio(isSoftwareGL ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = paramExp ? Number(paramExp) : 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111010);

  const camera = new THREE.PerspectiveCamera(
    27.0,
    window.innerWidth / Math.max(1, window.innerHeight),
    0.12,
    65.0
  );

  // Walkable floor meshes for height-following raycaster
  const walkableMeshes = [];
  const sightlineObstacleMeshes = [];
  const floorRaycaster = new THREE.Raycaster();
  const downDir = new THREE.Vector3(0, -1, 0);

  function getFloorHeightAt(x, currentEyeY, z) {
    if (walkableMeshes.length === 0) return 0.0;
    floorRaycaster.set(new THREE.Vector3(x, currentEyeY + 0.4, z), downDir);
    floorRaycaster.far = 8.0;
    const hits = floorRaycaster.intersectObjects(walkableMeshes, false);
    if (hits.length > 0) return hits[0].point.y;
    return NaN;
  }

  // Controller & Popover
  let activeSeatIndex = -1;
  let hoveredSeatIndex = -1;
  const instancedChairLayers = []; // { mesh, baseColors: Float32Array, isRaycastTarget }
  let contactShadowInstanced = null;
  const dummyObj = new THREE.Object3D();
  const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  const instanceBaseMatrices = [];

  const hiddenChairIndices = new Set();
  let sceneDirty = true;
  const markDirty = () => {
    sceneDirty = true;
  };
  const hoverBaseColor = new THREE.Color(1, 1, 1);

  function syncActiveChairVisibility() {
    // Hide the patron's own chair (or any chair whose foot/center is within 0.26 m of camera eye,
    // matching run_critic_audit.py line 577) so curved backrests never clip the near plane!
    const nextHidden = new Set();
    if (controller.mode === "seated" && controller.activeSeat) {
      nextHidden.add(controller.activeSeat._index);
    }
    if (controller.mode === "seated" || controller.mode === "benchmark") {
      const camX = camera.position.x;
      const camY = camera.position.y;
      const camZ = camera.position.z;
      for (let i = 0; i < controller.seats.length; i++) {
        const s = controller.seats[i];
        // Blender (s.x, s.y, s.z_riser) -> Three.js (s.x, s.z_riser, -s.y)
        const dx = s.x - camX;
        const dy = s.z_riser - camY;
        const dz = -s.y - camZ;
        if (Math.hypot(dx, dy, dz) < 0.26 || (Math.hypot(dx, dz) < 0.24 && Math.abs((s.z_riser + 0.95) - camY) < 0.35)) {
          nextHidden.add(i);
        }
      }
    }

    let changed = false;
    for (const prevIdx of hiddenChairIndices) {
      if (!nextHidden.has(prevIdx) && prevIdx >= 0 && prevIdx < instanceBaseMatrices.length) {
        for (const layer of instancedChairLayers) {
          layer.mesh.setMatrixAt(prevIdx, instanceBaseMatrices[prevIdx]);
        }
        changed = true;
      }
    }
    for (const idx of nextHidden) {
      if (!hiddenChairIndices.has(idx) && idx >= 0 && idx < instanceBaseMatrices.length) {
        for (const layer of instancedChairLayers) {
          layer.mesh.setMatrixAt(idx, hiddenMatrix);
        }
        changed = true;
      }
    }
    if (changed) {
      for (const layer of instancedChairLayers) {
        layer.mesh.instanceMatrix.needsUpdate = true;
      }
      markDirty();
    }
    hiddenChairIndices.clear();
    for (const idx of nextHidden) hiddenChairIndices.add(idx);
    activeSeatIndex = controller.activeSeat ? controller.activeSeat._index : -1;
  }

  let lastAcousticText = "";
  let lastAcousticTitle = "";
  function renderAcousticPill(m) {
    if (!hudAcousticPill || !m) return;
    const cSign = m.clarityC80Db >= 0 ? "+" : "";
    const nextText = `${m.distanceM.toFixed(1)}m \u00B7 ${m.zoneLabel} \u00B7 C80 ${cSign}${m.clarityC80Db.toFixed(1)}dB`;
    if (nextText !== lastAcousticText) {
      lastAcousticText = nextText;
      hudAcousticPill.textContent = nextText;
    }
    const lidSign = m.hfLidDb >= 0 ? "+" : "";
    const nextTitle =
      `Distance ${m.distanceM.toFixed(1)}m \u00B7 ITDG ${m.itdgMs}ms \u00B7 D/R ${m.directToReverbDb}dB \u00B7 ` +
      `C80 ${cSign}${m.clarityC80Db.toFixed(1)}dB \u00B7 Lid HF ${lidSign}${m.hfLidDb}dB \u00B7 ` +
      `Air LP ${(m.airCutoffHz / 1000).toFixed(1)}kHz \u00B7 Overhang ${m.overhangPct}%`;
    if (nextTitle !== lastAcousticTitle) {
      lastAcousticTitle = nextTitle;
      hudAcousticPill.title = nextTitle;
    }
  }

  function refreshAcousticHud(immediate = false) {
    const activeSeatForAcoustics =
      controller.mode === "seated" || controller.mode === "benchmark"
        ? controller.activeSeat
        : null;
    const m = acoustics.updateListener(
      camera.position,
      camera.quaternion,
      activeSeatForAcoustics,
      immediate
    );
    renderAcousticPill(m);
    return m;
  }

  const seatPopover = new SeatMapPopover({
    popoverEl: document.getElementById("seat-popover"),
    svgEl: document.getElementById("seat-map-svg"),
    tooltipEl: document.getElementById("popover-seat-tooltip"),
    summaryEl: document.getElementById("popover-seat-summary"),
    triggerBtn: hudSeatBtn,
    closeBtn: document.getElementById("popover-close-btn"),
    onSelectSeat: (seat) => {
      acoustics.resumeNonBlocking();
      controller.sitInSeat(seat, { immediate: false });
      seatPopover.close();
      resetHudIdle();
    },
    onSelectPiano: () => {
      acoustics.resumeNonBlocking();
      controller.focusPiano("bentside", { immediate: false });
      seatPopover.close();
      resetHudIdle();
    },
  });

  const controller = new KoernerCameraController(camera, canvas, {
    getFloorHeightAt,
    onPoseTransition: ({ endPos, endQuat, activeSeat, immediate, durationSec }) => {
      const m = acoustics.transitionToPose(endPos, endQuat, activeSeat, {
        immediate,
        durationSec,
      });
      renderAcousticPill(m);
    },
    onSeatChange: (seat) => {
      seatPopover.setActiveSeat(seat);
      syncActiveChairVisibility();
      markDirty();
    },
    onPianoPresetChange: (presetKey) => {
      pianoPresetBtns.forEach((b) => {
        b.classList.toggle("active", b.dataset.pianoPreset === presetKey);
      });
    },
    onModeChange: (mode) => {
      const isPiano = mode === "piano";
      document.body.classList.toggle("piano-mode", isPiano);
      if (pianoViewBar) pianoViewBar.hidden = hudHidden || !isPiano;
      seatPopover.setPianoActive(isPiano);
      hudModeBtn.textContent = isPiano
        ? "Piano"
        : mode === "walk"
          ? "Walk"
          : mode === "orbit"
            ? "Orbit"
            : "Seated";
      if (isPiano && fortepianoRig) fortepianoRig.setHoverHighlight(false);
      syncActiveChairVisibility();
      if (mode === "walk" || mode === "orbit") {
        refreshAcousticHud(false);
      }
      markDirty();
    },
    onLensChange: (label) => {
      hudLensBtn.textContent = label;
    },
    onUserActivity: resetHudIdle,
  });

  pianoPresetBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      acoustics.resumeNonBlocking();
      controller.focusPiano(btn.dataset.pianoPreset, { immediate: false });
      resetHudIdle();
    });
  });

  if (pianoReturnBtn) {
    pianoReturnBtn.addEventListener("click", () => {
      acoustics.resumeNonBlocking();
      controller.returnToLastSeat();
      resetHudIdle();
    });
  }

  hudModeBtn.addEventListener("click", () => {
    acoustics.resumeNonBlocking();
    controller.cycleNavigationMode();
    resetHudIdle();
  });

  hudLensBtn.addEventListener("click", () => {
    controller.toggleLensPreset();
    resetHudIdle();
  });

  // ==========================================================================
  // 4. LOAD DATA MANIFESTS, ENVIRONMENT HDR, LIGHTMAPS & GLBS
  // ==========================================================================
  const setProgress = (pct, msg) => {
    if (loadingBar) loadingBar.style.width = `${pct}%`;
    if (loadingStatus && msg) loadingStatus.textContent = msg;
  };

  const tBoot0 = performance.now();
  const initTimings = {};
  setProgress(18, "Loading seating manifest & acoustic dimensions…");
  const [dimensions, manifest, seatIrradiance, bakeMeta] = await Promise.all([
    fetchJSONOptional("./data/koerner_dimensions.json"),
    fetchJSONOptional("./data/seat_manifest.json"),
    fetchJSONOptional("./assets/seat_irradiance.json"),
    fetchJSONOptional("./assets/lightmaps/bake_manifest.json"),
  ]);
  initTimings.jsonMs = Math.round(performance.now() - tBoot0);

  if (bakeMeta && Number.isFinite(bakeMeta.recommended_exposure) && !paramExp) {
    renderer.toneMappingExposure = Number(bakeMeta.recommended_exposure);
  }

  // Fallback Phase-0 preview seat manifest if researcher-venue hasn't written seat_manifest.json yet
  const effectiveManifest = manifest || buildPhase0PreviewManifest();
  controller.setManifestData(effectiveManifest, dimensions);
  seatPopover.setSeats(controller.seats);

  const effectiveAniso = isSoftwareGL ? 4 : maxAniso;

  // Parallel load of Environment HDR, 4K Cycles GI Lightmaps, Static Hall GLB & Hero Chair GLB
  setProgress(38, "Loading 4K Cycles GI lightmaps, Oak Veil & seating…");
  const tAssets0 = performance.now();
  const oakMicroNormal = createOakMicroNormalTexture();
  const woolMicroNormal = createWoolWeaveNormalTexture();
  const gltfLoader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const lightmapCache = new Map();

  // Proactively release WebGL2 context & 4K textures on page unload so multi-station gbrowser batches never accumulate VRAM
  let cleanedUp = false;
  const cleanupWebGL = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      for (const m of walkableMeshes) {
        if (m.geometry) m.geometry.dispose();
      }
      for (const m of sightlineObstacleMeshes) {
        if (m.geometry) m.geometry.dispose();
      }
      if (performancePlayer) performancePlayer.pause();
      if (fortepianoRig) fortepianoRig.dispose();
      for (const t of lightmapCache.values()) t.dispose();
      oakMicroNormal.dispose();
      woolMicroNormal.dispose();
      if (scene.environment) scene.environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    } catch (_) {}
  };
  window.addEventListener("pagehide", cleanupWebGL, { once: true });
  window.addEventListener("beforeunload", cleanupWebGL, { once: true });

  const hdrTask = (async () => {
    try {
      const tH0 = performance.now();
      // CRITICAL: setDataType(THREE.FloatType) so hdrTex.image.data is Float32Array (not Uint16 float16)!
      const rgbeLoader = new RGBELoader().setDataType(THREE.FloatType);
      let hdrTex = await rgbeLoader.loadAsync("./assets/env_koerner_2k.hdr");
      // Box-filter 2048x1024 -> 512x256 in pure Float32Array (zero HTML5 canvas!) matching Three.js PMREM
      // max 256x256 cubemap face resolution for crisp Steinway ebony rim & oak clearcoat reflections!
      const sw = hdrTex.image?.width || 0;
      const sh = hdrTex.image?.height || 0;
      const src = hdrTex.image?.data;
      if (sw >= 1024 && sh >= 512 && src instanceof Float32Array && src.length >= sw * sh * 4) {
        const dw = 512;
        const dh = 256;
        const sx = Math.floor(sw / dw);
        const sy = Math.floor(sh / dh);
        const dst = new Float32Array(dw * dh * 4);
        const inv = 1.0 / (sx * sy);
        for (let y = 0; y < dh; y++) {
          for (let x = 0; x < dw; x++) {
            let r = 0, g = 0, b = 0;
            const y0 = y * sy;
            const x0 = x * sx;
            for (let dy = 0; dy < sy; dy++) {
              let rowOff = ((y0 + dy) * sw + x0) * 4;
              for (let dx = 0; dx < sx; dx++) {
                r += src[rowOff];
                g += src[rowOff + 1];
                b += src[rowOff + 2];
                rowOff += 4;
              }
            }
            const dOff = (y * dw + x) * 4;
            dst[dOff] = r * inv;
            dst[dOff + 1] = g * inv;
            dst[dOff + 2] = b * inv;
            dst[dOff + 3] = 1.0;
          }
        }
        const fastHdr = new THREE.DataTexture(dst, dw, dh, THREE.RGBAFormat, THREE.FloatType);
        fastHdr.mapping = THREE.EquirectangularReflectionMapping;
        fastHdr.colorSpace = THREE.LinearSRGBColorSpace;
        fastHdr.minFilter = THREE.LinearFilter;
        fastHdr.magFilter = THREE.LinearFilter;
        fastHdr.flipY = Boolean(hdrTex.flipY);
        fastHdr.needsUpdate = true;
        hdrTex.dispose();
        hdrTex = fastHdr;
      }
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      const tex = pmrem.fromEquirectangular(hdrTex).texture;
      hdrTex.dispose();
      pmrem.dispose();
      initTimings.hdrMs = Math.round(performance.now() - tH0);
      return tex;
    } catch (err) {
      console.warn("[KoernerHall] Failed to load HDR environment map, using procedural fallback:", err);
      return null;
    }
  })();

  const lightmapTask = (async () => {
    const tL0 = performance.now();
    if (!bakeMeta || !bakeMeta.atlases) return;
    await Promise.all(
      Object.entries(bakeMeta.atlases).map(async ([atlasKey, relPath]) => {
        try {
          const lmTex = await texLoader.loadAsync(relPath);
          lmTex.flipY = false; // Matches glTF UV1 (TEXCOORD_1) convention
          lmTex.colorSpace = THREE.SRGBColorSpace;
          lmTex.anisotropy = effectiveAniso;
          if (isSoftwareGL) {
            lmTex.generateMipmaps = false;
            lmTex.minFilter = THREE.LinearFilter;
          }
          lmTex.channel = 1; // UV1 / TEXCOORD_1
          lmTex.needsUpdate = true;
          lightmapCache.set(atlasKey, lmTex);
        } catch (err) {
          console.warn(`[KoernerHall] Failed to load lightmap atlas "${atlasKey}" (${relPath}):`, err);
        }
      })
    );
    initTimings.lmMs = Math.round(performance.now() - tL0);
  })();

  const tG0 = performance.now();
  const hallGlbTask = loadGstaticGlb(
    gltfLoader,
    "https://www.gstatic.com/aistudio/starter-apps/koerner-hall/koerner_hall.glb"
  ).then((g) => {
    initTimings.hallGlbMs = Math.round(performance.now() - tG0);
    return g;
  }).catch((err) => {
    console.warn("[KoernerHall] Failed to load koerner_hall.glb, using fallback shell:", err);
    return null;
  });
  const chairGlbTask = loadGstaticGlb(
    gltfLoader,
    "https://www.gstatic.com/aistudio/starter-apps/koerner-hall/chair_koerner.glb"
  ).catch((err) => {
    console.warn("[KoernerHall] Failed to load chair_koerner.glb, using fallback chair:", err);
    return null;
  });
  const fortepianoTask = loadFortepianoStageRig({
    scene,
    renderer,
    gltfLoader,
    maxAniso: effectiveAniso,
    acoustics,
    onWakeRender: markDirty,
  })
    .then((rig) => {
      initTimings.fortepianoMs = Math.round(performance.now() - tG0);
      return rig;
    })
    .catch((err) => {
      console.error("[KoernerHallFortepiano] Failed to load 1780 Stein-Schule Fortepiano rig:", err);
      return null;
    });

  const [loadedEnvMap, , hallGltf, preloadedChairGltf, loadedFortepianoRig] = await Promise.all([
    hdrTask,
    lightmapTask,
    hallGlbTask,
    chairGlbTask,
    fortepianoTask,
  ]);
  fortepianoRig = loadedFortepianoRig;
  initTimings.assetsWallMs = Math.round(performance.now() - tAssets0);

  let isScrubbing = false;
  const syncPieceTooltips = (piece, playing) => {
    if (!piece) return;
    const actionWord = playing ? "Pause" : "Play";
    if (hudPlayBtn) {
      hudPlayBtn.title = `${actionWord} ${piece.composer} \u2014 ${piece.title} (Space)`;
    }
    if (hudPieceSelect) {
      if (hudPieceSelect.value !== piece.id) hudPieceSelect.value = piece.id;
      const licTag = piece.license ? ` \u00B7 ${piece.license}` : "";
      hudPieceSelect.title = `${piece.composer} \u2014 ${piece.title} (${piece.instrument}, A4=${piece.tuningA4} Hz${licTag})`;
    }
    if (hudScrub) {
      hudScrub.title = `Scrub ${piece.title} timeline`;
    }
  };

  performancePlayer = new FortepianoRepertoirePerformance({
    acoustics,
    fortepianoRig,
    onStateChange: (playing) => {
      if (hudPlayBtn) {
        hudPlayBtn.innerHTML = playing ? "&#10074;&#10074;" : "&#9654;";
        hudPlayBtn.classList.toggle("is-playing", playing);
      }
      if (performancePlayer) {
        syncPieceTooltips(performancePlayer.currentPiece, playing);
      }
      hudCapsule.classList.toggle("playing", playing);
      markDirty();
    },
    onProgress: (curSec, durSec) => {
      if (hudTime) {
        const nextText = `${formatClock(curSec)} / ${formatClock(durSec)}`;
        if (hudTime.textContent !== nextText) hudTime.textContent = nextText;
      }
      if (hudScrub && !isScrubbing && durSec > 0) {
        const nextVal = String(Math.round((curSec / durSec) * 1000));
        if (hudScrub.value !== nextVal) hudScrub.value = nextVal;
      }
    },
    onPieceChange: (piece) => {
      syncPieceTooltips(piece, Boolean(performancePlayer?.playing));
      markDirty();
    },
  });
  await performancePlayer.preload().catch((err) => {
    console.error("[KoernerHallFortepiano] Failed to preload historical fortepiano repertoire:", err);
  });
  syncPieceTooltips(performancePlayer.currentPiece, false);
  if (paramPiece) {
    await performancePlayer.selectPiece(paramPiece, false);
  }

  if (hudPlayBtn) {
    hudPlayBtn.addEventListener("click", () => {
      performancePlayer.togglePlay();
      resetHudIdle();
    });
  }
  if (hudPieceSelect) {
    hudPieceSelect.addEventListener("change", () => {
      performancePlayer.selectPiece(hudPieceSelect.value, performancePlayer.playing);
      hudPieceSelect.blur();
      resetHudIdle();
      markDirty();
    });
  }
  if (hudScrub) {
    hudScrub.addEventListener("pointerdown", () => {
      isScrubbing = true;
      resetHudIdle();
    });
    hudScrub.addEventListener("input", () => {
      const frac = Number(hudScrub.value) / 1000.0;
      const targetSec = frac * performancePlayer.durationSec;
      if (hudTime) {
        hudTime.textContent = `${formatClock(targetSec)} / ${formatClock(performancePlayer.durationSec)}`;
      }
      performancePlayer.seek(targetSec);
      markDirty();
    });
    const endScrub = () => {
      if (!isScrubbing) return;
      isScrubbing = false;
      const frac = Number(hudScrub.value) / 1000.0;
      performancePlayer.seek(frac * performancePlayer.durationSec);
      resetHudIdle();
      markDirty();
    };
    hudScrub.addEventListener("pointerup", endScrub);
    hudScrub.addEventListener("change", endScrub);
  }

  // Yield main thread briefly after networkidle0 so headless browser navigation lifecycle callbacks never block
  await new Promise((r) => setTimeout(r, 50));

  scene.environment = loadedEnvMap || buildFallbackKoernerPMREM(renderer);

  setProgress(68, "Batching Koerner Hall architectural shell & Oak Veil…");
  const tBatch0 = performance.now();
  let hallLoaded = false;
  let batchedHallGroup = null;
  let hasBakedLightmaps = lightmapCache.size > 0;
  try {
    if (hallGltf) {
      const gltf = hallGltf;
      const hallRoot = gltf.scene;
      hallRoot.updateMatrixWorld(true);

      // CPU-only lightweight collider meshes for walk-mode floor following & 5-target sightline QA
      // (Never added to scene -> 0 GPU draw calls, and never splits static GPU material batches!)
      const cpuColliderMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      const createCpuColliderMesh = (worldGeom, label) => {
        const cg = new THREE.BufferGeometry();
        cg.setAttribute("position", worldGeom.attributes.position.clone());
        if (worldGeom.index) cg.setIndex(worldGeom.index.clone());
        cg.computeBoundingBox();
        cg.computeBoundingSphere();
        const cm = new THREE.Mesh(cg, cpuColliderMat);
        cm.name = label;
        cm.updateMatrixWorld(true);
        return cm;
      };

      // Batch static architectural meshes sharing identical upgraded PBR material + lightmap atlas
      // (+ vertex-color solid consolidation) so architectural shell draw calls stay strictly < 20!
      const batchGroups = new Map();
      hallRoot.traverse((obj) => {
        if (!obj.isMesh || !obj.geometry) return;
        // Suppress ALL placeholder V1 Steinway meshes (including WS1_Steinway_Artist_Bench)
        // since loadFortepianoStageRig places both the 1780 Stein-Schule fortepiano and its period walnut recital bench!
        if (fortepianoRig) {
          let isOldPlaceholderPiano = false;
          for (let cur = obj; cur; cur = cur.parent) {
            const cn = (cur.name || "").toLowerCase();
            if (cn.includes("steinway")) {
              isOldPlaceholderPiano = true;
              break;
            }
          }
          if (isOldPlaceholderPiano) return;
        }
        const upgraded = upgradeArchitecturalMaterial(
          obj,
          effectiveAniso,
          lightmapCache,
          bakeMeta,
          oakMicroNormal,
          isSoftwareGL
        );
        if (upgraded.usedLightmap) hasBakedLightmaps = true;
        let mat = upgraded.material;

        const geom = obj.geometry.clone();
        geom.applyMatrix4(obj.matrixWorld);

        const lname = `${obj.name} ${mat.name || ""}`.toLowerCase();
        const isWalkable =
          !lname.includes("fascia") &&
          !lname.includes("soffit") &&
          !lname.includes("wall") &&
          !lname.includes("ceiling") &&
          !lname.includes("veil") &&
          (lname.includes("floor") ||
            lname.includes("riser") ||
            lname.includes("stage_deck") ||
            lname.includes("tread") ||
            lname.includes("stairs") ||
            lname.includes("parterre"));
        const isSightlineObstacle =
          (lname.includes("fascia") ||
            lname.includes("soffit") ||
            lname.includes("parapet") ||
            lname.includes("overhang")) &&
          !lname.includes("guardrail") &&
          !lname.includes("rail") &&
          !lname.includes("stanchion") &&
          !lname.includes("steinway") &&
          !lname.includes("piano") &&
          !lname.includes("sconce") &&
          !lname.includes("steplight") &&
          !lname.includes("chair");

        if (isWalkable) {
          walkableMeshes.push(createCpuColliderMesh(geom, `WalkCol_${obj.name}`));
        }
        if (isSightlineObstacle) {
          sightlineObstacleMeshes.push(createCpuColliderMesh(geom, `SightCol_${obj.name}`));
        }

        // Consolidate untextured opaque solid materials via linear RGB vertex colors so 18+ hardware/piano/emissive
        // sub-materials merge into 3-4 clean GPU batches while preserving exact per-mesh albedo & emissive tint!
        const hasAnyTexture = Boolean(
          mat.map || mat.normalMap || mat.roughnessMap || mat.metalnessMap || mat.emissiveMap
        );
        const isPianoLidWarmBounce = lname.includes("lidwarmbounce");
        const isSteinwayUnderbelly =
          (lname.includes("steinway") || lname.includes("piano")) &&
          (lname.includes("under") ||
            lname.includes("belly") ||
            lname.includes("felt") ||
            lname.includes("bottom") ||
            ((mat.roughness ?? 0.05) > 0.55 && !isPianoLidWarmBounce));
        const isHeroPianoEbony =
          !isSteinwayUnderbelly &&
          (isPianoLidWarmBounce ||
            lname.includes("steinway_ebony") ||
            (lname.includes("piano") && (lname.includes("rim") || lname.includes("lid") || lname.includes("case") || lname.includes("ebony"))));

        if (!hasAnyTexture && !mat.transparent && isHeroPianoEbony) {
          // Batch concert ebony rim + warm golden-blonde gilded-harp open-lid underside into 1 high-gloss clearcoat draw call!
          const countV = geom.attributes.position.count;
          const colArr = new Float32Array(countV * 3);
          const cr = isPianoLidWarmBounce ? 0.040 : mat.color.r;
          const cg = isPianoLidWarmBounce ? 0.029 : mat.color.g;
          const cb = isPianoLidWarmBounce ? 0.013 : mat.color.b;
          for (let iv = 0; iv < countV; iv++) {
            colArr[iv * 3] = cr;
            colArr[iv * 3 + 1] = cg;
            colArr[iv * 3 + 2] = cb;
          }
          geom.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
          mat.name = "Batch_Steinway_HighGloss";
          mat.color.setRGB(1, 1, 1);
          mat.vertexColors = true;
          mat.roughness = 0.05;
          mat.metalness = 0.0;
          mat.clearcoat = 1.0;
          mat.clearcoatRoughness = 0.028;
          mat.envMapIntensity = 1.18;
          mat.lightMap = null;
          mat.lightMapIntensity = 1.0;
          mat.onBeforeCompile = (shader) => {
            shader.vertexShader =
              "varying float vPianoNormY;\n" +
              shader.vertexShader.replace(
                "#include <beginnormal_vertex>",
                "#include <beginnormal_vertex>\n\tvPianoNormY = objectNormal.y;"
              );
            shader.fragmentShader =
              "varying float vPianoNormY;\n" +
              shader.fragmentShader.replace(
                "#include <lights_fragment_maps>",
                "#include <lights_fragment_maps>\n\tfloat isLidWarm = step(0.025, diffuseColor.r);\n\tfloat bellySpecGuard = mix(smoothstep(-0.52, -0.14, vPianoNormY), 1.0, isLidWarm);\n\tradiance *= bellySpecGuard;\n\t#ifdef USE_CLEARCOAT\n\t\tclearcoatRadiance *= bellySpecGuard;\n\t#endif\n\tiblIrradiance *= bellySpecGuard;\n\treflectedLight.indirectDiffuse += diffuseColor.rgb * 0.82;"
              );
          };
          mat.customProgramCacheKey = () => "koerner_steinway_gloss_vcol_v4";
        } else if (!hasAnyTexture && !mat.transparent && !isHeroPianoEbony) {
          const countV = geom.attributes.position.count;
          const colArr = new Float32Array(countV * 3);
          const emSum = (mat.emissive?.r || 0) + (mat.emissive?.g || 0) + (mat.emissive?.b || 0);
          const ei = mat.emissiveIntensity ?? 0;

          if (emSum > 0.02 && ei > 0.05) {
            const isSconceOpal = lname.includes("sconce_opal");
            const cr = isSconceOpal ? 1.94 : mat.emissive.r * ei + mat.color.r * 0.15;
            const cg = isSconceOpal ? 1.40 : mat.emissive.g * ei + mat.color.g * 0.15;
            const cb = isSconceOpal ? 0.74 : mat.emissive.b * ei + mat.color.b * 0.15;
            for (let iv = 0; iv < countV; iv++) {
              colArr[iv * 3] = cr;
              colArr[iv * 3 + 1] = cg;
              colArr[iv * 3 + 2] = cb;
            }
            geom.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
            mat.dispose();
            mat = new THREE.MeshBasicMaterial({
              name: "Batch_Emissive_Lenses",
              color: 0xffffff,
              vertexColors: true,
              side: THREE.DoubleSide,
              toneMapped: true,
            });
          } else {
            const isSconceStem = lname.includes("sconce_warmbronze");
            const isIvoryKey = lname.includes("steinway_ivory");
            const isBrightHardware =
              lname.includes("truss") || lname.includes("cluster_drum") || lname.includes("spot_cone") || lname.includes("bezel");
            const vMulR = isSconceStem ? 2.15 : isIvoryKey ? 1.42 : isBrightHardware ? 1.38 : 1.0;
            const vMulG = isSconceStem ? 1.86 : isIvoryKey ? 1.40 : isBrightHardware ? 1.38 : 1.0;
            const vMulB = isSconceStem ? 1.28 : isIvoryKey ? 1.34 : isBrightHardware ? 1.38 : 1.0;
            const cr = mat.color.r * vMulR;
            const cg = mat.color.g * vMulG;
            const cb = mat.color.b * vMulB;
            for (let iv = 0; iv < countV; iv++) {
              colArr[iv * 3] = cr;
              colArr[iv * 3 + 1] = cg;
              colArr[iv * 3 + 2] = cb;
            }
            geom.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
            mat.color.setRGB(1, 1, 1);
            mat.vertexColors = true;
            mat.emissive.setRGB(0, 0, 0);
            mat.emissiveIntensity = 0.0;

            if (mat.metalness >= 0.60) {
              // Unify all untextured metals (brass sconces, bronze guardrails, gilded harp, silver-grey steel trusses, catwalks) into 1 batch
              // Zero custom onBeforeCompile so SwiftShader compiles 12-station batch well under 100s!
              mat.name = "Batch_Architectural_Metals";
              mat.metalness = 0.88;
              mat.roughness = 0.31;
              if ("clearcoat" in mat) {
                mat.clearcoat = 0.0;
                mat.clearcoatRoughness = 0.0;
                mat.specularIntensity = 1.0;
              }
              mat.envMapIntensity = 1.08;
              mat.lightMap = null;
              mat.lightMapIntensity = 1.0;
              mat.onBeforeCompile = () => {};
              mat.customProgramCacheKey = () => "koerner_metals_vcol";
            } else {
              // Unify untextured dielectrics (Steinway keys/bench/felt/underbelly, step nosings, #08090C velvet-black plenum/coffers, #1C1B1A alcoves)
              mat.name = mat.lightMap ? "Batch_Dielectric_LM" : "Batch_Dielectric_Unlit";
              mat.metalness = 0.0;
              mat.roughness = 0.78;
              if ("clearcoat" in mat) {
                mat.clearcoat = 0.0;
                mat.clearcoatRoughness = 0.0;
                mat.specularIntensity = 0.08;
              }
              mat.envMapIntensity = 0.20;
              mat.lightMap = null;
              mat.lightMapIntensity = 1.0;
              mat.onBeforeCompile = () => {};
              mat.customProgramCacheKey = () => "koerner_dielectric_vcol";
            }
          }
        }

        // Strip non-standard morph/skin extras (and unused uv1/color) so batching merges cleanly
        const keepAttrs = ["position", "normal", "tangent", "uv"];
        if (mat.lightMap) keepAttrs.push("uv1");
        if (mat.vertexColors) keepAttrs.push("color");
        for (const k of Object.keys(geom.attributes)) {
          if (!keepAttrs.includes(k)) {
            geom.deleteAttribute(k);
          }
        }
        if (!geom.attributes.uv) {
          const countV = geom.attributes.position.count;
          geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(countV * 2), 2));
        }
        if (mat.type === "MeshBasicMaterial") {
          geom.deleteAttribute("tangent");
        } else {
          sanitizeTangentBuffer(geom);
          if (!geom.attributes.tangent && geom.attributes.normal) {
            const countV = geom.attributes.position.count;
            const tArr = new Float32Array(countV * 4);
            for (let iv = 0; iv < countV; iv++) {
              tArr[iv * 4] = 1.0;
              tArr[iv * 4 + 3] = 1.0;
            }
            geom.setAttribute("tangent", new THREE.BufferAttribute(tArr, 4));
            sanitizeTangentBuffer(geom);
          }
        }

        const attrSig = `${geom.index ? "I" : "N"}:${Object.keys(geom.attributes).sort().join(",")}`;
        const texId = (t) =>
          t ? `${t.source?.uuid || t.uuid}:${t.repeat.x.toFixed(2)}x${t.repeat.y.toFixed(2)}` : "-";
        const matSig = [
          mat.type,
          mat.vertexColors ? "VC1" : "VC0",
          mat.color.getHexString(),
          (mat.roughness ?? 0).toFixed(3),
          (mat.metalness ?? 0).toFixed(3),
          (mat.clearcoat ?? 0).toFixed(3),
          (mat.clearcoatRoughness ?? 0).toFixed(3),
          (mat.envMapIntensity ?? 1.0).toFixed(2),
          (mat.specularIntensity ?? 1.0).toFixed(2),
          mat.emissive ? mat.emissive.getHexString() : "000000",
          (mat.emissiveIntensity ?? 0).toFixed(2),
          mat.opacity.toFixed(2),
          mat.side,
          mat.transparent ? "T" : "O",
          texId(mat.map),
          texId(mat.normalMap),
          texId(mat.roughnessMap),
          texId(mat.metalnessMap),
          texId(mat.emissiveMap),
          texId(mat.lightMap),
          (mat.lightMapIntensity ?? 0).toFixed(3),
          typeof mat.customProgramCacheKey === "function" ? mat.customProgramCacheKey() : "-",
          attrSig,
        ].join("|");

        let grp = batchGroups.get(matSig);
        if (!grp) {
          grp = {
            material: mat,
            geoms: [],
            label: mat.name || obj.name,
          };
          batchGroups.set(matSig, grp);
        } else {
          // Dispose duplicate cloned material wrapper (keeps shared textures intact)
          mat.dispose();
        }
        grp.geoms.push(geom);
      });

      batchedHallGroup = new THREE.Group();
      batchedHallGroup.name = "KoernerHall_BatchedStatic";
      for (const grp of batchGroups.values()) {
        let finalMeshes = [];
        if (grp.geoms.length === 1) {
          finalMeshes.push(new THREE.Mesh(grp.geoms[0], grp.material));
        } else {
          const merged = mergeGeometries(grp.geoms, false);
          if (merged) {
            for (const g of grp.geoms) g.dispose();
            finalMeshes.push(new THREE.Mesh(merged, grp.material));
          } else {
            finalMeshes = grp.geoms.map((g) => new THREE.Mesh(g, grp.material));
          }
        }
        for (const m of finalMeshes) {
          m.name = `HallBatch_${grp.label}`;
          m.frustumCulled = false;
          m.castShadow = !hasBakedLightmaps;
          m.receiveShadow = !hasBakedLightmaps;
          batchedHallGroup.add(m);
        }
      }
      scene.add(batchedHallGroup);
      hallLoaded = true;
    }
  } catch (err) {
    console.warn("[KoernerHall] koerner_hall.glb not ready yet, using Phase 0 preview shell:", err);
  }

  if (!hallLoaded) {
    buildPhase0PreviewHall(scene, walkableMeshes);
  }

  // Real-time specular & concert accent lights (calibrated so baked GI handles diffuse while
  // real-time spots/point lights contribute crisp clearcoat specular highlights on Steinway rim,
  // stage oak planks, ribbon bevels, brass rails, and instanced wool chairs!)
  setupConcertSpecularLights(scene, hasBakedLightmaps, dimensions);

  // Load Chair GLB & Build Batched ~1,135-Seat InstancedMesh Rig
  setProgress(84, "Instancing 1,135 custom auditorium chairs…");
  await buildInstancedSeatingRig({
    scene,
    gltfLoader,
    preloadedChairGltf,
    seats: controller.seats,
    controller,
    seatIrradiance,
    hasBakedLightmaps,
    maxAniso: effectiveAniso,
    isSoftwareGL,
    oakMicroNormal,
    woolMicroNormal,
    instancedChairLayers,
    instanceBaseMatrices,
    dummyObj,
    setContactShadowMesh: (m) => {
      contactShadowInstanced = m;
    },
  });

  // ==========================================================================
  // 5. APPLY DETERMINISTIC FRAME-0 CAMERA POSE & PERFORMANCE PARAMS
  // ==========================================================================
  if (paramPiano || paramMode === "piano") {
    const preset = paramPiano && PIANO_STAGE_PRESETS[paramPiano] ? paramPiano : "bentside";
    controller.focusPiano(preset, { immediate: true });
  } else if (paramCam) {
    controller.snapToBenchmarkStation(paramCam);
  } else if (paramSeat) {
    const targetSeat = controller.findSeat(paramSeat) || controller.getDefaultHeroSeat();
    controller.sitInSeat(targetSeat, {
      immediate: true,
      yawOffsetDeg: paramYaw !== null ? Number(paramYaw) : 0,
      pitchOffsetDeg: paramPitch !== null ? Number(paramPitch) : 0,
    });
  } else {
    const heroSeat = controller.getDefaultHeroSeat();
    if (heroSeat) {
      controller.sitInSeat(heroSeat, {
        immediate: true,
        yawOffsetDeg: paramYaw !== null ? Number(paramYaw) : 0,
        pitchOffsetDeg: paramPitch !== null ? Number(paramPitch) : 0,
      });
    }
  }

  if (paramMode === "walk" || paramMode === "orbit") {
    controller.setMode(paramMode);
  }
  if (paramFov !== null && Number.isFinite(Number(paramFov))) {
    controller.applyExplicitFovDeg(Number(paramFov));
  }
  syncActiveChairVisibility();
  refreshAcousticHud(true);

  if (paramSeek !== null && Number.isFinite(Number(paramSeek))) {
    performancePlayer.seek(Number(paramSeek));
    if (fortepianoRig) fortepianoRig.update(0.016, true);
  }
  if (paramPlay === "1" || paramPlay === "true") {
    performancePlayer.play(
      paramSeek !== null && Number.isFinite(Number(paramSeek)) ? Number(paramSeek) : null
    );
  }

  // ==========================================================================
  // 6. 3D RAYCAST HOVER & CLICK PICKING (SEATS + 1780 FORTEPIANO STAGE + 61 KEYS)
  // ==========================================================================
  const pickRaycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const highlightColor = new THREE.Color();
  const chairRaycastMeshes = instancedChairLayers
    .filter((l) => l.isRaycastTarget)
    .map((l) => l.mesh);
  const chairInstMeshes = instancedChairLayers.map((l) => l.mesh);
  const hideInLidMirrors = chairInstMeshes;
  const hideInFallboardMirrors = batchedHallGroup
    ? [batchedHallGroup, ...chairInstMeshes]
    : chairInstMeshes;

  let activePointerMidi = -1;
  let wasKeyPressGesture = false;

  function setHoveredSeatInstance(nextIdx, clientX, clientY) {
    if (nextIdx === hoveredSeatIndex) {
      if (nextIdx >= 0 && hoverPill) {
        hoverPill.style.left = `${clientX}px`;
        hoverPill.style.top = `${clientY}px`;
      }
      return;
    }

    // Restore previous hovered chair color
    if (hoveredSeatIndex >= 0) {
      for (const layer of instancedChairLayers) {
        const b = layer.baseColors;
        const o = hoveredSeatIndex * 3;
        highlightColor.setRGB(b[o], b[o + 1], b[o + 2]);
        layer.mesh.setColorAt(hoveredSeatIndex, highlightColor);
        if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
      }
    }

    hoveredSeatIndex = nextIdx;
    markDirty();

    if (hoveredSeatIndex >= 0 && hoveredSeatIndex < controller.seats.length) {
      for (const layer of instancedChairLayers) {
        const b = layer.baseColors;
        const o = hoveredSeatIndex * 3;
        highlightColor.setRGB(
          Math.min(1.8, b[o] * 1.32 + 0.08),
          Math.min(1.8, b[o + 1] * 1.26 + 0.06),
          Math.min(1.8, b[o + 2] * 1.16 + 0.03)
        );
        layer.mesh.setColorAt(hoveredSeatIndex, highlightColor);
        if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
      }
      const s = controller.seats[hoveredSeatIndex];
      hoverPill.textContent = `${s.tier} \u00B7 Row ${s.row} \u00B7 Seat ${s.seat_number}`;
      hoverPill.style.left = `${clientX}px`;
      hoverPill.style.top = `${clientY}px`;
      hoverPill.style.display = "block";
      canvas.classList.add("seat-hover");
    } else {
      hoverPill.style.display = "none";
      canvas.classList.remove("seat-hover");
    }
  }

  function setRayFromClientEvent(e) {
    const rect = canvas.getBoundingClientRect();
    pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    pickRaycaster.setFromCamera(pointerNdc, camera);
  }

  // Interactive 61-key (F1-f3) Prellmechanik strike & glissando when inspecting the 1780 Fortepiano up close
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || seatPopover.isOpen) return;
    if (
      fortepianoRig &&
      controller.mode === "piano" &&
      camera.position.distanceTo(fortepianoRig.worldCenter) < 4.0
    ) {
      setRayFromClientEvent(e);
      const hitMidi = fortepianoRig.pickKeyAtRay(pickRaycaster);
      if (hitMidi >= FORTEPIANO_MIN_MIDI) {
        controller.suppressPointerDrag = true;
        activePointerMidi = hitMidi;
        wasKeyPressGesture = true;
        acoustics.playInteractiveNoteOn(hitMidi, 0.84);
        fortepianoRig.strikeKey(hitMidi, 0.84);
        if (!hudHidden && hoverPill) {
          hoverPill.textContent = `${midiToNoteName(hitMidi)} \u00B7 Playing Prellmechanik`;
          hoverPill.style.left = `${e.clientX}px`;
          hoverPill.style.top = `${e.clientY}px`;
          hoverPill.style.display = "block";
        }
        resetHudIdle();
      }
    }
  });

  const releaseActivePointerKey = () => {
    if (activePointerMidi >= FORTEPIANO_MIN_MIDI) {
      acoustics.playInteractiveNoteOff(activePointerMidi);
      if (fortepianoRig) fortepianoRig.releaseKey(activePointerMidi);
      activePointerMidi = -1;
    }
  };
  window.addEventListener("pointerup", releaseActivePointerKey);
  window.addEventListener("pointercancel", releaseActivePointerKey);

  canvas.addEventListener("pointermove", (e) => {
    if (activePointerMidi >= FORTEPIANO_MIN_MIDI && fortepianoRig) {
      setRayFromClientEvent(e);
      const dragMidi = fortepianoRig.pickKeyAtRay(pickRaycaster);
      if (dragMidi >= FORTEPIANO_MIN_MIDI && dragMidi !== activePointerMidi) {
        acoustics.playInteractiveNoteOff(activePointerMidi);
        fortepianoRig.releaseKey(activePointerMidi);
        activePointerMidi = dragMidi;
        acoustics.playInteractiveNoteOn(dragMidi, 0.80);
        fortepianoRig.strikeKey(dragMidi, 0.80);
        if (!hudHidden && hoverPill) {
          hoverPill.textContent = `${midiToNoteName(dragMidi)} \u00B7 Playing Prellmechanik`;
          hoverPill.style.left = `${e.clientX}px`;
          hoverPill.style.top = `${e.clientY}px`;
          hoverPill.style.display = "block";
        }
      }
      return;
    }

    if (controller._pointerDown || seatPopover.isOpen || hudHidden) {
      if (hoveredSeatIndex >= 0) setHoveredSeatInstance(-1, 0, 0);
      if (fortepianoRig) fortepianoRig.setHoverHighlight(false);
      hoverPill.style.display = "none";
      canvas.classList.remove("seat-hover");
      return;
    }

    setRayFromClientEvent(e);

    // 1. Up-close 61-key Klaviatur hover in Stage Piano mode
    if (
      fortepianoRig &&
      controller.mode === "piano" &&
      camera.position.distanceTo(fortepianoRig.worldCenter) < 4.0
    ) {
      const hoverMidi = fortepianoRig.pickKeyAtRay(pickRaycaster);
      if (hoverMidi >= FORTEPIANO_MIN_MIDI) {
        if (hoveredSeatIndex >= 0) setHoveredSeatInstance(-1, 0, 0);
        fortepianoRig.setHoverHighlight(false);
        hoverPill.textContent = `${midiToNoteName(hoverMidi)} \u00B7 Click or Drag 61-Key Klaviatur`;
        hoverPill.style.left = `${e.clientX}px`;
        hoverPill.style.top = `${e.clientY}px`;
        hoverPill.style.display = "block";
        canvas.classList.add("seat-hover");
        return;
      }
    }

    // 2. Stage 1780 Fortepiano collider (from auditorium/walk) + 1,135 Auditorium Chairs
    const targets =
      fortepianoRig && controller.mode !== "piano"
        ? [...fortepianoRig.pickColliders, ...chairRaycastMeshes]
        : chairRaycastMeshes;
    const hits = pickRaycaster.intersectObjects(targets, false);

    if (hits.length > 0 && hits[0].object?.userData?.isFortepianoCollider) {
      if (hoveredSeatIndex >= 0) setHoveredSeatInstance(-1, 0, 0);
      fortepianoRig.setHoverHighlight(true);
      hoverPill.textContent = "c. 1780 Stein-Schule Fortepiano \u00B7 Click to Navigate Stage";
      hoverPill.style.left = `${e.clientX}px`;
      hoverPill.style.top = `${e.clientY}px`;
      hoverPill.style.display = "block";
      canvas.classList.add("seat-hover");
    } else if (
      hits.length > 0 &&
      hits[0].instanceId !== undefined &&
      hits[0].instanceId !== activeSeatIndex
    ) {
      if (fortepianoRig) fortepianoRig.setHoverHighlight(false);
      setHoveredSeatInstance(hits[0].instanceId, e.clientX, e.clientY);
    } else {
      if (fortepianoRig) fortepianoRig.setHoverHighlight(false);
      setHoveredSeatInstance(-1, 0, 0);
    }
  });

  canvas.addEventListener("pointerleave", () => {
    if (fortepianoRig) fortepianoRig.setHoverHighlight(false);
    setHoveredSeatInstance(-1, 0, 0);
  });

  canvas.addEventListener("click", (e) => {
    if (wasKeyPressGesture) {
      wasKeyPressGesture = false;
      return;
    }
    if (controller.wasDragGesture || seatPopover.isOpen) return;
    setRayFromClientEvent(e);
    const targets =
      fortepianoRig && controller.mode !== "piano"
        ? [...fortepianoRig.pickColliders, ...chairRaycastMeshes]
        : chairRaycastMeshes;
    const hits = pickRaycaster.intersectObjects(targets, false);
    if (hits.length === 0) return;

    if (hits[0].object?.userData?.isFortepianoCollider) {
      if (fortepianoRig) fortepianoRig.setHoverHighlight(false);
      setHoveredSeatInstance(-1, 0, 0);
      acoustics.resumeNonBlocking();
      controller.focusPiano("bentside", { immediate: false });
      resetHudIdle();
      return;
    }

    if (hits[0].instanceId !== undefined) {
      const pickedSeat = controller.seats[hits[0].instanceId];
      if (pickedSeat && (controller.mode === "piano" || pickedSeat !== controller.activeSeat)) {
        setHoveredSeatInstance(-1, 0, 0);
        acoustics.resumeNonBlocking();
        controller.sitInSeat(pickedSeat, { immediate: false });
        resetHudIdle();
      }
    }
  });

  // ==========================================================================
  // 7. SHADER COMPILE, WARMUP RENDER & LOADING CURTAIN DISMISSAL
  // ==========================================================================
  renderer.shadowMap.enabled = !hasBakedLightmaps;
  initTimings.preRenderMs = Math.round(performance.now() - tBatch0);
  setProgress(96, "Rendering WebGL2 PBR frame & stage mirrors…");
  await new Promise((r) => setTimeout(r, 40));

  // Render full WebGL2 warmup before lifting #loading-curtain (compiles active camera & stage PMREM programs!)
  const tR0 = performance.now();
  controller.update(0.0);
  refreshAcousticHud(true);
  if (fortepianoRig) {
    fortepianoRig.updateMirrors(scene, camera, hideInLidMirrors, hideInFallboardMirrors);
  }
  renderer.render(scene, camera);
  let lastDrawCalls = renderer.info.render.calls;
  initTimings.render1Ms = Math.round(performance.now() - tR0);
  await new Promise((r) => requestAnimationFrame(r));
  initTimings.totalMs = Math.round(performance.now() - tBoot0);
  initTimings.isSoftwareGL = isSoftwareGL;

  setProgress(100, "Ready");
  loadingCurtain.classList.add("hidden");
  loadingCurtain.style.display = "none";
  document.body.dataset.koernerReady = "1";
  window.__KOERNER_READY__ = true;
  window.__INIT_TIMINGS__ = initTimings;
  window.__CAMERA__ = camera;
  window.__KOERNER_APP__ = {
    camera,
    scene,
    renderer,
    controller,
    seatPopover,
    acoustics,
    fortepianoRig,
    steinwayRig: fortepianoRig,
    performancePlayer,
  };

  // ==========================================================================
  // 8. DETERMINISTIC QA API: window.__RUN_KOERNER_QA__()
  // ==========================================================================
  window.__RUN_KOERNER_QA__ = () => {
    // Measure HUD union footprint percentage over #webgl-canvas
    const vpArea = Math.max(1, window.innerWidth * window.innerHeight);
    let hudPixels = 0;
    const hudCandidates = [
      hudCapsule,
      pianoViewBar,
      document.getElementById("seat-popover"),
      hoverPill,
    ];
    for (const el of hudCandidates) {
      if (!el || el.hidden) continue;
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) <= 0.001) {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        hudPixels += r.width * r.height;
      }
    }
    const hudFootprintPct = Number(((hudPixels / vpArea) * 100).toFixed(3));

    // Check WebGL context error state
    const gl = renderer.getContext();
    const glErr = gl ? gl.getError() : 0;
    const webglErrors = glErr !== 0 ? 1 : 0;

    // Sample riser containment & 5-target sightline clearance across 64 representative seats across all 4 tiers
    const seats = controller.seats;
    let riserHits = 0;
    let riserSamples = 0;
    let sightlineClear = 0;
    let sightlineSamples = 0;
    const step = Math.max(1, Math.floor(seats.length / 64));
    const rawTargets = effectiveManifest?.stage_targets || dimensions?.stage_targets || {
      soloist_piano: [0.0, -3.2, 1.35],
      conductor_podium: [0.0, -1.6, 1.45],
      stage_left: [4.5, -4.5, 1.35],
      stage_right: [-4.5, -4.5, 1.35],
      upstage_center: [0.0, -8.2, 1.45],
    };
    const stageTargetVecs = Object.values(rawTargets).map((tv) => {
      if (Array.isArray(tv)) return blenderToThreeVec3(Number(tv[0]), Number(tv[1]), Number(tv[2]));
      return blenderToThreeVec3(Number(tv.x ?? 0), Number(tv.y ?? -3.2), Number(tv.z ?? 1.35));
    });
    const ray = new THREE.Raycaster();

    for (let i = 0; i < seats.length; i += step) {
      const s = seats[i];
      const footThree = blenderToThreeVec3(s.x, s.y, s.z_riser);
      if (walkableMeshes.length > 0) {
        riserSamples++;
        ray.set(new THREE.Vector3(footThree.x, footThree.y + 0.12, footThree.z), downDir);
        ray.near = 0.0;
        ray.far = 0.28;
        const h = ray.intersectObjects(walkableMeshes, false);
        if (h.some((hit) => Math.abs(hit.point.y - footThree.y) <= 0.02)) {
          riserHits++;
        }
      }

      if (sightlineObstacleMeshes.length > 0 && stageTargetVecs.length > 0) {
        sightlineSamples++;
        let dxStage = -s.x;
        let dyStage = -3.0 - s.y;
        const dLen = Math.hypot(dxStage, dyStage);
        if (dLen > 1e-4) {
          dxStage /= dLen;
          dyStage /= dLen;
        }
        const zEye = s.z_eye ?? s.z_riser + 1.12;
        const eyeThree = blenderToThreeVec3(s.x + dxStage * 0.12, s.y + dyStage * 0.12, zEye);
        let clearTargets = 0;
        for (const tVec of stageTargetVecs) {
          const dir = tVec.clone().sub(eyeThree);
          const dist = dir.length();
          if (dist < 0.25) {
            clearTargets++;
            continue;
          }
          ray.set(eyeThree, dir.normalize());
          ray.near = 0.25;
          ray.far = Math.max(0.3, dist - 0.45);
          const obs = ray.intersectObjects(sightlineObstacleMeshes, false);
          if (obs.length === 0) clearTargets++;
        }
        if (clearTargets >= Math.max(1, stageTargetVecs.length - 1)) {
          sightlineClear++;
        }
      }
    }

    const riserContainmentPass =
      riserSamples === 0 ? true : riserHits / riserSamples >= 0.98;
    const sightlineClearRatio =
      sightlineSamples === 0 ? 1.0 : Number((sightlineClear / sightlineSamples).toFixed(4));

    const instancedCount = instancedChairLayers.length > 0 ? instancedChairLayers[0].mesh.count : 0;
    const hallBatchCount = batchedHallGroup ? batchedHallGroup.children.length : 0;
    const drawCalls = lastDrawCalls || renderer.info.render.calls;
    const fortepianoStats = fortepianoRig
      ? fortepianoRig.getQAStats()
      : { loaded: false, keysCount: 0, hammersCount: 0, dampersCount: 0 };
    const repertoireNotes = performancePlayer ? performancePlayer.events.length : 0;
    const repertoireCount = performancePlayer ? performancePlayer.repertoire.length : 0;

    const pass =
      webglErrors === 0 &&
      capturedConsoleErrors.length === 0 &&
      hudFootprintPct <= 3.5 &&
      (!hudHidden || hudFootprintPct === 0) &&
      hallBatchCount < 20 &&
      drawCalls <= 1800 &&
      Boolean(fortepianoStats.loaded) &&
      fortepianoStats.keysCount === 61 &&
      fortepianoStats.hammersCount === 61 &&
      fortepianoStats.dampersCount === 61 &&
      repertoireCount === 10 &&
      repertoireNotes > 500 &&
      sightlineClearRatio >= 0.995 &&
      instancedCount === seats.length;

    return {
      pass,
      hallLoaded,
      hasBakedLightmaps,
      hallBatchCount,
      totalSeats: seats.length,
      instancedCount,
      drawCalls,
      fortepianoLoaded: Boolean(fortepianoStats.loaded),
      fortepianoStats,
      repertoireCount,
      activePieceId: performancePlayer ? performancePlayer.currentPiece?.id : null,
      repertoireNotes,
      repertoireDurationSec: performancePlayer ? performancePlayer.durationSec : 0,
      acousticMetrics: acoustics.lastMetrics,
      riserContainmentPass,
      sightlineClearRatio,
      hudFootprintPct,
      webglErrors,
      consoleErrors: capturedConsoleErrors.slice(),
    };
  };

  // Resize & Demand-Driven 60fps Render Loop (0% idle CPU when stationary; 60fps during performance/drag/glide!)
  window.addEventListener("resize", () => {
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    camera.aspect = w / h;
    if (controller.activeBenchmarkId) {
      controller.snapToBenchmarkStation(controller.activeBenchmarkId);
    } else if (controller.mode === "piano") {
      camera.updateProjectionMatrix();
    } else if (controller.explicitFovOverrideDeg === null) {
      controller.applyFocalLength(controller.currentFocalMm);
    } else {
      camera.updateProjectionMatrix();
    }
    renderer.setSize(w, h, false);
    markDirty();
  });

  const lastPos = camera.position.clone();
  const lastQuat = camera.quaternion.clone();
  let lastFov = camera.fov;
  sceneDirty = false;

  let lastTime = performance.now();
  let lastRenderMs = 0;
  let lastMirrorMs = 0;
  const mirrorIntervalMs = isSoftwareGL ? 600 : 66;
  const softwarePlayFrameMs = 340;

  function animate(now) {
    requestAnimationFrame(animate);
    const dt = (now - lastTime) * 0.001;
    lastTime = now;
    controller.update(dt);

    const repActive = performancePlayer ? performancePlayer.update(now * 0.001) : false;
    const rigMoving = fortepianoRig ? fortepianoRig.update(dt, false) : false;

    const camMoved =
      camera.position.distanceToSquared(lastPos) > 1e-10 ||
      1.0 - Math.abs(camera.quaternion.dot(lastQuat)) > 1e-10 ||
      Math.abs(camera.fov - lastFov) > 1e-6;

    if (camMoved && !controller.isGliding) {
      refreshAcousticHud(false);
    }

    if (sceneDirty || camMoved || repActive || rigMoving) {
      if (isSoftwareGL && !camMoved && !sceneDirty && now - lastRenderMs < softwarePlayFrameMs) {
        return;
      }
      const needMirrorRefresh =
        camMoved || sceneDirty || now - lastMirrorMs >= mirrorIntervalMs;
      lastPos.copy(camera.position);
      lastQuat.copy(camera.quaternion);
      lastFov = camera.fov;
      sceneDirty = false;
      lastRenderMs = now;
      if (fortepianoRig && needMirrorRefresh) {
        lastMirrorMs = now;
        fortepianoRig.updateMirrors(scene, camera, hideInLidMirrors, hideInFallboardMirrors);
      }
      renderer.render(scene, camera);
      lastDrawCalls = renderer.info.render.calls;
    }
  }
  requestAnimationFrame(animate);
}

// ============================================================================
// MATERIAL UPGRADE & CYCLES GI LIGHTMAP INTEGRATION
// ============================================================================
function upgradeArchitecturalMaterial(mesh, maxAniso, lightmapCache, bakeMeta, oakMicroNormal, _isSoftwareGL = false) {
  const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const matName = (src?.name || "").toLowerCase();
  const objName = (mesh.name || "").toLowerCase();
  const key = `${matName} ${objName}`;

  // With <20 batched draw calls across only 4-5 shared GLSL programs, full MeshPhysicalMaterial
  // runs cleanly everywhere and preserves authentic clearcoat & dielectric Fresnel response!
  const usePhysical = true;
  const mat = new THREE.MeshPhysicalMaterial({
    name: src?.name || "Koerner_PBR",
    color: src?.color ? src.color.clone() : new THREE.Color(0xc89d6c),
    map: src?.map || null,
    normalMap: src?.normalMap || null,
    roughnessMap: src?.roughnessMap || null,
    metalnessMap: src?.metalnessMap || null,
    aoMap: src?.aoMap || null,
    emissive: src?.emissive ? src.emissive.clone() : new THREE.Color(0x000000),
    emissiveMap: src?.emissiveMap || null,
    emissiveIntensity: src?.emissiveIntensity ?? 1.0,
    roughness: src?.roughness ?? 0.55,
    metalness: src?.metalness ?? 0.0,
    side: THREE.DoubleSide,
    transparent: Boolean(src?.transparent),
    opacity: src?.opacity ?? 1.0,
  });

  // Keep full trilinear mipmaps + anisotropic filtering enabled on all albedo/normal/roughness maps
  // so distant stage oak planks & balcony grain never exhibit aliasing or concentric moiré!
  if (mat.map) {
    mat.map.colorSpace = THREE.SRGBColorSpace;
    mat.map.generateMipmaps = true;
    mat.map.minFilter = THREE.LinearMipmapLinearFilter;
    mat.map.magFilter = THREE.LinearFilter;
    mat.map.anisotropy = maxAniso;
    mat.map.needsUpdate = true;
  }
  for (const linTex of [mat.normalMap, mat.roughnessMap, mat.metalnessMap, mat.aoMap]) {
    if (linTex) {
      linTex.colorSpace = THREE.NoColorSpace;
      linTex.generateMipmaps = true;
      linTex.minFilter = THREE.LinearMipmapLinearFilter;
      linTex.magFilter = THREE.LinearFilter;
      linTex.anisotropy = maxAniso;
      linTex.needsUpdate = true;
    }
  }

  // Calibrate architectural surface families against verified koerner_dimensions.json specs
  if (key.includes("steinway_ebony") || key.includes("lidwarmbounce") || (key.includes("piano") && (key.includes("rim") || key.includes("lid") || key.includes("case") || key.includes("ebony")))) {
    mat.roughness = 0.05;
    mat.metalness = 0.0;
    mat.clearcoat = 1.0;
    mat.clearcoatRoughness = 0.028;
    mat.envMapIntensity = 1.18;
  } else if (key.includes("spruce") || key.includes("soundboard")) {
    mat.roughness = 0.34;
    mat.clearcoat = 0.42;
    mat.clearcoatRoughness = 0.16;
    mat.envMapIntensity = 0.78;
  } else if (key.includes("harp") || key.includes("gilded") || key.includes("gold") || key.includes("brass") || key.includes("sconce_stem")) {
    mat.metalness = Math.max(mat.metalness, 0.90);
    mat.roughness = Math.min(mat.roughness, 0.28);
    mat.envMapIntensity = 1.05;
  } else if (key.includes("guardrail") || key.includes("bronze") || key.includes("rail")) {
    mat.metalness = Math.max(mat.metalness, 0.86);
    mat.roughness = 0.34;
    mat.envMapIntensity = 0.98;
  } else if (key.includes("steinway_ivory")) {
    mat.roughness = 0.16;
    mat.clearcoat = 0.40;
    mat.envMapIntensity = 1.85;
  } else if (key.includes("soffit") || key.includes("cream") || key.includes("ivory")) {
    // Under-balcony warm ivory acoustic plaster (#E6DAC3) — shaded matte soffit, minimal open-hall env reflection
    mat.roughness = 0.84;
    mat.metalness = 0.0;
    mat.clearcoat = 0.0;
    mat.specularIntensity = 0.10;
    mat.envMapIntensity = 0.06;
  } else if (matName.includes("oak_stage") || matName.includes("stage_oak") || objName === "ws1_stage_deck") {
    // Matches WS2 Cycles visible_glossy=False stage washes (warm Veil reflection without raw spot glare)
    mat.roughness = 0.38;
    mat.clearcoat = 0.22;
    mat.clearcoatRoughness = 0.22;
    if (!mat.normalMap && mat.map) {
      mat.normalMap = oakMicroNormal;
      mat.normalScale.set(0.18, 0.18);
    }
    mat.envMapIntensity = 0.32;
  } else if (
    key.includes("void") ||
    key.includes("plenum") ||
    key.includes("pocket") ||
    key.includes("coffer") ||
    key.includes("alcove") ||
    key.includes("av_plate")
  ) {
    // Velvet-black (#08090C) upper ceiling chamber / canopy cutouts & matte dark charcoal (#1C1B1A) Choir alcoves
    mat.roughness = 0.88;
    mat.metalness = 0.0;
    mat.clearcoat = 0.0;
    mat.specularIntensity = 0.08;
    mat.envMapIntensity = 0.14;
  } else if (key.includes("truss") || key.includes("catwalk") || key.includes("suspension") || key.includes("pipe")) {
    // Exposed lateral silver-grey X-braced steel box trusses (#6E7279) & dark catwalk steel
    mat.metalness = Math.max(mat.metalness, 0.82);
    mat.roughness = key.includes("truss") ? 0.34 : 0.46;
    mat.clearcoat = 0.0;
    mat.envMapIntensity = key.includes("truss") ? 1.05 : 0.65;
  } else if (key.includes("bezel") || (key.includes("reflector") && !mat.map)) {
    mat.metalness = Math.max(mat.metalness, 0.82);
    mat.roughness = 0.28;
    mat.envMapIntensity = 0.90;
  } else if (key.includes("plaster") || key.includes("charcoal")) {
    // Sculpted staggered pillowed slate-charcoal acoustic plaster (#4E4B48, roughness 0.82)
    mat.roughness = 0.82;
    mat.metalness = 0.0;
    mat.clearcoat = 0.0;
    mat.specularIntensity = 0.48;
    mat.envMapIntensity = 0.46;
  } else if (matName.includes("oak_floor") || key.includes("riser") || key.includes("aisle_stairs")) {
    // Tiered audience oak risers & aisle stairs — shaded by seats/balconies, low open-hall sky specular
    mat.roughness = 0.46;
    mat.clearcoat = 0.08;
    mat.clearcoatRoughness = 0.34;
    if (!mat.normalMap && mat.map) {
      mat.normalMap = oakMicroNormal;
      mat.normalScale.set(0.14, 0.14);
    }
    mat.specularIntensity = 0.28;
    mat.envMapIntensity = 0.14;
  } else if (
    (Boolean(mat.map) || matName.includes("oak") || matName.includes("veil")) &&
    (key.includes("veil") || key.includes("canopy") || key.includes("ribbon") || key.includes("stagereflector") || key.includes("fascia") || key.includes("surround") || key.includes("vestibule") || key.includes("oak"))
  ) {
    const isVeilOrCanopy = key.includes("veil") || key.includes("ribbon") || key.includes("oakstrands") || key.includes("stagereflector") || key.includes("canopy");
    mat.roughness = isVeilOrCanopy ? 0.37 : Math.min(Math.max(mat.roughness, 0.37), 0.46);
    mat.clearcoat = isVeilOrCanopy ? 0.18 : 0.16;
    mat.clearcoatRoughness = isVeilOrCanopy ? 0.24 : 0.28;
    if (!mat.normalMap && mat.map) {
      mat.normalMap = oakMicroNormal;
      mat.normalScale.set(0.15, 0.15);
    }
    mat.envMapIntensity = isVeilOrCanopy ? 0.56 : 0.46;
  } else if (key.includes("emissive") || key.includes("steplight") || key.includes("lamp") || key.includes("sconce") || key.includes("downlight") || key.includes("fixture_glow")) {
    if (!key.includes("exit")) {
      mat.emissiveIntensity = Math.min(2.3, Math.max(1.1, mat.emissiveIntensity));
    } else {
      mat.emissiveIntensity = Math.min(1.2, Math.max(0.25, mat.emissiveIntensity));
    }
  }

  // Attach Cycles UV1 (TEXCOORD_1) baked GI lightmap if available for this object
  let usedLightmap = false;
  const hasUV1 = Boolean(mesh.geometry?.attributes?.uv1);
  if (hasUV1 && bakeMeta?.object_to_atlas) {
    let atlasId = null;
    let cur = mesh;
    while (cur && !atlasId) {
      const cname = cur.name || "";
      const baseCname = cname.replace(/_\d+$/, "");
      atlasId = bakeMeta.object_to_atlas[cname] || bakeMeta.object_to_atlas[baseCname] || null;
      cur = cur.parent;
    }
    const lmTex = atlasId ? lightmapCache.get(atlasId) : null;
    if (lmTex) {
      mat.lightMap = lmTex;
      // Exact physical 1:1 Cycles radiance: atlas_scale * Math.PI compensates for Three.js BRDF_Lambert 1/PI
      const exactIntensity =
        bakeMeta.atlas_lightmap_intensities?.[atlasId] ??
        (bakeMeta.atlas_scales?.[atlasId] !== undefined
          ? bakeMeta.atlas_scales[atlasId] * Math.PI
          : bakeMeta.lightmap_intensity ?? 3.2 * Math.PI);
      const isSoffit = key.includes("soffit") || key.includes("cream");
      const isStageDeck = matName.includes("oak_stage") || matName.includes("stage_oak") || objName === "ws1_stage_deck";
      const isRiserFloor = matName.includes("oak_floor") || key.includes("riser") || key.includes("aisle_stairs");
      let atlasTrim =
        atlasId === "shell_walls"
          ? 1.065
          : atlasId === "fascias_soffits"
            ? 1.09
            : atlasId === "tiers_stage"
              ? 0.97
              : 1.12;
      if (isSoffit) atlasTrim = 0.975;
      else if (isStageDeck) atlasTrim = 0.975;
      else if (isRiserFloor) atlasTrim = 0.86;
      mat.lightMapIntensity = exactIntensity * atlasTrim;
      // Keep open-hall IBL diffuse minimal on high-albedo soffit/oak (0.025) while lifting dark #2C2A29 charcoal plaster (0.14)
      const isCharcoalPlaster = key.includes("plaster") || key.includes("charcoal");
      const iblDiffScale = isCharcoalPlaster ? "0.14" : "0.025";
      const progTag = isStageDeck ? "stg" : (isCharcoalPlaster ? "ch" : "std");
      mat.onBeforeCompile = (shader) => {
        if (isStageDeck) {
          shader.vertexShader =
            "varying vec3 vStageWorldPos;\n" +
            shader.vertexShader.replace(
              "#include <begin_vertex>",
              "#include <begin_vertex>\n\tvStageWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;"
            );
          shader.fragmentShader =
            "varying vec3 vStageWorldPos;\n" +
            shader.fragmentShader.replace(
              "#include <lights_fragment_maps>",
              `#include <lights_fragment_maps>\n\tiblIrradiance *= ${iblDiffScale};` +
                "\n\tvec2 pXZ = vStageWorldPos.xz;" +
                "\n\tfloat bentZ = mix(3.95, 3.17, clamp((pXZ.x + 1.26) / 1.53, 0.0, 1.0));" +
                "\n\tfloat hullDx = max(max(-1.26 - pXZ.x, pXZ.x - 0.84), 0.0);" +
                "\n\tfloat hullDz = max(max(bentZ - pXZ.y, pXZ.y - 4.13), 0.0);" +
                "\n\tfloat hullDist = length(vec2(hullDx, hullDz));" +
                "\n\tfloat hullSpecOcc = mix(0.18, 1.0, smoothstep(0.0, 0.46, hullDist));" +
                "\n\tfloat hullDiffOcc = mix(0.90, 1.0, smoothstep(0.0, 0.38, hullDist));" +
                "\n\tfloat footD = min(min(length(pXZ - vec2(0.752, 4.044)), length(pXZ - vec2(0.750, 3.254))), min(length(pXZ - vec2(0.310, 3.244)), length(pXZ - vec2(-1.142, 4.051))));" +
                "\n\tfloat benchD = min(min(length(pXZ - vec2(1.08, 3.97)), length(pXZ - vec2(1.08, 3.33))), min(length(pXZ - vec2(1.36, 3.97)), length(pXZ - vec2(1.36, 3.33))));" +
                "\n\tfloat contactAO = mix(0.36, 1.0, smoothstep(0.020, 0.14, min(footD, benchD * 1.10)));" +
                "\n\tradiance *= hullSpecOcc * contactAO;" +
                "\n\t#ifdef USE_CLEARCOAT\n\t\tclearcoatRadiance *= hullSpecOcc * contactAO;\n\t#endif" +
                "\n\tirradiance *= contactAO * hullDiffOcc;"
            );
        } else {
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <lights_fragment_maps>",
            `#include <lights_fragment_maps>\n\tiblIrradiance *= ${iblDiffScale};`
          );
        }
      };
      mat.customProgramCacheKey = () => `koerner_lm_${mat.type}_${progTag}_v4`;
      usedLightmap = true;
    }
  }

  return { material: mat, usedLightmap };
}

function setupConcertSpecularLights(scene, hasBakedLightmaps, dimensions) {
  if (hasBakedLightmaps) {
    // Subtle 3100K overhead specular glint light (kept low at 0.05 so 4K Cycles lightmaps own 100% of direct+indirect diffuse!)
    const specKey = new THREE.DirectionalLight(0xfff1dc, 0.05);
    specKey.position.set(-1.5, 11.0, 2.5);
    specKey.target.position.set(-0.4, 1.0, 2.0);
    scene.add(specKey);
    scene.add(specKey.target);
    return;
  }

  // Fallback real-time concert lights when running Phase-0 unbaked preview
  const stageKey = new THREE.SpotLight(0xffdfba, 95.0, 34.0, Math.PI * 0.30, 0.55, 1.5);
  stageKey.position.set(0.0, 10.5, 4.2);
  stageKey.target.position.set(0.0, 1.1, 3.8);
  stageKey.castShadow = true;
  stageKey.shadow.mapSize.set(2048, 2048);
  stageKey.shadow.bias = -0.0003;
  scene.add(stageKey);
  scene.add(stageKey.target);

  const pianoSpot = new THREE.SpotLight(0xffe6c7, 62.0, 24.0, Math.PI * 0.20, 0.65, 1.5);
  pianoSpot.position.set(-2.4, 9.4, 1.2);
  pianoSpot.target.position.set(-0.85, 1.32, 3.20);
  scene.add(pianoSpot);
  scene.add(pianoSpot.target);

  const houseHemi = new THREE.HemisphereLight(0xffd9ad, 0x3b2818, 0.72);
  scene.add(houseHemi);

  const orchFill = new THREE.PointLight(0xffd2a1, 28.0, 28.0, 1.6);
  orchFill.position.set(0.0, 7.8, -9.5);
  scene.add(orchFill);

  const rearUnderBalc = new THREE.PointLight(0xffcf99, 14.0, 16.0, 1.6);
  rearUnderBalc.position.set(0.0, 3.3, -19.5);
  scene.add(rearUnderBalc);
}

// ============================================================================
// BATCHED ~1,135-SEAT INSTANCEDMESH BUILDER + PER-SEAT CYCLES IRRADIANCE
// ============================================================================
async function buildInstancedSeatingRig({
  scene,
  gltfLoader,
  preloadedChairGltf,
  seats,
  controller,
  seatIrradiance,
  hasBakedLightmaps,
  maxAniso,
  isSoftwareGL = false,
  oakMicroNormal,
  woolMicroNormal,
  instancedChairLayers,
  instanceBaseMatrices,
  dummyObj,
  setContactShadowMesh,
}) {
  if (!seats || seats.length === 0) return;

  const rawChairParts = [];
  let accessibleFramePart = null;
  let chairForwardAxis = "-Y"; // Default Blender chair local forward (-Y_b -> +Z_three)
  const ChairMatCtor = THREE.MeshPhysicalMaterial;

  try {
    const gltf =
      preloadedChairGltf ||
      (await loadGstaticGlb(
        gltfLoader,
        "https://www.gstatic.com/aistudio/starter-apps/koerner-hall/chair_koerner.glb"
      ));
    if (gltf) {
      gltf.scene.updateMatrixWorld(true);

      // Extract optional Chair_Koerner_AccessibleFrame for the 7 wheelchair companion spaces
      const accNode = gltf.scene.getObjectByName("Chair_Koerner_AccessibleFrame");
      if (accNode) {
        accNode.traverse((n) => {
          if (n.isMesh && !accessibleFramePart) {
            const g = n.geometry.clone();
            sanitizeTangentBuffer(g);
            const sm = Array.isArray(n.material) ? n.material[0] : n.material;
            accessibleFramePart = {
              geometry: g,
              material: new ChairMatCtor({
                name: sm?.name || "AccFrame_PBR",
                color: sm?.color ? sm.color.clone() : new THREE.Color(0x3b312b),
                map: sm?.map || null,
                roughness: 0.44,
                metalness: 0.78,
              }),
            };
          }
        });
      }

      // Build exact interior vertex sets from Chair_Koerner_Interior so non-aisle sides collapse
      // their floor-to-armrest oak aisle panels, corner standoffs & acrylic plaques in 0 extra draw calls!
      const interiorNode = gltf.scene.getObjectByName("Chair_Koerner_Interior");
      const interiorVertSetsByMat = new Map();
      let interiorStanchionGeom = null;
      if (interiorNode) {
        const invIntRoot = new THREE.Matrix4().copy(interiorNode.matrixWorld).invert();
        interiorNode.traverse((inode) => {
          if (!inode.isMesh || !inode.geometry?.attributes?.position) return;
          const ig = inode.geometry.clone();
          const irel = new THREE.Matrix4().copy(inode.matrixWorld).premultiply(invIntRoot);
          ig.applyMatrix4(irel);
          const ism = Array.isArray(inode.material) ? inode.material[0] : inode.material;
          const mName = (ism?.name || "").toLowerCase();
          if (mName.includes("stanchion") || mName.includes("metal")) {
            interiorStanchionGeom = ig.clone();
          }
          let vset = interiorVertSetsByMat.get(mName);
          if (!vset) {
            vset = new Set();
            interiorVertSetsByMat.set(mName, vset);
          }
          const posArr = ig.attributes.position.array;
          for (let vi = 0; vi < posArr.length; vi += 3) {
            vset.add(
              `${Math.round(posArr[vi] * 10000)},${Math.round(posArr[vi + 1] * 10000)},${Math.round(posArr[vi + 2] * 10000)}`
            );
          }
          ig.dispose();
        });
      }

      // Prefer Chair_Koerner_Seated subtree if both Seated and TipUp variants exist in chair_koerner.glb
      let searchRoot = gltf.scene;
      const seatedNode = gltf.scene.getObjectByName("Chair_Koerner_Seated");
      if (seatedNode) searchRoot = seatedNode;

      searchRoot.traverse((node) => {
        if (!node.isMesh) return;
        const nLower = node.name.toLowerCase();
        if (!seatedNode && (nLower.includes("tipup") || nLower.includes("accessible") || nLower.includes("interior") || nLower.includes("aisleleft") || nLower.includes("aisleright"))) return;

        const srcMat = Array.isArray(node.material) ? node.material[0] : node.material;
        const srcMatNameLower = (srcMat?.name || "").toLowerCase();
        const matKey = `${srcMatNameLower} ${nLower}`;

        // Use full-height steel stanchions from Chair_Koerner_Interior so non-aisle sides have floor-to-armrest stanchions
        let geom;
        if ((srcMatNameLower.includes("stanchion") || srcMatNameLower.includes("metal")) && interiorStanchionGeom) {
          geom = interiorStanchionGeom.clone();
        } else {
          geom = node.geometry.clone();
          const relMat = new THREE.Matrix4().copy(node.matrixWorld);
          if (seatedNode) {
            const invRoot = new THREE.Matrix4().copy(seatedNode.matrixWorld).invert();
            relMat.premultiply(invRoot);
          }
          geom.applyMatrix4(relMat);
        }

        const canHaveAisleParts = !(srcMatNameLower.includes("stanchion") || srcMatNameLower.includes("wool"));
        if (canHaveAisleParts && geom.index) {
          const nonIdx = geom.toNonIndexed();
          geom.dispose();
          geom = nonIdx;
        }

        const keepAttrs = ["position", "normal", "tangent", "uv"];
        for (const k of Object.keys(geom.attributes)) {
          if (!keepAttrs.includes(k)) geom.deleteAttribute(k);
        }
        if (!geom.attributes.uv) {
          geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(geom.attributes.position.count * 2), 2));
        }
        sanitizeTangentBuffer(geom);
        if (!geom.attributes.tangent && geom.attributes.normal) {
          const countV = geom.attributes.position.count;
          const tArr = new Float32Array(countV * 4);
          for (let iv = 0; iv < countV; iv++) {
            tArr[iv * 4] = 1.0;
            tArr[iv * 4 + 3] = 1.0;
          }
          geom.setAttribute("tangent", new THREE.BufferAttribute(tArr, 4));
          sanitizeTangentBuffer(geom);
        }

        // Tag aisle-only triangles STRICTLY PER-FACE (all 3 vertices of each triangle get identical -1, 0, or +1)
        // so collapsing hidden aisle panels to vec3(0.0) produces ZERO mixed/stretched oak shards!
        const allAisleOnly =
          Boolean(srcMat?.emissiveMap) ||
          matKey.includes("acrylic") ||
          matKey.includes("plaque") ||
          matKey.includes("glyph");
        const intSet = interiorVertSetsByMat.get(srcMatNameLower);
        let isAisleSidePart = false;
        let hasGlyphQuadAttr = false;

        if (allAisleOnly && canHaveAisleParts) {
          // Strip static 3D 'Q' glyph prisms (cu < 0.24 && cy < 0.555) and replace with Left & Right
          // UV-indexed per-row glyph quads sampling our procedural DataTexture atlas in 0 extra draw calls!
          const pArr = geom.attributes.position.array;
          const nArr = geom.attributes.normal.array;
          const tArr = geom.attributes.tangent.array;
          const uArr = geom.attributes.uv.array;
          const triCount = Math.floor(geom.attributes.position.count / 3);

          const outP = [], outN = [], outT = [], outU = [], outTag = [], outGlyph = [];
          for (let tri = 0; tri < triCount; tri++) {
            const i0 = tri * 3, i1 = i0 + 1, i2 = i0 + 2;
            const cx = (pArr[i0 * 3] + pArr[i1 * 3] + pArr[i2 * 3]) / 3.0;
            const cy = (pArr[i0 * 3 + 1] + pArr[i1 * 3 + 1] + pArr[i2 * 3 + 1]) / 3.0;
            const cu = (uArr[i0 * 2] + uArr[i1 * 2] + uArr[i2 * 2]) / 3.0;
            if (cu < 0.24 && cy < 0.555) continue;
            const tag = cx < 0 ? -1.0 : 1.0;
            for (const vi of [i0, i1, i2]) {
              outP.push(pArr[vi * 3], pArr[vi * 3 + 1], pArr[vi * 3 + 2]);
              outN.push(nArr[vi * 3], nArr[vi * 3 + 1], nArr[vi * 3 + 2]);
              outT.push(tArr[vi * 4], tArr[vi * 4 + 1], tArr[vi * 4 + 2], tArr[vi * 4 + 3]);
              outU.push(uArr[vi * 2], uArr[vi * 2 + 1]);
              outTag.push(tag);
              outGlyph.push(0.0);
            }
          }

          // Append crisp Left (-X) & Right (+X) silkscreened row-glyph quads on outer glass standoff plane
          const yBot = 0.4972, yTop = 0.5218, zCtr = 0.1505, hw = 0.0102;
          const addGlyphQuad = (sideSign) => {
            const xPlane = sideSign * 0.2643;
            const zLeft = sideSign < 0 ? zCtr - hw : zCtr + hw;
            const zRight = sideSign < 0 ? zCtr + hw : zCtr - hw;
            const corners = [
              [xPlane, yBot, zLeft, 0.0, 0.0],
              [xPlane, yBot, zRight, 1.0, 0.0],
              [xPlane, yTop, zRight, 1.0, 1.0],
              [xPlane, yTop, zLeft, 0.0, 1.0],
            ];
            const tz = sideSign < 0 ? 1.0 : -1.0;
            for (const ci of [0, 1, 2, 0, 2, 3]) {
              const c = corners[ci];
              outP.push(c[0], c[1], c[2]);
              outN.push(sideSign, 0.0, 0.0);
              outT.push(0.0, 0.0, tz, 1.0);
              outU.push(c[3], c[4]);
              outTag.push(sideSign);
              outGlyph.push(1.0);
            }
          };
          addGlyphQuad(-1.0);
          addGlyphQuad(1.0);

          const rebuilt = new THREE.BufferGeometry();
          rebuilt.setAttribute("position", new THREE.BufferAttribute(new Float32Array(outP), 3));
          rebuilt.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(outN), 3));
          rebuilt.setAttribute("tangent", new THREE.BufferAttribute(new Float32Array(outT), 4));
          rebuilt.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(outU), 2));
          rebuilt.setAttribute("aAisleTag", new THREE.BufferAttribute(new Float32Array(outTag), 1));
          rebuilt.setAttribute("aIsGlyphQuad", new THREE.BufferAttribute(new Float32Array(outGlyph), 1));
          geom.dispose();
          geom = rebuilt;
          isAisleSidePart = true;
          hasGlyphQuadAttr = true;
        } else if (canHaveAisleParts) {
          const posAttr = geom.attributes.position;
          const vCount = posAttr.count;
          const triCount = Math.floor(vCount / 3);
          const aisleSideTag = new Float32Array(vCount);
          const isBrassHardware = matKey.includes("brass") || matKey.includes("plate");

          for (let tri = 0; tri < triCount; tri++) {
            const i0 = tri * 3, i1 = i0 + 1, i2 = i0 + 2;
            const x0 = posAttr.getX(i0), y0 = posAttr.getY(i0), z0 = posAttr.getZ(i0);
            const x1 = posAttr.getX(i1), y1 = posAttr.getY(i1), z1 = posAttr.getZ(i1);
            const x2 = posAttr.getX(i2), y2 = posAttr.getY(i2), z2 = posAttr.getZ(i2);
            const cx = (x0 + x1 + x2) / 3.0;
            const cy = (y0 + y1 + y2) / 3.0;
            const minY = Math.min(y0, y1, y2);

            let isAisleTri = false;
            if (isBrassHardware) {
              // Armrest top seat-number disc sits at cy ~ 0.625; 8 plaque corner standoffs sit at cy < 0.59, |cx| >= 0.255
              isAisleTri = cy < 0.605 && Math.abs(cx) >= 0.250;
            } else if (intSet && intSet.size > 0) {
              const h0 = intSet.has(`${Math.round(x0 * 10000)},${Math.round(y0 * 10000)},${Math.round(z0 * 10000)}`) ? 1 : 0;
              const h1 = intSet.has(`${Math.round(x1 * 10000)},${Math.round(y1 * 10000)},${Math.round(z1 * 10000)}`) ? 1 : 0;
              const h2 = intSet.has(`${Math.round(x2 * 10000)},${Math.round(y2 * 10000)},${Math.round(z2 * 10000)}`) ? 1 : 0;
              isAisleTri = (h0 + h1 + h2) < 3 || minY <= 0.13;
            }

            if (isAisleTri) {
              const triTag = cx < 0 ? -1.0 : 1.0;
              aisleSideTag[i0] = triTag;
              aisleSideTag[i1] = triTag;
              aisleSideTag[i2] = triTag;
              isAisleSidePart = true;
            }
          }

          if (isAisleSidePart) {
            geom.setAttribute("aAisleTag", new THREE.BufferAttribute(aisleSideTag, 1));
          }
        }

        const pbrMat = new ChairMatCtor({
          name: srcMat?.name || "Chair_Part_PBR",
          color: srcMat?.color ? srcMat.color.clone() : new THREE.Color(0xb88b58),
          map: srcMat?.map || null,
          normalMap: srcMat?.normalMap || null,
          roughnessMap: srcMat?.roughnessMap || null,
          metalnessMap: srcMat?.metalnessMap || null,
          emissive: srcMat?.emissive ? srcMat.emissive.clone() : new THREE.Color(0x000000),
          emissiveMap: srcMat?.emissiveMap || null,
          emissiveIntensity: srcMat?.emissiveMap
            ? 1.68
            : (srcMat?.emissive && (srcMat.emissive.r + srcMat.emissive.g + srcMat.emissive.b > 0.02)
                ? (srcMat?.emissiveIntensity ?? 1.2)
                : 0.0),
          roughness: srcMat?.roughness ?? 0.65,
          metalness: srcMat?.metalness ?? 0.0,
          transparent: Boolean(srcMat?.transparent),
          opacity: srcMat?.opacity ?? 1.0,
          depthWrite: srcMat?.transparent ? false : true,
        });

        if (pbrMat.map) {
          pbrMat.map.colorSpace = THREE.SRGBColorSpace;
          pbrMat.map.generateMipmaps = true;
          pbrMat.map.minFilter = THREE.LinearMipmapLinearFilter;
          pbrMat.map.anisotropy = maxAniso;
          pbrMat.map.needsUpdate = true;
        }
        if (pbrMat.emissiveMap) {
          pbrMat.emissiveMap.colorSpace = THREE.SRGBColorSpace;
          pbrMat.emissiveMap.generateMipmaps = true;
          pbrMat.emissiveMap.minFilter = THREE.LinearMipmapLinearFilter;
          pbrMat.emissiveMap.anisotropy = maxAniso;
          pbrMat.emissiveMap.needsUpdate = true;
        }
        for (const t of [pbrMat.normalMap, pbrMat.roughnessMap, pbrMat.metalnessMap]) {
          if (t) {
            t.colorSpace = THREE.NoColorSpace;
            t.generateMipmaps = true;
            t.minFilter = THREE.LinearMipmapLinearFilter;
            t.anisotropy = maxAniso;
            t.needsUpdate = true;
          }
        }

        let familyKey = `part_${srcMat?.name || node.name}`;
        if (matKey.includes("acrylic") || Boolean(pbrMat.emissiveMap)) {
          pbrMat.metalness = 0.0;
          pbrMat.roughness = 0.22;
          pbrMat.clearcoat = 0.75;
          pbrMat.clearcoatRoughness = 0.08;
          pbrMat.envMapIntensity = 0.72;
          familyKey = `chair_acrylic_${pbrMat.map?.uuid || "-"}_${pbrMat.emissiveMap?.uuid || "-"}`;
        } else if (matKey.includes("wool") || matKey.includes("upholster") || matKey.includes("cushion") || matKey.includes("fabric")) {
          pbrMat.roughness = 0.87;
          pbrMat.metalness = 0.0;
          pbrMat.sheen = 0.26;
          pbrMat.sheenRoughness = 0.78;
          pbrMat.sheenColor = new THREE.Color(0x5c4c47);
          if (!pbrMat.normalMap) {
            pbrMat.normalMap = woolMicroNormal;
            pbrMat.normalScale.set(0.22, 0.22);
          }
          pbrMat.envMapIntensity = 0.30;
          familyKey = `chair_wool_${pbrMat.map?.uuid || "-"}`;
        } else if (matKey.includes("oak") || matKey.includes("shell") || matKey.includes("arm") || matKey.includes("wood")) {
          pbrMat.roughness = 0.40;
          pbrMat.clearcoat = 0.14;
          pbrMat.clearcoatRoughness = 0.28;
          if (!pbrMat.normalMap) {
            pbrMat.normalMap = oakMicroNormal;
            pbrMat.normalScale.set(0.16, 0.16);
          }
          pbrMat.envMapIntensity = 0.46;
          familyKey = `chair_oak_${pbrMat.map?.uuid || "-"}`;
        } else if (matKey.includes("brass") || matKey.includes("plate") || matKey.includes("stanchion") || matKey.includes("metal") || matKey.includes("leg") || matKey.includes("steel")) {
          pbrMat.metalness = 0.85;
          pbrMat.roughness = matKey.includes("brass") ? 0.28 : 0.54;
          pbrMat.envMapIntensity = 0.52;
        }

        rawChairParts.push({
          familyKey: `${familyKey}|A:${isAisleSidePart ? 1 : 0}|G:${hasGlyphQuadAttr ? 1 : 0}|I:${geom.index ? 1 : 0}`,
          geometry: geom,
          material: pbrMat,
          isAisleSidePart,
          hasEmissivePlaque: Boolean(pbrMat.emissiveMap),
          hasGlyphQuadAttr,
          isRaycastTarget: !pbrMat.transparent,
        });
      });
      if (interiorStanchionGeom) interiorStanchionGeom.dispose();

      if (gltf.scene.userData?.forward_axis) {
        chairForwardAxis = String(gltf.scene.userData.forward_axis);
      }
    }
  } catch (_) {}

  // Merge sub-meshes within the chair sharing identical material family so instanced draw calls stay minimal (3-5 calls)
  const chairParts = [];
  const familyBuckets = new Map();
  for (const rp of rawChairParts) {
    let b = familyBuckets.get(rp.familyKey);
    if (!b) {
      b = {
        material: rp.material,
        geoms: [rp.geometry],
        isAisleSidePart: rp.isAisleSidePart,
        hasEmissivePlaque: rp.hasEmissivePlaque,
        hasGlyphQuadAttr: rp.hasGlyphQuadAttr,
        isRaycastTarget: rp.isRaycastTarget,
      };
      familyBuckets.set(rp.familyKey, b);
    } else {
      b.geoms.push(rp.geometry);
      rp.material.dispose();
    }
  }
  for (const b of familyBuckets.values()) {
    if (b.geoms.length === 1) {
      chairParts.push({
        geometry: b.geoms[0],
        material: b.material,
        isAisleSidePart: b.isAisleSidePart,
        hasEmissivePlaque: b.hasEmissivePlaque,
        hasGlyphQuadAttr: b.hasGlyphQuadAttr,
        isRaycastTarget: b.isRaycastTarget,
      });
    } else {
      const mg = mergeGeometries(b.geoms, false);
      if (mg) {
        for (const g of b.geoms) g.dispose();
        chairParts.push({
          geometry: mg,
          material: b.material,
          isAisleSidePart: b.isAisleSidePart,
          hasEmissivePlaque: b.hasEmissivePlaque,
          hasGlyphQuadAttr: b.hasGlyphQuadAttr,
          isRaycastTarget: b.isRaycastTarget,
        });
      } else {
        for (const g of b.geoms) {
          chairParts.push({
            geometry: g,
            material: b.material,
            isAisleSidePart: b.isAisleSidePart,
            hasEmissivePlaque: b.hasEmissivePlaque,
            hasGlyphQuadAttr: b.hasGlyphQuadAttr,
            isRaycastTarget: b.isRaycastTarget,
          });
        }
      }
    }
  }

  // Fallback sculpted chair geometry if chair_koerner.glb is not built yet
  if (chairParts.length === 0) {
    const cushionGeo = new THREE.BoxGeometry(0.46, 0.09, 0.44, 2, 2, 2);
    cushionGeo.translate(0, 0.43, 0.02);
    sanitizeTangentBuffer(cushionGeo);

    const backGeo = new THREE.BoxGeometry(0.46, 0.46, 0.06, 2, 2, 2);
    backGeo.translate(0, 0.68, -0.19);
    sanitizeTangentBuffer(backGeo);

    const woolMat = new THREE.MeshPhysicalMaterial({
      color: 0x9b6b43,
      roughness: 0.78,
      sheen: 0.65,
      sheenRoughness: 0.75,
      normalMap: woolMicroNormal,
    });
    const oakShellMat = new THREE.MeshPhysicalMaterial({
      color: 0xc8965e,
      roughness: 0.40,
      clearcoat: 0.16,
      normalMap: oakMicroNormal,
    });
    chairParts.push({ geometry: cushionGeo, material: woolMat, isRaycastTarget: true });
    chairParts.push({ geometry: backGeo, material: oakShellMat, isRaycastTarget: true });
  }

  const count = seats.length;
  const irrMap = seatIrradiance?.seats || null;
  const hasBakedSeatIrr = Boolean(irrMap);
  const irrScale = Number(seatIrradiance?.irradiance_intensity ?? 1.0);
  const colorTmp = new THREE.Color();
  const rowGlyphAtlasTex = createRowGlyphAtlasTexture();

  // Compute instance matrices, left/right aisle plaque masks, row glyph cells & per-seat warm Cycles irradiance
  const perSeatIrrLinear = new Float32Array(count * 3);
  const perSeatTint = new Float32Array(count * 3);
  const perSeatAisleSides = new Float32Array(count * 2);
  const perSeatGlyphCells = new Float32Array(count * 2);
  const accessibleIndices = [];
  for (let i = 0; i < count; i++) {
    const s = seats[i];
    if (s.is_accessible) accessibleIndices.push(i);
    const side = String(s.aisle_side || "none").toLowerCase();
    perSeatAisleSides[i * 2] = side === "left" || side === "both" ? 1.0 : 0.0;
    perSeatAisleSides[i * 2 + 1] = side === "right" || side === "both" ? 1.0 : 0.0;
    const [gCol, gRow] = getSeatGlyphAtlasCell(s);
    perSeatGlyphCells[i * 2] = gCol;
    perSeatGlyphCells[i * 2 + 1] = gRow;
    const pos = blenderToThreeVec3(s.x, s.y, s.z_riser);
    const fwd = controller.getSeatForwardBlender(s);
    let yawThree = Math.atan2(fwd.horizX, -fwd.horizY);
    if (chairForwardAxis === "+Y") yawThree += Math.PI;
    else if (chairForwardAxis === "+X") yawThree -= Math.PI / 2;
    else if (chairForwardAxis === "-X") yawThree += Math.PI / 2;

    dummyObj.position.copy(pos);
    dummyObj.rotation.set(0, yawThree, 0);
    dummyObj.scale.set(1, 1, 1);
    dummyObj.updateMatrix();
    instanceBaseMatrices.push(dummyObj.matrix.clone());

    const rec = irrMap ? (irrMap[s.id] || irrMap[s.short_id] || irrMap[String(i)]) : null;
    if (rec) {
      perSeatIrrLinear[i * 3] = Number(rec.r ?? rec[0] ?? 0.6) * irrScale;
      perSeatIrrLinear[i * 3 + 1] = Number(rec.g ?? rec[1] ?? 0.5) * irrScale;
      perSeatIrrLinear[i * 3 + 2] = Number(rec.b ?? rec[2] ?? 0.4) * irrScale;
      perSeatTint[i * 3] = 1.0;
      perSeatTint[i * 3 + 1] = 1.0;
      perSeatTint[i * 3 + 2] = 1.0;
    } else {
      const distToStage = Math.hypot(s.x, s.y + 3.0);
      const atten = Math.max(0.58, Math.min(1.08, 1.12 - distToStage * 0.014));
      perSeatIrrLinear[i * 3] = 0.0;
      perSeatIrrLinear[i * 3 + 1] = 0.0;
      perSeatIrrLinear[i * 3 + 2] = 0.0;
      perSeatTint[i * 3] = atten * 1.02;
      perSeatTint[i * 3 + 1] = atten * 0.98;
      perSeatTint[i * 3 + 2] = atten * 0.93;
    }
  }

  for (const part of chairParts) {
    const isPlaqueMat = Boolean(part.isAisleSidePart && part.geometry.attributes.aAisleTag);
    const hasEmissivePlaque = Boolean(part.hasEmissivePlaque || part.material.emissiveMap);
    const hasGlyphQuad = Boolean(part.hasGlyphQuadAttr && part.geometry.attributes.aIsGlyphQuad);
    const matNameLow = (part.material.name || "").toLowerCase();
    const isOakShell = matNameLow.includes("oak") || matNameLow.includes("shell");
    const isWoolUpholstery = matNameLow.includes("wool") || matNameLow.includes("upholster");
    if (isPlaqueMat) {
      part.geometry.setAttribute(
        "instanceAisleSides",
        new THREE.InstancedBufferAttribute(perSeatAisleSides, 2)
      );
      if (hasGlyphQuad) {
        part.geometry.setAttribute(
          "instanceGlyphCell",
          new THREE.InstancedBufferAttribute(perSeatGlyphCells, 2)
        );
      }
    }
    if (hasBakedSeatIrr || isPlaqueMat) {
      if (hasBakedSeatIrr) {
        part.geometry.setAttribute(
          "instanceIrradiance",
          new THREE.InstancedBufferAttribute(perSeatIrrLinear, 3)
        );
        if (hasBakedLightmaps) {
          part.material.envMapIntensity = (part.material.envMapIntensity ?? 0.65) * 0.48;
        }
      }
      part.material.onBeforeCompile = (shader) => {
        if (hasGlyphQuad) {
          shader.uniforms.uGlyphAtlas = { value: rowGlyphAtlasTex };
        }
        let vHead = "";
        let fHead = "";
        if (hasBakedSeatIrr) {
          vHead += "attribute vec3 instanceIrradiance;\nvarying vec3 vSeatIrradiance;\nvarying float vChairSpecAO;\n";
          fHead += "varying vec3 vSeatIrradiance;\nvarying float vChairSpecAO;\n";
        }
        if (isPlaqueMat) {
          vHead += "attribute float aAisleTag;\nattribute vec2 instanceAisleSides;\n";
          if (hasEmissivePlaque) {
            vHead += "varying float vAisleEmissive;\n";
            fHead += "varying float vAisleEmissive;\n";
          }
          if (hasGlyphQuad) {
            vHead +=
              "attribute float aIsGlyphQuad;\nattribute vec2 instanceGlyphCell;\n" +
              "varying float vIsGlyphQuad;\nvarying vec2 vGlyphUV;\nvarying vec3 vPocketCoord;\n";
            fHead +=
              "uniform sampler2D uGlyphAtlas;\n" +
              "varying float vIsGlyphQuad;\nvarying vec2 vGlyphUV;\nvarying vec3 vPocketCoord;\n";
          }
        }
        let plaqueVertSnippet = "";
        if (isPlaqueMat) {
          plaqueVertSnippet =
            "\n\tfloat hideLeftAisle = step(aAisleTag, -0.5) * (1.0 - instanceAisleSides.x);" +
            "\n\tfloat hideRightAisle = step(0.5, aAisleTag) * (1.0 - instanceAisleSides.y);" +
            "\n\tif (hideLeftAisle > 0.5 || hideRightAisle > 0.5) { transformed = vec3(0.0); }" +
            (hasEmissivePlaque
              ? "\n\tvAisleEmissive = step(aAisleTag, -0.5) * instanceAisleSides.x + step(0.5, aAisleTag) * instanceAisleSides.y;"
              : "") +
            (hasGlyphQuad
              ? "\n\tvIsGlyphQuad = aIsGlyphQuad;" +
                "\n\tvGlyphUV = vec2((instanceGlyphCell.x + uv.x) / 8.0, (instanceGlyphCell.y + uv.y) / 4.0);" +
                "\n\tfloat pktMask = step(0.48, uv.x) * (1.0 - aIsGlyphQuad);" +
                "\n\tvPocketCoord = vec3(clamp((position.z - 0.073) / 0.100, 0.0, 1.0), clamp((position.y - 0.490) / 0.106, 0.0, 1.0), pktMask);"
              : "");
        }
        const frontTrimVal = isWoolUpholstery ? "0.86" : "0.94";
        const oakCavityExpr = (isOakShell && isPlaqueMat)
          ? "\n\tfloat openSideMask = (position.x < 0.0) ? instanceAisleSides.x : instanceAisleSides.y;" +
            "\n\tfloat nonRearMask = smoothstep(-0.32, -0.05, normal.z);" +
            "\n\tfloat lowPanMask = 1.0 - smoothstep(0.53, 0.615, position.y);" +
            "\n\tfloat cavityOcc = mix(1.0, 0.20, (1.0 - openSideMask) * nonRearMask * lowPanMask);" +
            "\n\tfloat sideBoost = 1.0 - 0.18 * abs(normal.x) * openSideMask;"
          : "\n\tfloat cavityOcc = 1.0;\n\tfloat sideBoost = 1.0 - 0.16 * abs(normal.x);";
        const chairIrrSnippet = hasBakedSeatIrr
          ? "\n\tfloat rowHeightAO = mix(0.50, 1.05, smoothstep(0.04, 0.84, position.y));" +
            "\n\tfloat hemiFactor = mix(0.28, 1.00, clamp(normal.y * 0.5 + 0.5, 0.0, 1.0));" +
            "\n\tfloat backShadow = mix(0.37, 1.03, smoothstep(-0.95, -0.05, normal.z));" +
            `\n\tfloat frontTrim = mix(1.00, ${frontTrimVal}, smoothstep(0.10, 0.95, normal.z));` +
            oakCavityExpr +
            "\n\tfloat stageBias = backShadow * frontTrim * sideBoost * cavityOcc;" +
            "\n\tvSeatIrradiance = instanceIrradiance * rowHeightAO * (0.36 + 0.64 * hemiFactor) * stageBias;" +
            "\n\tvChairSpecAO = cavityOcc * rowHeightAO * mix(0.38, 1.00, clamp(normal.y * 0.5 + 0.5, 0.0, 1.0)) * mix(0.22, 1.00, smoothstep(-0.95, -0.05, normal.z));"
          : "";
        shader.vertexShader =
          vHead +
          shader.vertexShader.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>" + chairIrrSnippet + plaqueVertSnippet
          );
        let frag = fHead + shader.fragmentShader;
        if (hasGlyphQuad) {
          frag = frag.replace(
            "#include <map_fragment>",
            "#include <map_fragment>\n\tif (vIsGlyphQuad > 0.5) {\n\t\tvec4 gSamp = texture2D(uGlyphAtlas, vGlyphUV);\n\t\tif (gSamp.a < 0.42) discard;\n\t\tdiffuseColor.rgb = vec3(0.95, 0.91, 0.84);\n\t}"
          );
        }
        if (hasBakedSeatIrr) {
          frag = frag.replace(
            "#include <lights_fragment_maps>",
            "#include <lights_fragment_maps>\n\tiblIrradiance *= 0.04 * vChairSpecAO;\n\tradiance *= vChairSpecAO;\n\treflectedLight.indirectDiffuse += vSeatIrradiance * diffuseColor.rgb;"
          );
        }
        if (isPlaqueMat && hasEmissivePlaque) {
          const emPatch = hasGlyphQuad
            ? "\n\tif (vIsGlyphQuad > 0.5) {\n\t\ttotalEmissiveRadiance = vec3(0.84, 0.75, 0.58) * vAisleEmissive;\n\t} else {\n\t\tfloat pocketWash = vPocketCoord.z * pow(vPocketCoord.y, 1.25) * (0.42 + 0.58 * sin(vPocketCoord.x * 3.14159265));\n\t\ttotalEmissiveRadiance = totalEmissiveRadiance * vAisleEmissive + vec3(1.05, 0.58, 0.20) * (pocketWash * 0.54 * vAisleEmissive);\n\t}"
            : "\n\ttotalEmissiveRadiance *= vAisleEmissive;";
          frag = frag.replace(
            "#include <emissivemap_fragment>",
            "#include <emissivemap_fragment>" + emPatch
          );
        }
        shader.fragmentShader = frag;
      };
      part.material.customProgramCacheKey = () =>
        `koerner_chair_${part.material.name}_irr${hasBakedSeatIrr ? 1 : 0}_aisle${isPlaqueMat ? 1 : 0}_em${hasEmissivePlaque ? 1 : 0}_gq${hasGlyphQuad ? 1 : 0}_v4`;
    }

    const inst = new THREE.InstancedMesh(part.geometry, part.material, count);
    inst.name = `InstancedChair_${part.material.name}`;
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const baseColors = new Float32Array(perSeatTint);
    for (let i = 0; i < count; i++) {
      inst.setMatrixAt(i, instanceBaseMatrices[i]);
      colorTmp.setRGB(baseColors[i * 3], baseColors[i * 3 + 1], baseColors[i * 3 + 2]);
      inst.setColorAt(i, colorTmp);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    scene.add(inst);
    instancedChairLayers.push({
      mesh: inst,
      baseColors,
      isRaycastTarget: part.isRaycastTarget,
    });
  }

  // Accessible wheelchair companion floor frames (7 seats)
  if (accessibleFramePart && accessibleIndices.length > 0) {
    const accInst = new THREE.InstancedMesh(
      accessibleFramePart.geometry,
      accessibleFramePart.material,
      accessibleIndices.length
    );
    accInst.name = "InstancedChair_AccessibleFrames";
    for (let k = 0; k < accessibleIndices.length; k++) {
      accInst.setMatrixAt(k, instanceBaseMatrices[accessibleIndices[k]]);
    }
    accInst.instanceMatrix.needsUpdate = true;
    accInst.computeBoundingSphere();
    scene.add(accInst);
  }

  // Batched Riser Contact Shadow Discs — ONLY needed in unbaked Phase-0 preview!
  // When 4K Cycles lightmaps are present, WS3 chairs cast physical multi-bounce shadows directly into lm_tiers_stage_4k.jpg!
  if (!hasBakedLightmaps) {
    const discGeo = new THREE.PlaneGeometry(0.58, 0.56);
    discGeo.rotateX(-Math.PI / 2);
    const discMat = new THREE.MeshBasicMaterial({
      map: createRadialContactShadowTexture(),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const shadowInst = new THREE.InstancedMesh(discGeo, discMat, count);
    shadowInst.name = "InstancedChair_ContactShadows";
    for (let i = 0; i < count; i++) {
      dummyObj.matrix.copy(instanceBaseMatrices[i]);
      dummyObj.matrix.decompose(dummyObj.position, dummyObj.quaternion, dummyObj.scale);
      dummyObj.position.y += 0.0025;
      dummyObj.updateMatrix();
      shadowInst.setMatrixAt(i, dummyObj.matrix);
    }
    shadowInst.instanceMatrix.needsUpdate = true;
    shadowInst.computeBoundingSphere();
    scene.add(shadowInst);
    setContactShadowMesh(shadowInst);
  }
}

// ============================================================================
// PHASE-0 FALLBACK PREVIEW HALL (Active ONLY before WS1/WS2/WS3 GLBs land)
// ============================================================================
function buildPhase0PreviewManifest() {
  const seats = [];
  const rows = "ABCDEFGHIJKLMNOPQ".split("");
  for (let r = 0; r < rows.length; r++) {
    const y = 2.6 + r * 0.92;
    const zRiser = Math.max(0, (r - 2) * 0.11);
    const nSeats = 26;
    for (let k = 1; k <= nSeats; k++) {
      const x = (k - (nSeats + 1) / 2) * 0.56;
      seats.push({
        id: `ORCH-${rows[r]}-${k}`,
        short_id: `ORCH-${rows[r]}-${k}`,
        tier: "Orchestra",
        section: "Orchestra Center",
        row: rows[r],
        seat_number: k,
        x: Number(x.toFixed(3)),
        y: Number(y.toFixed(3)),
        z_riser: Number(zRiser.toFixed(3)),
        z_eye: Number((zRiser + 1.12).toFixed(3)),
        yaw_deg: 0,
        pitch_deg: -3,
        is_accessible: r === rows.length - 1 && (k <= 2 || k >= nSeats - 1),
        aisle_side: "none",
      });
    }
  }
  return {
    venue: "Koerner Hall (Phase 0 Preview)",
    total_seats: seats.length,
    stage_targets: { soloist_piano: { x: 0, y: -3.4, z: 1.35 } },
    seats,
  };
}

function buildPhase0PreviewHall(scene, walkableMeshes) {
  // Stage deck (y_b = 0..-11.2, z_b = 0.95 -> Three.js z = 0..+11.2, y = 0.95)
  const stageGeo = new THREE.BoxGeometry(18.0, 0.95, 11.2);
  stageGeo.translate(0, 0.475, 5.6);
  const stageMat = new THREE.MeshPhysicalMaterial({
    color: 0xc9965b,
    roughness: 0.36,
    clearcoat: 0.32,
  });
  const stageMesh = new THREE.Mesh(stageGeo, stageMat);
  stageMesh.name = "Preview_Stage_Oak";
  scene.add(stageMesh);
  walkableMeshes.push(stageMesh);

  // Orchestra parterre floor
  const floorGeo = new THREE.PlaneGeometry(22.0, 26.0);
  floorGeo.rotateX(-Math.PI / 2);
  floorGeo.translate(0, 0.0, -13.0);
  const floorMat = new THREE.MeshPhysicalMaterial({
    color: 0x3b2c20,
    roughness: 0.65,
  });
  const floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.name = "Preview_Orchestra_Floor";
  scene.add(floorMesh);
  walkableMeshes.push(floorMesh);

  // Sculpted Oak Veil preview arch
  for (let i = 0; i < 8; i++) {
    const zThree = 9.0 - i * 3.6;
    const yThree = 9.2 + Math.sin(i * 0.55) * 1.4;
    const ribGeo = new THREE.BoxGeometry(19.5, 0.12, 2.2);
    const ribMat = new THREE.MeshPhysicalMaterial({
      color: 0xd4a36a,
      roughness: 0.40,
      clearcoat: 0.16,
    });
    const rib = new THREE.Mesh(ribGeo, ribMat);
    rib.position.set(0, yThree, zThree);
    rib.rotation.x = Math.cos(i * 0.5) * 0.14;
    scene.add(rib);
  }
}

initKoernerHallExplorer();
