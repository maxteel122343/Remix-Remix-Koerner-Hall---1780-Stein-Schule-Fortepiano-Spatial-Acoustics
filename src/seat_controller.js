/**
 * Seated, Stage-Piano Orbit, Walk & Benchmark-Locked Camera Controller for Koerner Hall V2
 *
 * Coordinate Transform Invariant (Blender Z-up -> glTF/Three.js Y-up):
 *   x_three =  x_blender
 *   y_three =  z_blender
 *   z_three = -y_blender
 *
 * Never uses OrbitControls in Seated mode so looking +80° up at the Baillie Oak Veil
 * never shifts or lifts the seated eye point by even 0.1 mm.
 * In Stage Piano mode ("piano"), orbits smoothly around the CAD Steinway Model D-274 on stage.
 */

import * as THREE from "three";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export const DEFAULT_BENCHMARK_STATIONS = [
  { id: "01", title: "Orchestra Center (Row H) -> Stage & Oak Veil", eye: [0.0, 9.2, 1.55], target: [0.0, -4.5, 3.2], vfov_deg: 38.0 },
  { id: "02", title: "Orchestra Front (Row B Left) -> Soloist Piano & Stage Canopy", eye: [-3.4, 2.8, 1.18], target: [0.2, -3.2, 2.1], vfov_deg: 38.0 },
  { id: "03", title: "Rear Orchestra (Under Lower Balcony Overhang)", eye: [0.0, 19.2, 2.55], target: [0.0, -3.5, 2.8], vfov_deg: 40.0 },
  { id: "04", title: "Lower Balcony Center (Row A) Panoramic", eye: [0.0, 16.5, 5.65], target: [0.0, -3.8, 2.6], vfov_deg: 42.0 },
  { id: "05", title: "Lower Balcony Side Box / Loge Raking View", eye: [-8.4, 7.5, 5.10], target: [2.2, -3.0, 2.5], vfov_deg: 42.0 },
  { id: "06", title: "Upper Balcony Center (Row C) Steep Sightline", eye: [0.0, 18.2, 10.10], target: [0.0, -3.5, 2.0], vfov_deg: 42.0 },
  { id: "07", title: "Upper Balcony Corner Wide Diagonal", eye: [-8.6, 17.5, 10.40], target: [2.5, -2.5, 3.2], vfov_deg: 46.0 },
  { id: "08", title: "Choir Loft Looking Out Into House", eye: [0.0, -13.2, 4.45], target: [0.0, 10.5, 4.2], vfov_deg: 44.0 },
  { id: "09", title: "On-Stage Performer POV Looking Into All 3 Tiers", eye: [0.0, -3.2, 2.18], target: [0.0, 13.5, 4.5], vfov_deg: 45.0 },
  { id: "10", title: "Upward Architectural Hero of the Sculpted Baillie Oak Veil", eye: [0.0, 7.5, 1.50], target: [0.0, -1.5, 12.2], vfov_deg: 50.0 },
  { id: "11", title: "2.5x Macro of Custom Koerner Chair & Riser Step-Light", eye: [-1.35, 6.35, 1.38], target: [-0.28, 7.45, 0.92], vfov_deg: 27.0 },
  { id: "12", title: "2.5x Macro of Balcony Oak Fascia, Guardrail & Stage Planks", eye: [-5.2, 4.6, 4.35], target: [-8.6, 1.5, 3.85], vfov_deg: 28.0 },
];

// Curated Stage-Fortepiano Inspection Presets in 1780 Stein-Schule local coordinates (lx, ly, lz)
// Transformed to Koerner Hall Three.js world space via (0.84 + lz, 0.96 + ly, 3.65 - lx)
export const PIANO_STAGE_PRESETS = {
  bentside: {
    key: "bentside",
    label: "Bentside",
    localPos: [1.80, 1.28, 1.02],
    localTarget: [-0.04, 0.78, -0.82],
    fov: 35.0,
  },
  pianist: {
    key: "pianist",
    label: "Klaviatur",
    localPos: [0.00, 1.18, 0.54],
    localTarget: [0.00, 0.75, -0.26],
    fov: 41.0,
  },
  harp: {
    key: "harp",
    label: "Soundboard",
    localPos: [1.08, 1.48, -0.34],
    localTarget: [-0.04, 0.83, -0.94],
    fov: 36.5,
  },
  action: {
    key: "action",
    label: "Prellmechanik",
    localPos: [0.62, 0.98, 0.48],
    localTarget: [0.05, 0.76, -0.14],
    fov: 31.5,
  },
  hall_view: {
    key: "hall_view",
    label: "Stage \u2192 Hall",
    localPos: [-0.82, 1.42, 1.54],
    localTarget: [0.75, 0.88, -0.72],
    fov: 43.0,
  },
};

function pianoLocalArrToWorld(arr, target = new THREE.Vector3()) {
  return target.set(0.84 + arr[2], 0.96 + arr[1], 3.65 - arr[0]);
}

export function blenderToThreeVec3(bx, by, bz, target = new THREE.Vector3()) {
  return target.set(bx, bz, -by);
}

export function threeToBlenderObj(vec3) {
  return { x: vec3.x, y: -vec3.z, z: vec3.y };
}

