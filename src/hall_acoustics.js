/**
 * Koerner Hall (RCM / KPMB / Sound Space Vision) — Real-Time 3D Room Acoustics Engine
 * & Synchronized 1780 Stein-Schule Historical Fortepiano Performance Controller.
 *
 * Models 6 physical seat- & orientation-dependent acoustic phenomena in Three.js Y-up space:
 *   1. Direct-Sound Inverse-Distance Law (0.9 m stage nearfield -> 28.5 m Upper Balcony)
 *   2. 1780 Fortepiano 48.5° Open Walnut Deckel Lid Directivity (+1.3 dB toward Orchestra/Balconies
 *      vs -5.2 dB solid walnut lid high-frequency shadow in the Choir Loft behind the spine)
 *   3. Architectural Under-Balcony Soffit Overhang Shadow (Rear Orchestra Rows P-U & Rear Lower Balcony)
 *   4. ISO 9613-1 Distance Air Absorption + Compact 2.10 m Spruce Soundboard Stereo Subtense (Mid/Side)
 *   5. Head-Tracked Binaural Azimuth Pan + Contralateral Head-Shadow ILD Shelving
 *   6. Zero-Doppler 4-Bank Silent-Latch Early Reflections (Left Wall, Right Wall, Baillie Oak Veil,
 *      Rear Balcony Fascia) + True Stereo 1.96s RT60 Koerner Hall Diffuse Impulse Convolver.
 */

import * as THREE from "three";
import { HISTORICAL_REPERTOIRE } from "./fortepiano_repertoire_data.js";
import {
  FORTEPIANO_MIN_MIDI,
  FORTEPIANO_MAX_MIDI,
  foldMidiIntoFortepianoCompass,
} from "./fortepiano_stage_rig.js";

const SPEED_OF_SOUND = 343.0; // m/s at 20 °C
const HEAD_RADIUS_M = 0.0875;
const SAMPLE_MIDIS = [24, 36, 43, 48, 52, 55, 60, 63, 67, 72, 76, 79, 84, 88, 91, 96];

// 1780 Stein-Schule Fortepiano acoustic radiation center in Koerner Hall Three.js world space:
// Anchor at (0.84, 0.96, 3.65), rotY = +PI/2 -> Haselfichte spruce soundboard centroid at (-0.08, 1.78, 3.65)
export const PIANO_ACOUSTIC_SOURCE = new THREE.Vector3(-0.08, 1.78, 3.65);

// 48.5° Open walnut Deckel lid primary specular projection axis (hinged on upstage spine z=+4.13, opening toward -Z house)
const LID_PROJECTION_AXIS = new THREE.Vector3(0.06, 0.22, -0.974).normalize();

// 1st-order Koerner Hall shoebox boundary planes for image-source early reflections:
const IMAGE_SOURCES = {
  leftWall: new THREE.Vector3(-21.6 - PIANO_ACOUSTIC_SOURCE.x, PIANO_ACOUSTIC_SOURCE.y, PIANO_ACOUSTIC_SOURCE.z),
  rightWall: new THREE.Vector3(21.6 - PIANO_ACOUSTIC_SOURCE.x, PIANO_ACOUSTIC_SOURCE.y, PIANO_ACOUSTIC_SOURCE.z),
  oakVeil: new THREE.Vector3(PIANO_ACOUSTIC_SOURCE.x, 21.2 - PIANO_ACOUSTIC_SOURCE.y, PIANO_ACOUSTIC_SOURCE.z),
  rearFascia: new THREE.Vector3(PIANO_ACOUSTIC_SOURCE.x, PIANO_ACOUSTIC_SOURCE.y + 1.2, -45.2 - PIANO_ACOUSTIC_SOURCE.z),
};

const PIECE_SHORT_LABELS = {
  alberti_op1_no5_fortepiano_cc_by4: "Alberti Op. 1/5 \u00B7 18th-c. Fortepiano (CC BY) \u25BE",
  dittersdorf_sonata_a_mvt1_walter1790: "Dittersdorf I. Allegro \u00B7 Walter 1790 (CC BY-SA) \u25BE",
  dittersdorf_sonata_a_mvt2_walter1790: "Dittersdorf II. Andante \u00B7 Walter 1790 (CC BY-SA) \u25BE",
  dittersdorf_sonata_a_mvt3_walter1790: "Dittersdorf III. Finale \u00B7 Walter 1790 (CC BY-SA) \u25BE",
  dittersdorf_hocus_pocus_ouverture_walter1790: "Dittersdorf Ouverture \u00B7 Walter 1790 (CC BY-SA) \u25BE",
};

