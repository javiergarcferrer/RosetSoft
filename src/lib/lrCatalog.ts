/**
 * Ligne Roset catalog import — pure mapping + merge logic.
 *
 * The `lr-catalog` Edge Function fetches a product page's catalog AJAX
 * endpoints and returns a list of `LrPattern`s (fabric name, type, composition,
 * care remark, and every color with its catalog `code`). This module turns that
 * into a non-destructive merge against the existing `materials` catalog:
 *
 *   - A pattern with no name match → a NEW material.
 *   - A pattern that matches an existing material (by normalized name) →
 *     ENRICHED in place: add colors whose `code` we don't have yet, fill the
 *     name on a color we have by code but never named, and backfill
 *     composition / notes only when ours is empty.
 *
 * What it never touches: grade, wear, price, measure (those come from the
 * dealer's price list, not these endpoints), a color's uploaded `imageId`, and
 * anything that's already set. Nothing is ever deleted. The merge is
 * idempotent — re-running with the same input yields zero changed rows.
 *
 * Kept dependency-free (type-only import of the domain types) so it unit-tests
 * without pulling in the Supabase client.
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
  namedColors: number;
  filledComposition: number;
  filledNotes: number;
}

export interface MergeContext {
  profileId: string;
  now: number;
  newId: () => string;
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
  return String(name || '').trim().toUpperCase().replace(/\s+/g, ' ');
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

/**
 * Merge imported patterns into the existing catalog. Pure: pass `now` and a
 * `newId` factory so callers (and tests) control id/timestamp generation.
 * Returns only the rows that actually changed (ready for `db.materials.bulkPut`)
 * plus a summary of what changed.
 */
export function mergeCatalog(
  existing: Material[],
  patterns: LrPattern[],
  { profileId, now, newId }: MergeContext,
): { rows: Material[]; summary: ImportSummary } {
  const byName = new Map<string, Material>();
  for (const m of existing) byName.set(normalizeName(m.name), m);

  const rows: Material[] = [];
  const summary: ImportSummary = {
    newMaterials: 0,
    updatedMaterials: 0,
    unchangedMaterials: 0,
    newColors: 0,
    namedColors: 0,
    filledComposition: 0,
    filledNotes: 0,
  };

  for (const p of patterns) {
    const key = normalizeName(p.name);
    if (!key) continue;

    const category = lrTypeToCategory(p.type);
    const composition = trimmed(p.composition) || null;
    const notes = cleanNotes(p.remark);
    const importedColors = dedupeColors(p.colors);
    const current = byName.get(key);

    if (!current) {
      const colors: MaterialColor[] = importedColors.map((c) => ({
        name: c.name || '',
        code: c.code,
      }));
      rows.push({
        id: newId(),
        profileId,
        category,
        name: trimmed(p.name),
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
        createdAt: now,
        updatedAt: now,
      });
      summary.newMaterials += 1;
      summary.newColors += colors.length;
      continue;
    }

    // Enrich an existing material — clone its colors, never its identity.
    let changed = false;
    const colors: MaterialColor[] = (current.colors || []).map((c) => ({ ...c }));
    const codeIndex = new Map<string, number>();
    colors.forEach((c, i) => {
      const code = trimmed(c.code);
      if (code) codeIndex.set(code, i);
    });

    for (const ic of importedColors) {
      const at = codeIndex.get(ic.code);
      if (at == null) {
        colors.push({ name: ic.name || '', code: ic.code });
        codeIndex.set(ic.code, colors.length - 1);
        summary.newColors += 1;
        changed = true;
      } else if (ic.name && !trimmed(colors[at].name)) {
        colors[at] = { ...colors[at], name: ic.name };
        summary.namedColors += 1;
        changed = true;
      }
    }

    const patch: Partial<Material> = {};
    if (composition && !trimmed(current.composition)) {
      patch.composition = composition;
      summary.filledComposition += 1;
      changed = true;
    }
    if (notes && !trimmed(current.notes)) {
      patch.notes = notes;
      summary.filledNotes += 1;
      changed = true;
    }

    if (changed) {
      rows.push({ ...current, ...patch, colors, updatedAt: now });
      summary.updatedMaterials += 1;
    } else {
      summary.unchangedMaterials += 1;
    }
  }

  return { rows, summary };
}
