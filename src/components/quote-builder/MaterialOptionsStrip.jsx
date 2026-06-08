import { Check } from 'lucide-react';
import { materialOptionDeltas } from '../../lib/pricing.js';
import { splitSkuGrade } from '../../lib/catalog.js';
import { colorCodeFromSubtype } from '../../lib/swatchMatch.js';
import { formatMoney } from '../../lib/format.js';
import { swatchUrl } from '../../lib/swatchImage.js';
import ImageView from '../ImageView.jsx';

/**
 * "Opciones de material" — the fabric/leather grades a line (or compound
 * component) can be re-quoted in, each shown with the PRICE DIFFERENCE versus
 * the chosen base grade. The base reads as the anchor ("Incluida", no number);
 * each alternative shows its signed delta (e.g. "Cuero L +$420.00"; a cheaper
 * grade shows "−$120.00"). Swatch chips enlarge on hover (fine-pointer only).
 *
 * Two modes:
 *   - read-only (default)        a quiet spec grid — what the dealer sees in the
 *                                client preview + (mirrored) in the PDF.
 *   - interactive (`onSelect`)   each grade becomes a selectable card; the
 *                                client picks the material it wants and the
 *                                quote total recomputes. `selectedGrade` marks
 *                                the active choice (defaults to the base grade).
 *
 * Deltas come from `materialOptionDeltas(materialOptions, family)` when a
 * `families` map resolves a family for the line's SKU root; otherwise each
 * option's own `delta` (baked in by the quote-share function for the public
 * view) is used, and failing that the row shows label-only. The component
 * degrades in layers so the customer never sees a broken strip.
 *
 * `marginFactor` scales the CATALOG-derived deltas (the `families` path) by the
 * same per-line margin the public-link bundle bakes into its option deltas, so
 * the dealer's in-app preview shows the same +/- the client link does. The
 * already-baked option `delta`s (the public bundle) are left untouched — they
 * carry their margin already — and the default of 1 keeps every other surface
 * (e.g. the read-only editor compose strip) on raw list deltas.
 */
export default function MaterialOptionsStrip({
  materialOptions, reference, families, currency, rates, baseSwatchImageId,
  selectedGrade, onSelect, marginFactor = 1,
}) {
  const rawOptions = materialOptions?.options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return null;

  const baseLabel = materialOptions.baseLabel || materialOptions.baseGrade || null;
  const baseGrade = materialOptions.baseGrade ?? null;

  // Prefer the priced rows from materialOptionDeltas (catalog-derived) when a
  // family resolves; else fall back to the raw options (which carry a baked
  // `delta` in the public bundle, or none at all → label-only).
  const priced = (() => {
    if (!families) return null;
    const root = splitSkuGrade(reference || '').root;
    const family = root ? families.get(root) : null;
    if (!family) return null;
    try {
      const rows = materialOptionDeltas(materialOptions, family);
      if (!Array.isArray(rows)) return null;
      // Bake the per-line margin so the chip deltas match the public link (which
      // carries them baked); marginFactor === 1 leaves the raw list deltas as-is.
      return marginFactor === 1 ? rows : rows.map((r) => ({ ...r, delta: r.delta * marginFactor }));
    } catch {
      return null;
    }
  })();

  const optionRows = (priced || rawOptions).map((o) => ({
    grade: o?.grade,
    label: o?.label,
    code: o?.code,
    swatchImageId: o?.swatchImageId,
    delta: typeof o?.delta === 'number' ? o.delta : null,
  })).filter((o) => o.label);

  if (optionRows.length === 0) return null;

  const interactive = typeof onSelect === 'function';
  // The active grade in interactive mode defaults to the base material.
  const activeGrade = selectedGrade != null ? selectedGrade : baseGrade;

  // One uniform grid: the base material leads as the anchor ("Incluida", no
  // delta), then each alternative with its signed price difference. Every cell
  // carries a same-size swatch so the grid reads evenly.
  const cells = [];
  if (baseLabel) {
    cells.push({
      key: 'base',
      grade: baseGrade,
      label: baseLabel,
      swatchImageId: baseSwatchImageId,
      code: colorCodeFromSubtype(baseLabel),
      note: 'Incluida',
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
      grade: opt.grade,
      label: opt.label,
      swatchImageId: opt.swatchImageId,
      code: opt.code || colorCodeFromSubtype(opt.label),
      note: signed,
      noteClass: hasDelta && opt.delta < 0 ? 'text-emerald-700 font-semibold' : 'text-ink-500 font-semibold',
    });
  });

  return (
    <div className="mt-2">
      {interactive && (
        <div className="eyebrow-xs tracking-widest text-ink-500 mb-1.5">Elige el material</div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 min-w-0">
        {cells.map((c) => {
          const selected = interactive && c.grade != null && c.grade === activeGrade;
          const body = (
            <>
              <div className="relative w-16">
                <ImageView
                  id={c.swatchImageId}
                  fallbackUrl={swatchUrl(c.code)}
                  alt=""
                  hoverPreview
                  className={`w-16 h-16 object-cover rounded border bg-white ${
                    selected ? 'border-brand-500 ring-2 ring-brand-500' : 'border-ink-200'
                  }`}
                />
                {selected && (
                  <span className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-brand-600 text-white shadow ring-2 ring-white">
                    <Check size={12} aria-hidden />
                  </span>
                )}
              </div>
              <div className="mt-1 leading-tight min-w-0">
                <div className={`text-[11px] font-medium break-words ${selected ? 'text-brand-800' : 'text-ink-700'}`}>{c.label}</div>
                {c.note && <div className={`text-[10px] break-words ${c.noteClass}`}>{c.note}</div>}
              </div>
            </>
          );
          if (!interactive) {
            return <div key={c.key} className="min-w-0">{body}</div>;
          }
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => c.grade != null && onSelect(c.grade)}
              aria-pressed={selected}
              title={`Elegir ${c.label}${c.note && c.note !== 'Incluida' ? ` (${c.note})` : ''}`}
              className="min-w-0 text-left appearance-none bg-transparent p-0 border-0 cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            >
              {body}
            </button>
          );
        })}
      </div>
    </div>
  );
}
