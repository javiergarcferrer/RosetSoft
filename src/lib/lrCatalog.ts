/**
 * Ligne Roset catalog import — pure mapping + merge logic.
 *
 * The `lr-catalog` Edge Function returns a list of `LrPattern`s (fabric name,
 * type, composition, care remark, and every color with its catalog `code`),
 * either for one product or — in a full catalog sweep — for the entire site.
 * This module merges that into our `materials`, treating the **site as the
 * source of truth** for everything it carries:
 *
 *   - name, category, composition, care notes → overwritten from the site.
 *   - color set → replaced by the site's (the color list is global per
 *     fabric, so this is authoritative). A color's uploaded photo (`imageId`)
 *     is carried across by matching `code`.
 *
 * What it deliberately PRESERVES, because the site has no equivalent and
 * nulling them would break quoting: grade, price, measure/units, wear, plus a
 * color's uploaded photo. Nothing is deleted.
 *
 * On a **complete** sweep (`complete: true`), materials that aren't offered
 * anywhere on the site are flagged (`discontinuedAt`) rather than removed, so a
 * custom/COM entry or one carrying dealer pricing survives review. A flagged
 * material that reappears on the site is un-flagged.
 *
 * Pure (type-only import of the domain types) so it unit-tests without the
 * Supabase client. The merge is idempotent — re-running changes nothing.
 */
import type { Material, MaterialCategory, MaterialColor } from '../types/domain';

/** One color of a pattern, as returned by the `lr-catalog` function. */
export interface LrColor {
  code: string;
  name: string | null;
}

/** One fabric/leather pattern, as returned by the `lr-catalog` function. */
export interface LrPattern {
  name: string;
  type: string | null;
  composition: string | null;
  remark: string | null;
  description?: string | null;
  colors: LrColor[];
}

/** Tally of what a merge changed — surfaced to the admin before applying. */
export interface ImportSummary {
  newMaterials: number;
  updatedMaterials: number;
  unchangedMaterials: number;
  newColors: number;
  removedColors: number;
  flaggedMissing: number;
  restored: number;
}

export interface MergeContext {
  profileId: string;
  now: number;
  newId: () => string;
  /**
   * True when `patterns` represents the WHOLE site (a full sweep), so existing
   * materials absent from it can be flagged as no-longer-offered. False for a
   * single-product import, where absence just means "not on this product".
   */
  complete?: boolean;
}

/**
 * Map Ligne Roset's pattern `type` (e.g. "Fabrics", "Microfibres", "Velvets",
 * "Leather", "Fabrics with effect threads") to our three-way category. Anything
 * leather → leather, anything outdoor → outdoor, everything else → fabric.
 */
export function lrTypeToCategory(type: string | null | undefined): MaterialCategory {
  const t = (type || '').toLowerCase();
  if (t.includes('leather')) return 'leather';
  if (t.includes('outdoor')) return 'outdoor';
  return 'fabric';
}

