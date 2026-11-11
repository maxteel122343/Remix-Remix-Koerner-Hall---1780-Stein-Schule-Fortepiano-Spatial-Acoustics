/**
 * Koerner Hall Fortepiano Edition — c. 1780 Stein-Schule South German Fortepiano Stage Rig
 * Greifenberger Institut Inventory HFH006 (Circle of Johann Andreas Stein, Augsburg, c. 1780)
 *
 * Loads `./assets/stein_1780_fortepiano.glb`, places it on Koerner Hall's concert stage
 * in place of the Steinway D-274 alongside a period-matched South German walnut & madder-velvet
 * recital bench, upgrades all 1,449 meshes to museum-calibrated `THREE.MeshPhysicalMaterial`
 * (hand-rubbed shellac walnut, fiddleback sycamore marquetry, quarter-sawn Haselfichte spruce,
 * Gabon ebony naturals, bone accidentals, tawed Hirschleder buckskin, and forged iron/brass)
 * under a pure-Float32 3200K Koerner Hall stage-canopy PMREM, and drives full 61-key (F1-f3)
 * Prellmechanik hammer, Auslöser escapement, overhead Keil damper, bichord string, and
 * underside knee-lever (Kniehebel) kinematics.
 *
 * Strictly zero HTML5 2D <canvas> usage (100% immune to headless Chrome 2D canvas hangs).
 */

import * as THREE from "three";

export const FORTEPIANO_STAGE_ANCHOR_POS = new THREE.Vector3(0.84, 0.96, 3.65);
export const FORTEPIANO_STAGE_ROT_Y = Math.PI / 2;

export const FORTEPIANO_MIN_MIDI = 29; // F1
export const FORTEPIANO_MAX_MIDI = 89; // f3
export const FORTEPIANO_TOTAL_KEYS = 61;

const NOTE_NAMES = ["C", "C\u266F", "D", "D\u266F", "E", "F", "F\u266F", "G", "G\u266F", "A", "A\u266F", "B"];