export function getShortPieceLabel(piece) {
  if (!piece) return "Alberti Op. 1/5 \u00B7 18th-c. Fortepiano (CC BY)";
  return PIECE_SHORT_LABELS[piece.id] || piece.title || "Fortepiano";
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class KoernerHallAcousticsEngine {
  constructor() {
    this.ctx = null;
    this.graphReady = false;
    this.sourceBus = null;
    this.mediaElementSource = null;
    this.boundAudioEl = null;

    // Interactive 61-key Schloss Kremsegg historical fortepiano sample state
    this.sampleBuffers = new Map();
    this.samplesLoadingPromise = null;
    this.concertPitchHz = 425.0; // Classical Augsburg / Viennese Kammerton (A4 = 425 Hz)
    this.moderator = false;
    this.damperSustain = false; // Underside wooden Kniehebel knee-lever damper lift
    this.keysDown = new Set();
    this.activeVoices = new Map();

    // Scratch vectors for spatial evaluation
    this._toSource = new THREE.Vector3();
    this._camFwd = new THREE.Vector3();
    this._camRight = new THREE.Vector3();
    this._camUp = new THREE.Vector3();
    this._imgVec = new THREE.Vector3();

    // Analytical AudioParam knot trackers & silent-latch ER bank crossfade state
    // Guarantees DelayNode.delayTime is NEVER modulated while audible (zero Doppler / record-scratch!)
    this._paramKnots = new Map();
    this.erBanks = [];
    this._activeErBankIdx = 0;
    this._erAnchorPos = new THREE.Vector3(0.0, 1.55, -9.2);
    this._lastErCrossfadeTime = -10.0;
    this._glideTargetPos = new THREE.Vector3(0.0, 1.55, -9.2);
    this._glideTargetQuat = new THREE.Quaternion();
    this._glideWallEndMs = 0.0;

    this.lastMetrics = this.computeMetrics(
      new THREE.Vector3(0.0, 1.55, -9.2),
      new THREE.Quaternion(),
      null
    );
  }

  /**
   * Deterministically computes full Koerner Hall room-acoustic parameters for any 3D listener pose.
   */
  computeMetrics(listenerPos, listenerQuat, activeSeat = null) {
    this._toSource.copy(PIANO_ACOUSTIC_SOURCE).sub(listenerPos);
    const rawDist = this._toSource.length();
    const d = Math.max(0.80, rawDist);
    const dirToPiano = this._toSource.clone().divideScalar(Math.max(1e-5, rawDist));

    this._camFwd.set(0, 0, -1).applyQuaternion(listenerQuat).normalize();
    this._camRight.set(1, 0, 0).applyQuaternion(listenerQuat).normalize();
    this._camUp.set(0, 1, 0).applyQuaternion(listenerQuat).normalize();

    const rightDot = clamp(dirToPiano.dot(this._camRight), -1.0, 1.0);
    const fwdDot = clamp(dirToPiano.dot(this._camFwd), -1.0, 1.0);
    const azimuthRad = Math.atan2(rightDot, fwdDot);

    // 1. Direct-sound inverse-distance pressure gain (normalized around Orchestra Row G/H d_ref = 13.5m)
    const dRef = 13.5;
    const directGain = clamp(Math.pow(dRef / Math.max(1.15, d), 0.58), 0.45, 1.70);

    // 2. 1780 Fortepiano 48.5° open walnut Deckel lid radiation directivity
    const radDirX = -dirToPiano.x;
    const radDirY = -dirToPiano.y;
    const radDirZ = -dirToPiano.z;
    const lidAlign =
      radDirX * LID_PROJECTION_AXIS.x +
      radDirY * LID_PROJECTION_AXIS.y +
      radDirZ * LID_PROJECTION_AXIS.z;

    // Behind upstage straight walnut spine (z > +4.18m) the raised walnut lid shadows >1.8 kHz direct radiation
    let lidShadowFactor = 0.0;
    if (listenerPos.z > 4.18) {
      lidShadowFactor = clamp((listenerPos.z - 4.18) / 5.0, 0.0, 1.0);
    }
    let hfLidDb = 0.0;
    if (d < 2.8 && listenerPos.x > 0.55) {
      // Klaviatur nearfield: crisp Hirschleder buckskin hammer & bichord brass/iron immediacy
      hfLidDb = 1.75;
    } else if (lidShadowFactor > 0.01) {
      hfLidDb = -5.2 * lidShadowFactor + 0.45 * (1.0 - lidShadowFactor);
    } else {
      // Specular 48.5° walnut lid lobe toward Orchestra & Balconies
      hfLidDb = clamp(lidAlign * 1.50, -1.6, 1.40);
    }

    // 3. Architectural Under-Balcony Soffit Overhang Shadow
    let overhang = 0.0;
    if (listenerPos.y < 3.92 && listenerPos.z < -16.5) {
      overhang = clamp((-listenerPos.z - 16.5) / 5.6, 0.0, 1.0);
    } else if (listenerPos.y >= 3.92 && listenerPos.y < 7.95 && listenerPos.z < -18.8) {
      overhang = clamp((-listenerPos.z - 18.8) / 4.4, 0.0, 0.72);
    }

    // 4. Atmospheric Air Absorption (ISO 9613-1) + Overhang Grazing HF Roll-off
    const airCutoffHz = Math.round(
      clamp(
        20000.0 * Math.exp(-0.020 * Math.max(0.0, d - 1.3)) * (1.0 - 0.42 * overhang) * (1.0 - 0.15 * lidShadowFactor),
        6800.0,
        20000.0
      )
    );

    // 5. Compact 2.10m Spruce Soundboard Angular Subtense Stereo Width (Mid/Side) + Binaural ITD / ILD
    const stereoWidth = clamp(0.22 + 1.38 / Math.sqrt(Math.max(0.95, d)), 0.24, 1.24);
    const binauralPan = clamp(rightDot * clamp((d - 0.75) / 3.0, 0.25, 0.90), -0.90, 0.90);

    const absAz = Math.abs(azimuthRad);
    const woodworthSec =
      (HEAD_RADIUS_M / SPEED_OF_SOUND) * (Math.min(Math.PI * 0.5, absAz) + Math.sin(Math.min(Math.PI * 0.5, absAz)));
    const delayLeftSec = rightDot > 0 ? woodworthSec : 0.0;
    const delayRightSec = rightDot < 0 ? woodworthSec : 0.0;

    const rearPinnaDb = fwdDot < 0 ? fwdDot * 2.1 : 0.0;
    const leftHeadHighDb = (rightDot > 0 ? -3.1 * rightDot : 0.4 * -rightDot) + rearPinnaDb;
    const rightHeadHighDb = (rightDot < 0 ? -3.1 * -rightDot : 0.4 * rightDot) + rearPinnaDb;

    // 6. 1st-Order Image-Source Early Reflections (delays & gains)
    const propDelaySec = clamp(d / SPEED_OF_SOUND, 0.0024, 0.12);
    const calcTap = (imgPos, reflCoeff, extraAtten = 1.0) => {
      const imgDist = listenerPos.distanceTo(imgPos);
      const deltaM = Math.max(1.1, imgDist - d);
      const relDelaySec = clamp(deltaM / SPEED_OF_SOUND, 0.004, 0.185);
      const gain = clamp((dRef / Math.max(4.0, imgDist)) * reflCoeff * extraAtten, 0.02, 0.42);
      this._imgVec.copy(imgPos).sub(listenerPos).normalize();
      const pan = clamp(this._imgVec.dot(this._camRight) * 0.85, -0.88, 0.88);
      return { delaySec: relDelaySec, gain, pan };
    };

    const tapLeft = calcTap(IMAGE_SOURCES.leftWall, 0.25, 1.0 - 0.15 * overhang);
    const tapRight = calcTap(IMAGE_SOURCES.rightWall, 0.25, 1.0 - 0.15 * overhang);
    const tapVeil = calcTap(IMAGE_SOURCES.oakVeil, 0.31, 1.0 - 0.74 * overhang);
    const tapRear = calcTap(IMAGE_SOURCES.rearFascia, 0.16, 1.0);

    const itdgMs = Number(
      (Math.min(tapLeft.delaySec, tapRight.delaySec, tapVeil.delaySec) * 1000.0).toFixed(1)
    );

    // Diffuse Koerner Hall reverberant field (RT60 = 1.96s): slightly drier C80 clarity for crisp Viennese articulation
    const upperCanopyBoost = listenerPos.y > 7.5 ? 1.12 : 1.0;
    const reverbSendGain = clamp(0.43 * upperCanopyBoost * (1.0 - 0.34 * overhang), 0.17, 0.58);

    const earlyEnergy =
      directGain * directGain +
      tapLeft.gain * tapLeft.gain +
      tapRight.gain * tapRight.gain +
      tapVeil.gain * tapVeil.gain;
    const lateEnergy = Math.pow(reverbSendGain * 1.50, 2);
    const directToReverbDb = Number((10.0 * Math.log10((directGain * directGain) / Math.max(1e-5, lateEnergy))).toFixed(1));
    const clarityC80Db = Number((10.0 * Math.log10(earlyEnergy / Math.max(1e-5, lateEnergy))).toFixed(1));

    const tier = activeSeat?.tier || "";
    let zoneLabel = "Open Lid Axis";
    if (d < 4.0 && listenerPos.z > -0.5) {
      zoneLabel = d < 2.1 ? "Stage Nearfield" : "Stage Apron";
    } else if (lidShadowFactor > 0.25 || tier === "Choir Loft") {
      zoneLabel = "Choir \u00B7 Lid Shadow";
    } else if (overhang > 0.22) {
      zoneLabel = "Under-Balcony Soffit";
    } else if (Math.abs(listenerPos.x) > 6.8 && d > 7.0) {
      zoneLabel = "Side Loge Lateral";
    } else if (listenerPos.y > 8.2 || tier === "Upper Balcony") {
      zoneLabel = "Upper Canopy Bloom";
    } else if (listenerPos.y > 4.2 || tier === "Lower Balcony") {
      zoneLabel = "Balcony Panorama";
    } else if (d < 9.5) {
      zoneLabel = "Front Intimate Direct";
    } else {
      zoneLabel = "Orchestra Sweet Spot";
    }

    return {
      distanceM: Number(d.toFixed(1)),
      propDelaySec,
      directGain,
      hfLidDb: Number(hfLidDb.toFixed(1)),
      lidShadowFactor,
      overhang,
      overhangPct: Math.round(overhang * 100),
      airCutoffHz,
      stereoWidth,
      stereoWidthPct: Math.round(clamp((stereoWidth / 1.24) * 100, 18, 100)),
      binauralPan,
      delayLeftSec,
      delayRightSec,
      leftHeadHighDb,
      rightHeadHighDb,
      tapLeft,
      tapRight,
      tapVeil,
      tapRear,
      reverbSendGain,
      itdgMs,
      directToReverbDb,
      clarityC80Db,
      zoneLabel,
    };
  }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC({ latencyHint: "interactive" });
    this._buildSpatialGraph();
    return this.ctx;
  }

  async resumeNonBlocking() {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      await Promise.race([
        ctx.resume().catch(() => {}),
        new Promise((r) => setTimeout(r, 120)),
      ]);
    }
  }

  _buildKoernerImpulseResponse(durationSec = 2.25) {
    const sr = this.ctx.sampleRate || 44100;
    const len = Math.floor(sr * durationSec);
    const buf = this.ctx.createBuffer(2, len, sr);

    const kLow = -Math.log(1000.0) / 2.18;
    const kMid = -Math.log(1000.0) / 1.96;
    const kHigh = -Math.log(1000.0) / 1.26;

    for (let ch = 0; ch < 2; ch++) {
      const out = buf.getChannelData(ch);
      let seed = ch === 0 ? 0x9e3779b9 : 0x85ebca6b;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return (seed / 0xffffffff) * 2.0 - 1.0;
      };

      let lpLow = 0.0;
      let lpMid = 0.0;
      const preDelaySamples = Math.floor(sr * 0.016);
      for (let i = 0; i < len; i++) {
        if (i < preDelaySamples) {
          out[i] = 0.0;
          continue;
        }
        const t = (i - preDelaySamples) / sr;
        const buildUp = Math.min(1.0, (i - preDelaySamples) / (sr * 0.024));
        const w = rand();
        lpLow = lpLow * 0.955 + w * 0.045;
        lpMid = lpMid * 0.72 + w * 0.28;
        const bandLow = lpLow;
        const bandMid = lpMid - lpLow;
        const bandHigh = w - lpMid;

        const sample =
          bandLow * Math.exp(kLow * t) * 1.15 +
          bandMid * Math.exp(kMid * t) * 1.0 +
          bandHigh * Math.exp(kHigh * t) * 0.62;

        out[i] = sample * buildUp * 0.24;
      }
    }
    return buf;
  }

  _buildSpatialGraph() {
    if (this.graphReady || !this.ctx) return;
    const ctx = this.ctx;

    this.sourceBus = ctx.createGain();
    this.sourceBus.gain.value = 1.0;

    // --- A. PHASE-COHERENT DIRECT PATH (Zero DelayNodes = 0.00 cents Doppler / record-scratch!) ---
    const splitter = ctx.createChannelSplitter(2);
    this.sourceBus.connect(splitter);

    this.midSum = ctx.createGain();
    this.midSum.gain.value = 0.5;
    this.sideSub = ctx.createGain();
    this.sideSub.gain.value = 0.5;
    const invR = ctx.createGain();
    invR.gain.value = -1.0;

    splitter.connect(this.midSum, 0);
    splitter.connect(this.midSum, 1);
    splitter.connect(this.sideSub, 0);
    splitter.connect(invR, 1);
    invR.connect(this.sideSub);

    this.sideWidthGain = ctx.createGain();
    this.sideWidthGain.gain.value = 0.34;
    this.sideSub.connect(this.sideWidthGain);

    const dirL = ctx.createGain();
    const dirR = ctx.createGain();
    const negSide = ctx.createGain();
    negSide.gain.value = -1.0;
    this.sideWidthGain.connect(negSide);

    this.midSum.connect(dirL);
    this.sideWidthGain.connect(dirL);
    this.midSum.connect(dirR);
    negSide.connect(dirR);

    const directMerger = ctx.createChannelMerger(2);
    dirL.connect(directMerger, 0, 0);
    dirR.connect(directMerger, 0, 1);

    // 48.5° Walnut Deckel Lid Directivity High-Shelf (> 1.85 kHz silvery bichord overtones vs Choir Loft lid shadow)
    this.lidShelfFilter = ctx.createBiquadFilter();
    this.lidShelfFilter.type = "highshelf";
    this.lidShelfFilter.frequency.value = 1850.0;
    this.lidShelfFilter.gain.value = 0.9;

    // Thin Alpine Spruce (Haselfichte) Soundboard Presence Contour (~960 Hz singing register)
    this.spruceFormant = ctx.createBiquadFilter();
    this.spruceFormant.type = "peaking";
    this.spruceFormant.frequency.value = 960.0;
    this.spruceFormant.Q.value = 1.1;
    this.spruceFormant.gain.value = 0.85;

    // Walnut Korpus Nearfield / Choir Diffraction Low-Shelf (< 230 Hz)
    this.bodyLowShelf = ctx.createBiquadFilter();
    this.bodyLowShelf.type = "lowshelf";
    this.bodyLowShelf.frequency.value = 230.0;
    this.bodyLowShelf.gain.value = 0.35;

    // Atmospheric Air Absorption + Under-Balcony Overhang Lowpass
    this.airLowpass = ctx.createBiquadFilter();
    this.airLowpass.type = "lowpass";
    this.airLowpass.frequency.value = 16500.0;
    this.airLowpass.Q.value = 0.55;

    this.directGainNode = ctx.createGain();
    this.directGainNode.gain.value = 1.0;

    this.directPanner = ctx.createStereoPanner();
    this.directPanner.pan.value = 0.0;

    const earSplit = ctx.createChannelSplitter(2);
    this.earShadowL = ctx.createBiquadFilter();
    this.earShadowL.type = "highshelf";
    this.earShadowL.frequency.value = 2400.0;
    this.earShadowR = ctx.createBiquadFilter();
    this.earShadowR.type = "highshelf";
    this.earShadowR.frequency.value = 2400.0;
    const earMerge = ctx.createChannelMerger(2);

    directMerger.connect(this.lidShelfFilter);
    this.lidShelfFilter.connect(this.spruceFormant);
    this.spruceFormant.connect(this.bodyLowShelf);
    this.bodyLowShelf.connect(this.airLowpass);
    this.airLowpass.connect(this.directGainNode);
    this.directGainNode.connect(this.directPanner);
    this.directPanner.connect(earSplit);

    earSplit.connect(this.earShadowL, 0);
    this.earShadowL.connect(earMerge, 0, 0);

    earSplit.connect(this.earShadowR, 1);
    this.earShadowR.connect(earMerge, 0, 1);

    // --- B. 4-BANK SILENT-LATCH EARLY REFLECTION CROSSFADER ---
    // DelayNode.delayTime on any bank is ONLY ever set while that bank's masterGain is strictly 0.0,
    // then equal-power crossfaded (cos/sin) against the outgoing bank — 0% Doppler / record-scratch!
    const makeReflectionTap = (destBus, cutoffHz, warmBoostDb = 0.0) => {
      const delay = ctx.createDelay(0.25);
      delay.delayTime.value = 0.02;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = cutoffHz;
      lp.Q.value = 0.5;
      const eq = ctx.createBiquadFilter();
      eq.type = "peaking";
      eq.frequency.value = 410.0;
      eq.Q.value = 0.85;
      eq.gain.value = warmBoostDb;
      const gain = ctx.createGain();
      gain.gain.value = 0.12;
      const pan = ctx.createStereoPanner();
      this.midSum.connect(delay);
      delay.connect(eq);
      eq.connect(lp);
      lp.connect(gain);
      gain.connect(pan);
      pan.connect(destBus);
      return { delay, lp, gain, pan };
    };

    // --- C. KOERNER HALL DIFFUSE REVERBERATION CONVOLVER (RT60 = 1.96s) ---
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.40;

    const revHP = ctx.createBiquadFilter();
    revHP.type = "highpass";
    revHP.frequency.value = 115.0;
    revHP.Q.value = 0.65;

    // Keep bass/tenor bichord brass strings crisp & transparent inside Koerner Hall's 1.96s bloom
    const revClarityDip = ctx.createBiquadFilter();
    revClarityDip.type = "peaking";
    revClarityDip.frequency.value = 275.0;
    revClarityDip.Q.value = 0.9;
    revClarityDip.gain.value = -1.6;

    this.reverbAirLP = ctx.createBiquadFilter();
    this.reverbAirLP.type = "lowpass";
    this.reverbAirLP.frequency.value = 6000.0;

    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this._buildKoernerImpulseResponse(2.25);

    this.sourceBus.connect(this.reverbSend);
    this.reverbSend.connect(revHP);
    revHP.connect(revClarityDip);
    revClarityDip.connect(this.reverbAirLP);
    this.reverbAirLP.connect(this.convolver);

    // --- D. MASTER CONCERT HALL OUTPUT BUS (Transparent Soft Limiter) ---
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 1.08;

    this.erBanks = [];
    for (let i = 0; i < 4; i++) {
      const bankBus = ctx.createGain();
      const initGain = i === 0 ? 1.0 : 0.0;
      bankBus.gain.value = initGain;
      bankBus.connect(this.masterGain);
      this.erBanks.push({
        masterGain: bankBus,
        gainKnots: [[0.0, initGain]],
        left: makeReflectionTap(bankBus, 5000.0, 0.35),
        right: makeReflectionTap(bankBus, 5000.0, 0.35),
        veil: makeReflectionTap(bankBus, 6600.0, 1.75), // Signature warm laminated Baillie White-Oak Veil reflection
        rear: makeReflectionTap(bankBus, 4000.0, 0.5),
      });
    }
    this._activeErBankIdx = 0;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3.5;
    limiter.knee.value = 8.0;
    limiter.ratio.value = 6.0;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.18;

    earMerge.connect(this.masterGain);
    this.convolver.connect(this.masterGain);

    this.masterGain.connect(limiter);
    limiter.connect(ctx.destination);

    this.graphReady = true;
    this._applyImmediateMetrics(this.lastMetrics);
  }

  bindMediaElement(audioEl) {
    this.ensureContext();
    if (!this.ctx || !audioEl) return;
    if (this.boundAudioEl === audioEl && this.mediaElementSource) return;
    this.boundAudioEl = audioEl;
    this.mediaElementSource = this.ctx.createMediaElementSource(audioEl);
    this.mediaElementSource.connect(this.sourceBus);
  }

  _sampleKnots(knots, t) {
    if (!knots || knots.length === 0) return 0.0;
    if (t <= knots[0][0]) return knots[0][1];
    for (let i = 0; i < knots.length - 1; i++) {
      const t0 = knots[i][0];
      const t1 = knots[i + 1][0];
      if (t <= t1) {
        const span = Math.max(1e-6, t1 - t0);
        const u = clamp((t - t0) / span, 0.0, 1.0);
        return knots[i][1] + (knots[i + 1][1] - knots[i][1]) * u;
      }
    }
    return knots[knots.length - 1][1];
  }

  _holdParam(param, knots, now, fallbackVal) {
    const cur = knots && knots.length > 0 ? this._sampleKnots(knots, now) : fallbackVal;
    try {
      if (typeof param.cancelAndHoldAtTime === "function") {
        param.cancelAndHoldAtTime(now);
      } else {
        param.cancelScheduledValues(now);
      }
    } catch (_) {
      try {
        param.cancelScheduledValues(now);
      } catch (__) {}
    }
    param.setValueAtTime(cur, now);
    return cur;
  }

  _setParamImmediate(key, param, val, now) {
    try {
      param.cancelScheduledValues(now);
    } catch (_) {}
    param.setValueAtTime(val, now);
    this._paramKnots.set(key, [[now, val]]);
  }

  _scheduleSCurve(key, param, targetVal, now, durationSec, isLog = false) {
    const vStart = this._holdParam(param, this._paramKnots.get(key), now, param.value);
    const knots = [[now, vStart]];
    const steps = 8;
    const dur = Math.max(0.08, durationSec);
    const safeStart = Math.max(1e-4, vStart);
    const safeEnd = Math.max(1e-4, targetVal);
    for (let k = 1; k <= steps; k++) {
      const p = k / steps;
      const s = k === steps ? 1.0 : 0.5 - 0.5 * Math.cos(Math.PI * p);
      const t = now + p * dur;
      const v = isLog ? safeStart * Math.pow(safeEnd / safeStart, s) : vStart + (targetVal - vStart) * s;
      param.linearRampToValueAtTime(v, t);
      knots.push([t, v]);
    }
    this._paramKnots.set(key, knots);
  }

  _slewParam(key, param, targetVal, now, slewSec = 0.16) {
    const vStart = this._holdParam(param, this._paramKnots.get(key), now, param.value);
    const tEnd = now + slewSec;
    param.linearRampToValueAtTime(targetVal, tEnd);
    this._paramKnots.set(key, [
      [now, vStart],
      [tEnd, targetVal],
    ]);
  }

  _latchSilentErBankTaps(bank, m, latchTime) {
    const applyTap = (nodeTap, tapSpec) => {
      nodeTap.delay.delayTime.cancelScheduledValues(latchTime);
      nodeTap.delay.delayTime.setValueAtTime(tapSpec.delaySec, latchTime);
      nodeTap.gain.gain.cancelScheduledValues(latchTime);
      nodeTap.gain.gain.setValueAtTime(tapSpec.gain, latchTime);
      nodeTap.pan.pan.cancelScheduledValues(latchTime);
      nodeTap.pan.pan.setValueAtTime(tapSpec.pan, latchTime);
    };
    applyTap(bank.left, m.tapLeft);
    applyTap(bank.right, m.tapRight);
    applyTap(bank.veil, m.tapVeil);
    applyTap(bank.rear, m.tapRear);
  }

  _applyImmediateMetrics(m) {
    if (!this.graphReady || !this.ctx) return;
    const now = this.ctx.currentTime;
    const bassLift = m.distanceM < 2.6 ? 1.5 : m.lidShadowFactor > 0.2 ? 1.2 : 0.25;
    const revLP = 6000.0 * (1.0 - 0.28 * m.overhang);

    this._setParamImmediate("sideWidth", this.sideWidthGain.gain, m.stereoWidth * 0.5, now);
    this._setParamImmediate("lidShelf", this.lidShelfFilter.gain, m.hfLidDb, now);
    this._setParamImmediate("bodyLow", this.bodyLowShelf.gain, bassLift, now);
    this._setParamImmediate("airLP", this.airLowpass.frequency, m.airCutoffHz, now);
    this._setParamImmediate("directGain", this.directGainNode.gain, m.directGain, now);
    this._setParamImmediate("directPan", this.directPanner.pan, m.binauralPan, now);
    this._setParamImmediate("earShadowL", this.earShadowL.gain, m.leftHeadHighDb, now);
    this._setParamImmediate("earShadowR", this.earShadowR.gain, m.rightHeadHighDb, now);
    this._setParamImmediate("reverbSend", this.reverbSend.gain, m.reverbSendGain, now);
    this._setParamImmediate("reverbAirLP", this.reverbAirLP.frequency, revLP, now);

    for (let i = 0; i < this.erBanks.length; i++) {
      const bank = this.erBanks[i];
      const g = i === 0 ? 1.0 : 0.0;
      try {
        bank.masterGain.gain.cancelScheduledValues(now);
      } catch (_) {}
      bank.masterGain.gain.setValueAtTime(g, now);
      bank.gainKnots = [[now, g]];
      if (i === 0) {
        this._latchSilentErBankTaps(bank, m, now);
      }
    }
    this._activeErBankIdx = 0;
  }

  _crossfadeErBanksTo(mTarget, targetPos, durationSec = 0.72) {
    if (!this.graphReady || !this.ctx || this.erBanks.length === 0) return;
    const now = this.ctx.currentTime;
    const nBanks = this.erBanks.length;

    const curGains = new Array(nBanks);
    for (let i = 0; i < nBanks; i++) {
      const b = this.erBanks[i];
      curGains[i] = this._holdParam(
        b.masterGain.gain,
        b.gainKnots,
        now,
        i === this._activeErBankIdx ? 1.0 : 0.0
      );
    }

    let nextIdx = (this._activeErBankIdx + 1) % nBanks;
    let minG = Infinity;
    for (let i = 0; i < nBanks; i++) {
      if (i === this._activeErBankIdx) continue;
      if (curGains[i] < minG) {
        minG = curGains[i];
        nextIdx = i;
      }
    }

    const nextBank = this.erBanks[nextIdx];
    let tFadeStart = now + 0.005;
    const nextKnots = [[now, curGains[nextIdx]]];

    if (curGains[nextIdx] > 0.0003) {
      const tMute = now + 0.030;
      nextBank.masterGain.gain.linearRampToValueAtTime(0.0, tMute);
      nextKnots.push([tMute, 0.0]);
      this._latchSilentErBankTaps(nextBank, mTarget, tMute + 0.003);
      tFadeStart = tMute + 0.006;
      nextBank.masterGain.gain.setValueAtTime(0.0, tFadeStart);
      nextKnots.push([tFadeStart, 0.0]);
    } else {
      nextBank.masterGain.gain.setValueAtTime(0.0, now);
      nextKnots[0][1] = 0.0;
      this._latchSilentErBankTaps(nextBank, mTarget, now + 0.001);
      nextBank.masterGain.gain.setValueAtTime(0.0, tFadeStart);
      nextKnots.push([tFadeStart, 0.0]);
    }

    const steps = 8;
    const dur = Math.max(0.18, durationSec);

    for (let k = 1; k <= steps; k++) {
      const p = k / steps;
      const t = tFadeStart + p * dur;
      const g = k === steps ? 1.0 : Math.sin(p * Math.PI * 0.5);
      nextBank.masterGain.gain.linearRampToValueAtTime(g, t);
      nextKnots.push([t, g]);
    }
    nextBank.gainKnots = nextKnots;

    for (let i = 0; i < nBanks; i++) {
      if (i === nextIdx) continue;
      const b = this.erBanks[i];
      const g0 = curGains[i];
      if (g0 <= 0.0001) {
        b.masterGain.gain.setValueAtTime(0.0, now);
        b.gainKnots = [[now, 0.0]];
        continue;
      }
      const knots = [[now, g0]];
      if (tFadeStart > now + 0.001) {
        b.masterGain.gain.setValueAtTime(g0, tFadeStart);
        knots.push([tFadeStart, g0]);
      }
      for (let k = 1; k <= steps; k++) {
        const p = k / steps;
        const t = tFadeStart + p * dur;
        const g = k === steps ? 0.0 : g0 * Math.cos(p * Math.PI * 0.5);
        b.masterGain.gain.linearRampToValueAtTime(g, t);
        knots.push([t, g]);
      }
      b.gainKnots = knots;
    }

    this._activeErBankIdx = nextIdx;
    if (targetPos) this._erAnchorPos.copy(targetPos);
    this._lastErCrossfadeTime = now;
  }

  /**
   * Subtle endpoint-to-endpoint acoustic crossfade when gliding to a seat or onto the stage.
   * Avoids flying the virtual microphone across the stage mid-glide and never touches live DelayNodes.
   */
  transitionToPose(targetPos, targetQuat, activeSeat = null, { immediate = false, durationSec = 0.72 } = {}) {
    const m = this.computeMetrics(targetPos, targetQuat, activeSeat);
    this.lastMetrics = m;
    this._glideTargetPos.copy(targetPos);
    this._glideTargetQuat.copy(targetQuat);

    if (immediate) {
      this._glideWallEndMs = 0.0;
      this._erAnchorPos.copy(targetPos);
      this._applyImmediateMetrics(m);
      return m;
    }

    const dur = clamp(Number(durationSec) || 0.72, 0.35, 1.35);
    this._glideWallEndMs = performance.now() + dur * 1000.0;

    if (!this.graphReady || !this.ctx) return m;
    const now = this.ctx.currentTime;
    const bassLift = m.distanceM < 2.6 ? 1.5 : m.lidShadowFactor > 0.2 ? 1.2 : 0.25;
    const revLP = 6000.0 * (1.0 - 0.28 * m.overhang);

    this._scheduleSCurve("sideWidth", this.sideWidthGain.gain, m.stereoWidth * 0.5, now, dur, false);
    this._scheduleSCurve("lidShelf", this.lidShelfFilter.gain, m.hfLidDb, now, dur, false);
    this._scheduleSCurve("bodyLow", this.bodyLowShelf.gain, bassLift, now, dur, false);
    this._scheduleSCurve("airLP", this.airLowpass.frequency, m.airCutoffHz, now, dur, true);
    this._scheduleSCurve("directGain", this.directGainNode.gain, m.directGain, now, dur, true);
    this._scheduleSCurve("directPan", this.directPanner.pan, m.binauralPan, now, dur, false);
    this._scheduleSCurve("earShadowL", this.earShadowL.gain, m.leftHeadHighDb, now, dur, false);
    this._scheduleSCurve("earShadowR", this.earShadowR.gain, m.rightHeadHighDb, now, dur, false);
    this._scheduleSCurve("reverbSend", this.reverbSend.gain, m.reverbSendGain, now, dur, true);
    this._scheduleSCurve("reverbAirLP", this.reverbAirLP.frequency, revLP, now, dur, true);

    this._crossfadeErBanksTo(m, targetPos, dur);
    return m;
  }

  updateListener(listenerPos, listenerQuat, activeSeat = null, immediate = false) {
    if (immediate) {
      return this.transitionToPose(listenerPos, listenerQuat, activeSeat, { immediate: true });
    }

    if (
      performance.now() < this._glideWallEndMs &&
      listenerPos.distanceToSquared(this._glideTargetPos) < 1e-4 &&
      1.0 - Math.abs(listenerQuat.dot(this._glideTargetQuat)) < 1e-4
    ) {
      return this.lastMetrics;
    }

    const m = this.computeMetrics(listenerPos, listenerQuat, activeSeat);
    this.lastMetrics = m;
    if (!this.graphReady || !this.ctx) return m;

    const now = this.ctx.currentTime;
    const bassLift = m.distanceM < 2.6 ? 1.5 : m.lidShadowFactor > 0.2 ? 1.2 : 0.25;
    const revLP = 6000.0 * (1.0 - 0.28 * m.overhang);
    const slewSec = 0.16;

    this._slewParam("sideWidth", this.sideWidthGain.gain, m.stereoWidth * 0.5, now, slewSec);
    this._slewParam("lidShelf", this.lidShelfFilter.gain, m.hfLidDb, now, slewSec);
    this._slewParam("bodyLow", this.bodyLowShelf.gain, bassLift, now, slewSec);
    this._slewParam("airLP", this.airLowpass.frequency, m.airCutoffHz, now, slewSec);
    this._slewParam("directGain", this.directGainNode.gain, m.directGain, now, slewSec);
    this._slewParam("directPan", this.directPanner.pan, m.binauralPan, now, slewSec);
    this._slewParam("earShadowL", this.earShadowL.gain, m.leftHeadHighDb, now, slewSec);
    this._slewParam("earShadowR", this.earShadowR.gain, m.rightHeadHighDb, now, slewSec);
    this._slewParam("reverbSend", this.reverbSend.gain, m.reverbSendGain, now, slewSec);
    this._slewParam("reverbAirLP", this.reverbAirLP.frequency, revLP, now, slewSec);

    if (
      listenerPos.distanceTo(this._erAnchorPos) >= 1.35 &&
      now - this._lastErCrossfadeTime >= 0.55
    ) {
      this._crossfadeErBanksTo(m, listenerPos, 0.55);
    } else if (this.erBanks[this._activeErBankIdx]) {
      const activeBank = this.erBanks[this._activeErBankIdx];
      const slewTapPanGain = (tapNode, tapSpec) => {
        tapNode.gain.gain.setTargetAtTime(tapSpec.gain, now, 0.075);
        tapNode.pan.pan.setTargetAtTime(tapSpec.pan, now, 0.075);
      };
      slewTapPanGain(activeBank.left, m.tapLeft);
      slewTapPanGain(activeBank.right, m.tapRight);
      slewTapPanGain(activeBank.veil, m.tapVeil);
      slewTapPanGain(activeBank.rear, m.tapRear);
    }

    return m;
  }

  // ==========================================================================
  // INTERACTIVE 61-KEY SCHLOSS KREMSEGG HISTORICAL FORTEPIANO VOICE SYNTH
  // ==========================================================================
  preloadKeySamples() {
    if (this.samplesLoadingPromise) return this.samplesLoadingPromise;
    const OfflineAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineAC) return Promise.resolve();
    const decodeCtx = new OfflineAC(2, 1, 44100);
    const jobs = [];
    for (const m of SAMPLE_MIDIS) {
      for (const layer of ["mp", "f"]) {
        jobs.push(
          (async () => {
            try {
              const res = await fetch(`./assets/sandbox_audio/kremsegg_pleyel/m${m}_${layer}.mp3`);
              if (!res.ok) return;
              const ab = await res.arrayBuffer();
              const audioBuf = await decodeCtx.decodeAudioData(ab);
              this.sampleBuffers.set(`${m}_${layer}`, audioBuf);
            } catch (err) {
              console.warn(`[KoernerHallAcoustics] Failed to preload sample m${m}_${layer}.mp3:`, err);
            }
          })()
        );
      }
    }
    this.samplesLoadingPromise = Promise.all(jobs);
    return this.samplesLoadingPromise;
  }

  _nearestSampleMidi(midi) {
    let best = SAMPLE_MIDIS[0];
    let bestDist = Math.abs(midi - best);
    for (const s of SAMPLE_MIDIS) {
      const d = Math.abs(midi - s);
      if (d < bestDist) {
        best = s;
        bestDist = d;
      }
    }
    return best;
  }

  isDamperLifted(midi) {
    const m = foldMidiIntoFortepianoCompass(midi);
    // All 61 courses (F1-f3, MIDI 29..89) on HFH006 have individual overhead Keil / Püschel dampers
    if (this.damperSustain) return true;
    if (this.keysDown.has(m)) return true;
    return false;
  }

  setKneeLever(engaged) {
    this.damperSustain = Boolean(engaged);
    if (!this.damperSustain) {
      for (const m of this.activeVoices.keys()) {
        this._evaluateDampingForMidi(m);
      }
    }
  }

  playInteractiveNoteOn(rawMidi, velocity = 0.80) {
    const midi = foldMidiIntoFortepianoCompass(rawMidi);
    if (midi < FORTEPIANO_MIN_MIDI || midi > FORTEPIANO_MAX_MIDI) return;
    this.keysDown.add(midi);
    this.ensureContext();
    this.resumeNonBlocking();
    this.preloadKeySamples();
    if (!this.ctx || !this.sourceBus) return;

    const now = this.ctx.currentTime;
    const vel = clamp(velocity, 0.08, 1.0);
    const refMidi = this._nearestSampleMidi(midi);
    // Schloss Kremsegg historical fortepiano samples are recorded near A4 = 430 Hz
    const pitchRatio = (this.concertPitchHz / 430.0) * Math.pow(2.0, (midi - refMidi) / 12.0);
    const bufMp = this.sampleBuffers.get(`${refMidi}_mp`);
    const bufF = this.sampleBuffers.get(`${refMidi}_f`);

    const voiceGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(
      Math.min(19500, (1900 + Math.pow(vel, 1.30) * 15500) * (this.moderator ? 0.55 : 1.0)),
      now
    );
    filter.Q.value = 0.62;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = ((midi - FORTEPIANO_MIN_MIDI) / 60.0 - 0.5) * 0.86;
    filter.connect(panner);
    panner.connect(voiceGain);
    voiceGain.connect(this.sourceBus);

    const amp = Math.pow(vel, 1.35) * 0.88;
    voiceGain.gain.setValueAtTime(0.0001, now);
    voiceGain.gain.linearRampToValueAtTime(amp, now + 0.0022);

    const sources = [];
    if (bufMp || bufF) {
      const fMix = clamp((vel - 0.24) / 0.64, 0, 1) * (this.moderator ? 0.50 : 1.0);
      const mpMix = 1.0 - fMix * 0.72;
      if (bufMp && mpMix > 0.02) {
        const sMp = this.ctx.createBufferSource();
        sMp.buffer = bufMp;
        sMp.playbackRate.value = pitchRatio;
        const gMp = this.ctx.createGain();
        gMp.gain.value = mpMix;
        sMp.connect(gMp);
        gMp.connect(filter);
        sMp.start(now);
        sources.push(sMp);
      }
      if (bufF && fMix > 0.02) {
        const sF = this.ctx.createBufferSource();
        sF.buffer = bufF;
        sF.playbackRate.value = pitchRatio;
        const gF = this.ctx.createGain();
        gF.gain.value = fMix;
        sF.connect(gF);
        gF.connect(filter);
        sF.start(now);
        sources.push(sF);
      }
    } else {
      // Immediate bichord brass/iron fallback while MP3 sample bank finishes decoding
      const freq = this.concertPitchHz * Math.pow(2.0, (midi - 69) / 12.0);
      for (const [harm, hGain] of [[1, 0.45], [2, 0.24], [3, 0.12], [4, 0.05]]) {
        const osc = this.ctx.createOscillator();
        osc.type = harm === 1 ? "triangle" : "sine";
        osc.frequency.value = freq * harm;
        const hg = this.ctx.createGain();
        hg.gain.setValueAtTime(hGain, now);
        hg.gain.exponentialRampToValueAtTime(0.0001, now + 2.1 / harm);
        osc.connect(hg);
        hg.connect(filter);
        osc.start(now);
        osc.stop(now + 2.3);
        sources.push(osc);
      }
    }

    const voice = { midi, voiceGain, sources, damped: false };
    if (!this.activeVoices.has(midi)) this.activeVoices.set(midi, []);
    this.activeVoices.get(midi).push(voice);
    setTimeout(() => this._cleanupVoice(midi, voice), 10000);
  }

  playInteractiveNoteOff(rawMidi) {
    const midi = foldMidiIntoFortepianoCompass(rawMidi);
    this.keysDown.delete(midi);
    this._evaluateDampingForMidi(midi);
  }

  _evaluateDampingForMidi(midi) {
    if (this.isDamperLifted(midi)) return;
    const list = this.activeVoices.get(midi);
    if (!list || !this.ctx) return;
    const now = this.ctx.currentTime;
    // Fast Viennese leather Keil / wool Püschel damper cutoff
    const releaseTau = midi < 45 ? 0.058 : 0.028;
    for (const v of list) {
      if (v.damped) continue;
      v.damped = true;
      try {
        v.voiceGain.gain.cancelScheduledValues(now);
        v.voiceGain.gain.setTargetAtTime(0.00001, now, releaseTau);
      } catch (_) {}
      setTimeout(() => {
        for (const s of v.sources) {
          try {
            s.stop();
          } catch (_) {}
        }
        this._cleanupVoice(midi, v);
      }, Math.ceil(releaseTau * 6500));
    }
  }

  _cleanupVoice(midi, voice) {
    const list = this.activeVoices.get(midi);
    if (!list) return;
    const idx = list.indexOf(voice);
    if (idx !== -1) list.splice(idx, 1);
  }
}

