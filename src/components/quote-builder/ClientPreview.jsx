import { useMemo, useState } from 'react';
import { Boxes } from 'lucide-react';
import ImageView from '../ImageView.jsx';
import Modal from '../Modal.jsx';
import {
  ITBIS_PCT, isCompoundLine, componentSubtotal, compoundSubtotal, lineTotal,
  quoteSavings, setSubtotal, setGroupInfo,
} from '../../lib/pricing.js';
import { LINE_KIND_SECTION } from '../../lib/constants.js';
import { formatMoney, formatDate } from '../../lib/format.js';

/**
 * Read-only client-facing preview of the quote. Renders the same data the
 * PDF generator does, in HTML, so the dealer can flip "Vista cliente" in
 * the header during a sales conversation without downloading a PDF first.
 *
 * Intentionally NOT styled to match the PDF pixel-for-pixel — the PDF
 * follows pdf-lib's text layout constraints; this is the *web* twin, with
 * generous typography honoring the brand and the things you can do in HTML
 * (line item images at scale, hover-cleaner totals, etc.).
 */
/**
 * A displayed image that opens a centered lightbox (the shared Modal) on
 * click so the customer can study the product photo / fabric swatch at
 * size. Tapping an image to ZOOM is the expected gesture — a download is
 * not. Falls back to a plain, non-interactive ImageView when there's no
 * image id (the placeholder box).
 */
function ImageZoom({ id, className, alt = '' }) {
  const [open, setOpen] = useState(false);
  if (!id) return <ImageView id={id} className={className} alt={alt} />;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex-shrink-0 block appearance-none p-0 bg-transparent border-0 cursor-zoom-in rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-900 focus-visible:ring-offset-1"
        aria-label="Ampliar imagen"
        title="Ampliar imagen"
      >
        <ImageView id={id} className={className} alt={alt} />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} size="xl">
        <div className="flex items-center justify-center">
          <ImageView id={id} alt={alt} className="max-h-[78vh] w-auto max-w-full object-contain rounded-md" />
        </div>
      </Modal>
    </>
  );
}

