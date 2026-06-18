/**
 * Procedural Togo geometry — the PURE part-list for the 3D preview.
 *
 * We have no 3D mesh assets (the source DWGs carry only the flat "Mobilier 2D"
 * plan layer; Ligne Roset's real 3D models live in the dealer's pCon/OFML trade
 * channel). So the interim 3D view GENERATES each Togo piece from its footprint:
 * the iconic Togo is a low, legless pile of puffy, ribbed cushions, which a few
 * generously-rounded boxes approximate well. This module returns ONLY numbers
 * (cm) — no three.js — so it's unit-testable and the renderer just maps each
 * part to a RoundedBox. When real GLBs arrive, the renderer swaps mesh-loading
 * in per piece and this becomes the fallback.
 *
 * Coordinates (per piece, centred on the floor): X = width (left↔right),
 * Z = depth (back ↔ front: back at −Z, the open front at +Z), Y = up (floor 0).
 * Cushions split into ribs so the silhouette reads as Togo, not a slab.
 */
import { TOGO_PIECES } from '../../assets/togo/pieces.js';

// Togo backrest height (cm) — low and ground-hugging.
const BACK_TOP = 72;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Infer a piece's form from its label + footprint, robust to ANY dealer-named
 * model (we can't assume the 5 canonical SKUs). Returns the arm count:
 *   0 = chauffeuse / fireside / armless · 1 = méridienne / chaise / corner · 2 = the rest.
 */
export function inferTogoForm(label = '', widthCm = 0, depthCm = 0) {
  const s = String(label).toLowerCase();
  if (/chauffeuse|fireside|chofesa|sin\s*brazo|armless/.test(s)) return { armCount: 0 };
  const chaise = /lounge|m[ée]ridienne|meridienne|meridiana|chaise|angle|corner/.test(s)
    || (depthCm > 0 && widthCm > 0 && depthCm >= widthCm * 1.25);
  if (chaise) return { armCount: 1 };
  return { armCount: 2 };
}

/**
 * The parts of one Togo piece at a footprint. `armCount` from inferTogoForm.
 * Togo's identity is the QUILTED CHANNELS, so they're modelled as real geometry:
 * a few rounded-box CORES form the continuous foam mass (and fill behind, so
 * nothing floats), and capsule RIDGES lay the iconic channels across that mass —
 * a front bolster + seat channels + a reclined stack of back channels + arm rolls.
 *
 * Each part is either:
 *   • a box   { role, shape:'box', w, h, d, r, x, y, z }            (RoundedBox)
 *   • a ridge { role, shape:'ridge', axis:'x'|'z', radius, length, x, y, z } (Capsule)
 * Cores stay within the footprint AABB (the 3D mass matches the 2D plan tile);
 * ridges may plush-overhang a couple of cm, like real cushions.
 */
export function togoParts(widthCm, depthCm, { armCount = 2 } = {}) {
  const W = Math.max(1, Number(widthCm) || 0);
  const D = Math.max(1, Number(depthCm) || 0);
  const armW = armCount > 0 ? clamp(W * 0.16, 18, 30) : 0;
  const backThick = clamp(D * 0.32, 26, 40);
  const seatW = Math.max(24, W - (armCount === 2 ? 2 * armW : armCount === 1 ? armW : 0));
  const seatXc = armCount === 1 ? armW / 2 : 0;           // a single arm shifts the seat off the armed side
  const backW = clamp(seatW + (armCount ? armW * 0.6 : 0), 0, W);
  const backX = clamp(seatXc, -(W / 2 - backW / 2), W / 2 - backW / 2);
  const seatBackZ = -D / 2 + backThick;
  const seatFrontZ = D / 2;
  const seatDepth = Math.max(20, seatFrontZ - seatBackZ);
  const seatCZ = (seatBackZ + seatFrontZ) / 2;
  const parts = [];
  const box = (role, w, h, d, x, y, z, r) => parts.push({ role, shape: 'box', w, h, d, x, y, z, r });
  const ridge = (role, axis, length, radius, x, y, z) => parts.push({ role, shape: 'ridge', axis, length, radius, x, y, z });

  // Cores — the continuous mass that fills behind the channel ridges.
  box('seat', seatW, 30, seatDepth + 4, seatXc, 15, seatCZ - 2, 11);
  box('back', backW, 58, 28, backX, 32, -D / 2 + 14, 11);
  const armXs = armCount === 2 ? [-(W / 2 - armW / 2), W / 2 - armW / 2]
    : armCount === 1 ? [-(W / 2 - armW / 2)] : [];
  for (const x of armXs) box('arm', armW, 50, D, x, 25, 0, 12);

  // Channels — the Togo quilting, as real capsule ridges across the mass.
  const blRad = Math.min(15, seatDepth * 0.18);
  ridge('bolster', 'x', seatW, blRad, seatXc, 16, seatFrontZ - blRad);        // front roll, front flush to the footprint
  for (let i = 0; i < 3; i++) ridge('seatch', 'x', seatW, 8, seatXc, 31, seatBackZ + 12 + i * ((seatDepth - 22) / 2));
  for (let i = 0; i < 5; i++) { const t = i / 4; ridge('backch', 'x', seatW, 8.5, backX, 16 + t * 46, (-D / 2 + 14) + 12 - t * 6); }
  for (const x of armXs) { ridge('armch', 'z', D - 16, 7, x, 49, 2); ridge('armch', 'z', D - 16, 7, x, 37, 2); }

  // Cushion seams — a settee/3-seater is several seats, not one stretched
  // cushion (the "wrong proportions" read on wide pieces). Drop a front-to-back
  // welt at each seat boundary so the mass reads as distinct cushions. Seat
  // count from the overall width (~90 cm/seat); a chair/chauffeuse stays single.
  // role 'seam' (a ridge) ⇒ the seat CORE count stays 1, so the pin holds.
  const seats = clamp(Math.round(W / 90), 1, 4);
  for (let i = 1; i < seats; i++) {
    const sx = seatXc - seatW / 2 + (i * seatW) / seats;
    ridge('seam', 'z', seatDepth - 6, 3.2, sx, 31, seatCZ);
  }

  return parts;
}

/**
 * Map a placement to one of the five canonical Togo kinds (chauf · a · gb · mc ·
 * lounge), so the renderer can look up a REAL 3D model (GLB) for it. Matches the
 * piece's label keywords first (any language), then falls back to the nearest
 * measured footprint. Returns a TOGO_PIECES id, or null if nothing is close.
 */
export function inferTogoKind(label = '', widthCm = 0, depthCm = 0) {
  const s = String(label).toLowerCase();
  for (const p of TOGO_PIECES) {
    // Skip the generic 'togo' and bare-digit keywords ('2','3') — a stray number
    // in the label ("Togo 2025") must not false-match a piece count.
    if ((p.match || []).some((k) => k !== 'togo' && !/^\d+$/.test(k) && s.includes(k))) return p.id;
  }
  if (widthCm > 0 && depthCm > 0) {
    let best = null, bestD = Infinity;
    for (const p of TOGO_PIECES) {
      const d = Math.abs(p.widthCm - widthCm) + Math.abs(p.depthCm - depthCm);
      if (d < bestD) { bestD = d; best = p.id; }
    }
    return best;
  }
  return null;
}

/** The overall built height (cm) of any Togo piece — the backrest top. */
export const TOGO_HEIGHT_CM = BACK_TOP;

/**
 * UNIFORM scale for an uploaded mesh: normalise its HEIGHT to the Togo's uniform
 * ~72 cm and keep the mesh's TRUE proportions, so it's unit-testable. Given the
 * mesh's measured world bounding-box `size` (after the loader's up-axis
 * correction), returns a single scalar `s` taking it to `heightCm`. Every piece
 * comes out the same height WITHOUT distorting its footprint — a square-footprint
 * corner stays square; we never squash a mesh per-axis to force it into the
 * catalogue's nominal width×depth (that per-axis "fit to tile" is exactly what
 * turned the square corner rectangular). It's a ratio, so it also absorbs
 * whatever unit (mm/cm/m) the FBX was exported in. The View drops the scaled mesh
 * on its footprint centre at the plan position.
 */
export function togoMeshFit(size, heightCm = TOGO_HEIGHT_CM) {
  const sy0 = Math.max(1e-6, Number(size?.y) || 0);
  const H = Math.max(1, Number(heightCm) || TOGO_HEIGHT_CM);
  return { s: H / sy0 };
}
