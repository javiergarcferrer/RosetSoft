import { materialOptionDeltas } from '../../lib/pricing.js';
import { splitSkuGrade } from '../../lib/catalog.js';
import { colorCodeFromSubtype } from '../../lib/swatchMatch.js';
import { formatMoney } from '../../lib/format.js';
import { swatchUrl } from '../../lib/swatchImage.js';
import ImageView from '../ImageView.jsx';

/**
 * "Opciones de material" — a compact, read-only strip listing the fabric/
 * leather grades a line (or compound component) can be re-quoted in, with
 * the price delta versus the chosen grade. The base grade reads as the
 * anchor (no number, "incluido"); each alternative shows its label and the
 * delta (e.g. "Cuero L +$420.00", a cheaper grade shows "−$120.00").
 *
 * Deltas come from materialOptionDeltas(materialOptions, family) where the
 * family is looked up in the parent-supplied `families` map by the line's
 * SKU root. The component degrades in layers so the customer never sees a
 * broken strip while the catalog wiring settles:
 *   - no options                                  → renders nothing
 *   - no `families` / no family / a row whose delta
 *     is unavailable                              → that option shows
 *                                                    label-only (no number)
 *
 * Small swatch chips reuse the same Ligne-Roset-code fallback vocabulary as
 * the line's main swatch, kept deliberately tiny so the strip stays a quiet
 * spec line, not a second gallery.
 */
export default function MaterialOptionsStrip({ materialOptions, reference, families, currency, rates, baseSwatchImageId }) {
  const rawOptions = materialOptions?.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return null;

  const baseLabel = materialOptions.baseLabel || materialOptions.baseGrade || null;

  // Prefer the priced rows from materialOptionDeltas (which carry
  // grade/label/code/swatchImageId/delta together); fall back to the raw
  // options (label-only, delta null) whenever there's no `families` map or no
  // family resolves for this SKU root.
  const priced = (() => {
    if (!families) return null;
    const root = splitSkuGrade(reference || '').root;
    const family = root ? families.get(root) : null;
    if (!family) return null;
    try {
      const rows = materialOptionDeltas(materialOptions, family);
      return Array.isArray(rows) ? rows : null;
    } catch {
      return null;
    }
  })();

  // Merge: walk the priced rows when present (authoritative label + delta),
  // else the raw options. Each entry → { grade, label, code, swatchImageId, delta }.
  const optionRows = (priced || rawOptions).map((o) => ({
    grade: o?.grade,
    label: o?.label,
    code: o?.code,
    swatchImageId: o?.swatchImageId,
    delta: typeof o?.delta === 'number' ? o.delta : null,
  })).filter((o) => o.label);

  if (optionRows.length === 0) return null;

  // One uniform grid of materials: the selected (base) material reads first
  // as the anchor ("incluido", no delta), then each alternative with its
  // price delta. Every cell carries a same-size swatch tile so the grid
  // reads evenly — no "Opciones de material" heading; the swatch + label is
  // self-explanatory.
  const cells = [];
  if (baseLabel) {
    cells.push({
      key: 'base',
      label: baseLabel,
      swatchImageId: baseSwatchImageId,
      code: colorCodeFromSubtype(baseLabel),
      note: 'incluido',
      noteClass: 'text-ink-400',
    });
  }
  optionRows.forEach((opt, i) => {
    const hasDelta = typeof opt.delta === 'number';
    // Money string with an explicit sign — negative deltas show "−".
    const signed = hasDelta
      ? `${opt.delta < 0 ? '−' : '+'}${formatMoney(Math.abs(opt.delta), currency, rates)}`
      : null;
    cells.push({
      key: opt.grade != null ? `${opt.grade}-${i}` : `opt-${i}`,
      label: opt.label,
      swatchImageId: opt.swatchImageId,
      code: opt.code || colorCodeFromSubtype(opt.label),
      note: signed,
      noteClass: hasDelta && opt.delta < 0 ? 'text-emerald-700 font-semibold' : 'text-ink-500 font-semibold',
    });
  });

  return (
    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 max-w-md">
      {cells.map((c) => (
        <div key={c.key} className="min-w-0">
          <ImageView
            id={c.swatchImageId}
            fallbackUrl={swatchUrl(c.code)}
            alt=""
            className="w-16 h-16 object-cover rounded border border-ink-200 bg-white"
          />
          <div className="mt-1 leading-tight">
            <div className="text-[11px] font-medium text-ink-700">{c.label}</div>
            {c.note && <div className={`text-[10px] ${c.noteClass}`}>{c.note}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