/**
 * Period-Instrument Fortepiano Repertoire Performance Controller:
 * Synchronizes 10 historical Stein / Walter / Schantz / Haschka recordings of Beethoven & Schubert
 * (defaulting to Beethoven's Kurfürsten Sonata No. 2 in F Minor, WoO 47 on a 1788 J. A. Stein replica)
 * with the 61-key 3D Prellmechanik action on Koerner Hall's concert stage.
 */
export class FortepianoRepertoirePerformance {
  constructor({ acoustics, fortepianoRig, onStateChange, onProgress, onPieceChange }) {
    this.acoustics = acoustics;
    this.fortepianoRig = fortepianoRig;
    this.onStateChange = onStateChange || (() => {});
    this.onProgress = onProgress || (() => {});
    this.onPieceChange = onPieceChange || (() => {});

    this.repertoire = HISTORICAL_REPERTOIRE;
    this.currentPieceIndex = 0;

    this.loaded = false;
    this.playing = false;
    this.durationSec = 228.88;
    this.a4Hz = 425.0;
    this.events = [];
    this.eventPtr = 0;
    this.scheduledOffs = [];

    this.pausedAtSec = 0.0;
    this.startWallSec = 0.0;
    this.seekBaseSec = 0.0;
    this.audioEl = null;

    this._loadPieceData(0);
  }

