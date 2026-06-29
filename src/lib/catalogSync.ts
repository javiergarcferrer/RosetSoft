// One bulletproof catalog update.
//
// The dealer uploads the price-list PDF; we ALSO sync the Ligne Roset website in
// the same pass and merge both into a single set of writes (+ deletes). There's
// no separate "sync" button and no per-product URL — the PDF is the trigger, the
// website sync is stacked automatically.
//
// Ownership stays clean: the website owns colors / photos / care notes; the
// price list owns commercial spec (grade, wear, width, price, composition) and
// the canonical name + category. The website merge runs FIRST (so its colors are
// in place), then the PDF merge runs ON TOP and is authoritative — it also
// consolidates any stale "/FR"-vs-clean duplicates into one row.
import type { Material } from '../types/domain';
import { mergeCatalog, type ImportSummary, type LrPattern } from './lrCatalog.js';
import { mergePriceList, type ParsedPdfMaterial } from './materialsPdf.js';

export interface SyncSummary {
  pdfCount: number;
  siteCount: number;
  siteSynced: boolean;
  newMaterials: number;
  updatedMaterials: number;
  colorsAdded: number;
  consolidated: number;
  flaggedNoList: number;
  flaggedNoSite: number;
}

export interface SyncContext {
  profileId: string;
  now: number;
  newId: () => string;
  /** The PDF set is the COMPLETE price list (flag materials it omits). */
  complete?: boolean;
  /** The website sweep saw the whole catalog (flag materials the site omits). */
  siteComplete?: boolean;
}

function substantiveChange(o: Material, r: Material): boolean {
  return (
    (o.name ?? '') !== (r.name ?? '') ||
    o.category !== r.category ||
    (o.grade ?? null) !== (r.grade ?? null) ||
    (o.price ?? null) !== (r.price ?? null) ||
    (o.measure ?? null) !== (r.measure ?? null) ||
    (o.composition ?? null) !== (r.composition ?? null) ||
    (o.notes ?? null) !== (r.notes ?? null) ||
    (o.colors?.length || 0) !== (r.colors?.length || 0)
  );
}

/**
 * Stack the website sync and the price-list PDF into one set of row writes +
 * id deletes. Pure — the caller applies them (`bulkPut(rows)` + `bulkDelete`).
 * `sitePatterns` is null when the website couldn't be reached, in which case
 * only the PDF is applied (the import still works).
 */
export function syncCatalog(
  existing: Material[],
  sitePatterns: LrPattern[] | null,
  parsedPdf: ParsedPdfMaterial[],
  ctx: SyncContext,
): { rows: Material[]; deleteIds: string[]; summary: SyncSummary } {
  const base = { profileId: ctx.profileId, now: ctx.now, newId: ctx.newId };

  // 1) Website first — colors / photos / notes only. We DON'T let it flag
  // "no en sitio": the price-list PDF is the roster now, and the site scraper
  // has coverage gaps (it can miss a current fabric like ARDA). So complete:false.
  const emptySummary = (): ImportSummary => ({
    newMaterials: 0, updatedMaterials: 0, unchangedMaterials: 0,
    newColors: 0, removedColors: 0, flaggedMissing: 0, restored: 0,
  });
  const site = sitePatterns
    ? mergeCatalog(existing, sitePatterns, { ...base, complete: false })
    : { rows: [] as Material[], summary: emptySummary() };

  const afterSite = new Map(existing.map((m) => [m.id, m]));
  for (const r of site.rows) afterSite.set(r.id, r);

  // 2) Price-list PDF on top — spec/pricing/category + /FR consolidation.
  const pdf = mergePriceList([...afterSite.values()], parsedPdf, { ...base, complete: ctx.complete });

  // Combine: website changes overlaid by PDF changes, minus consolidation deletes.
  const out = new Map<string, Material>();
  for (const r of site.rows) out.set(r.id, r);
  for (const r of pdf.rows) out.set(r.id, r);
  const deleteSet = new Set(pdf.deleteIds);
  for (const id of deleteSet) out.delete(id);
  const rows = [...out.values()];

  // Summary from the final diff vs the original catalog (honest, non-overlapping).
  const orig = new Map(existing.map((m) => [m.id, m]));
  let newMaterials = 0;
  let updatedMaterials = 0;
  let flaggedNoList = 0;
  let flaggedNoSite = 0;
  for (const r of rows) {
    const o = orig.get(r.id);
    if (!o) { newMaterials += 1; continue; }
    if (r.notInPricelistAt != null && o.notInPricelistAt == null) flaggedNoList += 1;
    if (r.discontinuedAt != null && o.discontinuedAt == null) flaggedNoSite += 1;
    if (substantiveChange(o, r)) updatedMaterials += 1;
  }

  return {
    rows,
    deleteIds: [...deleteSet],
    summary: {
      pdfCount: parsedPdf.length,
      siteCount: sitePatterns?.length ?? 0,
      siteSynced: !!sitePatterns,
      newMaterials,
      updatedMaterials,
      colorsAdded: site.summary.newColors ?? 0,
      consolidated: deleteSet.size,
      flaggedNoList,
      flaggedNoSite,
    },
  };
}