export function focalLengthToVerticalFov(focalMm, aspect = 1.6, matchBlenderAutoSensor = false) {
  if (matchBlenderAutoSensor) {
    const sensorWidth = 36.0;
    const effectiveHeight = aspect >= 1.0 ? sensorWidth / aspect : sensorWidth;
    return 2.0 * Math.atan(effectiveHeight / (2.0 * focalMm)) * RAD2DEG;
  }
  return 2.0 * Math.atan(24.0 / (2.0 * focalMm)) * RAD2DEG;
}

export function verticalFovToFocalLength(vfovDeg) {
  const halfRad = (vfovDeg * DEG2RAD) * 0.5;
  return 12.0 / Math.max(1e-4, Math.tan(halfRad));
}

export class KoernerCameraController {
  constructor(camera, domElement, options = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.onSeatChange = options.onSeatChange || (() => {});
    this.onModeChange = options.onModeChange || (() => {});
    this.onLensChange = options.onLensChange || (() => {});
    this.onPianoPresetChange = options.onPianoPresetChange || (() => {});
    this.onPoseTransition = options.onPoseTransition || null;
    this.onUserActivity = options.onUserActivity || (() => {});
    this.getFloorHeightAt = options.getFloorHeightAt || null;

    this.seats = [];
    this.seatById = new Map();
    this.rowsByTier = new Map();
    this.stageTargetBlender = { x: 0.0, y: -3.2, z: 1.35 };
    this.benchmarkCameras = new Map();

    this._yawBasisMode = "auto";
    this._hasInitializedPose = false;

    this.mode = "seated"; // "seated" | "piano" | "walk" | "orbit" | "benchmark"
    this.activeSeat = null;
    this.lastSeat = null;
    this.activeBenchmarkId = null;
    this.activePianoPreset = "bentside";

    // Seated head-turn offsets (degrees)
    this.headYawOffsetDeg = 0.0;
    this.headPitchOffsetDeg = 0.0;
    this._baseYawRad = Math.PI;
    this._basePitchRad = 0.0;

    // Smooth camera glide state (seat <-> seat, seat <-> piano, piano preset <-> preset)
    this._glideActive = false;
    this._glideElapsed = 0.0;
    this._glideDuration = 0.45;
    this._glideStartPos = new THREE.Vector3();
    this._glideEndPos = new THREE.Vector3();
    this._glideStartQuat = new THREE.Quaternion();
    this._glideEndQuat = new THREE.Quaternion();
    this._glideStartFov = 27.0;
    this._glideEndFov = 27.0;

    // Stage Piano spherical orbit & pan state
    this.pianoTarget = new THREE.Vector3(0.12, 1.84, 3.69);
    this.pianoRadius = 3.40;
    this.pianoTheta = 0.0;
    this.pianoPhi = 1.35;
    this.suppressPointerDrag = false;

    // Walk mode state (1.68 m standing eye height)
    this.walkStandingEyeM = 1.68;
    this.walkPos = new THREE.Vector3(0, 1.68, -8.5);
    this.walkYawRad = Math.PI;
    this.walkPitchRad = -0.04;
    this._keysDown = new Set();

    // Hall-wide Orbit mode state
    this.orbitTarget = new THREE.Vector3(0, 2.2, 2.0);
    this.orbitRadius = 16.0;
    this.orbitTheta = Math.PI;
    this.orbitPhi = 1.18;

    // Lens state
    this.currentFocalMm = 50;
    this.explicitFovOverrideDeg = null;

    // Pointer drag tracking
    this._pointerDown = false;
    this._pointerButton = 0;
    this._pointerId = null;
    this._downX = 0;
    this._downY = 0;
    this._lastX = 0;
    this._lastY = 0;
    this.wasDragGesture = false;

    this._eulerTmp = new THREE.Euler(0, 0, 0, "YXZ");
    this._vecTmp = new THREE.Vector3();
    this._rightTmp = new THREE.Vector3();
    this._upTmp = new THREE.Vector3();
    this._lookMatTmp = new THREE.Matrix4();

    this._bindEvents();
    this.applyFocalLength(50);
  }

  setManifestData(manifest, dimensions) {
    this.seats = Array.isArray(manifest?.seats) ? manifest.seats : [];
    this.seatById.clear();
    this.rowsByTier.clear();

    if (manifest?.stage_targets?.soloist_piano) {
      const sp = manifest.stage_targets.soloist_piano;
      this.stageTargetBlender = {
        x: Number(sp.x ?? sp[0] ?? 0),
        y: Number(sp.y ?? sp[1] ?? -3.2),
        z: Number(sp.z ?? sp[2] ?? 1.35),
      };
    } else if (dimensions?.stage_targets?.soloist_piano) {
      const sp = dimensions.stage_targets.soloist_piano;
      this.stageTargetBlender = {
        x: Number(sp.x ?? sp[0] ?? 0),
        y: Number(sp.y ?? sp[1] ?? -3.2),
        z: Number(sp.z ?? sp[2] ?? 1.35),
      };
    }

    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      s._index = i;
      if (s.id) this.seatById.set(String(s.id).toUpperCase(), s);
      if (s.short_id) this.seatById.set(String(s.short_id).toUpperCase(), s);

      const tierPrefix = this._tierPrefix(s.tier);
      const compact = `${tierPrefix}-${String(s.row).toUpperCase()}-${s.seat_number}`;
      if (!this.seatById.has(compact)) {
        this.seatById.set(compact, s);
      }

      const tierKey = s.tier || "Orchestra";
      if (!this.rowsByTier.has(tierKey)) this.rowsByTier.set(tierKey, new Map());
      const tierMap = this.rowsByTier.get(tierKey);
      const rowKey = String(s.row);
      if (!tierMap.has(rowKey)) tierMap.set(rowKey, []);
      tierMap.get(rowKey).push(s);
    }