  get currentPiece() {
    return this.repertoire[this.currentPieceIndex] || this.repertoire[0];
  }

  _loadPieceData(index) {
    const safeIdx = clamp(Math.floor(Number(index) || 0), 0, this.repertoire.length - 1);
    this.currentPieceIndex = safeIdx;
    const piece = this.repertoire[safeIdx];

    const rawNotes = piece.alignedNotes || [];
    const events = rawNotes
      .map((n) => ({
        t: Number(n[0] ?? 0),
        dur: Number(n[1] ?? 0.22),
        midi: foldMidiIntoFortepianoCompass(Number(n[4] ?? 60)),
        vel: clamp(Number(n[5] ?? 0.80), 0.14, 1.0),
      }))
      .sort((a, b) => a.t - b.t || a.midi - b.midi);

    // Ensure crisp Viennese Prellmechanik escapement releases ~22 ms prior to same-key re-strike
    const lastPerMidi = new Map();
    for (const ev of events) {
      const prev = lastPerMidi.get(ev.midi);
      if (prev && prev.t + prev.dur > ev.t - 0.022) {
        prev.dur = Math.max(0.020, ev.t - prev.t - 0.022);
      }
      lastPerMidi.set(ev.midi, ev);
    }

    this.events = events;
    this.durationSec = Number(piece.durationSec || 228.88);
    this.a4Hz = Number(piece.tuningA4 || 425.0);
    if (this.acoustics) {
      this.acoustics.concertPitchHz = this.a4Hz;
    }
    this.loaded = true;
    this.pausedAtSec = 0.0;
    this.seekBaseSec = 0.0;
    this.eventPtr = 0;
    this.scheduledOffs = [];

    if (this.audioEl && piece.audioUrl) {
      const cleanRel = piece.audioUrl.replace("./", "");
      if (!this.audioEl.src.endsWith(cleanRel)) {
        this.audioEl.src = piece.audioUrl;
      }
    }

    this.onPieceChange(piece, safeIdx);
    this.onProgress(0.0, this.durationSec);
  }

