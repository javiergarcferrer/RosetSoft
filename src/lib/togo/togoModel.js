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

// Togo proportions (cm) — low and ground-hugging.
const SEAT_TOP = 40;   // seat cushion height
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
  const armW = armCount > 0 ? clamp(W * 0.15, 14, 26) : 0;
  const backD = clamp(D * 0.28, 20, 32);
  const seatW = Math.max(20, W - (armCount === 2 ? 2 * armW : armCount === 1 ? armW : 0));
  const seatD = Math.max(20, D - backD);
  const seatZc = (-D / 2 + backD + D / 2) / 2;            // seat centre, between back and front edge
  const seatXc = armCount === 1 ? armW / 2 : 0;           // a single arm shifts the seat off the armed side
  const backW = seatW + (armCount ? armW * 0.5 : 0);      // back tucks behind the arms (no corner gap)
  const parts = [];

  // Seat — two ribs front↔back (the Togo channels run across the width).
  const ribD = (seatD - 2) / 2;
  for (const sign of [-1, 1]) {
    parts.push({
      role: 'seat', w: seatW, h: SEAT_TOP, d: ribD,
      x: seatXc, y: SEAT_TOP / 2, z: seatZc + sign * (ribD / 2 + 1),
      r: clamp(Math.min(SEAT_TOP, ribD) * 0.42, 4, 18),
    });
  }
  // Backrest — two reclined tiers at the rear. The lower tier (top 48cm) OVERLAPS
  // the 40cm seat so the back reads as connected, not a floating bar; the upper
  // tier completes the pile to the Togo height.
  const backZ = -D / 2 + backD / 2;
  for (const t of [{ h: 48, y: 24 }, { h: BACK_TOP - 30, y: BACK_TOP - (BACK_TOP - 30) / 2 }]) {
    parts.push({
      role: 'back', w: backW, h: t.h, d: backD,
      x: seatXc, y: t.y, z: backZ,
      r: clamp(Math.min(t.h, backD) * 0.42, 4, 16),
    });
  }
  // Arms — full-depth puffy rolls on the sides.
  const armXs = armCount === 2 ? [-(W / 2 - armW / 2), (W / 2 - armW / 2)]
    : armCount === 1 ? [-(W / 2 - armW / 2)] : [];
  for (const x of armXs) {
    parts.push({
      role: 'arm', w: armW, h: ARM_TOP, d: D,
      x, y: ARM_TOP / 2, z: 0,
      r: clamp(Math.min(armW, ARM_TOP) * 0.42, 4, 16),
    });
  }
  return parts;
}

/** The overall built height (cm) of any Togo piece — the backrest top. */
export const TOGO_HEIGHT_CM = BACK_TOP;
