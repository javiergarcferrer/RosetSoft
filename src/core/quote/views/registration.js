// ViewModel for the Ligne Roset order-registration document — the simple
// PO-style list the dealer generates from a pedido to register it with the
// supplier. Deliberately NOT an invoice: no prices, no taxes — just what to
// order (reference · product · quantity) plus the per-quote context the
// dealer wants on file (customer, decorator, seller).
//
// MVVM: pages/OrderDetail.jsx calls this and hands the result to the PDF
// renderer (src/pdf/order). Pure — no React, no db, no pdf.
import { isPricedLine, isPricedComponent } from '../../../lib/constants.js';

// What's ORDERED is what's priced: an excluded optional or a non-selected
// alternative still renders to the customer on the quote, but it must never
// reach the Ligne Roset registration — that would order furniture nobody
// bought. Same gates as the money (isPricedLine / isPricedComponent).
function rowsForLine(ln) {
  if (ln.kind === 'section') return [];
  if (!isPricedLine(ln)) return [];
  const qtyOf = (v) => (Number.isFinite(Number(v)) ? Number(v) : 1);

  // Compound: the orderable SKUs are the COMPONENTS (each carries its own
  // reference + qty; the parent is a composition with qty 1 — see
  // lib/pricing:lineQty). Drop unpriced components/modules the same way
  // the totals do.
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
      }));
  }

  return [{
    reference: ln.reference || '',
    name: ln.name || ln.reference || '—',
    detail: [ln.productDescription || null, ln.subtype || null].filter(Boolean).join(' · '),
    qty: qtyOf(ln.qty),
  }];
}

/**
 * Project an order (+ its attached quotes/lines) into the registration
 * document's content: one group per quote — customer, decorator and seller
 * names resolved — each with its orderable rows, plus the piece totals.
 */
export function resolveOrderRegistration({
  order, quotes, lines, customers, professionals, profiles,
}) {
  const byId = (arr) => new Map((arr || []).map((x) => [x.id, x]));
  const customersById = byId(customers);
  const professionalsById = byId(professionals);
  const profilesById = byId(profiles);

  const linesByQuote = new Map();
  for (const ln of lines || []) {
    if (!linesByQuote.has(ln.quoteId)) linesByQuote.set(ln.quoteId, []);
    linesByQuote.get(ln.quoteId).push(ln);
  }

  const groups = (quotes || [])
    .slice()
    .sort((a, b) => (a.number || 0) - (b.number || 0))
    .map((q) => {
      const rows = (linesByQuote.get(q.id) || [])
        .slice()
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
        .flatMap(rowsForLine);
      const customer = q.customerId ? customersById.get(q.customerId) : null;
      const professional = q.professionalId ? professionalsById.get(q.professionalId) : null;
      const seller = q.createdByUserId ? profilesById.get(q.createdByUserId) : null;
      return {
        quoteId: q.id,
        quoteNumber: q.number || null,
        customerName: customer ? (customer.company || customer.name || '') : '',
        professionalName: professional?.name || null,
        sellerName: seller?.name || null,
        rows,
        pieces: rows.reduce((s, r) => s + r.qty, 0),
      };
    })
    // A quote whose every line is excluded contributes nothing to register.
    .filter((g) => g.rows.length > 0);

  return {
    orderNumber: order?.number || null,
    orderName: order?.name || '',
    groups,
    totalPieces: groups.reduce((s, g) => s + g.pieces, 0),
    rowCount: groups.reduce((s, g) => s + g.rows.length, 0),
  };
}
