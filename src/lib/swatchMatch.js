/**
 * Pure matching helpers that map a quote line's `subtype` to a catalog
 * material + color. Kept free of any DB/Supabase import so the matching
 * logic — the part that decides where a remembered swatch lands — is unit
 * testable in isolation. The DB side (copying images, writing rows) lives
 * in swatchCatalog.js, which builds on these.
 *
 * The swatch picker composes the fabric portion of a subtype as
 * "MATERIAL · COLOR (#code)". Hand-typed fabrics carry no "(#code)" and so
 * have no catalog color to match against — those return null by design.
 */

import { parseSubtype } from './subtype.js';

/** The catalog color code embedded as "… (#code)", or null when absent. */
export function colorCodeFromSubtype(subtype) {
  const { fabric } = parseSubtype(subtype);
  if (!fabric) return null;
  const m = /\(#([^)]+)\)/.exec(fabric);
  return m ? m[1].trim() : null;
}

/** The material name the picker writes before " · COLOR (#code)", or null. */
export function materialNameFromSubtype(subtype) {
  const { fabric } = parseSubtype(subtype);
  if (!fabric) return null;
  const name = fabric.split(' · ')[0];
  return name ? name.trim() : null;
}

/**
 * Locate the catalog material + color index a subtype refers to, matching
 * on the embedded `#code` and preferring a material whose name also
 * matches (codes can repeat across materials). Returns { material, idx } or
 * null when the subtype has no code or nothing matches.
 */
export function locateColor(materials, subtype) {
  const code = colorCodeFromSubtype(subtype);
  if (!code) return null;
  const wantName = (materialNameFromSubtype(subtype) || '').toLowerCase();
  let fallback = null;
  for (const material of materials || []) {
    const idx = (material.colors || []).findIndex((c) => (c.code || '') === code);
    if (idx < 0) continue;
    if (wantName && (material.name || '').trim().toLowerCase() === wantName) {
      return { material, idx };
    }
    if (!fallback) fallback = { material, idx };
  }
  return fallback;
}
