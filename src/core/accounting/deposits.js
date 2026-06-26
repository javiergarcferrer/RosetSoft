// Depósitos por confirmar — the soft hand-off from quoting to the books.
//
// A quote's "depósito recibido" milestone is only a SIGNAL: the dealer marks,
// on the CRM side, that the customer paid a down payment. It posts nothing to
// the ledger (see core/bridge:quoteToSale, which no longer carries a deposit).
// Accounting is the single source of truth for the money — the dealer confirms
// the signal by registering the actual cobro, which carries the quote's id
// (payments.quoteId). This VM is the reconciliation between the two: the quotes
// that signalled a deposit and have NO confirming cobro yet.
//
// A quote drops off the queue the moment EITHER:
//   • a confirming cobro is recorded against it (payments.quoteId === quote.id), or
//   • it gets invoiced — once a factura exists the deposit folds into normal
//     receivables (the advance cobro nets via the FIFO), so nagging to "confirm
//     the deposit" no longer makes sense.
//
// Pure: no React, no db. `quotes`/`payments`/`salesPostings` are plain rows;
// `totalsByQuote` (Map quoteId → USD grand total) and `customersById` are
// optional and only feed the display reference. The amount is the dealer's to
// enter at confirm time — the quote never dictates it.

/**
 * @returns {{ rows: Array<{ quoteId, quote, customer, signalledAt, usdTotal }>, count: number }}
 */
export function resolveDepositConfirmations({
  quotes, payments, salesPostings, totalsByQuote, customersById,
} = {}) {
  const invoiced = new Set(
    (salesPostings || []).filter((s) => !s.voidedAt && s.quoteId).map((s) => s.quoteId),
  );
  const confirmed = new Set(
    (payments || []).filter((p) => p.direction === 'in' && p.quoteId).map((p) => p.quoteId),
  );

  const rows = (quotes || [])
    .filter((q) => q
      && q.status === 'accepted'
      && q.depositReceivedAt
      && !invoiced.has(q.id)
      && !confirmed.has(q.id))
    .map((q) => ({
      quoteId: q.id,
      quote: q,
      customer: (customersById && q.customerId && customersById.get(q.customerId)) || null,
      signalledAt: q.depositReceivedAt,
      usdTotal: (totalsByQuote && totalsByQuote.get(q.id)) || 0,
    }))
    // Oldest signal first — the deposit that's waited longest to be booked.
    .sort((a, b) => (a.signalledAt || 0) - (b.signalledAt || 0));

  return { rows, count: rows.length };
}
