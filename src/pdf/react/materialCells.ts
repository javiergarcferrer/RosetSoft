import { materialOptionDeltas } from '../../lib/pricing.js';
import { splitSkuGrade } from '../../lib/catalog.js';
import { swatchProxyUrl } from '../../lib/swatchImage.js';
import { colorCodeFromSubtype } from '../../lib/swatchMatch.js';
import { formatMoney } from '../../lib/format.js';
import type { MaterialOptions, CurrencyCode } from '../../types/domain.ts';
import type { CatalogFamily } from '../../lib/catalog.ts';
import { C } from './theme.js';

export interface MoCell {
  label: string;
  note: string | null;
  noteColor: string;
  swatch: { imageId?: string | null; url?: string | null };
}

/**
 * The materials a line/component can be re-quoted in, as cell data: the base
 * material first ("incluido"), then each alternative with its signed price
 * delta. Ported 1:1 from the pdf-lib `materialOptionCells` (data half) so the
 * react-pdf grid and the legacy renderer can't drift. Pure — no image fetch.
 *
 * Deltas resolve when `families` has the SKU root's family; otherwise the
 * cells degrade to label-only, the same graceful fallback the on-screen
 * preview uses.
 */
export function materialCells({
  mo, reference, baseSwatchImageId, families, currency, rates,
}: {
  mo: MaterialOptions | null | undefined;
  reference: string | null | undefined;
  baseSwatchImageId: string | null | undefined;
  families: Map<string, CatalogFamily> | null | undefined;
  currency: CurrencyCode;
  rates: Record<string, number>;
}): MoCell[] {
  const rawOptions = mo?.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return [];
  const baseLabel = mo?.baseLabel || mo?.baseGrade || '';

  let priced: ReturnType<typeof materialOptionDeltas> | null = null;
  if (families) {
    const root = splitSkuGrade(reference || '').root;
    const family = root ? families.get(root) : null;
    if (family) {
      try { priced = materialOptionDeltas(mo, family); } catch { priced = null; }
    }
  }

  const cells: MoCell[] = [];
  if (baseLabel) {
    cells.push({
      label: baseLabel,
      note: 'incluido',
      noteColor: C.inkSoft,
      swatch: { imageId: baseSwatchImageId, url: swatchProxyUrl(colorCodeFromSubtype(baseLabel)) },
    });
  }

  const rows = priced && priced.length ? priced : rawOptions;
  for (const o of rows) {
    const d = (o as { delta?: number }).delta;
    const delta = typeof d === 'number' ? d : null;
    const note = delta != null
      ? `${delta < 0 ? '−' : '+'}${formatMoney(Math.abs(delta), currency, rates)}`
      : null;
    const noteColor = delta != null && delta < 0 ? C.emerald700 : C.inkMid;
    const code = o.code || colorCodeFromSubtype(o.label);
    cells.push({ label: o.label || '', note, noteColor, swatch: { imageId: o.swatchImageId, url: swatchProxyUrl(code) } });
  }
  return cells;
}

/**
 * Standalone swatch source for a line/component: the uploaded swatch image if
 * present, else the catalog color's CORS-proxied swatch derived from the
 * subtype. Mirrors ClientPreview's ClearSwatch fallback so the PDF shows a
 * fabric swatch even when the dealer picked a catalog color (no uploaded
 * image). Shared by the renderer (QuoteDocument) and the image resolver
 * (images.ts) so they agree on the swatch key.
 */
export function swatchSrcFor(
  swatchImageId: string | null | undefined,
  subtype: string | null | undefined,
): { imageId: string | null; url: string | null } {
  return { imageId: swatchImageId ?? null, url: swatchProxyUrl(colorCodeFromSubtype(subtype)) };
}