  async preload() {
    return true;
  }

  async selectPiece(idOrIndex, autoPlay = false) {
    const wasPlaying = this.playing;
    if (this.playing) {
      this.pause();
    }
    let idx = 0;
    if (typeof idOrIndex === "number" || /^\d+$/.test(String(idOrIndex))) {
      idx = clamp(parseInt(String(idOrIndex), 10), 0, this.repertoire.length - 1);
    } else {
      const q = String(idOrIndex).trim().toLowerCase();
      const found = this.repertoire.findIndex(
        (p) => p.id.toLowerCase() === q || p.id.toLowerCase().includes(q)
      );
      if (found >= 0) idx = found;
    }
    this._loadPieceData(idx);
    this._syncKinematicsToTime(0.0);
    if (autoPlay || wasPlaying) {
      await this.play(0.0);
    }
  }

  _ensureAudioElement() {
    const piece = this.currentPiece;
    if (!this.audioEl) {
      const el = new Audio();
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      el.preservesPitch = true;
      el.src = piece.audioUrl;
      this.audioEl = el;
      this.acoustics.bindMediaElement(el);
    } else if (piece?.audioUrl) {
      const cleanRel = piece.audioUrl.replace("./", "");
      if (!this.audioEl.src.endsWith(cleanRel)) {
        this.audioEl.src = piece.audioUrl;
      }
    }
    return this.audioEl;
  }

