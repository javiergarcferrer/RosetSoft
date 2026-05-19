import { useMemo } from 'react';
import ImageView from '../ImageView.jsx';
import { ITBIS_PCT } from '../../lib/pricing.js';
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
export default function ClientPreview({ quote, settings, lines, totals, customer }) {
  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
  const dopRate = rates.DOP || null;
  const fmt = (v) => formatMoney(v, currency, rates);

  // Group lines under their preceding section, if any. Top-level items (no
  // section before them) live under a null-key group rendered without a
  // heading.
  const groups = useMemo(() => groupBySection(lines), [lines]);

  return (
    <div className="bg-white border border-ink-100 rounded-xl shadow-soft overflow-hidden">
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

      {/* Customer block */}
      {customer && (
        <div className="px-6 sm:px-10 py-5 border-b border-ink-100">
          <div className="eyebrow mb-1.5">Cliente</div>
          <div className="text-sm font-semibold text-ink-900">{customer.name}</div>
          {customer.company && <div className="text-xs text-ink-700">{customer.company}</div>}
          <div className="text-[11px] text-ink-500 leading-relaxed mt-1">
            {[customer.address, [customer.city, customer.state, customer.zip].filter(Boolean).join(', '), customer.country, customer.email, customer.phone].filter(Boolean).join(' · ')}
          </div>
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
                {g.items.map((l) => (
                  <ClientLine key={l.id} line={l} currency={currency} rates={rates} fmt={fmt} />
                ))}
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
            <TotalRow label={`Descuento (${quote.discountPct}%)`} value={`–${fmt(totals.discountAmt)}`} muted />
          ) : null}
          <TotalRow label={`ITBIS (${ITBIS_PCT}%)`} value={fmt(totals.taxAmt)} muted />
          {quote.shipping ? <TotalRow label="Envío" value={fmt(totals.shipping)} muted /> : null}
          <div className="border-t border-ink-300 mt-2 pt-2">
            <TotalRow label="Total" value={fmt(totals.grandTotal)} bold />
          </div>
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

function ClientLine({ line, currency, rates, fmt }) {
  const unit = (Number(line.unitPrice) || 0)
    * (1 + (Number(line.lineMarginPct) || 0) / 100)
    * (1 - (Number(line.lineDiscountPct) || 0) / 100);
  const total = unit * (Number(line.qty) || 0);
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
  return (
    <li className="px-3 sm:px-5 py-4 border-b border-ink-100 last:border-b-0">
      <div className="flex items-start gap-4">
        {line.imageId ? (
          <ImageView id={line.imageId} className="w-20 h-20 sm:w-24 sm:h-24 object-contain bg-white rounded-md border border-ink-100 flex-shrink-0" />
        ) : (
          <div className="w-20 h-20 sm:w-24 sm:h-24 bg-ink-50 rounded-md border border-ink-100 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0 sm:flex sm:items-start sm:gap-6">
          <div className="min-w-0 sm:flex-1">
            {line.family && (
              <div className="text-[10px] font-semibold uppercase tracking-widest text-brand-700 mb-0.5">
                {line.family}
              </div>
            )}
            <div className="text-sm font-semibold text-ink-900">{line.name || '—'}</div>
            {line.subtype && <div className="text-[11px] text-ink-500 mt-0.5">{line.subtype}</div>}
            {(line.reference || line.dimensions) && (
              <div className="text-[10px] text-ink-500 mt-1 flex flex-wrap gap-x-2">
                {line.reference && <span className="font-mono">ref {line.reference}</span>}
                {line.dimensions && <span>{line.dimensions}</span>}
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

          {/* Mobile: single-line equation. Hidden at sm+. */}
          <div className="sm:hidden mt-3 pt-3 border-t border-ink-100 text-right text-sm tabular-nums whitespace-nowrap">
            <span className="text-ink-700">{line.qty || 0}</span>
            <span className="text-ink-400 mx-1.5" aria-hidden>×</span>
            <span className="text-ink-700">{fmt(unit)}</span>
            <span className="text-ink-400 mx-1.5" aria-hidden>=</span>
            <span className="text-ink-900 font-semibold">{fmt(total)}</span>
          </div>

          {/* sm+: vertical labelled column. Hidden below sm. */}
          <div className="hidden sm:block text-right tabular-nums min-w-[110px] flex-shrink-0">
            <PriceCell label="Cantidad" value={String(line.qty || 0)} />
            <div className="mt-1.5"><PriceCell label="Unitario" value={fmt(unit)} /></div>
            <div className="mt-1.5"><PriceCell label="Total" value={fmt(total)} emphasis /></div>
          </div>
        </div>
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

function TotalRow({ label, value, muted, bold }) {
  return (
    <div className={`flex justify-between text-sm ${
      muted ? 'text-ink-500' : ''
    } ${bold ? 'font-semibold text-base text-ink-900' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function groupBySection(lines) {
  const groups = [];
  let cur = { label: null, items: [] };
  for (const l of lines) {
    if (l.kind === 'section') {
      if (cur.items.length || cur.label) groups.push(cur);
      cur = { label: l.name || 'Sección', items: [] };
    } else {
      cur.items.push(l);
    }
  }
  if (cur.items.length || cur.label) groups.push(cur);
  return groups;
}
