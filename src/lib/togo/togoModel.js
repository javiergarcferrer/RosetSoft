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

// Togo proportions (cm) — low and ground-hugging.
const SEAT_TOP = 38;   // seat cushion height
const BACK_TOP = 72;   // backrest height
const ARM_TOP = 56;    // armrest height

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
 * The rounded-box parts of one Togo piece at a footprint. `armCount` from
 * inferTogoForm. Each part: { role, w, h, d, x, y, z, r } in cm — the renderer
 * draws a RoundedBox of size (w,h,d) at (x,y,z) with corner radius r. Every part
 * stays within the footprint AABB so the 3D mass matches the 2D plan tile.
 */
export function togoParts(widthCm, depthCm, { armCount = 2 } = {}) {
  const W = Math.max(1, Number(widthCm) || 0);
  const D = Math.max(1, Number(depthCm) || 0);
  const armW = armCount > 0 ? clamp(W * 0.17, 16, 30) : 0;
  const backThick = clamp(D * 0.34, 26, 40);
  const seatW = Math.max(20, W - (armCount === 2 ? 2 * armW : armCount === 1 ? armW : 0));
  const seatXc = armCount === 1 ? armW / 2 : 0;           // a single arm shifts the seat off the armed side
  const backW = seatW + (armCount ? armW * 0.7 : 0);      // back tucks behind the arms (no corner gap)
  const seatBackZ = -D / 2 + backThick * 0.62;            // seat overlaps INTO the backrest
  const seatFrontZ = D / 2;
  const seatDepth = Math.max(20, seatFrontZ - seatBackZ);
  const parts = [];

  // Togo is a single, legless, low foam MASS — its identity is the quilted
  // channels grooved INTO that mass, not separate rolls. So the geometry is a
  // few generously-rounded bodies that OVERLAP into one cohesive sofa (no
  // floating gaps); the channel quilting is added as a normal map on the fabric
  // (togoSceneBuilder.makeQuiltNormalMap). r ≈ half the short side ⇒ plush.

  // Seat cushion — one puffy body, overlapping the backrest at the rear.
  parts.push({
    role: 'seat', w: seatW, h: SEAT_TOP, d: seatDepth,
    x: seatXc, y: SEAT_TOP / 2, z: (seatBackZ + seatFrontZ) / 2,
    r: clamp(Math.min(SEAT_TOP, seatDepth) * 0.5, 9, 19),
  });
  // Backrest — a thick body at the rear; its lower half overlaps the seat so the
  // two read as one continuous form (the quilt sells the recline). Its centre is
  // clamped so even the single-arm (chaise) tuck-behind stays inside the
  // footprint AABB — the 3D mass must match the 2D plan tile.
  const backX = clamp(seatXc, -(W / 2 - backW / 2), W / 2 - backW / 2);
  parts.push({
    role: 'back', w: backW, h: BACK_TOP, d: backThick,
    x: backX, y: BACK_TOP / 2, z: -D / 2 + backThick / 2,
    r: clamp(Math.min(backThick, BACK_TOP) * 0.42, 10, 18),
  });
  // Arms — full-depth bodies on the sides, overlapping the seat.
  const armXs = armCount === 2 ? [-(W / 2 - armW / 2), (W / 2 - armW / 2)]
    : armCount === 1 ? [-(W / 2 - armW / 2)] : [];
  for (const x of armXs) {
    parts.push({
      role: 'arm', w: armW, h: ARM_TOP, d: D,
      x, y: ARM_TOP / 2, z: 0,
      r: clamp(Math.min(armW, ARM_TOP) * 0.45, 9, 18),
    });
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