  _syncKinematicsToTime(targetSec) {
    if (this.fortepianoRig) this.fortepianoRig.releaseAllKeysAndPedals();
    this.scheduledOffs = [];
    this.acoustics.keysDown.clear();
    this.acoustics.setKneeLever(false);

    const t = clamp(Number(targetSec) || 0, 0, this.durationSec);
    this.eventPtr = 0;

    while (this.eventPtr < this.events.length && this.events[this.eventPtr].t <= t) {
      const ev = this.events[this.eventPtr++];
      const offTime = ev.t + Math.max(0.050, ev.dur * 0.94);
      if (offTime > t) {
        if (this.fortepianoRig) this.fortepianoRig.holdKeyMidNote(ev.midi, ev.vel);
        this.acoustics.keysDown.add(ev.midi);
        this.scheduledOffs.push({ offTime, midi: ev.midi });
      }
    }

    this.onProgress(t, this.durationSec);
  }

  async play(seekSec = null) {
    await this.preload();
    await this.acoustics.resumeNonBlocking();
    const el = this._ensureAudioElement();

    const startAt =
      seekSec !== null
        ? clamp(Number(seekSec), 0, this.durationSec - 0.05)
        : this.pausedAtSec >= this.durationSec - 0.2
          ? 0.0
          : this.pausedAtSec;

    this.seekBaseSec = startAt;
    this.startWallSec = performance.now() * 0.001;
    this._syncKinematicsToTime(startAt);

    try {
      if (Math.abs((el.currentTime || 0) - startAt) > 0.08) {
        el.currentTime = startAt;
      }
    } catch (_) {}

    this.playing = true;
    this.onStateChange(true);

    Promise.race([
      el.play().catch(() => {}),
      new Promise((r) => setTimeout(r, 150)),
    ]).then(() => {
      if (this.playing && el && !el.paused && Math.abs(el.currentTime - startAt) > 0.35) {
        try {
          el.currentTime = startAt;
        } catch (_) {}
      }
      this.startWallSec = performance.now() * 0.001;
    });
  }