export function midiToNoteName(midi) {
  const m = Math.round(midi);
  const oct = Math.floor(m / 12) - 1;
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${oct}`;
}

export function foldMidiIntoFortepianoCompass(midi) {
  let m = Math.round(midi);
  while (m < FORTEPIANO_MIN_MIDI) m += 12;
  while (m > FORTEPIANO_MAX_MIDI) m -= 12;
  return m;
}

/**
 * Converts 1780 Fortepiano local coordinates (lx, ly, lz) into Koerner Hall Three.js world space:
 * Anchor = (0.84, 0.96, 3.65), rotation.y = +PI/2 -> (0.84 + lz, 0.96 + ly, 3.65 - lx).
 */
export function pianoLocalToWorld(lx, ly, lz, target = new THREE.Vector3()) {
  return target.set(
    FORTEPIANO_STAGE_ANCHOR_POS.x + lz,
    FORTEPIANO_STAGE_ANCHOR_POS.y + ly,
    FORTEPIANO_STAGE_ANCHOR_POS.z - lx
  );
}

let _sharedMicrofiberNormalTex = null;

function getMicrofiberNormalMap() {
  if (_sharedMicrofiberNormalTex) return _sharedMicrofiberNormalTex;
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  let seed = 0x517cc1b7;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const weaveX = Math.sin((x / size) * Math.PI * 24.0) * 0.35 + (rand() - 0.5) * 0.45;
      const weaveY = Math.cos((y / size) * Math.PI * 24.0) * 0.35 + (rand() - 0.5) * 0.45;
      const idx = (y * size + x) * 4;
      data[idx] = Math.max(0, Math.min(255, Math.round(128 + weaveX * 26)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(128 + weaveY * 26)));
      data[idx + 2] = 255;
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(12, 12);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  _sharedMicrofiberNormalTex = tex;
  return tex;
}

function sanitizeTangentBuffer(tanAttr, normAttr) {
  if (!tanAttr || !tanAttr.array || tanAttr.array.length === 0) return false;
  const arr = tanAttr.array;
  const normArr = normAttr && normAttr.array ? normAttr.array : null;
  const vertCount = Math.floor(arr.length / 4);
  let fixed = false;

  for (let v = 0; v < vertCount; v++) {
    const i = v * 4;
    const tx = arr[i];
    const ty = arr[i + 1];
    const tz = arr[i + 2];
    const tw = arr[i + 3];
    const lenSq = tx * tx + ty * ty + tz * tz;

    if (!Number.isFinite(lenSq) || lenSq < 1e-4) {
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
      fixed = true;
    } else if (!Number.isFinite(tw) || Math.abs(tw) < 0.1) {
      arr[i + 3] = 1.0;
      fixed = true;
    }
  }
  if (fixed) tanAttr.needsUpdate = true;
  return true;
}

function sanitizeAndComputeTangents(geometry) {
  if (!geometry || !geometry.attributes) return false;
  if (geometry.attributes.normal && geometry.attributes.normal.array) {
    const narr = geometry.attributes.normal.array;
    let fixedN = false;
    for (let i = 0; i < narr.length; i += 3) {
      const lSq = narr[i] * narr[i] + narr[i + 1] * narr[i + 1] + narr[i + 2] * narr[i + 2];
      if (!Number.isFinite(lSq) || lSq < 1e-6) {
        narr[i] = 0.0;
        narr[i + 1] = 1.0;
        narr[i + 2] = 0.0;
        fixedN = true;
      }
    }
    if (fixedN) geometry.attributes.normal.needsUpdate = true;
  }
  if (geometry.attributes.tangent) {
    if (sanitizeTangentBuffer(geometry.attributes.tangent, geometry.attributes.normal)) {
      return true;
    }
  }
  if (
    geometry.index &&
    geometry.attributes.position &&
    geometry.attributes.normal &&
    geometry.attributes.uv
  ) {
    try {
      geometry.computeTangents();
      if (sanitizeTangentBuffer(geometry.attributes.tangent, geometry.attributes.normal)) {
        return true;
      }
    } catch (_) {
      return false;
    }
  }
  return false;
}

/**
 * Pure Float32Array 512x256 Equirectangular Stage-Canopy HDRI for the 1780 Fortepiano.
 * Calibrated for Koerner Hall's AgX tone mapping (exposure = 0.70) with 3200K overhead soloist
 * spots, warm Baillie Oak Veil canopy fill, and white-oak stage deck bounce — zero <canvas> calls.
 */
function buildKoernerStageFortepianoPMREM(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const zenith = [0.22, 0.16, 0.105];
  const horizon = [0.34, 0.24, 0.155];
  const floorBounce = [0.28, 0.18, 0.10];

  // Defined in Fortepiano local space (lx, ly, lz), then rotated +90° around +Y -> (lz, ly, -lx)
  const localBoxes = [
    // Overhead Koerner stage canopy soloist array (3200K warm halogen-tungsten)
    { dir: [0.26, 0.92, 0.28], wu: 0.42, wv: 0.28, col: [6.4, 5.2, 3.8], exp: 1.75 },
    // Downstage walnut bentside & sycamore marquetry key fill
    { dir: [0.84, 0.46, -0.22], wu: 0.34, wv: 0.18, col: [4.2, 3.4, 2.45], exp: 1.85 },
    // Klaviatur & Vorsatzbrett marquetry wash (+X world toward pianist)
    { dir: [-0.08, 0.64, 0.76], wu: 0.38, wv: 0.25, col: [4.8, 4.0, 3.0], exp: 1.80 },
    // Upstage Baillie Oak Veil warm kicker onto coffered open walnut lid & spruce soundboard
    { dir: [-0.58, 0.56, -0.54], wu: 0.36, wv: 0.22, col: [3.9, 2.85, 1.75], exp: 1.85 },
    // Raking strip highlights sculpting French-polished walnut case walls & turned legs
    { dir: [0.78, -0.04, 0.58], wu: 0.18, wv: 0.26, col: [2.3, 1.82, 1.28], exp: 2.05 },
    { dir: [0.56, -0.05, -0.80], wu: 0.16, wv: 0.24, col: [1.85, 1.46, 1.02], exp: 2.05 },
  ];

  const preparedBoxes = localBoxes.map((b) => {
    const F = new THREE.Vector3(b.dir[2], b.dir[1], -b.dir[0]).normalize();
    const worldUp = Math.abs(F.y) > 0.94 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const R = new THREE.Vector3().crossVectors(worldUp, F).normalize();
    const U = new THREE.Vector3().crossVectors(F, R).normalize();
    return { F, R, U, wu: b.wu, wv: b.wv, col: b.col, exp: b.exp };
  });

  const W = 512;
  const H = 256;
  const data = new Float32Array(W * H * 4);

  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const theta = (1.0 - v) * Math.PI;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);

    let baseR, baseG, baseB;
    if (cosT >= 0.0) {
      const t = Math.pow(cosT, 0.65);
      baseR = horizon[0] * (1 - t) + zenith[0] * t;
      baseG = horizon[1] * (1 - t) + zenith[1] * t;
      baseB = horizon[2] * (1 - t) + zenith[2] * t;
    } else {
      const t = Math.pow(-cosT, 0.75);
      baseR = horizon[0] * (1 - t) + floorBounce[0] * t;
      baseG = horizon[1] * (1 - t) + floorBounce[1] * t;
      baseB = horizon[2] * (1 - t) + floorBounce[2] * t;
    }

    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const phi = (u - 0.5) * Math.PI * 2.0;
      const dx = -sinT * Math.sin(phi);
      const dy = cosT;
      const dz = -sinT * Math.cos(phi);

      let r = baseR;
      let g = baseG;
      let b = baseB;

      for (let k = 0; k < preparedBoxes.length; k++) {
        const sb = preparedBoxes[k];
        const dotF = dx * sb.F.x + dy * sb.F.y + dz * sb.F.z;
        if (dotF > 0.14) {
          const su = (dx * sb.R.x + dy * sb.R.y + dz * sb.R.z) / (dotF * sb.wu);
          const sv = (dx * sb.U.x + dy * sb.U.y + dz * sb.U.z) / (dotF * sb.wv);
          const dNorm = Math.pow(Math.abs(su), sb.exp) + Math.pow(Math.abs(sv), sb.exp);
          if (dNorm < 7.5) {
            const profile = Math.exp(-dNorm);
            r += sb.col[0] * profile;
            g += sb.col[1] * profile;
            b += sb.col[2] * profile;
          }
        }
      }

      const idx = (y * W + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 1.0;
    }
  }

  const hdrTex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  hdrTex.mapping = THREE.EquirectangularReflectionMapping;
  hdrTex.colorSpace = THREE.LinearSRGBColorSpace;
  hdrTex.minFilter = THREE.LinearFilter;
  hdrTex.magFilter = THREE.LinearFilter;
  hdrTex.needsUpdate = true;

  const rt = pmrem.fromEquirectangular(hdrTex);
  hdrTex.dispose();
  pmrem.dispose();
  return rt;
}

function configureTextureFiltering(mat, maxAniso) {
  const srgbSlots = ["map", "emissiveMap", "sheenColorMap"];
  const linearSlots = [
    "normalMap",
    "roughnessMap",
    "metalnessMap",
    "aoMap",
    "clearcoatMap",
    "clearcoatRoughnessMap",
    "clearcoatNormalMap",
  ];

  for (const slot of srgbSlots) {
    const tex = mat[slot];
    if (tex && tex.isTexture) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = maxAniso;
      tex.needsUpdate = true;
    }
  }
  for (const slot of linearSlots) {
    const tex = mat[slot];
    if (tex && tex.isTexture) {
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = maxAniso;
      tex.needsUpdate = true;
    }
  }
}

function classifyOrganologicalSurface(matName, meshContext) {
  const m = (matName || "").toLowerCase();
  const c = (meshContext || "").toLowerCase();
  const full = `${m} ${c}`;

  if (m.includes("brass_string") || (c.includes("course_") && m.includes("brass"))) {
    return "brass_strings";
  }
  if (m.includes("iron_string") || m.includes("tinned") || (c.includes("course_") && (m.includes("iron") || m.includes("steel")))) {
    return "iron_strings";
  }
  if (m.includes("brass") || m.includes("messing") || c.includes("hinge") || c.includes("escutcheon") || c.includes("stegstift") || c.includes("kapselbrass")) {
    return "tarnished_brass";
  }
  if (m.includes("wirbel") || c.includes("wirbel")) {
    return "forged_wirbel";
  }
  if (m.includes("iron") || m.includes("wrought") || c.includes("prop_stick") || c.includes("ironbracket") || c.includes("balancepin") || c.includes("spik") || c.includes("anheng") || c.includes("hitchpin")) {
    return "wrought_iron";
  }

  if (
    m.includes("crimson") ||
    m.includes("scarlet") ||
    m.includes("listing") ||
    m.includes("garnish") ||
    m.includes("wool") ||
    c.includes("listingcloth") ||
    c.includes("pueschel") ||
    c.includes("puschel")
  ) {
    return "madder_wool_cloth";
  }
  if (
    m.includes("buckskin") ||
    m.includes("leather") ||
    m.includes("hirschleder") ||
    m.includes("polster") ||
    c.includes("leathercap") ||
    c.includes("keilwedge") ||
    c.includes("piloteleather") ||
    c.includes("cushion") ||
    c.includes("restcloth")
  ) {
    return "tawed_buckskin";
  }

  if (
    /\b(ivory|bone)\b/.test(m) ||
    m.includes("ivory") ||
    m.includes("bone_") ||
    m.includes("beinbelag") ||
    c.includes("ivoryslip")
  ) {
    return "bone_ivory";
  }

  if (
    m.includes("matteebonized") ||
    m.includes("mortise") ||
    m.includes("slotshadow") ||
    c.includes("vorderbalken") ||
    c.includes("frontrail") ||
    c.includes("mortiseslot") ||
    c.includes("slotao")
  ) {
    return "matte_cavity";
  }

  if (
    m.includes("ebony_trim") ||
    m.includes("ebonizedrim") ||
    m.includes("ebonized_keyfront") ||
    c.includes("oberkante") ||
    c.includes("rim_cap") ||
    c.includes("ebony_rim") ||
    c.includes("ebony_edge") ||
    c.includes("ebony_slip") ||
    c.includes("ebonyframe") ||
    c.includes("ebonyborder") ||
    c.includes("ebonypurfling") ||
    c.includes("outerebony") ||
    c.includes("backenklotz") ||
    c.includes("keyfrontmoulding")
  ) {
    return "ebonized_rim_trim";
  }

  if (
    m.includes("ebony") ||
    m.includes("ebenholz") ||
    m.includes("ebonized") ||
    m.includes("keytop") ||
    c.includes("ebonynatural") ||
    c.includes("sharpbody")
  ) {
    return "ebony_polished";
  }

  if (
    m.includes("sycamore") ||
    m.includes("marquetry") ||
    m.includes("inlay") ||
    m.includes("riegelahorn") ||
    m.includes("maple") ||
    c.includes("sycamore") ||
    c.includes("marquetry")
  ) {
    return "sycamore_marquetry";
  }

  if (
    (m.includes("spruce") && !m.includes("rib")) ||
    (m.includes("resonanz") && !m.includes("rib")) ||
    c.includes("resonanzboden_soundboard") ||
    c.includes("resonanzboden_spruce")
  ) {
    return "alpine_spruce";
  }

  if (m.includes("bridge") || c.includes("steg_klangbalken") || c.includes("stimmstock_steg")) {
    return "bridge_hardwood";
  }

  if (m.includes("wrestplank") || m.includes("stimmstock") || m.includes("oak")) {
    return "wrestplank_oak";
  }

  if (c.includes("verschluss")) {
    return "walnut_french_polish";
  }

  if (
    m.includes("limewood") ||
    m.includes("pearwood") ||
    m.includes("darkstained_rail") ||
    m.includes("keylever") ||
    c.includes("limewoodlever") ||
    c.includes("hammerkapsel") ||
    c.includes("pearwoodshank") ||
    c.includes("hopper") ||
    c.includes("rechen")
  ) {
    return "action_wood";
  }

  if (
    m.includes("seam_shadow") ||
    m.includes("center_bore") ||
    c.includes("seamshadow") ||
    c.includes("centerbore")
  ) {
    return "matte_cavity";
  }
  if (
    m.includes("walnut_underside") ||
    m.includes("turnedwood") ||
    c.includes("beinteller") ||
    c.includes("legboss")
  ) {
    return "turned_underside_wood";
  }

  if (
    m.includes("pine") ||
    m.includes("unterboden") ||
    m.includes("rasten") ||
    m.includes("softwood") ||
    m.includes("spruce_rib") ||
    c.includes("unterboden") ||
    c.includes("rasten_")
  ) {
    return "pine_conifer";
  }

  if (m.includes("endgrain") || c.includes("krawattenzinken")) {
    return "walnut_endgrain";
  }
  if (c.includes("deckel_main_plate") || c.includes("deckel_flap_main_plate")) {
    return "deckel_coffer_panel";
  }
  if (m.includes("walnut_interior") || (c.includes("deckel") && c.includes("_underside"))) {
    return "walnut_interior";
  }
  if (
    full.includes("walnut") ||
    full.includes("korpus") ||
    full.includes("deckel") ||
    full.includes("notenpult") ||
    full.includes("leg") ||
    full.includes("beine") ||
    full.includes("innenzarge")
  ) {
    return "walnut_french_polish";
  }

  return "walnut_french_polish";
}

function getPolygonOffsetTier(meshName, matName) {
  const n = (meshName || "").toLowerCase();
  const m = (matName || "").toLowerCase();

  // Surface-mounted brass hardware, hinge barrels/leaves, pins & keyhole slots (front-most)
  if (
    n.includes("keyhole_slot") ||
    n.includes("cheekinlay_pins") ||
    n.includes("brass_hinge") ||
    n.includes("hinge_barrel") ||
    n.includes("hinge_mainleaf") ||
    n.includes("hinge_leaf")
  ) {
    return -5.0;
  }
  if (n.includes("escutcheon") && !n.includes("diamond_escutcheon")) {
    return -4.5;
  }

  // Nested nameboard & cheek marquetry stack (monotonically ordered from outer crossband inward)
  if (n.includes("sycamorepanel") || n.includes("sycamoreinlay") || n.includes("diamond_escutcheon")) {
    return -4.2;
  }
  if (n.includes("innerebonypurfling")) {
    return -3.8;
  }
  if (n.includes("maplepurfling")) {
    return -3.4;
  }
  if (
    n.includes("ebonyborder") ||
    n.includes("ebonyframe") ||
    n.includes("diamond_outerebony") ||
    n.includes("cheekinlay_ebony") ||
    n.includes("cheekinlay_sycamore") ||
    n.includes("ivoryslip") ||
    n.includes("hinge_mortiseshadow") ||
    n.includes("tenon_reveal") ||
    n.includes("kneelever_ironbracket")
  ) {
    return -3.0;
  }

  // Ebonized rim caps, sharp blocks, lip mouldings & cavity/seam AO strips
  if (
    n.includes("sharpbody") ||
    n.includes("rim_cap_moulding") ||
    n.includes("slope_ebony_cap") ||
    n.includes("cap_ebonyfillet") ||
    n.includes("front_keybed_ebony_slip") ||
    n.includes("backenklotz") ||
    n.includes("ebony_rim") ||
    n.includes("ebony_edge") ||
    n.includes("score_ledge_bead") ||
    n.includes("seamshadow") ||
    n.includes("slotao") ||
    n.includes("mortiseslotshadows") ||
    n.includes("exposedtenons") ||
    m.includes("center_bore")
  ) {
    return -2.0;
  }

  // Audience-facing coffered lid underside battens, applied base skirt mouldings, natural keytops & crossbands
  if (
    n.includes("base_skirt_moulding") ||
    n.includes("base_skirt_upperastragal") ||
    (n.includes("deckel_") && n.includes("_underside")) ||
    n.includes("ebonynatural") ||
    n.includes("keyfrontmoulding") ||
    n.includes("crossband")
  ) {
    return -1.0;
  }

  // Outer lid top-relief battens & outer spine/cheek walls where shared edges meet caps/hinges
  if (
    (n.includes("deckel_") && n.includes("_toprelief")) ||
    n === "korpus_spine_basswand" ||
    n === "korpus_cheek_diskantwand" ||
    n === "korpus_tail_spitze"
  ) {
    return 1.0;
  }

  // Coffer base plates, pine bottom planks, raw limewood levers & keyframe side cheeks
  if (
    n === "deckel_main_plate" ||
    n === "deckel_flap_main_plate" ||
    n.includes("unterboden_keybed_plank") ||
    n.includes("unterboden_plank_") ||
    n.includes("limewoodlever") ||
    n === "keyframe_sidecheeks"
  ) {
    return 2.0;
  }

  // Internal structural framing, recessed keybed underside frame & internal lockplate (rear-most)
  if (
    n.startsWith("rasten_") ||
    n.includes("keybed_underside_frame") ||
    n.includes("unterboden_backing_seal") ||
    n.includes("keyhole_lockplate")
  ) {
    return 3.0;
  }

  return 0.0;
}

/**
 * Surgically eliminates coplanar/penetrating mesh artifacts in `stein_1780_fortepiano.glb`
 * at runtime in glTF root coordinates without mutating the shared GLB symlink on disk:
 *  1. Retracts & insets `Korpus_Keybed_Underside_Frame_*` and lifts `Korpus_Unterboden_*` above `Y = 0.6550`
 *     so they never z-fight across the 96 cm front `Korpus_Base_Skirt_Moulding` / `UpperAstragal`.
 *  2. Strips the 2 stray detached outer boxes (`|x| > 0.30`) from `Korpus_KneeLever_Kniehebel` that
 *     collided with both front turned walnut legs, and recenters its hinge pivot onto `MountingBar`.
 *  3. Extends `Korpus_Keywell_InnerCheek_Bass` & `Treble` bottom bevels down by 7.0 mm (`0.6800 -> 0.6730`)
 *     to seal the 18 mm x 7 mm front corner gap flush with `Schlossbrett` & `Diskantwand`.
 *  4. Insets all 61 `Mesh_Key_XX_LimewoodLever` front paddles behind `KeyFrontMoulding` / `SharpBody`,
 *     above `KeyFrontMoulding` bottom (`0.7050`), and below `EbonyNatural` / `SharpBody` bottom (`0.7188`),
 *     plus separates `SharpBody` from `IvorySlip` and `Keyframe_SideCheeks` from `Keyframe_CheekInlay_*`.
 *  5. Progressively steps the sub-millimeter `Korpus_Nameboard_*`, `Korpus_Keywell_Cheek_*`, and
 *     `Korpus_Schlossbrett_*` marquetry/hardware laminates for crisp, shimmer-free rendering at all distances.
 */
function sanitizeFortepianoStageGeometry(rootObject) {
  rootObject.updateMatrixWorld(true);
  const rootInv = rootObject.matrixWorld.clone().invert();
  const localToRoot = new THREE.Matrix4();
  const rootToLocal = new THREE.Matrix4();
  const vTmp = new THREE.Vector3();

  const nameboardZShift = {
    korpus_nameboard_crossband_left_bass: 0.0004,
    korpus_nameboard_crossband_right_treble: 0.0004,
    korpus_nameboard_ebonyborder_left_bass: 0.0009,
    korpus_nameboard_ebonyborder_right_treble: 0.0009,
    korpus_nameboard_diamond_outerebony: 0.0009,
    korpus_nameboard_maplepurfling_left_bass: 0.0014,
    korpus_nameboard_maplepurfling_right_treble: 0.0014,
    korpus_nameboard_diamond_maplepurfling: 0.0014,
    korpus_nameboard_innerebonypurfling_left_bass: 0.0019,
    korpus_nameboard_innerebonypurfling_right_treble: 0.0019,
    korpus_nameboard_sycamorepanel_left_bass: 0.0024,
    korpus_nameboard_sycamorepanel_right_treble: 0.0024,
    korpus_nameboard_diamond_escutcheon: 0.0021,
    korpus_nameboard_keyhole_lockplate: -0.0014,
    korpus_nameboard_keyhole_slot_lower: 0.0027,
    korpus_nameboard_keyhole_slot_upperbore: 0.0027,
    korpus_schlossbrett_escutcheon: 0.0006,
    korpus_schlossbrett_keyhole_slot: 0.0012,
  };

  const cheekInlayXShift = {
    korpus_keywell_cheek_walnutcrossband_bass_l: 0.00015,
    korpus_keywell_cheek_ebonyframe_bass_l: 0.00035,
    korpus_keywell_cheek_maplepurfling_bass_l: 0.00055,
    korpus_keywell_cheek_innerebonypurfling_bass_l: 0.00075,
    korpus_keywell_cheek_sycamoreinlay_bass_l: 0.00095,
    korpus_keywell_cheek_walnutcrossband_treble_r: -0.00015,
    korpus_keywell_cheek_ebonyframe_treble_r: -0.00035,
    korpus_keywell_cheek_maplepurfling_treble_r: -0.00055,
    korpus_keywell_cheek_innerebonypurfling_treble_r: -0.00075,
    korpus_keywell_cheek_sycamoreinlay_treble_r: -0.00095,
  };

  rootObject.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.geometry || !mesh.geometry.attributes?.position) return;
    const rawName = mesh.name || "";
    const n = rawName.toLowerCase();
    const geom = mesh.geometry;
    const posAttr = geom.attributes.position;
    const count = posAttr.count;

    localToRoot.multiplyMatrices(rootInv, mesh.matrixWorld);
    rootToLocal.copy(localToRoot).invert();

    // Special pass: strip the 2 detached outer boxes (|x| > 0.30) from Korpus_KneeLever_Kniehebel
    // and recenter its rotation pivot onto Korpus_KneeLever_MountingBar (y = 0.642, z = -0.068).
    if (n === "korpus_kneelever_kniehebel") {
      if (geom.index) {
        const srcIdx = geom.index.array;
        const kept = [];
        for (let i = 0; i + 2 < srcIdx.length; i += 3) {
          const i0 = srcIdx[i];
          const i1 = srcIdx[i + 1];
          const i2 = srcIdx[i + 2];
          vTmp.fromBufferAttribute(posAttr, i0).applyMatrix4(localToRoot);
          const x0 = vTmp.x;
          vTmp.fromBufferAttribute(posAttr, i1).applyMatrix4(localToRoot);
          const x1 = vTmp.x;
          vTmp.fromBufferAttribute(posAttr, i2).applyMatrix4(localToRoot);
          const x2 = vTmp.x;
          const cx = (x0 + x1 + x2) / 3.0;
          if (Math.abs(cx) <= 0.30) {
            kept.push(i0, i1, i2);
          }
        }
        geom.setIndex(kept);
      }
      const pivotY = 0.642;
      const pivotZ = -0.068;
      for (let v = 0; v < count; v++) {
        vTmp.fromBufferAttribute(posAttr, v).applyMatrix4(localToRoot);
        vTmp.y -= pivotY;
        vTmp.z -= pivotZ;
        posAttr.setXYZ(v, vTmp.x, vTmp.y, vTmp.z);
      }
      mesh.position.set(0.0, pivotY, pivotZ);
      mesh.updateMatrixWorld(true);
      posAttr.needsUpdate = true;
      geom.computeBoundingBox();
      geom.computeBoundingSphere();
      return;
    }

    // Pre-scan slice midpoints for 61 LimewoodLever meshes so L/T-notched natural keys inset symmetrically
    let isLimewoodLever = n.includes("limewoodlever");
    let isNaturalKey = false;
    let isSharpKey = false;
    let midXRear = 0.0;
    let midXFront = 0.0;

    if (isLimewoodLever && mesh.parent) {
      for (const sib of mesh.parent.children) {
        const sn = (sib.name || "").toLowerCase();
        if (sn.includes("keyfrontmoulding") || sn.includes("ebonynatural")) isNaturalKey = true;
        if (sn.includes("sharpbody")) isSharpKey = true;
      }
      let minRear = Infinity, maxRear = -Infinity;
      let minFront = Infinity, maxFront = -Infinity;
      for (let v = 0; v < count; v++) {
        vTmp.fromBufferAttribute(posAttr, v).applyMatrix4(localToRoot);
        if (vTmp.z > -0.152 && vTmp.z < -0.070) {
          if (vTmp.x < minRear) minRear = vTmp.x;
          if (vTmp.x > maxRear) maxRear = vTmp.x;
        } else if (vTmp.z >= -0.070) {
          if (vTmp.x < minFront) minFront = vTmp.x;
          if (vTmp.x > maxFront) maxFront = vTmp.x;
        }
      }
      if (Number.isFinite(minRear) && Number.isFinite(maxRear)) {
        midXRear = 0.5 * (minRear + maxRear);
      }
      if (Number.isFinite(minFront) && Number.isFinite(maxFront)) {
        midXFront = 0.5 * (minFront + maxFront);
      } else {
        midXFront = midXRear;
      }
      if (!Number.isFinite(minRear)) midXRear = midXFront;
    }

    const zShift = nameboardZShift[n] || 0.0;
    const xShift = cheekInlayXShift[n] || 0.0;

    const isUndersideFront = n === "korpus_keybed_underside_frame_front";
    const isUndersideBass = n === "korpus_keybed_underside_frame_bass";
    const isUndersideTreble = n === "korpus_keybed_underside_frame_treble";
    const isUndersideRear = n === "korpus_keybed_underside_frame_rear";
    const isUnterbodenPlank =
      n === "korpus_unterboden_keybed_plank" || n.startsWith("korpus_unterboden_plank_");
    const isUnterbodenSeam = n.startsWith("korpus_unterboden_seamshadow_");
    const isInnerCheekBass = n === "korpus_keywell_innercheek_bass";
    const isInnerCheekTreble = n === "korpus_keywell_innercheek_treble";
    const isNameboardSpan =
      n === "korpus_nameboard_vorsatzbrett" ||
      n === "korpus_nameboard_cap_moulding" ||
      n === "korpus_nameboard_cap_ebonyfillet";
    const isSharpBody = n.includes("sharpbody");
    const isKeyframeSideCheeks = n === "keyframe_sidecheeks";
    const isKeyframeTenons = n === "keyframe_exposedtenons_endgrain";

    if (
      !isLimewoodLever &&
      !zShift &&
      !xShift &&
      !isUndersideFront &&
      !isUndersideBass &&
      !isUndersideTreble &&
      !isUndersideRear &&
      !isUnterbodenPlank &&
      !isUnterbodenSeam &&
      !isInnerCheekBass &&
      !isInnerCheekTreble &&
      !isNameboardSpan &&
      !isSharpBody &&
      !isKeyframeSideCheeks &&
      !isKeyframeTenons
    ) {
      return;
    }

    let modified = false;
    for (let v = 0; v < count; v++) {
      vTmp.fromBufferAttribute(posAttr, v).applyMatrix4(localToRoot);
      let rx = vTmp.x;
      let ry = vTmp.y;
      let rz = vTmp.z;

      if (isUndersideFront) {
        rx = Math.max(-0.4700, Math.min(0.4700, rx));
        ry = Math.max(0.6566, Math.min(0.6718, ry));
        rz = Math.max(-0.0220, Math.min(-0.0085, rz));
        modified = true;
      } else if (isUndersideBass) {
        rx = Math.max(-0.4715, rx);
        ry = Math.max(0.6566, Math.min(0.6718, ry));
        modified = true;
      } else if (isUndersideTreble) {
        rx = Math.min(0.4715, rx);
        ry = Math.max(0.6566, Math.min(0.6718, ry));
        modified = true;
      } else if (isUndersideRear) {
        rx = Math.max(-0.4715, Math.min(0.4715, rx));
        ry = Math.max(0.6566, Math.min(0.6718, ry));
        modified = true;
      } else if (isUnterbodenPlank) {
        rx = Math.max(-0.4720, Math.min(0.4720, rx));
        ry = Math.max(0.6564, Math.min(0.6718, ry));
        modified = true;
      } else if (isUnterbodenSeam) {
        ry = Math.max(0.6559, ry);
        modified = true;
      } else if (isInnerCheekBass) {
        if (ry < 0.6850) ry -= 0.0070;
        if (rx < -0.4608) rx = -0.4608;
        modified = true;
      } else if (isInnerCheekTreble) {
        if (ry < 0.6850) ry -= 0.0070;
        if (rx > 0.4608) rx = 0.4608;
        modified = true;
      } else if (isNameboardSpan) {
        rx = Math.max(-0.4439, Math.min(0.4439, rx));
        modified = true;
      } else if (isLimewoodLever) {
        if (rz > -0.1520) {
          const midX = rz >= -0.0700 ? midXFront : midXRear;
          const dx = midX - rx;
          rx += Math.sign(dx) * Math.min(0.0009, Math.abs(dx) * 0.28);
          if (isNaturalKey) {
            rz = Math.min(rz, -0.0245);
            ry = Math.max(0.7068, Math.min(0.7174, ry));
          } else if (isSharpKey) {
            rz = Math.min(rz, -0.0725);
            ry = Math.max(0.7072, Math.min(0.7174, ry));
          }
          modified = true;
        }
      } else if (isSharpBody) {
        if (ry > 0.7295) {
          ry = 0.7301;
          modified = true;
        } else if (ry < 0.7195) {
          ry = 0.7192;
          modified = true;
        }
      } else if (isKeyframeSideCheeks) {
        if (rz > -0.1445) {
          const signX = rx < 0.0 ? -1.0 : 1.0;
          const absX = Math.max(0.4242, Math.min(0.4398, Math.abs(rx)));
          rx = signX * absX;
          ry = Math.min(0.7184, ry);
          rz = Math.min(-0.0205, rz);
          modified = true;
        }
      } else if (isKeyframeTenons) {
        if (rz > -0.1000 && Math.abs(rx) > 0.4395) {
          rx = Math.sign(rx) * 0.4395;
          modified = true;
        }
      }

      if (zShift !== 0.0) {
        rz += zShift;
        modified = true;
      }
      if (xShift !== 0.0) {
        rx += xShift;
        modified = true;
      }

      if (modified) {
        vTmp.set(rx, ry, rz).applyMatrix4(rootToLocal);
        posAttr.setXYZ(v, vTmp.x, vTmp.y, vTmp.z);
      }
    }

    if (modified) {
      posAttr.needsUpdate = true;
      geom.computeBoundingBox();
      geom.computeBoundingSphere();
    }
  });
}

function upgradeFortepianoStageMaterials(rootObject, stageEnvTex, maxAniso) {
  const upgradedCache = new Map();
  const hoverHighlightMaterials = [];
  let sharedWalnutMat = null;
  let sharedCrimsonMat = null;
  let sharedBrassMat = null;
  let upgradedMeshes = 0;

  rootObject.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.geometry) return;
    upgradedMeshes++;

    const hasTangents = sanitizeAndComputeTangents(mesh.geometry);
    const meshCtx = `${mesh.name || ""} ${mesh.parent?.name || ""}`;

    const upgradeSingleMat = (srcMat) => {
      if (!srcMat) return srcMat;
      const surfaceClass = classifyOrganologicalSurface(srcMat.name, meshCtx);
      const offsetTier = getPolygonOffsetTier(mesh.name, srcMat.name);
      const cacheKey = `${srcMat.uuid}::${surfaceClass}::tan=${hasTangents ? 1 : 0}::po=${offsetTier}`;
      if (upgradedCache.has(cacheKey)) {
        return upgradedCache.get(cacheKey);
      }

      const phys = new THREE.MeshPhysicalMaterial({
        name: srcMat.name || `Fortepiano_${surfaceClass}`,
        color: srcMat.color ? srcMat.color.clone() : new THREE.Color(0xffffff),
        map: srcMat.map || null,
        normalMap: srcMat.normalMap || null,
        normalScale: srcMat.normalScale ? srcMat.normalScale.clone() : new THREE.Vector2(1, 1),
        roughness: typeof srcMat.roughness === "number" ? srcMat.roughness : 0.45,
        roughnessMap: srcMat.roughnessMap || null,
        metalness: typeof srcMat.metalness === "number" ? srcMat.metalness : 0.0,
        metalnessMap: srcMat.metalnessMap || null,
        aoMap: srcMat.aoMap || null,
        aoMapIntensity: typeof srcMat.aoMapIntensity === "number" ? srcMat.aoMapIntensity : 1.0,
        emissive: srcMat.emissive ? srcMat.emissive.clone() : new THREE.Color(0x000000),
        emissiveMap: srcMat.emissiveMap || null,
        emissiveIntensity: typeof srcMat.emissiveIntensity === "number" ? srcMat.emissiveIntensity : 1.0,
        vertexColors: Boolean(srcMat.vertexColors && mesh.geometry.attributes.color),
        transparent: Boolean(srcMat.transparent),
        opacity: typeof srcMat.opacity === "number" ? srcMat.opacity : 1.0,
        side: srcMat.side !== undefined ? srcMat.side : THREE.FrontSide,
        envMap: stageEnvTex,
      });

      switch (surfaceClass) {
        case "walnut_french_polish":
          phys.metalness = 0.0;
          phys.roughness = phys.roughnessMap ? Math.min(0.84, Math.max(0.20, phys.roughness)) : 0.26;
          if (phys.map) {
            phys.color.setRGB(0.92, 0.75, 0.60);
          }
          if (phys.normalMap) {
            phys.normalScale.set(1.22, 1.22);
          }
          phys.clearcoat = 0.72;
          phys.clearcoatRoughness = 0.14;
          phys.ior = 1.53;
          phys.reflectivity = 0.64;
          phys.envMapIntensity = 1.15;
          hoverHighlightMaterials.push({ mat: phys, baseEnv: 1.15, hoverEnv: 1.48 });
          if (!sharedWalnutMat && phys.map) sharedWalnutMat = phys;
          break;

        case "deckel_coffer_panel":
          phys.metalness = 0.0;
          phys.roughness = 0.29;
          if (phys.map) {
            phys.color.setRGB(0.86, 0.67, 0.50);
          }
          if (phys.normalMap) {
            phys.normalScale.set(1.50, 1.50);
          }
          phys.clearcoat = 0.34;
          phys.clearcoatRoughness = 0.22;
          phys.ior = 1.52;
          phys.reflectivity = 0.48;
          phys.envMapIntensity = 0.82;
          hoverHighlightMaterials.push({ mat: phys, baseEnv: 0.82, hoverEnv: 1.08 });
          break;

        case "walnut_interior":
          phys.metalness = 0.0;
          phys.roughness = 0.24;
          if (phys.map) {
            phys.color.setRGB(1.14, 0.92, 0.70);
          }
          if (phys.normalMap) {
            phys.normalScale.set(1.60, 1.60);
          }
          phys.clearcoat = 0.48;
          phys.clearcoatRoughness = 0.20;
          phys.ior = 1.53;
          phys.reflectivity = 0.56;
          phys.envMapIntensity = 0.96;
          break;

        case "walnut_endgrain":
          phys.metalness = 0.0;
          phys.clearcoat = 0.40;
          phys.clearcoatRoughness = 0.28;
          phys.ior = 1.52;
          phys.envMapIntensity = 1.10;
          break;

        case "sycamore_marquetry":
          phys.metalness = 0.0;
          if (phys.map) {
            phys.color.setRGB(0.98, 0.87, 0.67);
          }
          phys.clearcoat = 0.68;
          phys.clearcoatRoughness = 0.16;
          phys.ior = 1.53;
          phys.reflectivity = 0.62;
          phys.sheen = 0.22;
          phys.sheenRoughness = 0.38;
          phys.sheenColor = new THREE.Color(0xffe7ba);
          phys.envMapIntensity = 1.22;
          if (hasTangents) {
            phys.anisotropy = 0.24;
          }
          break;

        case "ebonized_rim_trim":
          phys.metalness = 0.0;
          phys.map = null;
          phys.color.setHex(0x1c140e);
          phys.roughness = 0.36;
          phys.clearcoat = 0.38;
          phys.clearcoatRoughness = 0.24;
          phys.ior = 1.49;
          phys.reflectivity = 0.44;
          phys.sheen = 0.16;
          phys.sheenRoughness = 0.58;
          phys.sheenColor = new THREE.Color(0x3a2616);
          phys.envMapIntensity = 0.76;
          break;

        case "ebony_polished":
          phys.metalness = 0.0;
          if (phys.map) {
            phys.color.setRGB(1.0, 1.0, 1.0);
          } else {
            phys.color.setHex(0x12100e);
          }
          if (phys.normalMap) {
            phys.normalScale.set(1.65, 1.65);
          }
          phys.roughness = 0.24;
          phys.clearcoat = 0.48;
          phys.clearcoatRoughness = 0.18;
          phys.ior = 1.51;
          phys.reflectivity = 0.48;
          phys.envMapIntensity = 0.85;
          break;

        case "bone_ivory":
          phys.metalness = 0.0;
          phys.clearcoat = 0.38;
          phys.clearcoatRoughness = 0.24;
          phys.ior = 1.54;
          phys.sheen = 0.18;
          phys.sheenRoughness = 0.44;
          phys.sheenColor = new THREE.Color(0xfff7e6);
          phys.envMapIntensity = 1.18;
          break;

        case "alpine_spruce":
          phys.metalness = 0.0;
          phys.clearcoat = 0.24;
          phys.clearcoatRoughness = 0.40;
          phys.ior = 1.50;
          phys.sheen = 0.14;
          phys.sheenRoughness = 0.54;
          phys.sheenColor = new THREE.Color(0xfff0d2);
          phys.envMapIntensity = 1.14;
          if (phys.normalMap) {
            phys.normalScale.set(1.18, 1.18);
          }
          break;

        case "bridge_hardwood":
          phys.metalness = 0.0;
          phys.clearcoat = 0.34;
          phys.clearcoatRoughness = 0.28;
          phys.ior = 1.52;
          phys.envMapIntensity = 1.16;
          break;

        case "wrestplank_oak":
          phys.metalness = 0.0;
          phys.clearcoat = 0.26;
          phys.clearcoatRoughness = 0.34;
          phys.ior = 1.51;
          phys.envMapIntensity = 1.10;
          break;

        case "action_wood":
          phys.metalness = 0.0;
          phys.clearcoat = 0.09;
          phys.clearcoatRoughness = 0.50;
          phys.sheen = 0.12;
          phys.sheenRoughness = 0.68;
          phys.sheenColor = new THREE.Color(0xf5e2c4);
          phys.envMapIntensity = 1.04;
          break;

        case "matte_cavity":
          phys.metalness = 0.0;
          phys.clearcoat = 0.0;
          phys.roughness = 0.92;
          phys.reflectivity = 0.05;
          phys.envMapIntensity = 0.14;
          break;

        case "turned_underside_wood":
          phys.metalness = 0.0;
          phys.clearcoat = 0.08;
          phys.clearcoatRoughness = 0.48;
          phys.roughness = Math.max(0.46, phys.roughness || 0.50);
          phys.envMapIntensity = 0.72;
          break;

        case "pine_conifer":
          phys.metalness = 0.0;
          phys.clearcoat = 0.04;
          phys.clearcoatRoughness = 0.65;
          phys.sheen = 0.10;
          phys.sheenRoughness = 0.76;
          phys.sheenColor = new THREE.Color(0xe8d0ae);
          phys.envMapIntensity = 0.92;
          break;

        case "madder_wool_cloth":
          phys.metalness = 0.0;
          phys.clearcoat = 0.0;
          phys.roughness = Math.max(0.82, phys.roughness);
          phys.sheen = 0.92;
          phys.sheenRoughness = 0.68;
          phys.sheenColor = new THREE.Color(0xd85c5c);
          phys.envMapIntensity = 0.80;
          if (!phys.normalMap) {
            phys.normalMap = getMicrofiberNormalMap();
            phys.normalScale.set(0.45, 0.45);
          }
          if (!sharedCrimsonMat) sharedCrimsonMat = phys;
          break;

        case "tawed_buckskin":
          phys.metalness = 0.0;
          phys.clearcoat = 0.0;
          phys.roughness = Math.max(0.76, phys.roughness);
          phys.sheen = 0.92;
          phys.sheenRoughness = 0.68;
          phys.sheenColor = new THREE.Color(0xfff7ea);
          phys.envMapIntensity = 0.86;
          if (!phys.normalMap) {
            phys.normalMap = getMicrofiberNormalMap();
            phys.normalScale.set(0.38, 0.38);
          }
          break;

        case "tarnished_brass":
          phys.metalness = Math.max(0.87, phys.metalness || 0.88);
          phys.roughness = Math.min(0.32, Math.max(0.22, phys.roughness || 0.27));
          phys.envMapIntensity = 1.38;
          phys.clearcoat = 0.10;
          phys.clearcoatRoughness = 0.34;
          if (hasTangents) {
            phys.anisotropy = 0.52;
          }
          if (!sharedBrassMat) sharedBrassMat = phys;
          break;

        case "brass_strings":
          phys.metalness = Math.max(0.84, phys.metalness || 0.85);
          phys.roughness = Math.max(0.28, phys.roughness || 0.32);
          phys.envMapIntensity = 1.16;
          if (hasTangents) {
            phys.anisotropy = 0.55;
          }
          break;

        case "iron_strings":
          phys.metalness = Math.max(0.84, phys.metalness || 0.85);
          phys.roughness = Math.max(0.30, phys.roughness || 0.34);
          phys.envMapIntensity = 1.14;
          if (hasTangents) {
            phys.anisotropy = 0.55;
          }
          break;

        case "forged_wirbel":
          phys.metalness = Math.max(0.86, phys.metalness || 0.88);
          phys.roughness = Math.min(0.34, Math.max(0.24, phys.roughness || 0.29));
          phys.envMapIntensity = 1.45;
          phys.iridescence = 0.16;
          phys.iridescenceIOR = 1.38;
          if (hasTangents) {
            phys.anisotropy = 0.55;
          }
          break;

        case "wrought_iron":
          phys.metalness = Math.max(0.85, phys.metalness || 0.86);
          phys.roughness = Math.min(0.34, Math.max(0.24, phys.roughness || 0.30));
          phys.envMapIntensity = 1.42;
          if (hasTangents) {
            phys.anisotropy = 0.50;
          }
          break;

        default:
          break;
      }

      if (offsetTier !== 0.0) {
        phys.polygonOffset = true;
        phys.polygonOffsetFactor = offsetTier;
        phys.polygonOffsetUnits = offsetTier;
      }

      configureTextureFiltering(phys, maxAniso);
      phys.needsUpdate = true;
      upgradedCache.set(cacheKey, phys);
      return phys;
    };

    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map(upgradeSingleMat);
    } else if (mesh.material) {
      mesh.material = upgradeSingleMat(mesh.material);
    }
  });

  return {
    upgradedMeshes,
    upgradedMaterials: upgradedCache.size,
    hoverHighlightMaterials,
    sharedWalnutMat,
    sharedCrimsonMat,
    sharedBrassMat,
  };
}

/**
 * Builds a period-matched c. 1780 South German Neoclassical walnut & madder-velvet recital bench
 * positioned ergonomically at local (0.0, 0.0, +0.38) in front of the 61-key Klaviatur.
 * Its 4 tapered turned walnut legs touch y = 0.0 at lx = +-0.32, lz = 0.38 +- 0.14,
 * mapping to Koerner Hall world (wx, wz) = (1.08, 3.97), (1.08, 3.33), (1.36, 3.97), (1.36, 3.33).
 */
function buildPeriodWalnutRecitalBench(stageEnvTex, pbrRefs) {
  const benchGroup = new THREE.Group();
  benchGroup.name = "Fortepiano_Walnut_RecitalBench";
  benchGroup.position.set(0.0, 0.0, 0.38);

  const walnutMat =
    pbrRefs.sharedWalnutMat ||
    new THREE.MeshPhysicalMaterial({
      name: "Bench_Walnut_Polish",
      color: new THREE.Color(0x5a3620),
      roughness: 0.28,
      metalness: 0.0,
      clearcoat: 0.68,
      clearcoatRoughness: 0.16,
      ior: 1.53,
      envMap: stageEnvTex,
      envMapIntensity: 1.12,
    });

  const velvetMat = new THREE.MeshPhysicalMaterial({
    name: "Bench_Madder_Velvet",
    color: new THREE.Color(0x4a1718),
    map: pbrRefs.sharedCrimsonMat?.map || null,
    normalMap: getMicrofiberNormalMap(),
    normalScale: new THREE.Vector2(0.38, 0.38),
    roughness: 0.88,
    metalness: 0.0,
    clearcoat: 0.0,
    sheen: 0.86,
    sheenRoughness: 0.64,
    sheenColor: new THREE.Color(0xb84846),
    envMap: stageEnvTex,
    envMapIntensity: 0.72,
  });

  const brassMat =
    pbrRefs.sharedBrassMat ||
    new THREE.MeshPhysicalMaterial({
      name: "Bench_Antique_Brass",
      color: new THREE.Color(0xb89248),
      metalness: 0.88,
      roughness: 0.28,
      envMap: stageEnvTex,
      envMapIntensity: 1.25,
    });

  // Molded walnut apron rails (width 0.70 m, depth 0.34 m, height 0.062 m around y = 0.425 m)
  const apronGeo = new THREE.BoxGeometry(0.69, 0.058, 0.33);
  sanitizeAndComputeTangents(apronGeo);
  const apronMesh = new THREE.Mesh(apronGeo, walnutMat);
  apronMesh.position.set(0.0, 0.422, 0.0);
  benchGroup.add(apronMesh);

  // Subtle lower ebonized bead along bottom of walnut apron
  const beadMat = new THREE.MeshPhysicalMaterial({
    name: "Bench_Ebonized_Bead",
    color: new THREE.Color(0x1c140e),
    roughness: 0.38,
    clearcoat: 0.35,
    envMap: stageEnvTex,
    envMapIntensity: 0.70,
  });
  const beadGeo = new THREE.BoxGeometry(0.702, 0.010, 0.342);
  sanitizeAndComputeTangents(beadGeo);
  const beadMesh = new THREE.Mesh(beadGeo, beadMat);
  beadMesh.position.set(0.0, 0.392, 0.0);
  benchGroup.add(beadMesh);

  // Plush upholstered madder-crimson / espresso velvet cushion (top at y = 0.486 m)
  const cushionBaseGeo = new THREE.BoxGeometry(0.71, 0.036, 0.35);
  sanitizeAndComputeTangents(cushionBaseGeo);
  const cushionBase = new THREE.Mesh(cushionBaseGeo, velvetMat);
  cushionBase.position.set(0.0, 0.466, 0.0);
  benchGroup.add(cushionBase);

  const cushionCrownGeo = new THREE.BoxGeometry(0.685, 0.014, 0.325);
  sanitizeAndComputeTangents(cushionCrownGeo);
  const cushionCrown = new THREE.Mesh(cushionCrownGeo, velvetMat);
  cushionCrown.position.set(0.0, 0.486, 0.0);
  benchGroup.add(cushionCrown);

  // 4 Tapered turned Neoclassical walnut legs with turned collars & brass ferrule rings
  const legOffsets = [
    [-0.32, -0.14],
    [0.32, -0.14],
    [-0.32, 0.14],
    [0.32, 0.14],
  ];
  const shaftGeo = new THREE.CylinderGeometry(0.021, 0.0125, 0.395, 20);
  const collarTopGeo = new THREE.CylinderGeometry(0.026, 0.025, 0.024, 20);
  const collarRingGeo = new THREE.CylinderGeometry(0.023, 0.023, 0.012, 20);
  const footBulbGeo = new THREE.CylinderGeometry(0.014, 0.0105, 0.022, 18);
  const brassRingGeo = new THREE.CylinderGeometry(0.0148, 0.0142, 0.008, 18);
  [shaftGeo, collarTopGeo, collarRingGeo, footBulbGeo, brassRingGeo].forEach(sanitizeAndComputeTangents);

  for (const [lx, lz] of legOffsets) {
    const leg = new THREE.Group();
    leg.position.set(lx, 0.0, lz);

    const shaft = new THREE.Mesh(shaftGeo, walnutMat);
    shaft.position.set(0.0, 0.205, 0.0);
    leg.add(shaft);

    const topCollar = new THREE.Mesh(collarTopGeo, walnutMat);
    topCollar.position.set(0.0, 0.384, 0.0);
    leg.add(topCollar);

    const midRing = new THREE.Mesh(collarRingGeo, walnutMat);
    midRing.position.set(0.0, 0.342, 0.0);
    leg.add(midRing);

    const brassFerrule = new THREE.Mesh(brassRingGeo, brassMat);
    brassFerrule.position.set(0.0, 0.032, 0.0);
    leg.add(brassFerrule);

    const footBulb = new THREE.Mesh(footBulbGeo, walnutMat);
    footBulb.position.set(0.0, 0.011, 0.0);
    leg.add(footBulb);

    benchGroup.add(leg);
  }

  return benchGroup;
}

/**
 * Builds off-scene CPU raycast hull meshes matching the 1780 Fortepiano walnut case, legs,
 * 48.5° open lid, and recital bench so clicking the fortepiano from any of the 1,135 seats
 * hits in < 0.02 ms with 0 extra GPU draw calls!
 */
function buildOffSceneFortepianoPickColliders() {
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const grp = new THREE.Group();
  grp.position.copy(FORTEPIANO_STAGE_ANCHOR_POS);
  grp.rotation.y = FORTEPIANO_STAGE_ROT_Y;

  // Compact 1.02 m x 2.12 m case + leg silhouette
  const bodyGeo = new THREE.BoxGeometry(1.04, 0.94, 2.14);
  bodyGeo.translate(0.0, 0.47, -1.04);
  const bodyMesh = new THREE.Mesh(bodyGeo, mat);
  bodyMesh.userData.isFortepianoCollider = true;

  // 48.5° open hinged walnut lid
  const lidGeo = new THREE.BoxGeometry(0.98, 0.05, 2.06);
  lidGeo.translate(0.48, 0.0, -1.02);
  const lidMesh = new THREE.Mesh(lidGeo, mat);
  lidMesh.position.set(-0.48, 0.90, 0.0);
  lidMesh.rotation.z = (48.5 * Math.PI) / 180.0;
  lidMesh.userData.isFortepianoCollider = true;

  // Period walnut recital bench collider in front of keyboard
  const benchGeo = new THREE.BoxGeometry(0.74, 0.50, 0.38);
  benchGeo.translate(0.0, 0.25, 0.38);
  const benchMesh = new THREE.Mesh(benchGeo, mat);
  benchMesh.userData.isFortepianoCollider = true;

  grp.add(bodyMesh);
  grp.add(lidMesh);
  grp.add(benchMesh);
  grp.updateMatrixWorld(true);
  return [bodyMesh, lidMesh, benchMesh];
}

export async function loadGstaticGlb(gltfLoader, gstaticUrl) {
  const proxyUrl = gstaticUrl.replace(
    "https://www.gstatic.com/aistudio/starter-apps/koerner-hall/",
    "./gstatic-koerner/"
  );
  try {
    return await gltfLoader.loadAsync(proxyUrl);
  } catch (err) {
    console.warn(`[KoernerHall] Proxy GLB load failed (${proxyUrl}), falling back to direct GStatic URL:`, err);
    return await gltfLoader.loadAsync(gstaticUrl);
  }
}

export async function loadFortepianoStageRig({
  scene,
  renderer,
  gltfLoader,
  maxAniso = 8,
  acoustics,
  onWakeRender = () => {},
}) {
  const gltf = await loadGstaticGlb(
    gltfLoader,
    "https://www.gstatic.com/aistudio/starter-apps/koerner-hall/stein_1780_fortepiano.glb"
  );
  const root = gltf.scene;

  sanitizeFortepianoStageGeometry(root);
  const stageFortepianoEnvRT = buildKoernerStageFortepianoPMREM(renderer);
  const pbr = upgradeFortepianoStageMaterials(root, stageFortepianoEnvRT.texture, maxAniso);

  const benchGroup = buildPeriodWalnutRecitalBench(stageFortepianoEnvRT.texture, pbr);

  const pianoAnchor = new THREE.Group();
  pianoAnchor.name = "Stein1780_Fortepiano_StageAnchor";
  pianoAnchor.position.copy(FORTEPIANO_STAGE_ANCHOR_POS);
  pianoAnchor.rotation.y = FORTEPIANO_STAGE_ROT_Y;
  pianoAnchor.add(root);
  pianoAnchor.add(benchGroup);
  scene.add(pianoAnchor);

  const restTransforms = new Map();
  const rigNodes = {
    loaded: true,
    lidMain: null,
    lidFlap: null,
    lidProp: null,
    musicDesk: null,
    actionSled: null,
    damperRack: null,
    kneeLever: null,
    keys: new Array(FORTEPIANO_TOTAL_KEYS).fill(null),
    hammers: new Array(FORTEPIANO_TOTAL_KEYS).fill(null),
    escapements: new Array(FORTEPIANO_TOTAL_KEYS).fill(null),
    dampers: new Array(FORTEPIANO_TOTAL_KEYS).fill(null),
    courses: new Array(FORTEPIANO_TOTAL_KEYS).fill(null),
  };

  root.traverse((obj) => {
    restTransforms.set(obj.uuid, {
      pos: obj.position.clone(),
      rot: obj.rotation.clone(),
    });

    const name = obj.name || "";
    if (name === "Lid_Main_Pivot" || name.startsWith("Lid_Main_Pivot")) {
      rigNodes.lidMain = obj;
    } else if (name === "Lid_Flap_Pivot" || name.startsWith("Lid_Flap_Pivot")) {
      rigNodes.lidFlap = obj;
    } else if (name === "Lid_Prop_Pivot" || name.startsWith("Lid_Prop_Pivot")) {
      rigNodes.lidProp = obj;
    } else if (name === "MusicDesk_Pivot" || name.startsWith("MusicDesk_Pivot")) {
      rigNodes.musicDesk = obj;
    } else if (name === "ActionSled_Root" || name.startsWith("ActionSled_Root")) {
      rigNodes.actionSled = obj;
    } else if (name === "DamperRack_GlobalLift" || name.startsWith("DamperRack_GlobalLift")) {
      rigNodes.damperRack = obj;
    } else if (name === "Korpus_KneeLever_Kniehebel" || name.startsWith("Korpus_KneeLever_Kniehebel")) {
      rigNodes.kneeLever = obj;
    }

    const keyMatch = name.match(/^Key_0*(\d+)(?:_|$)/i);
    if (keyMatch) {
      const kNum = parseInt(keyMatch[1], 10);
      if (kNum >= 1 && kNum <= FORTEPIANO_TOTAL_KEYS && !rigNodes.keys[kNum - 1]) {
        rigNodes.keys[kNum - 1] = obj;
      }
    }

    const hammerMatch = name.match(/^Hammer_0*(\d+)(?:_|$)/i);
    if (hammerMatch) {
      const kNum = parseInt(hammerMatch[1], 10);
      if (kNum >= 1 && kNum <= FORTEPIANO_TOTAL_KEYS && !rigNodes.hammers[kNum - 1]) {
        rigNodes.hammers[kNum - 1] = obj;
      }
    }

    const escMatch = name.match(/^Escapement_0*(\d+)(?:_|$)/i);
    if (escMatch) {
      const kNum = parseInt(escMatch[1], 10);
      if (kNum >= 1 && kNum <= FORTEPIANO_TOTAL_KEYS && !rigNodes.escapements[kNum - 1]) {
        rigNodes.escapements[kNum - 1] = obj;
      }
    }

    const damperMatch = name.match(/^Damper_0*(\d+)(?:_|$)/i);
    if (damperMatch) {
      const kNum = parseInt(damperMatch[1], 10);
      if (kNum >= 1 && kNum <= FORTEPIANO_TOTAL_KEYS && !rigNodes.dampers[kNum - 1]) {
        rigNodes.dampers[kNum - 1] = obj;
      }
    }

    const courseMatch = name.match(/^(?:Course|String)_0*(\d+)(?:_|$)/i);
    if (courseMatch) {
      const kNum = parseInt(courseMatch[1], 10);
      if (kNum >= 1 && kNum <= FORTEPIANO_TOTAL_KEYS && !rigNodes.courses[kNum - 1]) {
        rigNodes.courses[kNum - 1] = obj;
      }
    }
  });

  // Ensure open concert pose (Lid_Main_Pivot exported at ~48.5° on iron prop stick, Notenpult visible)
  let lidAngleDeg = 48.5;
  if (rigNodes.lidMain) {
    const restMain = restTransforms.get(rigNodes.lidMain.uuid);
    if (restMain && Math.abs(restMain.rot.z) < 0.25) {
      rigNodes.lidMain.rotation.z = (48.5 * Math.PI) / 180.0;
    } else if (restMain) {
      lidAngleDeg = Number(((restMain.rot.z * 180.0) / Math.PI).toFixed(1));
    }
  }
  if (rigNodes.musicDesk) {
    rigNodes.musicDesk.visible = true;
  }

  const interactiveKeyMeshes = [];
  const keyMeshToMidi = new Map();
  for (let i = 0; i < FORTEPIANO_TOTAL_KEYS; i++) {
    const kNode = rigNodes.keys[i];
    if (!kNode) continue;
    const midi = FORTEPIANO_MIN_MIDI + i;
    kNode.traverse((ch) => {
      if (ch.isMesh) {
        keyMeshToMidi.set(ch, midi);
        interactiveKeyMeshes.push(ch);
      }
    });
  }

  pianoAnchor.updateMatrixWorld(true);

  // Coupled 61-key Prellmechanik + Auslöser escapement + overhead Keil damper + knee-lever arrays
  const keyDown = new Uint8Array(FORTEPIANO_TOTAL_KEYS);
  const keyPos = new Float32Array(FORTEPIANO_TOTAL_KEYS);
  const keyVel = new Float32Array(FORTEPIANO_TOTAL_KEYS);
  const hammerPhase = new Float32Array(FORTEPIANO_TOTAL_KEYS);
  const hammerVel = new Float32Array(FORTEPIANO_TOTAL_KEYS);
  const hammerEscaped = new Uint8Array(FORTEPIANO_TOTAL_KEYS);
  const escapementPhase = new Float32Array(FORTEPIANO_TOTAL_KEYS);
  const stringEnergy = new Float32Array(FORTEPIANO_TOTAL_KEYS);
  const damperLift = new Float32Array(FORTEPIANO_TOTAL_KEYS);

  let curKneeLever = 0.0;
  let isHoveredFromHall = false;

  const pianoWorldCenter = pianoLocalToWorld(0.0, 0.82, -0.78);
  const pickColliders = buildOffSceneFortepianoPickColliders();

  function midiToKeyIndex(rawMidi) {
    const m = foldMidiIntoFortepianoCompass(rawMidi);
    const idx = m - FORTEPIANO_MIN_MIDI;
    return idx >= 0 && idx < FORTEPIANO_TOTAL_KEYS ? idx : -1;
  }

  function strikeKey(midi, velocity = 0.80) {
    const idx = midiToKeyIndex(midi);
    if (idx < 0) return;
    if (keyDown[idx]) {
      // Crisp Prellmechanik repetition re-strike!
      keyPos[idx] = Math.min(keyPos[idx], 0.30);
      hammerPhase[idx] = Math.min(hammerPhase[idx], 0.28);
    }
    keyDown[idx] = 1;
    keyVel[idx] = velocity;
    hammerEscaped[idx] = 0;
    hammerVel[idx] = 17.5 + velocity * 15.5;
    escapementPhase[idx] = 1.0;
    stringEnergy[idx] = Math.min(1.0, velocity * 1.12);
    onWakeRender();
  }

  function holdKeyMidNote(midi, velocity = 0.78) {
    const idx = midiToKeyIndex(midi);
    if (idx < 0) return;
    keyDown[idx] = 1;
    keyPos[idx] = 1.0;
    keyVel[idx] = velocity;
    hammerPhase[idx] = 0.29;
    hammerEscaped[idx] = 1;
    escapementPhase[idx] = 0.82;
    stringEnergy[idx] = Math.min(1.0, velocity * 0.82);
    onWakeRender();
  }

  function releaseKey(midi) {
    const idx = midiToKeyIndex(midi);
    if (idx < 0) return;
    keyDown[idx] = 0;
    onWakeRender();
  }

  function releaseAllKeysAndPedals() {
    for (let i = 0; i < FORTEPIANO_TOTAL_KEYS; i++) {
      keyDown[i] = 0;
    }
    onWakeRender();
  }

  function setHoverHighlight(hovered) {
    const next = Boolean(hovered);
    if (next === isHoveredFromHall) return;
    isHoveredFromHall = next;
    for (const item of pbr.hoverHighlightMaterials) {
      item.mat.envMapIntensity = next ? item.hoverEnv : item.baseEnv;
    }
    onWakeRender();
  }

  function pickKeyAtRay(raycaster) {
    const hits = raycaster.intersectObjects(interactiveKeyMeshes, false);
    if (hits.length > 0) {
      return keyMeshToMidi.get(hits[0].object) || -1;
    }
    return -1;
  }

  function update(rawDt, instant = false) {
    const dt = Math.min(0.05, Math.max(0.0, rawDt));
    const pedLerp = instant ? 1.0 : Math.min(1.0, dt * 15.0);
    let moving = false;

    const tKnee = acoustics?.damperSustain ? 1.0 : 0.0;
    if (Math.abs(tKnee - curKneeLever) > 0.001) {
      moving = true;
    }
    curKneeLever += (tKnee - curKneeLever) * pedLerp;

    if (rigNodes.damperRack) {
      const rest = restTransforms.get(rigNodes.damperRack.uuid);
      if (rest) {
        rigNodes.damperRack.position.y = rest.pos.y + curKneeLever * 0.0055;
      }
    }
    if (rigNodes.kneeLever) {
      const rest = restTransforms.get(rigNodes.kneeLever.uuid);
      if (rest) {
        rigNodes.kneeLever.rotation.x = rest.rot.x - curKneeLever * 0.14;
      }
    }

    const nowMs = performance.now();
    for (let i = 0; i < FORTEPIANO_TOTAL_KEYS; i++) {
      const midi = FORTEPIANO_MIN_MIDI + i;
      const down = keyDown[i];
      const targetK = down ? 1.0 : 0.0;
      const diffK = targetK - keyPos[i];
      if (instant) {
        keyPos[i] = targetK;
      } else if (Math.abs(diffK) > 0.001) {
        keyPos[i] += diffK * Math.min(1.0, dt * 38.0);
        moving = true;
      } else {
        keyPos[i] = targetK;
      }

      // Prellmechanik hammer trajectory (hammerRotSign = -1 -> upward strike into bichord pair)
      if (down && !hammerEscaped[i]) {
        hammerPhase[i] = instant ? 0.90 : hammerPhase[i] + hammerVel[i] * dt;
        escapementPhase[i] = 1.0;
        if (!instant) moving = true;
        if (hammerPhase[i] >= 1.0) {
          hammerPhase[i] = 1.0;
          hammerEscaped[i] = 1;
          hammerVel[i] = -11.5;
        }
      } else if (down && hammerEscaped[i]) {
        const checkLevel = 0.29;
        escapementPhase[i] = 0.82;
        if (hammerPhase[i] > checkLevel) {
          hammerPhase[i] = instant
            ? checkLevel
            : Math.max(checkLevel, hammerPhase[i] + hammerVel[i] * dt);
          if (!instant) moving = true;
        }
      } else {
        if (instant) {
          hammerPhase[i] = 0.0;
          escapementPhase[i] = 0.0;
        } else if (hammerPhase[i] > 0.001 || escapementPhase[i] > 0.001) {
          hammerPhase[i] = Math.max(0.0, hammerPhase[i] - dt * 16.0);
          escapementPhase[i] = Math.max(0.0, escapementPhase[i] - dt * 18.0);
          moving = true;
        } else {
          hammerPhase[i] = 0.0;
          escapementPhase[i] = 0.0;
        }
      }

      const kNode = rigNodes.keys[i];
      if (kNode) {
        const rest = restTransforms.get(kNode.uuid);
        if (rest) kNode.rotation.x = rest.rot.x + keyPos[i] * 0.0733;
      }

      const hNode = rigNodes.hammers[i];
      if (hNode) {
        const rest = restTransforms.get(hNode.uuid);
        if (rest) hNode.rotation.x = rest.rot.x - hammerPhase[i] * 0.34;
      }

      const eNode = rigNodes.escapements[i];
      if (eNode) {
        const rest = restTransforms.get(eNode.uuid);
        if (rest) eNode.rotation.x = rest.rot.x + escapementPhase[i] * 0.19;
      }

      // Individual overhead Keil / Püschel damper jack lift (+10.5 mm on key press)
      const keyLiftsDamper = down || (acoustics && acoustics.keysDown.has(midi)) ? 1.0 : 0.0;
      const diffD = keyLiftsDamper - damperLift[i];
      if (instant) {
        damperLift[i] = keyLiftsDamper;
      } else if (Math.abs(diffD) > 0.001) {
        damperLift[i] += diffD * Math.min(1.0, dt * 26.0);
        moving = true;
      } else {
        damperLift[i] = keyLiftsDamper;
      }
      const dNode = rigNodes.dampers[i];
      if (dNode) {
        const rest = restTransforms.get(dNode.uuid);
        if (rest) dNode.position.y = rest.pos.y + damperLift[i] * 0.0105;
      }

      if (stringEnergy[i] > 0.002) {
        stringEnergy[i] *= instant ? 0.0 : Math.pow(0.24, dt);
        const cNode = rigNodes.courses[i];
        if (cNode) {
          const rest = restTransforms.get(cNode.uuid);
          if (rest) {
            cNode.position.x = rest.pos.x + Math.sin(nowMs * 0.095 + i) * 0.00085 * stringEnergy[i];
          }
        }
        if (!instant) moving = true;
      } else {
        const cNode = rigNodes.courses[i];
        if (cNode) {
          const rest = restTransforms.get(cNode.uuid);
          if (rest && cNode.position.x !== rest.pos.x) cNode.position.x = rest.pos.x;
        }
      }
    }

    return moving;
  }

  update(0.016, true);

  return {
    anchor: pianoAnchor,
    worldCenter: pianoWorldCenter,
    pickColliders,
    interactiveKeyMeshes,
    pickKeyAtRay,
    setHoverHighlight,
    strikeKey,
    holdKeyMidNote,
    releaseKey,
    releaseAllKeysAndPedals,
    update,
    updateMirrors() {
      // Hand-rubbed shellac walnut uses pure Float32 stage PMREM (zero planar mirror render passes needed)
    },
    dispose() {
      stageFortepianoEnvRT.dispose();
      for (const c of pickColliders) {
        if (c.geometry) c.geometry.dispose();
      }
    },
    getQAStats() {
      let activeKeysCount = 0;
      let liftedDampersCount = 0;
      for (let i = 0; i < FORTEPIANO_TOTAL_KEYS; i++) {
        if (keyPos[i] > 0.05) activeKeysCount++;
        if (damperLift[i] > 0.05 || curKneeLever > 0.05) liftedDampersCount++;
      }
      return {
        loaded: true,
        instrument: "c. 1780 Stein-Schule South German Fortepiano (HFH006)",
        upgradedMeshes: pbr.upgradedMeshes,
        upgradedMaterials: pbr.upgradedMaterials,
        keysCount: rigNodes.keys.filter(Boolean).length,
        hammersCount: rigNodes.hammers.filter(Boolean).length,
        escapementsCount: rigNodes.escapements.filter(Boolean).length,
        dampersCount: rigNodes.dampers.filter(Boolean).length,
        coursesCount: rigNodes.courses.filter(Boolean).length,
        activeKeysCount,
        liftedDampersCount,
        lidAngleDeg,
      };
    },
  };
}