export default function ClientPreview({ quote, settings, lines, totals, customer, professional, seller }) {
  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
  const dopRate = rates.DOP || null;
  const fmt = (v) => formatMoney(v, currency, rates);

  // Group lines under their preceding section, if any. Top-level items (no
  // section before them) live under a null-key group rendered without a
  // heading.
  const groups = useMemo(() => groupBySection(lines), [lines]);
  // Total cash the customer is saving across line-level + quote-level
  // discounts. Surfaced under the totals as a one-line callout when
  // non-zero so the concessions don't read as silent post-discount
  // numbers.
  const savings = useMemo(() => quoteSavings(lines, totals), [lines, totals]);
  // Alternative-group index/total lookup — same shape the editor uses
  // so the "Alternativa N de M" caption reads identically on both
  // surfaces. Cheap to compute on every render.
  const groupInfo = useMemo(() => {
    const counts = new Map();
    for (const l of lines) {
      if (!l.alternativeGroup) continue;
      counts.set(l.alternativeGroup, (counts.get(l.alternativeGroup) || 0) + 1);
    }
    const seen = new Map();
    const map = new Map();
    for (const l of lines) {
      if (!l.alternativeGroup) continue;
      const idx = (seen.get(l.alternativeGroup) || 0) + 1;
      seen.set(l.alternativeGroup, idx);
      map.set(l.id, { index: idx, total: counts.get(l.alternativeGroup) });
    }
    return map;
  }, [lines]);
  // Conjunto (set) "Conjunto N de M" position lookup — keyed by line id,
  // SAME { index, total } shape as the alternative groupInfo above. We
  // import the shared helper rather than re-deriving it so the caption
  // reads identically across editor / preview / PDF.
  const setInfo = useMemo(() => setGroupInfo(lines), [lines]);

  // overflow-clip (not -hidden) so the rounded corners still clip the
  // full-bleed banner WITHOUT establishing a scroll container — an
  // overflow:hidden ancestor would trap the sticky product image in
  // CompoundClientLine and stop it following the page scroll.
  return (
    <div className="bg-white border border-ink-100 rounded-xl shadow-soft overflow-clip">
      {/* Banner so the dealer knows this is a preview, not the live editor */}
      <div className="bg-ink-900 text-ink-50 px-5 py-2 text-[11px] flex items-center justify-between">
        <span>Vista previa del cliente · de solo lectura</span>
        <span className="opacity-60">{formatDate(quote.updatedAt)}</span>
      </div>

      {/* Header */}
      <div className="px-6 sm:px-10 pt-8 pb-6 border-b border-ink-100 flex flex-wrap items-start gap-6 justify-between">
        <div className="min-w-0">
          {settings?.logoImageId ? (
            <ImageView
              id={settings.logoImageId}
              className="h-12 max-w-[200px] object-contain object-left mb-3"
            />
          ) : (
            <div className="text-xl font-semibold text-ink-900">{settings?.companyName || 'Tu empresa'}</div>
          )}
          <div className="text-[11px] text-ink-500 leading-relaxed whitespace-pre-line max-w-xs">
            {[settings?.companyAddress, settings?.companyPhone, settings?.companyEmail].filter(Boolean).join('\n')}
          </div>
        </div>
        <div className="text-right">
          <div className="eyebrow">Cotización</div>
          <div className="text-3xl font-semibold tracking-tight">#{quote.number || '—'}</div>
          <div className="text-[11px] text-ink-500 mt-2">{formatDate(quote.updatedAt)}</div>
        </div>
      </div>

      {/* Customer block — client on the left, who's selling it (vendedor)
          and the referring professional on the right. */}
      {(customer || seller || professional) && (
        <div className="px-6 sm:px-10 py-5 border-b border-ink-100 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <div className="eyebrow mb-1.5">Cliente</div>
            {customer ? (
              <>
                <div className="text-sm font-semibold text-ink-900">{customer.name}</div>
                {customer.company && <div className="text-xs text-ink-700">{customer.company}</div>}
                <div className="text-[11px] text-ink-500 leading-relaxed mt-1">
                  {[customer.address, [customer.city, customer.state, customer.zip].filter(Boolean).join(', '), customer.country, customer.email, customer.phone].filter(Boolean).join(' · ')}
                </div>
              </>
            ) : (
              <div className="text-sm text-ink-400">Sin cliente asignado</div>
            )}
          </div>
          {(seller || professional) && (
            <div className="text-right shrink-0 space-y-3">
              {seller && (
                <div>
                  <div className="eyebrow mb-0.5">Vendedor</div>
                  <div className="text-sm font-medium text-ink-900">{seller.name}</div>
                </div>
              )}
              {professional && (
                <div>
                  <div className="eyebrow mb-0.5">Profesional</div>
                  <div className="text-sm font-medium text-ink-900">{professional.name}</div>
                  {professional.company && <div className="text-[11px] text-ink-500">{professional.company}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Line items */}
      <div className="px-2 sm:px-6 py-2">
        {lines.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-ink-500">
            Aún no hay artículos en esta cotización.
          </div>
        ) : (
          groups.map((g, gi) => (
            <div key={gi} className="mb-2">
              {g.label && (
                <div className="px-4 pt-5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-brand-700">
                  {g.label}
                </div>
              )}
              <ul>
                {g.items.map((l, i) => {
                  // Conjunto (set) run detection — mirrors the editor's
                  // LineItemList: a run is a maximal stretch of ADJACENT
                  // lines sharing the same setGroup. Set members render
                  // normally (priced, undimmed); the run gets a shared
                  // violet left accent and one "Total del conjunto" footer
                  // after its LAST member. Sections never appear in
                  // g.items (groupBySection strips them), so a run can't
                  // straddle a section boundary.
                  const setGroup = l.setGroup || null;
                  const inSet = !!setGroup;
                  const isFirstInSet = inSet && g.items[i - 1]?.setGroup !== setGroup;
                  const isLastInSet = inSet && g.items[i + 1]?.setGroup !== setGroup;
                  return (
                    <ClientLine
                      key={l.id}
                      line={l}
                      currency={currency}
                      rates={rates}
                      fmt={fmt}
                      groupInfo={groupInfo.get(l.id)}
                      setInfo={inSet ? setInfo.get(l.id) : undefined}
                      inSet={inSet}
                      isFirstInSet={isFirstInSet}
                      isLastInSet={isLastInSet}
                      setFooter={isLastInSet ? fmt(setSubtotal(lines, setGroup)) : null}
                    />
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      {/* Totals */}
      <div className="px-6 sm:px-10 py-6 border-t border-ink-100 bg-ink-50/50">
        <div className="ml-auto max-w-sm space-y-1.5 tabular-nums">
          <TotalRow label="Subtotal" value={fmt(totals.subtotal)} />
          {quote.discountPct ? (
            // Discount row reads in brand colour — muted styling made
            // it look incidental next to the (muted) ITBIS / Envío
            // lines, which buried the concession the customer was
            // supposed to perceive.
            <TotalRow
              label={`Descuento (${quote.discountPct}%)`}
              value={`–${fmt(totals.discountAmt)}`}
              accent
            />
          ) : null}
          <TotalRow label={`ITBIS (${ITBIS_PCT}%)`} value={fmt(totals.taxAmt)} muted />
          {quote.shipping ? <TotalRow label="Envío" value={fmt(totals.shipping)} muted /> : null}
          <div className="border-t border-ink-300 mt-2 pt-2">
            <TotalRow label="Total" value={fmt(totals.grandTotal)} bold />
          </div>
          {savings > 0 && (
            <div className="mt-2 text-right text-[12px] font-medium text-brand-700">
              Ahorras {fmt(savings)} en esta cotización
            </div>
          )}
          {dopRate && currency === 'USD' && (
            <div className="text-[11px] text-ink-500 text-right pt-0.5">
              ≈ RD$ {Math.round(totals.grandTotal * dopRate).toLocaleString('en-US')} a {dopRate.toFixed(2)} DOP/USD
            </div>
          )}
        </div>
      </div>

      {/* Terms */}
      {quote.terms && (
        <div className="px-6 sm:px-10 py-6 border-t border-ink-100">
          <div className="eyebrow mb-2">Términos</div>
          <div className="text-xs text-ink-700 leading-relaxed whitespace-pre-line">{quote.terms}</div>
        </div>
      )}

      {/* Footer */}
      {settings?.quoteFooter && (
        <div className="px-6 sm:px-10 py-3 border-t border-ink-100 text-[10px] text-ink-500 text-center">
          {settings.quoteFooter}
        </div>
      )}
    </div>
  );
}

function ClientLine({ line, currency, rates, fmt, groupInfo, setInfo, inSet, isFirstInSet, isLastInSet, setFooter }) {
  // The "Total del conjunto" roll-up renders as a sibling row after the
  // last member of a contiguous set run. It is purely presentational —
  // setSubtotal is the SUM of each member's own line total (computed by
  // the parent), so it doesn't touch the grand-total math. Set members
  // are never dimmed (every member is priced / take-all).
  const footer = isLastInSet && setFooter != null ? <SetFooter value={setFooter} /> : null;
  if (isCompoundLine(line)) {
    return (
      <>
        <CompoundClientLine
          line={line}
          fmt={fmt}
          groupInfo={groupInfo}
          setInfo={setInfo}
          inSet={inSet}
          isFirstInSet={isFirstInSet}
          isLastInSet={isLastInSet}
        />
        {footer}
      </>
    );
  }
  const base = Number(line.unitPrice) || 0;
  const margin = Number(line.lineMarginPct) || 0;
  const discount = Number(line.lineDiscountPct) || 0;
  const qty = Number(line.qty) || 0;
  // List unit = post-margin, pre-discount. That's the catalogue price
  // the customer would have paid without the discount — so the
  // strike-through / "antes" line reflects the figure they're saving
  // against, not the dealer's internal cost basis.
  const listUnit = base * (1 + margin / 100);
  const unit = listUnit * (1 - discount / 100);
  const listTotal = listUnit * qty;
  const total = unit * qty;
  const discounted = discount > 0;
  // Layout shape, mobile-first:
  //
  //   row 1   image + text side-by-side
  //   row 2   compact label/value strip at the card bottom — three
  //           pairs (CANTIDAD / UNITARIO / TOTAL) rendered as a
  //           horizontal flex with a top hairline so it reads as a
  //           summary footer, not a leftover wrapped column.
  //
  // On sm+ the strip promotes back to a vertical column in a third
  // grid column to the right of the text — same vocabulary, denser.
  //
  // The previous full-width col-span-2 wrap was technically right-
  // aligned but left a tall dead zone next to it on mobile because
  // each label/value pair sat on its own row. A horizontal strip
  // uses the width that's already there instead of stacking
  // vertically into the void.
  const optional = !!line.isOptional;
  const inGroup = !!line.alternativeGroup;
  const isSelected = !!line.isSelectedAlternative;
  const dimmed = optional || (inGroup && !isSelected);
  return (
    <>
    <li className={`px-3 sm:px-5 py-4 border-b border-ink-100 last:border-b-0 ${
      optional ? 'bg-ink-50/30 border-l-2 border-dashed border-ink-300' : ''
    } ${
      inGroup ? 'border-l-2 border-solid border-brand-300' : ''
    } ${
      // Conjunto member: shared violet left accent + tint, distinct from
      // the alternative's brand accent. Members are NEVER dimmed (every
      // piece is priced / take-all), so no veil here.
      inSet ? 'border-l-2 border-solid border-violet-300 bg-violet-50/20' : ''
    } ${
      dimmed ? 'relative' : ''
    }`}>
      {/* Deactivated (optional) or non-selected alternative: fade the row
          with a white veil. Only the swatch is lifted above it (z-[2]); the
          product photo dims with the rest, matching the editor + PDF. */}
      {dimmed && (
        <div className="pointer-events-none absolute inset-0 z-[1] bg-white/45" aria-hidden />
      )}
      {(optional || inGroup || inSet) && (
        <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-widest">
          {optional && (
            <span className="text-ink-500">
              Opcional · no incluido en el total
            </span>
          )}
          {inGroup && groupInfo && (
            <span className="text-brand-700 font-semibold">
              Alternativa {groupInfo.index} de {groupInfo.total}
              {isSelected && <span className="ml-1.5 text-emerald-700 normal-case font-medium">· seleccionada</span>}
            </span>
          )}
          {inSet && setInfo && (
            <span className="inline-flex items-center gap-1 text-violet-700 font-semibold">
              <Boxes size={11} className="opacity-80" aria-hidden />
              Conjunto {setInfo.index} de {setInfo.total}
            </span>
          )}
        </div>
      )}
      {/* Image sizing matches the PDF: a "quarter page of space" per
          dealer's directive. The PDF uses 170pt (~60mm); we land
          around the same physical scale on screen — w-44 (176px) on
          phones, w-52 (208px) on tablets+ — so the on-screen preview
          and the printed PDF read the same. The previous w-20 / w-24
          (80px / 96px) was small enough that dealers asked for the
          PDF images to be bigger when the preview "looked fine". */}
      <div className="flex items-start gap-4 sm:gap-5">
        {line.imageId ? (
          <ImageZoom id={line.imageId} alt={line.name || ''} className="w-32 h-32 sm:w-44 sm:h-44 lg:w-52 lg:h-52 object-contain bg-white rounded-md border border-ink-100" />
        ) : (
          <div className="w-32 h-32 sm:w-44 sm:h-44 lg:w-52 lg:h-52 bg-ink-50 rounded-md border border-ink-100 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0 sm:flex sm:items-start sm:gap-6">
          <div className="min-w-0 sm:flex-1">
            {line.family && (
              <div className="text-[10px] font-semibold uppercase tracking-widest text-brand-700 mb-0.5">
                {line.family}
              </div>
            )}
            <div className="text-sm font-semibold text-ink-900">{line.name || '—'}</div>
            {(line.subtype || line.reference || line.dimensions || line.swatchImageId) && (
              <div className="flex items-start gap-2.5 mt-1">
                {line.swatchImageId && (
                  <ImageZoom
                    id={line.swatchImageId}
                    alt="Muestra de tela"
                    className="relative z-[2] w-11 h-11 object-cover rounded border border-ink-200 bg-white"
                  />
                )}
                {/* Subtype + ref/dimensions stacked to the right of the
                    swatch so the photo spans both rows instead of sitting
                    inline with just the grade line. */}
                <div className="min-w-0">
                  {line.subtype && <div className="text-[11px] text-ink-500">{line.subtype}</div>}
                  {(line.reference || line.dimensions) && (
                    <div className="text-[10px] text-ink-500 mt-0.5 flex flex-wrap gap-x-2">
                      {line.reference && <span className="font-mono">REF. {line.reference}</span>}
                      {line.dimensions && <span>DIM. {line.dimensions}</span>}
                    </div>
                  )}
                </div>
              </div>
            )}
            {line.description && (
              <div className="text-[11px] text-ink-600 mt-1.5 max-w-xl whitespace-pre-line">
                {line.description}
              </div>
            )}
          </div>

          {/* Numbers — on mobile we render a single compact line at
              the bottom of the card (`1 × $11,310.00 = $11,310.00`).
              That's the dealer-side editor's mental model already, and
              it solves the layout problem that two prior fixes danced
              around: a wide horizontal pill strip kept flex-wrapping
              each label/value pair onto its own row when the values
              were 5+ digits, and a vertical right-aligned column left
              a tall dead zone next to it. One inline equation is
              ~30 chars wide, fits comfortably on any phone, and reads
              as "this line costs $11,310.00" in one glance.

              On sm+ we promote back to the labelled vertical column
              (CANTIDAD / UNITARIO / TOTAL) as the right rail — the
              desktop layout had no width problem and benefits from
              the explicit labels. */}

          {/* Mobile: single-line equation. Hidden at sm+.
              When the line carries a discount we surface a second
              right-aligned caption ("antes $X · –Y%") so the customer
              can see what they're saving — the bare equation otherwise
              shows only the post-discount unit and hides the
              concession. */}
          <div className="sm:hidden mt-3 pt-3 border-t border-ink-100 text-right tabular-nums">
            <div className="text-sm whitespace-nowrap">
              <span className="text-ink-700">{qty}</span>
              <span className="text-ink-400 mx-1.5" aria-hidden>×</span>
              <span className="text-ink-700">{fmt(unit)}</span>
              <span className="text-ink-400 mx-1.5" aria-hidden>=</span>
              <span className="text-ink-900 font-semibold">{fmt(total)}</span>
            </div>
            {discounted && (
              <div className="text-[11px] text-brand-700 mt-1 whitespace-nowrap">
                <span className="line-through text-ink-400 mr-1.5">{fmt(listUnit)}</span>
                <span>descuento –{discount}%</span>
              </div>
            )}
          </div>

          {/* sm+: vertical labelled column. Hidden below sm.
              Discount, when present, becomes the visual centerpiece:
              the list price is struck through above Unitario, and a
              brand-color "Descuento –Y%" caption sits between Unitario
              and Total so the savings register at a glance. */}
          <div className="hidden sm:block text-right tabular-nums min-w-[120px] flex-shrink-0">
            <PriceCell label="Cantidad" value={String(qty)} />
            {discounted && (
              <div className="mt-1.5 text-right">
                <div className="text-[10px] uppercase tracking-wide text-brand-700 font-semibold whitespace-nowrap">
                  Precio lista
                </div>
                <div className="text-sm text-ink-400 line-through whitespace-nowrap">
                  {fmt(listUnit)}
                </div>
              </div>
            )}
            <div className="mt-1.5"><PriceCell label="Unitario" value={fmt(unit)} /></div>
            {discounted && (
              <div className="text-[11px] text-brand-700 font-medium mt-0.5">
                Descuento –{discount}%
              </div>
            )}
            <div className="mt-1.5"><PriceCell label="Total" value={fmt(total)} emphasis /></div>
            {discounted && qty > 1 && (
              <div className="text-[10px] text-ink-500 mt-0.5 whitespace-nowrap">
                ahorras {fmt(listTotal - total)}
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
    {footer}
    </>
  );
}

// Compound line — one family + one image header, then a stacked list of
// component rows underneath. Each row has its own name / ref / dim /
// subtype + its own qty × unit = subtotal. The whole block resolves into
// a single "Total compuesto" amount.
//
// The footer mirrors the article line's discount column (PriceCell +
// Precio lista + Descuento + ahorras) so a customer comparing a single-
// item discount to a bundle discount reads the same vocabulary in the
// same position — the "design system" is the shared eyebrow / strike /
// brand-caption stack, not a one-off composition.
function CompoundClientLine({ line, fmt, groupInfo, setInfo, inSet }) {
  const subtotal = compoundSubtotal(line);
  const grandTotal = lineTotal(line);
  const discount = Number(line.lineDiscountPct) || 0;
  const discounted = discount > 0;
  const optional = !!line.isOptional;
  const inGroup = !!line.alternativeGroup;
  const isSelected = !!line.isSelectedAlternative;
  const dimmed = optional || (inGroup && !isSelected);
  return (
    <li className={`px-3 sm:px-5 py-4 border-b border-ink-100 last:border-b-0 ${
      optional ? 'bg-ink-50/30 border-l-2 border-dashed border-ink-300' : ''
    } ${
      inGroup ? 'border-l-2 border-solid border-brand-300' : ''
    } ${
      // Conjunto member (a set member may itself be a compound article):
      // shared violet left accent + tint, never dimmed.
      inSet ? 'border-l-2 border-solid border-violet-300 bg-violet-50/20' : ''
    } ${
      dimmed ? 'relative' : ''
    }`}>
      {/* Deactivated (optional) or non-selected alternative: fade the row
          with a white veil. Only the swatch is lifted above it (z-[2]); the
          product photo dims with the rest, matching the editor + PDF. */}
      {dimmed && (
        <div className="pointer-events-none absolute inset-0 z-[1] bg-white/45" aria-hidden />
      )}
      {(optional || inGroup || inSet) && (
        <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-widest">
          {optional && (
            <span className="text-ink-500">Opcional · no incluido en el total</span>
          )}
          {inGroup && groupInfo && (
            <span className="text-brand-700 font-semibold">
              Alternativa {groupInfo.index} de {groupInfo.total}
              {isSelected && <span className="ml-1.5 text-emerald-700 normal-case font-medium">· seleccionada</span>}
            </span>
          )}
          {inSet && setInfo && (
            <span className="inline-flex items-center gap-1 text-violet-700 font-semibold">
              <Boxes size={11} className="opacity-80" aria-hidden />
              Conjunto {setInfo.index} de {setInfo.total}
            </span>
          )}
        </div>
      )}
      <div className="flex items-start gap-4 sm:gap-5">
        {/* Sticky image column: a compound article can carry a long
            component list, so the shared product image is pinned to the
            top of the viewport (offset clears the mobile sticky header)
            and stays visible as the customer scrolls the components
            beside it. `self-start` keeps the sticky box confined to this
            row's height; with a short component list there's nothing to
            scroll past, so it simply sits put — graceful degradation. */}
        <div className="flex-shrink-0 self-start sticky top-4">
          {line.imageId ? (
            <ImageZoom
              id={line.imageId}
              alt={line.name || ''}
              className="w-32 h-32 sm:w-44 sm:h-44 lg:w-52 lg:h-52 object-contain bg-white rounded-md border border-ink-100"
            />
          ) : (
            <div className="w-32 h-32 sm:w-44 sm:h-44 lg:w-52 lg:h-52 bg-ink-50 rounded-md border border-ink-100" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          {line.family && (
            <div className="text-[10px] font-semibold uppercase tracking-widest text-brand-700 mb-0.5">
              {line.family}
            </div>
          )}
          {line.name && (
            <div className="text-sm font-semibold text-ink-900">{line.name}</div>
          )}
          <ul className="mt-2 divide-y divide-ink-100 border-t border-ink-100">
            {(line.components || []).map((c, i) => (
              <CompoundComponentRow key={c.id || i} component={c} fmt={fmt} />
            ))}
          </ul>
          <div className="mt-3 pt-2 border-t border-ink-200 tabular-nums">
            <div className="ml-auto w-fit text-right">
              {discounted && (
                <>
                  <div className="text-[10px] uppercase tracking-wide text-brand-700 font-semibold whitespace-nowrap">
                    Precio lista
                  </div>
                  <div className="text-sm text-ink-400 line-through whitespace-nowrap">
                    {fmt(subtotal)}
                  </div>
                  <div className="text-[11px] text-brand-700 font-medium mt-0.5 whitespace-nowrap">
                    Descuento –{discount}%
                  </div>
                </>
              )}
              <div className={discounted ? 'mt-1.5' : ''}>
                <PriceCell label="Total compuesto" value={fmt(grandTotal)} emphasis />
              </div>
              {discounted && (
                <div className="text-[10px] text-ink-500 mt-0.5 whitespace-nowrap">
                  ahorras {fmt(subtotal - grandTotal)}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

function CompoundComponentRow({ component, fmt }) {
  const qty = Number(component.qty) || 0;
  const unit = Number(component.unitPrice) || 0;
  const subtotal = componentSubtotal(component);
  const optional = !!component.isOptional;
  return (
    <li className={`py-2 flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-x-4 ${
      optional ? 'relative pl-3 border-l-2 border-dashed border-ink-300' : ''
    }`}>
      {/* Optional: dim with a white veil; the swatch carries its own
          z-[2] so the fabric colour stays visible to the client. */}
      {optional && (
        <div className="pointer-events-none absolute inset-0 z-[1] bg-white/45" aria-hidden />
      )}
      <div className="min-w-0 sm:flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium text-ink-900">{component.name || '—'}</span>
          {optional && (
            <span className="text-[10px] uppercase tracking-widest text-ink-500">
              Opcional · no incluido
            </span>
          )}
        </div>
        {(component.subtype || component.reference || component.dimensions || component.swatchImageId) && (
          <div className="flex items-start gap-2 mt-0.5">
            {component.swatchImageId && (
              <ImageZoom
                id={component.swatchImageId}
                alt="Muestra de tela"
                className="relative z-[2] w-11 h-11 object-cover rounded border border-ink-200 bg-white"
              />
            )}
            {/* Subtype + ref/dimensions stacked to the right so the swatch
                spans both rows, mirroring the standalone line treatment. */}
            <div className="min-w-0">
              {component.subtype && <div className="text-[11px] text-ink-500">{component.subtype}</div>}
              {(component.reference || component.dimensions) && (
                <div className="text-[10px] text-ink-500 mt-0.5 flex flex-wrap gap-x-2">
                  {component.reference && <span className="font-mono">REF. {component.reference}</span>}
                  {component.dimensions && <span>DIM. {component.dimensions}</span>}
                </div>
              )}
            </div>
          </div>
        )}
        {component.description && (
          <div className="text-[11px] text-ink-600 mt-1 max-w-xl whitespace-pre-line">
            {component.description}
          </div>
        )}
      </div>
      <div className={`text-right tabular-nums whitespace-nowrap text-xs sm:text-sm ${
        optional ? 'text-ink-500' : ''
      }`}>
        <span className="text-ink-700">{qty}</span>
        <span className="text-ink-400 mx-1.5" aria-hidden>×</span>
        <span className="text-ink-700">{fmt(unit)}</span>
        <span className="text-ink-400 mx-1.5" aria-hidden>=</span>
        <span className={optional ? 'text-ink-500 font-medium' : 'text-ink-900 font-semibold'}>
          {optional ? `+ ${fmt(subtotal)}` : fmt(subtotal)}
        </span>
      </div>
    </li>
  );
}

// Small label/value pair used inside the line-item summary strip.
// label = brand-700 eyebrow; value = ink-900. On mobile each cell sits
// inline with its siblings (label-above-value still, just compact);
// on sm+ they stack vertically and right-align as part of the column.
function PriceCell({ label, value, emphasis }) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-wide text-brand-700 font-semibold whitespace-nowrap">
        {label}
      </div>
      <div className={`whitespace-nowrap ${emphasis ? 'text-base font-semibold text-ink-900' : 'text-sm font-medium text-ink-900'}`}>
        {value}
      </div>
    </div>
  );
}

// Conjunto (set) roll-up footer — rendered once after the last member of
// a contiguous set run. Mirrors the editor's LineItemList treatment
// (violet left accent + tint, Boxes icon, "Total del conjunto"). The
// value is setSubtotal(): the simple SUM of each member's own line total,
// computed by the parent. Purely presentational — it does NOT feed the
// grand total (members already counted individually via isPricedLine).
function SetFooter({ value }) {
  return (
    <li className="border-l-2 border-solid border-violet-300 bg-violet-50/40 px-4 sm:px-5 py-2.5 flex items-center justify-between gap-2 border-b border-ink-100 last:border-b-0">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-violet-700">
        <Boxes size={12} className="opacity-80" aria-hidden />
        Total del conjunto
      </span>
      <span className="text-sm font-semibold text-ink-900 tabular-nums">{value}</span>
    </li>
  );
}

function TotalRow({ label, value, muted, accent, bold }) {
  const tone = bold
    ? 'font-semibold text-base text-ink-900'
    : accent
    ? 'text-brand-700 font-medium'
    : muted
    ? 'text-ink-500'
    : '';
  return (
    <div className={`flex justify-between text-sm ${tone}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function groupBySection(lines) {
  const groups = [];
  let cur = { label: null, items: [] };
  for (const l of lines) {
    if (l.kind === LINE_KIND_SECTION) {
      if (cur.items.length || cur.label) groups.push(cur);
      cur = { label: l.name || 'Sección', items: [] };
    } else {
      cur.items.push(l);
    }
  }
  if (cur.items.length || cur.label) groups.push(cur);
  return groups;
}