  pause() {
    if (!this.playing) return;
    this.pausedAtSec = this.getCurrentTimeSec();
    this.playing = false;
    if (this.audioEl) {
      try {
        this.audioEl.pause();
      } catch (_) {}
    }
    if (this.fortepianoRig) this.fortepianoRig.releaseAllKeysAndPedals();
    this.acoustics.keysDown.clear();
    this.acoustics.setKneeLever(false);
    this.onStateChange(false);
    this.onProgress(this.pausedAtSec, this.durationSec);
  }

  togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(targetSec) {
    const clamped = clamp(Number(targetSec) || 0, 0, this.durationSec - 0.05);
    this.pausedAtSec = clamped;
    this.seekBaseSec = clamped;
    this.startWallSec = performance.now() * 0.001;
    if (this.audioEl) {
      try {
        this.audioEl.currentTime = clamped;
      } catch (_) {}
    }
    this._syncKinematicsToTime(clamped);
  }

  getCurrentTimeSec(nowSec = performance.now() * 0.001) {
    if (!this.playing) return this.pausedAtSec;
    if (
      this.audioEl &&
      !this.audioEl.paused &&
      Number.isFinite(this.audioEl.currentTime) &&
      this.audioEl.readyState >= 2
    ) {
      const audioT = this.audioEl.currentTime;
      const wallElapsed = Math.max(0, nowSec - this.startWallSec);
      if (wallElapsed < 0.25 || audioT > this.seekBaseSec + 0.02) {
        return audioT;
      }
    }
    return this.seekBaseSec + Math.max(0, nowSec - this.startWallSec);
  }

