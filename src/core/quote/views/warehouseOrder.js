// ViewModel for the warehouse-order (orden de almacén) document — the picking
// list the dealer hands the warehouse to PULL and PREPARE a quote's furniture:
// product photo · reference · name · quantity. Distinct from the supplier
// "Registro LR" (core/quote/views/registration): that registers a whole pedido
// with Ligne Roset and is price-free by design; this one is per-QUOTE, carries
// a PHOTO so the warehouse recognises each piece, and is also price-free (a
// fulfilment doc, never an invoice).
//
// MVVM: QuoteBuilder's export hook calls this and hands the result to the PDF
// renderer (src/pdf/order/WarehouseOrderDocument). Pure — no React, no db, no
// pdf. The cover photo is referenced by the owning line's id (`lineId`); the
// renderer (View layer, where the image-map key format lives) maps that to the
// SAME key the quote PDF's image resolver fills, so the photo resolves.
import { isPricedLine, isPricedComponent } from '../../../lib/constants.js';

// What's pulled is what's priced: an excluded optional or a non-selected
// alternative still renders on the customer's quote but must never reach the
// warehouse — that would prepare furniture nobody bought. Same gates as the
// money (isPricedLine / isPricedComponent). The product PHOTO is line-level
// (only a line carries `imageId`), so every row a line produces — including a
// compound's component rows — shares the parent line's cover photo.
function rowsForLine(ln) {
  if (ln.kind === 'section') return [];
  if (!isPricedLine(ln)) return [];
  const qtyOf = (v) => (Number.isFinite(Number(v)) ? Number(v) : 1);
  const lineId = ln.id;

  // Compound: the pullable SKUs are the COMPONENTS (each carries its own
  // reference + qty; the parent is a composition with qty 1 — see
  // lib/pricing:lineQty). Drop unpriced components/modules the same way the
  // totals do, and pin each to the parent line's photo.
  if (Array.isArray(ln.components) && ln.components.length > 0) {
    return ln.components
      .filter((c) => isPricedComponent(c))
      .map((c) => ({
        reference: c.reference || '',
        name: c.name || ln.name || '—',
        // Parent composition as context when the component has its own name.
        detail: [
          c.name && ln.name && c.name !== ln.name ? ln.name : null,
          c.subtype || null,
        ].filter(Boolean).join(' · '),
        qty: qtyOf(c.qty),
        lineId,
      }));
  }

  return [{
    reference: ln.reference || '',
    name: ln.name || ln.reference || '—',
    detail: [ln.productDescription || null, ln.subtype || null].filter(Boolean).join(' · '),
    qty: qtyOf(ln.qty),
    lineId,
  }];
}

/**
 * Project one quote (+ its lines) into the warehouse-order document's content:
 * the customer / decorator / seller context the warehouse wants on file, the
 * pullable rows (photo key · reference · name · qty), and the piece totals.
 */
export function resolveWarehouseOrder({
  quote, lines, customer, professional, seller,
}) {
  const rows = (lines || [])
    .slice()
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .flatMap(rowsForLine);

  return {
    quoteNumber: quote?.number || null,
    customerName: customer ? (customer.company || customer.name || '') : '',
    professionalName: professional?.name || null,
    sellerName: seller?.name || null,
    rows,
    totalPieces: rows.reduce((s, r) => s + r.qty, 0),
    rowCount: rows.length,
  };
}