/** Canonical key for matching a pattern to an existing material by name. */
export function normalizeName(name: string | null | undefined): string {
  return String(name || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    // "APPA/FR" (fire-retardant) and "APPA" are the same fabric — match them as
    // one so a re-import never strands or duplicates an /FR-vs-clean pair.
    .replace(/\s*\/\s*FR$/, '');
}

/**
 * Ligne Roset's `remark` is free-text care/usage notes (e.g. "THIS FABRIC IS
 * NOT TB117-2013 APPROVED…", "Treated against stains (TEFLON)") — NOT a grade.
 * Drop the trivial "SWATCH A"/"SWATCH B" markers (the swatch-book letter is
 * already implied by the material name) and keep only real warnings.
 */
export function cleanNotes(remark: string | null | undefined): string | null {
  const r = String(remark || '').trim().replace(/\s+/g, ' ');
  if (!r) return null;
  if (/^swatch\s+[a-z0-9]$/i.test(r)) return null;
  return r;
}

function trimmed(s: string | null | undefined): string {
  return String(s || '').trim();
}

/** Dedupe a pattern's colors by code, preferring the first non-empty name. */
function dedupeColors(colors: LrColor[] | undefined): LrColor[] {
  const seen = new Map<string, LrColor>();
  for (const c of colors || []) {
    const code = trimmed(c?.code);
    if (!code) continue;
    const existing = seen.get(code);
    if (!existing) {
      seen.set(code, { code, name: c.name ? trimmed(c.name) : null });
    } else if (!existing.name && c.name) {
      existing.name = trimmed(c.name);
    }
  }
  return [...seen.values()];
}

/** Deep-equal two color lists over the fields we manage (order included). */
function sameColors(a: MaterialColor[], b: MaterialColor[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (trimmed(a[i].code) !== trimmed(b[i].code)) return false;
    if ((a[i].name || '') !== (b[i].name || '')) return false;
    if ((a[i].imageId ?? null) !== (b[i].imageId ?? null)) return false;
  }
  return true;
}

/**
 * Merge imported patterns into the existing catalog (site as source of truth).
 * Pure: pass `now` and a `newId` factory so callers (and tests) control
 * id/timestamp generation. Returns only the rows that actually changed (ready
 * for `db.materials.bulkPut`) plus a summary of what changed.
 */
export function mergeCatalog(
  existing: Material[],
  patterns: LrPattern[],
  { profileId, now, newId, complete = false }: MergeContext,
): { rows: Material[]; summary: ImportSummary } {
  const byName = new Map<string, Material>();
  for (const m of existing) byName.set(normalizeName(m.name), m);

  const rows: Material[] = [];
  const seen = new Set<string>();
  const summary: ImportSummary = {
    newMaterials: 0,
    updatedMaterials: 0,
    unchangedMaterials: 0,
    newColors: 0,
    removedColors: 0,
    flaggedMissing: 0,
    restored: 0,
  };

  for (const p of patterns) {
    const key = normalizeName(p.name);
    if (!key) continue;
    seen.add(key);

    // Drop the "/FR" suffix so website + price-list names agree (see normalizeName).
    const name = trimmed(p.name).replace(/\s*\/\s*FR$/i, '');
    const composition = trimmed(p.composition) || null;
    const notes = cleanNotes(p.remark);
    const siteColors = dedupeColors(p.colors);
    const current = byName.get(key);
    // Category + composition are owned by the price-list PDF (it has explicit
    // FABRICS/LEATHER/OUTDOOR sections and authoritative composition). The
    // website only sets them when creating a material it sees first; for an
    // existing material it keeps the dealer/PDF category and only fills an
    // EMPTY composition.
    const category = current ? current.category : lrTypeToCategory(p.type);

    if (!current) {
      const colors: MaterialColor[] = siteColors.map((c) => ({ name: c.name || '', code: c.code }));
      rows.push({
        id: newId(),
        profileId,
        category,
        name,
        grade: null,
        wearRating: null,
        wearDoubleRubs: null,
        measure: null,
        measureUnit: category === 'leather' ? 'mm' : 'in',
        price: null,
        priceUnit: category === 'leather' ? 'sm' : 'yard',
        composition,
        colors,
        notes,
        discontinuedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      summary.newMaterials += 1;
      summary.newColors += colors.length;
      continue;
    }

    // Website-owned fields only (colors + notes; composition filled if empty).
    // name + category belong to the price list and are left untouched here.
    const existingByCode = new Map<string, MaterialColor>();
    for (const c of current.colors || []) {
      const code = trimmed(c.code);
      if (code) existingByCode.set(code, c);
    }

    let colors: MaterialColor[];
    let added = 0;
    let removed = 0;
    if (siteColors.length === 0) {
      // A transient empty colors payload must never wipe a real color set.
      colors = (current.colors || []).map((c) => ({ ...c }));
    } else {
      colors = siteColors.map((sc) => {
        const ex = existingByCode.get(sc.code);
        const col: MaterialColor = { name: sc.name || (ex?.name ?? ''), code: sc.code };
        if (ex?.imageId) col.imageId = ex.imageId; // carry the dealer's photo
        return col;
      });
      const siteCodes = new Set(siteColors.map((c) => c.code));
      for (const code of existingByCode.keys()) if (!siteCodes.has(code)) removed += 1;
      for (const c of siteColors) if (!existingByCode.has(c.code)) added += 1;
    }

    // Composition is the price list's to own — only fill it when ours is empty.
    const nextComposition = trimmed(current.composition) ? (current.composition ?? null) : composition;

    const wasFlagged = current.discontinuedAt != null;
    const changed =
      (current.notes ?? null) !== notes ||
      (current.composition ?? null) !== nextComposition ||
      !sameColors(current.colors || [], colors) ||
      wasFlagged;

    if (changed) {
      rows.push({ ...current, notes, colors, composition: nextComposition, discontinuedAt: null, updatedAt: now });
      summary.updatedMaterials += 1;
      summary.newColors += added;
      summary.removedColors += removed;
      if (wasFlagged) summary.restored += 1;
    } else {
      summary.unchangedMaterials += 1;
    }
  }

  // Full sweep only: anything we have that the site no longer offers gets
  // flagged (kept, never deleted). Already-flagged rows stay as they are.
  if (complete) {
    for (const m of existing) {
      if (seen.has(normalizeName(m.name))) continue;
      if (m.discontinuedAt == null) {
        rows.push({ ...m, discontinuedAt: now, updatedAt: now });
        summary.flaggedMissing += 1;
      } else {
        summary.unchangedMaterials += 1;
      }
    }
  }

  return { rows, summary };
}