    for (const [, tierMap] of this.rowsByTier) {
      for (const [, rowSeats] of tierMap) {
        rowSeats.sort((a, b) => Number(a.x) - Number(b.x));
      }
    }

    this._yawBasisMode = "negY_negLeft";

    this.benchmarkCameras.clear();
    for (const d of DEFAULT_BENCHMARK_STATIONS) {
      this.benchmarkCameras.set(d.id, { ...d });
    }
    const rawCams =
      dimensions?.benchmark_cameras ||
      manifest?.benchmark_cameras ||
      dimensions?.stations ||
      null;
    if (rawCams) {
      if (Array.isArray(rawCams)) {
        rawCams.forEach((c, idx) => {
          if (!c || typeof c !== "object") return;
          const rawId = String(c.id ?? c.station ?? c.cam ?? idx + 1);
          const cid = rawId.match(/^\d+$/) ? rawId.padStart(2, "0") : rawId.slice(-2).padStart(2, "0");
          const prev = this.benchmarkCameras.get(cid) || {};
          this.benchmarkCameras.set(cid, { ...prev, ...c });
        });
      } else if (typeof rawCams === "object") {
        for (const [k, c] of Object.entries(rawCams)) {
          if (!c || typeof c !== "object") continue;
          const numMatch = String(k).match(/(\d+)/);
          const cid = numMatch ? numMatch[1].padStart(2, "0") : String(k);
          const prev = this.benchmarkCameras.get(cid) || {};
          this.benchmarkCameras.set(cid, { ...prev, ...c });
        }
      }
    }
  }

  _tierPrefix(tier) {
    const t = String(tier || "").toLowerCase();
    if (t.includes("lower")) return "LBAL";
    if (t.includes("upper")) return "UBAL";
    if (t.includes("choir")) return "CHOIR";
    return "ORCH";
  }

  getSeatForwardBlender(seat) {
    let fx = this.stageTargetBlender.x - seat.x;
    let fy = this.stageTargetBlender.y - seat.y;
    const horizDist = Math.hypot(fx, fy) || 1.0;

    if (Number.isFinite(seat.yaw_deg) && this._yawBasisMode !== "target_vector") {
      const rad = seat.yaw_deg * DEG2RAD;
      if (this._yawBasisMode === "blender_atan2") {
        fx = Math.cos(rad);
        fy = Math.sin(rad);
      } else if (this._yawBasisMode === "negY_posLeft") {
        fx = -Math.sin(rad);
        fy = -Math.cos(rad);
      } else if (this._yawBasisMode === "negY_negLeft") {
        fx = Math.sin(rad);
        fy = -Math.cos(rad);
      }
    } else {
      fx /= horizDist;
      fy /= horizDist;
    }

    const eyeZ = Number.isFinite(seat.z_eye) ? seat.z_eye : seat.z_riser + 1.12;
    const pitchRad = Number.isFinite(seat.pitch_deg)
      ? seat.pitch_deg * DEG2RAD
      : Math.atan2(this.stageTargetBlender.z - eyeZ, horizDist);

    const cosP = Math.cos(pitchRad);
    return {
      fx: fx * cosP,
      fy: fy * cosP,
      fz: Math.sin(pitchRad),
      horizX: fx,
      horizY: fy,
      pitchRad,
    };
  }

  computeSeatCameraPoseThree(seat, forwardOffsetM = 0.12) {
    const eyeZ = Number.isFinite(seat.z_eye) ? seat.z_eye : seat.z_riser + 1.12;
    const fwd = this.getSeatForwardBlender(seat);

    const bx = seat.x + fwd.horizX * forwardOffsetM;
    const by = seat.y + fwd.horizY * forwardOffsetM;
    const bz = eyeZ;

    const posThree = blenderToThreeVec3(bx, by, bz);
    const dirThree = new THREE.Vector3(fwd.fx, fwd.fz, -fwd.fy).normalize();
    const yawRad = Math.atan2(-dirThree.x, -dirThree.z);
    const pitchRad = Math.asin(Math.max(-0.999, Math.min(0.999, dirThree.y)));

    return { posThree, yawRad, pitchRad };
  }

  findSeat(query) {
    if (!query || this.seats.length === 0) return null;
    const key = String(query).trim().toUpperCase();
    if (this.seatById.has(key)) return this.seatById.get(key);
    const norm = key.replace(/[_\s]+/g, "-");
    if (this.seatById.has(norm)) return this.seatById.get(norm);
    return (
      this.seats.find(
        (s) =>
          String(s.id).toUpperCase().includes(norm) ||
          String(s.short_id || "").toUpperCase() === norm
      ) || null
    );
  }

  getDefaultHeroSeat() {
    if (this.seats.length === 0) return null;
    return (
      this.findSeat("ORCH-H-14") ||
      this.findSeat("ORCH-G-14") ||
      this.seats.find(
        (s) => s.tier === "Orchestra" && (s.row === "H" || s.row === "G") && Math.abs(s.x) < 1.5
      ) ||
      this.seats.find((s) => s.tier === "Orchestra" && Math.abs(s.x) < 1.5) ||
      this.seats[0]
    );
  }

  /**
   * Sit in any of the 1,135 auditorium seats (gliding smoothly from another seat OR from stage!).
   */
  sitInSeat(seat, { immediate = false, yawOffsetDeg = 0, pitchOffsetDeg = 0 } = {}) {
    if (!seat) return;
    this.activeSeat = seat;
    this.lastSeat = seat;
    this.activeBenchmarkId = null;
    this.mode = "seated";

    const pose = this.computeSeatCameraPoseThree(seat, 0.12);
    this._baseYawRad = pose.yawRad;
    this._basePitchRad = pose.pitchRad;
    this.headYawOffsetDeg = Math.max(-165, Math.min(165, yawOffsetDeg));
    this.headPitchOffsetDeg = Math.max(-60, Math.min(80, pitchOffsetDeg));

    const targetQuat = this._computeSeatedQuaternion();
    const targetFov =
      this.explicitFovOverrideDeg !== null
        ? this.explicitFovOverrideDeg
        : focalLengthToVerticalFov(this.currentFocalMm, this.camera.aspect || 1.6, false);

    const isImmediate = Boolean(immediate || !this._hasInitializedPose);
    if (isImmediate) {
      this._hasInitializedPose = true;
      this._glideActive = false;
      this.camera.position.copy(pose.posThree);
      this.camera.quaternion.copy(targetQuat);
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld(true);
    } else {
      this._glideActive = true;
      this._glideElapsed = 0.0;
      this._glideStartWallMs = performance.now();
      const dist = this.camera.position.distanceTo(pose.posThree);
      this._glideDuration = Math.min(0.84, Math.max(0.42, 0.34 + dist * 0.017));
      this._glideStartPos.copy(this.camera.position);
      this._glideEndPos.copy(pose.posThree);
      this._glideStartQuat.copy(this.camera.quaternion);
      this._glideEndQuat.copy(targetQuat);
      this._glideStartFov = this.camera.fov;
      this._glideEndFov = targetFov;
    }

    if (this.onPoseTransition) {
      this.onPoseTransition({
        endPos: pose.posThree,
        endQuat: targetQuat,
        activeSeat: seat,
        immediate: isImmediate,
        durationSec: isImmediate ? 0.0 : Math.max(0.68, this._glideDuration * 1.12),
      });
    }

    this.onLensChange(`${Math.round(this.currentFocalMm)}mm`);
    this.onSeatChange(seat);
    this.onModeChange(this.mode);
  }

  /**
   * Glide onto the concert stage and enter interactive 360° Steinway D-274 navigation mode!
   */
  focusPiano(presetKey = "bentside", { immediate = false } = {}) {
    const preset = PIANO_STAGE_PRESETS[presetKey] || PIANO_STAGE_PRESETS.bentside;
    if (this.activeSeat) {
      this.lastSeat = this.activeSeat;
    }
    this.activeSeat = null;
    this.activeBenchmarkId = null;
    this.mode = "piano";
    this.activePianoPreset = preset.key;

    const endPos = pianoLocalArrToWorld(preset.localPos);
    const endTarget = pianoLocalArrToWorld(preset.localTarget);

    this.pianoTarget.copy(endTarget);
    const offset = this._vecTmp.copy(endPos).sub(endTarget);
    this.pianoRadius = Math.max(0.48, Math.min(7.5, offset.length() || 2.8));
    this.pianoPhi = Math.acos(Math.max(-0.98, Math.min(0.98, offset.y / this.pianoRadius)));
    this.pianoTheta = Math.atan2(offset.x, offset.z);

    this._lookMatTmp.lookAt(endPos, endTarget, new THREE.Vector3(0, 1, 0));
    const endQuat = new THREE.Quaternion().setFromRotationMatrix(this._lookMatTmp);
    const endFov = preset.fov;

    const isImmediate = Boolean(immediate || !this._hasInitializedPose);
    if (isImmediate) {
      this._hasInitializedPose = true;
      this._glideActive = false;
      this.camera.position.copy(endPos);
      this.camera.quaternion.copy(endQuat);
      this.camera.fov = endFov;
      this.camera.updateProjectionMatrix();
      this.camera.updateMatrixWorld(true);
    } else {
      this._glideActive = true;
      this._glideElapsed = 0.0;
      this._glideStartWallMs = performance.now();
      const dist = this.camera.position.distanceTo(endPos);
      this._glideDuration = Math.min(0.84, Math.max(0.44, 0.36 + dist * 0.017));
      this._glideStartPos.copy(this.camera.position);
      this._glideEndPos.copy(endPos);
      this._glideStartQuat.copy(this.camera.quaternion);
      this._glideEndQuat.copy(endQuat);
      this._glideStartFov = this.camera.fov;
      this._glideEndFov = endFov;
    }

    if (this.onPoseTransition) {
      this.onPoseTransition({
        endPos,
        endQuat,
        activeSeat: null,
        immediate: isImmediate,
        durationSec: isImmediate ? 0.0 : Math.max(0.68, this._glideDuration * 1.12),
      });
    }

    const eqFocal = Math.round(verticalFovToFocalLength(endFov));
    this.onLensChange(`${eqFocal}mm`);
    this.onSeatChange(null);
    this.onPianoPresetChange(this.activePianoPreset);
    this.onModeChange("piano");
  }

  get isGliding() {
    return this._glideActive;
  }

  returnToLastSeat() {
    const target = this.lastSeat || this.getDefaultHeroSeat();
    if (target) {
      this.sitInSeat(target, { immediate: false });
    }
  }

  snapToBenchmarkStation(camIdRaw) {
    const cid = String(camIdRaw).replace(/^cam/i, "").padStart(2, "0");
    const camDef = this.benchmarkCameras.get(cid);
    this.activeBenchmarkId = cid;
    this.mode = "benchmark";
    this._glideActive = false;
    this._hasInitializedPose = true;

    if (!camDef) {
      const fallback = this.getDefaultHeroSeat();
      if (fallback) this.sitInSeat(fallback, { immediate: true });
      return false;
    }

    if (camDef.seat_id) {
      const matched = this.findSeat(camDef.seat_id);
      if (matched) {
        this.activeSeat = matched;
        this.lastSeat = matched;
      }
    } else {
      this.activeSeat = null;
    }

    const rawEye = camDef.eye || camDef.location || camDef.pos || camDef.position;
    const rawTarget = camDef.target || camDef.look_at || camDef.lookAt;

    if (rawEye) {
      const ex = Number(rawEye.x ?? rawEye[0] ?? 0);
      const ey = Number(rawEye.y ?? rawEye[1] ?? 8);
      const ez = Number(rawEye.z ?? rawEye[2] ?? 2);
      blenderToThreeVec3(ex, ey, ez, this.camera.position);
    } else if (this.activeSeat) {
      const eyeZ = Number.isFinite(this.activeSeat.z_eye)
        ? this.activeSeat.z_eye
        : this.activeSeat.z_riser + 1.12;
      blenderToThreeVec3(this.activeSeat.x, this.activeSeat.y, eyeZ, this.camera.position);
    }

    if (rawTarget) {
      const tx = Number(rawTarget.x ?? rawTarget[0] ?? 0);
      const ty = Number(rawTarget.y ?? rawTarget[1] ?? -3.5);
      const tz = Number(rawTarget.z ?? rawTarget[2] ?? 1.4);
      const targetThree = blenderToThreeVec3(tx, ty, tz);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(targetThree);
    } else if (Array.isArray(camDef.rotation_euler_deg) || Array.isArray(camDef.rotation_euler)) {
      const rot = camDef.rotation_euler_deg
        ? camDef.rotation_euler_deg.map((d) => d * DEG2RAD)
        : camDef.rotation_euler;
      const eBlender = new THREE.Euler(rot[0], rot[1], rot[2], "XYZ");
      const qBlender = new THREE.Quaternion().setFromEuler(eBlender);
      const qBasis = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        -Math.PI / 2
      );
      this.camera.quaternion.multiplyQuaternions(qBasis, qBlender);
    }

    const aspect = this.camera.aspect || 1.6;
    if (Number.isFinite(camDef.vfov_deg)) {
      this.camera.fov = Number(camDef.vfov_deg);
    } else if (Number.isFinite(camDef.fov_deg) || Number.isFinite(camDef.fov)) {
      this.camera.fov = Number(camDef.fov_deg ?? camDef.fov);
    } else if (Number.isFinite(camDef.focal_mm) || Number.isFinite(camDef.lens_mm) || Number.isFinite(camDef.lens)) {
      const lensMm = Number(camDef.focal_mm ?? camDef.lens_mm ?? camDef.lens);
      this.camera.fov = focalLengthToVerticalFov(lensMm, aspect, false);
    } else if (Number.isFinite(camDef.hfov_deg)) {
      const hRad = Number(camDef.hfov_deg) * DEG2RAD;
      this.camera.fov = 2.0 * Math.atan(Math.tan(hRad * 0.5) / aspect) * RAD2DEG;
    }

    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    this._eulerTmp.setFromQuaternion(this.camera.quaternion, "YXZ");
    this._baseYawRad = this._eulerTmp.y;
    this._basePitchRad = this._eulerTmp.x;
    this.headYawOffsetDeg = 0;
    this.headPitchOffsetDeg = 0;

    if (this.onPoseTransition) {
      this.onPoseTransition({
        endPos: this.camera.position,
        endQuat: this.camera.quaternion,
        activeSeat: this.activeSeat,
        immediate: true,
        durationSec: 0.0,
      });
    }

    if (this.activeSeat) this.onSeatChange(this.activeSeat);
    this.onModeChange("seated");
    return true;
  }

  _computeSeatedQuaternion() {
    const totalYaw = this._baseYawRad + this.headYawOffsetDeg * DEG2RAD;
    const rawPitch = this._basePitchRad + this.headPitchOffsetDeg * DEG2RAD;
    const clampedPitch = Math.max(-62 * DEG2RAD, Math.min(82 * DEG2RAD, rawPitch));
    this._eulerTmp.set(clampedPitch, totalYaw, 0, "YXZ");
    return new THREE.Quaternion().setFromEuler(this._eulerTmp);
  }

  setMode(newMode) {
    if (newMode === "piano") {
      this.focusPiano(this.activePianoPreset || "bentside", { immediate: false });
      return;
    }
    if (newMode === "walk") {
      if (this.activeSeat) this.lastSeat = this.activeSeat;
      this.mode = "walk";
      this._glideActive = false;
      this.walkPos.copy(this.camera.position);
      if (this.activeSeat) {
        this.walkPos.y = this.activeSeat.z_riser + this.walkStandingEyeM;
      } else if (this.getFloorHeightAt) {
        const fh = this.getFloorHeightAt(this.walkPos.x, this.walkPos.y, this.walkPos.z);
        if (Number.isFinite(fh)) this.walkPos.y = fh + this.walkStandingEyeM;
      }
      this._eulerTmp.setFromQuaternion(this.camera.quaternion, "YXZ");
      this.walkYawRad = this._eulerTmp.y;
      this.walkPitchRad = this._eulerTmp.x;
      this.camera.position.copy(this.walkPos);
      this.onModeChange("walk");
    } else if (newMode === "orbit") {
      this.mode = "orbit";
      this._glideActive = false;
      const offset = this._vecTmp.copy(this.camera.position).sub(this.orbitTarget);
      this.orbitRadius = Math.max(3.0, Math.min(32.0, offset.length() || 15.0));
      this.orbitPhi = Math.acos(Math.max(-0.98, Math.min(0.98, offset.y / this.orbitRadius)));
      this.orbitTheta = Math.atan2(offset.x, offset.z);
      this.onModeChange("orbit");
    } else {
      const target = this.activeSeat || this.lastSeat || this.getDefaultHeroSeat();
      if (target) {
        this.sitInSeat(target, { immediate: false });
      }
    }
  }

  cycleNavigationMode() {
    if (this.mode === "seated" || this.mode === "benchmark") {
      this.setMode("piano");
    } else if (this.mode === "piano") {
      this.setMode("walk");
    } else {
      this.setMode("seated");
    }
  }

  applyFocalLength(focalMm) {
    this.explicitFovOverrideDeg = null;
    this.currentFocalMm = Math.max(28, Math.min(55, focalMm));
    this.camera.fov = focalLengthToVerticalFov(this.currentFocalMm, this.camera.aspect || 1.6, false);
    this.camera.updateProjectionMatrix();
    this.onLensChange(`${Math.round(this.currentFocalMm)}mm`);
  }

  applyExplicitFovDeg(vfovDeg) {
    this.explicitFovOverrideDeg = Number(vfovDeg);
    this.camera.fov = this.explicitFovOverrideDeg;
    this.camera.updateProjectionMatrix();
    this.currentFocalMm = Math.round(verticalFovToFocalLength(this.explicitFovOverrideDeg));
    this.onLensChange(`${this.currentFocalMm}mm`);
  }

  toggleLensPreset() {
    const next = Math.abs(this.currentFocalMm - 50) <= 5 ? 32 : 50;
    this.applyFocalLength(next);
  }

  stepAdjacentSeat(deltaSeat, deltaRow) {
    if (this.mode === "piano") return;
    const refSeat = this.activeSeat || this.lastSeat;
    if (!refSeat || this.seats.length === 0) return;
    const tierMap = this.rowsByTier.get(refSeat.tier);
    if (!tierMap) return;

    if (deltaSeat !== 0) {
      const rowSeats = tierMap.get(String(refSeat.row)) || [];
      const idx = rowSeats.indexOf(refSeat);
      if (idx >= 0) {
        const nextIdx = Math.max(0, Math.min(rowSeats.length - 1, idx + deltaSeat));
        if (rowSeats[nextIdx] && rowSeats[nextIdx] !== refSeat) {
          this.sitInSeat(rowSeats[nextIdx]);
        }
      }
      return;
    }

    if (deltaRow !== 0) {
      const stageX = this.stageTargetBlender.x;
      const stageY = this.stageTargetBlender.y;
      const rowEntries = [];
      for (const [rKey, rList] of tierMap.entries()) {
        if (rList.length === 0) continue;
        let sumDist = 0;
        for (const s of rList) sumDist += Math.hypot(s.x - stageX, s.y - stageY);
        rowEntries.push({ rowKey: rKey, seats: rList, avgDist: sumDist / rList.length });
      }
      rowEntries.sort((a, b) => a.avgDist - b.avgDist);
      const curRowIdx = rowEntries.findIndex((e) => e.rowKey === String(refSeat.row));
      if (curRowIdx < 0) return;
      const targetRowIdx = Math.max(0, Math.min(rowEntries.length - 1, curRowIdx + deltaRow));
      if (targetRowIdx === curRowIdx) return;
      const candidateSeats = rowEntries[targetRowIdx].seats;
      let best = candidateSeats[0];
      let bestDistSq = Infinity;
      for (const c of candidateSeats) {
        const dSq = (c.x - refSeat.x) ** 2 + (c.y - refSeat.y) ** 2;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          best = c;
        }
      }
      if (best) this.sitInSeat(best);
    }
  }

  update(dt) {
    const clampedDt = Math.min(0.05, Math.max(0.0, dt));

    if (this._glideActive && (this.mode === "seated" || this.mode === "piano")) {
      this._glideElapsed = Math.max(0.0, (performance.now() - (this._glideStartWallMs || performance.now())) * 0.001);
      const rawT = Math.min(1.0, this._glideElapsed / this._glideDuration);
      const ease = 1.0 - Math.pow(1.0 - rawT, 4);
      this.camera.position.lerpVectors(this._glideStartPos, this._glideEndPos, ease);
      this.camera.quaternion.slerpQuaternions(this._glideStartQuat, this._glideEndQuat, ease);
      const nextFov = this._glideStartFov + (this._glideEndFov - this._glideStartFov) * ease;
      if (Math.abs(nextFov - this.camera.fov) > 1e-4) {
        this.camera.fov = nextFov;
        this.camera.updateProjectionMatrix();
      }
      if (rawT >= 1.0) {
        this._glideActive = false;
      }
      return;
    }

    if (this.mode === "seated") {
      if (this.activeSeat) {
        const q = this._computeSeatedQuaternion();
        this.camera.quaternion.copy(q);
      }
    } else if (this.mode === "piano") {
      const sinP = Math.sin(this.pianoPhi);
      let px = this.pianoTarget.x + this.pianoRadius * sinP * Math.sin(this.pianoTheta);
      let py = this.pianoTarget.y + this.pianoRadius * Math.cos(this.pianoPhi);
      let pz = this.pianoTarget.z + this.pianoRadius * sinP * Math.cos(this.pianoTheta);

      // Keep camera comfortably inside Koerner Hall walls & above the 0.96m stage deck
      px = Math.max(-9.6, Math.min(9.6, px));
      pz = Math.max(-21.5, Math.min(13.0, pz));
      const minFloorY = pz > 0.2 ? 1.12 : 0.45;
      if (py < minFloorY) py = minFloorY;

      this.camera.position.set(px, py, pz);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.pianoTarget);
    } else if (this.mode === "walk") {
      const moveSpeed = this._keysDown.has("ShiftLeft") || this._keysDown.has("ShiftRight") ? 6.2 : 3.4;
      let fwd = 0;
      let strafe = 0;
      if (this._keysDown.has("KeyW")) fwd += 1;
      if (this._keysDown.has("KeyS")) fwd -= 1;
      if (this._keysDown.has("KeyD")) strafe += 1;
      if (this._keysDown.has("KeyA")) strafe -= 1;

      if (fwd !== 0 || strafe !== 0) {
        const len = Math.hypot(fwd, strafe);
        fwd /= len;
        strafe /= len;
        const sinY = Math.sin(this.walkYawRad);
        const cosY = Math.cos(this.walkYawRad);
        const dx = (-sinY * fwd + cosY * strafe) * moveSpeed * clampedDt;
        const dz = (-cosY * fwd - sinY * strafe) * moveSpeed * clampedDt;
        this.walkPos.x = Math.max(-13.5, Math.min(13.5, this.walkPos.x + dx));
        this.walkPos.z = Math.max(-29.0, Math.min(17.5, this.walkPos.z + dz));

        if (this.getFloorHeightAt) {
          const floorY = this.getFloorHeightAt(this.walkPos.x, this.walkPos.y, this.walkPos.z);
          if (Number.isFinite(floorY)) {
            const targetEyeY = floorY + this.walkStandingEyeM;
            this.walkPos.y += (targetEyeY - this.walkPos.y) * Math.min(1.0, clampedDt * 12.0);
          }
        }
        this.onUserActivity();
      }
      this.camera.position.copy(this.walkPos);
      this._eulerTmp.set(this.walkPitchRad, this.walkYawRad, 0, "YXZ");
      this.camera.quaternion.setFromEuler(this._eulerTmp);
    } else if (this.mode === "orbit") {
      const sinP = Math.sin(this.orbitPhi);
      this.camera.position.set(
        this.orbitTarget.x + this.orbitRadius * sinP * Math.sin(this.orbitTheta),
        this.orbitTarget.y + this.orbitRadius * Math.cos(this.orbitPhi),
        this.orbitTarget.z + this.orbitRadius * sinP * Math.cos(this.orbitTheta)
      );
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.orbitTarget);
    }
  }

  _bindEvents() {
    this.domElement.addEventListener("contextmenu", (e) => {
      if (this.mode === "piano") e.preventDefault();
    });

    this.domElement.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && !(this.mode === "piano" && e.button === 2)) return;
      this._pointerDown = true;
      this._pointerButton = e.button;
      this._pointerId = e.pointerId;
      this._downX = e.clientX;
      this._downY = e.clientY;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      this.wasDragGesture = false;
      this.domElement.classList.add("dragging");
      try {
        this.domElement.setPointerCapture(e.pointerId);
      } catch (_) {}
      this.onUserActivity();
    });

    this.domElement.addEventListener("pointermove", (e) => {
      this.onUserActivity();
      if (!this._pointerDown || e.pointerId !== this._pointerId) return;
      const dx = e.clientX - this._lastX;
      const dy = e.clientY - this._lastY;
      this._lastX = e.clientX;
      this._lastY = e.clientY;

      if (Math.hypot(e.clientX - this._downX, e.clientY - this._downY) > 4.5) {
        this.wasDragGesture = true;
      }

      if (this.suppressPointerDrag) return;

      if (this.mode === "benchmark") {
        this.mode = "seated";
      }

      const sensitivity = (this.camera.fov / 40.0) * 0.16;
      if (this.mode === "seated") {
        this._glideActive = false;
        this.headYawOffsetDeg = Math.max(-165, Math.min(165, this.headYawOffsetDeg - dx * sensitivity));
        this.headPitchOffsetDeg = Math.max(-60, Math.min(80, this.headPitchOffsetDeg - dy * sensitivity));
      } else if (this.mode === "piano") {
        this._glideActive = false;
        if (this._pointerButton === 2 || e.shiftKey) {
          // Pan target across the 2.74m Steinway on stage
          const panScale = Math.max(0.0008, this.pianoRadius * 0.0011);
          this._rightTmp.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
          this._upTmp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
          this.pianoTarget.addScaledVector(this._rightTmp, -dx * panScale);
          this.pianoTarget.addScaledVector(this._upTmp, dy * panScale);
          this.pianoTarget.x = Math.max(-2.4, Math.min(2.4, this.pianoTarget.x));
          this.pianoTarget.y = Math.max(1.10, Math.min(2.65, this.pianoTarget.y));
          this.pianoTarget.z = Math.max(2.00, Math.min(5.20, this.pianoTarget.z));
        } else {
          this.pianoTheta -= dx * 0.0055;
          this.pianoPhi = Math.max(0.14, Math.min(Math.PI * 0.64, this.pianoPhi - dy * 0.0052));
        }
      } else if (this.mode === "walk") {
        this.walkYawRad -= dx * sensitivity * DEG2RAD;
        this.walkPitchRad = Math.max(
          -75 * DEG2RAD,
          Math.min(82 * DEG2RAD, this.walkPitchRad - dy * sensitivity * DEG2RAD)
        );
      } else if (this.mode === "orbit") {
        this.orbitTheta -= dx * 0.005;
        this.orbitPhi = Math.max(0.12, Math.min(Math.PI - 0.12, this.orbitPhi - dy * 0.005));
      }
    });

    const endDrag = (e) => {
      if (this._pointerDown && e.pointerId === this._pointerId) {
        this._pointerDown = false;
        this._pointerId = null;
        this.suppressPointerDrag = false;
        this.domElement.classList.remove("dragging");
        try {
          this.domElement.releasePointerCapture(e.pointerId);
        } catch (_) {}
      }
    };
    this.domElement.addEventListener("pointerup", endDrag);
    this.domElement.addEventListener("pointercancel", endDrag);

    this.domElement.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.onUserActivity();
        if (this.mode === "piano") {
          this._glideActive = false;
          this.pianoRadius = Math.max(0.48, Math.min(7.5, this.pianoRadius + e.deltaY * 0.0028));
        } else if (this.mode === "orbit") {
          this.orbitRadius = Math.max(2.5, Math.min(34.0, this.orbitRadius + e.deltaY * 0.012));
        } else {
          const nextMm = this.currentFocalMm - Math.sign(e.deltaY) * 2.5;
          this.applyFocalLength(nextMm);
        }
      },
      { passive: false }
    );

    window.addEventListener("keydown", (e) => {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      this._keysDown.add(e.code);
      this.onUserActivity();

      if (e.key === "[" || e.key === "ArrowLeft") {
        if (this.mode !== "piano") {
          e.preventDefault();
          this.stepAdjacentSeat(-1, 0);
        }
      } else if (e.key === "]" || e.key === "ArrowRight") {
        if (this.mode !== "piano") {
          e.preventDefault();
          this.stepAdjacentSeat(1, 0);
        }
      } else if (e.key === "ArrowUp") {
        if (this.mode !== "piano") {
          e.preventDefault();
          this.stepAdjacentSeat(0, -1);
        }
      } else if (e.key === "ArrowDown") {
        if (this.mode !== "piano") {
          e.preventDefault();
          this.stepAdjacentSeat(0, 1);
        }
      } else if (e.code === "KeyP" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (this.mode === "piano") this.returnToLastSeat();
        else this.focusPiano("bentside");
      } else if (e.code === "KeyO" && !e.metaKey && !e.ctrlKey) {
        this.setMode(this.mode === "orbit" ? "seated" : "orbit");
      }
    });

    window.addEventListener("keyup", (e) => {
      this._keysDown.delete(e.code);
    });
  }
}