  update(nowSec = performance.now() * 0.001) {
    if (!this.playing || !this.loaded) return false;
    const t = this.getCurrentTimeSec(nowSec);
    this.pausedAtSec = t;
    this.onProgress(t, this.durationSec);

    while (this.eventPtr < this.events.length && this.events[this.eventPtr].t <= t) {
      const ev = this.events[this.eventPtr++];
      for (let k = this.scheduledOffs.length - 1; k >= 0; k--) {
        if (this.scheduledOffs[k].midi === ev.midi) this.scheduledOffs.splice(k, 1);
      }
      if (this.fortepianoRig) {
        this.fortepianoRig.strikeKey(ev.midi, ev.vel);
      }
      this.acoustics.keysDown.add(ev.midi);
      this.scheduledOffs.push({
        offTime: ev.t + Math.max(0.050, ev.dur * 0.94),
        midi: ev.midi,
      });
    }

    for (let i = this.scheduledOffs.length - 1; i >= 0; i--) {
      const off = this.scheduledOffs[i];
      if (t >= off.offTime) {
        if (this.fortepianoRig) this.fortepianoRig.releaseKey(off.midi);
        this.acoustics.keysDown.delete(off.midi);
        this.scheduledOffs.splice(i, 1);
      }
    }

    if ((this.audioEl && this.audioEl.ended) || t >= this.durationSec + 0.1) {
      this.pausedAtSec = 0.0;
      this.pause();
      return false;
    }
    return true;
  }
}
