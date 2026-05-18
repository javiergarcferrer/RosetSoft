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
          <div className="text-[10px] font-medium uppercase tracking-widest text-ink-500">Cotización</div>
          <div className="text-3xl font-semibold tracking-tight">#{quote.number || '—'}</div>
          <div className="text-[11px] text-ink-500 mt-2">{formatDate(quote.updatedAt)}</div>
        </div>
      </div>

      {/* Customer block */}
      {customer && (
        <div className="px-6 sm:px-10 py-5 border-b border-ink-100">
          <div className="text-[10px] font-medium uppercase tracking-widest text-ink-500 mb-1.5">Cliente</div>
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
          <div className="text-[10px] font-medium uppercase tracking-widest text-ink-500 mb-2">Términos</div>
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
  // CSS grid instead of flex-wrap. The old layout used `min-w-[120px]
  // text-right` on the numeric column, which on a phone-width row
  // wrapped onto its own line at ~120px wide — leaving the values
  // floating in the middle of the card instead of sticking to the
  // right edge. Grid lets the numeric column span both other columns
  // on mobile (full-width row, right-aligned to the card border)
  // and slot back to a third column on sm+ widths.
  return (
    <li className="px-3 sm:px-5 py-4 border-b border-ink-100 last:border-b-0">
      <div className="grid gap-x-4 gap-y-3 grid-cols-[80px_minmax(0,1fr)] sm:grid-cols-[96px_minmax(0,1fr)_auto] items-start">
        {line.imageId ? (
          <ImageView id={line.imageId} className="w-20 h-20 sm:w-24 sm:h-24 object-contain bg-white rounded-md border border-ink-100" />
        ) : (
          <div className="w-20 h-20 sm:w-24 sm:h-24 bg-ink-50 rounded-md border border-ink-100" />
        )}
        <div className="min-w-0">
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
        {/* col-span-2 on mobile: numeric slot occupies the full row
            beneath the image+text, so text-right hugs the right edge
            of the card. On sm+ it returns to a third column next to
            the text block. min-w-0 keeps long money strings from
            forcing the row wider than the card. */}
        <div className="col-span-2 sm:col-span-1 text-right tabular-nums min-w-0 sm:min-w-[110px]">
          <div className="text-[10px] uppercase tracking-wide text-brand-700 font-semibold">Cantidad</div>
          <div className="text-sm font-medium">{line.qty || 0}</div>
          <div className="text-[10px] uppercase tracking-wide text-brand-700 font-semibold mt-1.5">Unitario</div>
          <div className="text-sm font-medium">{fmt(unit)}</div>
          <div className="text-[10px] uppercase tracking-wide text-brand-700 font-semibold mt-1.5">Total</div>
          <div className="text-base font-semibold">{fmt(total)}</div>
        </div>
      </div>
    </li>
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
