// Meta receipts review-queue ViewModel — projects the pending `meta_receipts`
// drafts into exactly what the review panel renders, and hands each row a
// ready-to-post Expense draft. Pure: no React, no db.
//
// The "Meta" vendor is an `exterior` supplier (no Dominican RNC/NCF). We resolve
// it from the suppliers list by kind+name so the dealer doesn't pick it every
// time; a row whose supplier isn't set up yet is flagged `needsSupplier` so the
// View can offer to create it.
import { round2 } from '../../lib/accounting/ledger.js';
import { metaReceiptDraft, billingPeriodLabel } from '../../lib/accounting/metaReceipts.js';

/** Find the team's "Meta" exterior supplier (Meta / Facebook / Instagram). */
export function findMetaSupplier(suppliers) {
  return (suppliers || []).find(
    (s) => s.kind === 'exterior' && /\bmeta\b|facebook|instagram/i.test(s.name || ''),
  ) || null;
}

/**
 * Resolve the pending Meta receipts into review rows + their Expense drafts.
 * `dopRate` is the live USD→DOP rate (effectiveDopRate) — the AUTHORITATIVE
 * conversion is recomputed here via the Model, so a stale denormalized
 * `amountDop` never reaches the books.
 */
export function resolveMetaReceiptsQueue({ receipts, suppliers, accounts, dopRate, defaultAccountCode } = {}) {
  const supplier = findMetaSupplier(suppliers);
  // The gasto account: the Meta supplier's default, else the caller's fallback.
  const accountCode = supplier?.defaultAccountCode || defaultAccountCode || null;
  const nameByCode = new Map((accounts || []).map((a) => [a.code, a.name]));

  const rows = (receipts || [])
    .filter((r) => r.status === 'pending')
    .sort((a, b) => (b.periodEndAt || 0) - (a.periodEndAt || 0))
    .map((r) => {
      // Build the draft only when we can convert + book it; otherwise flag why.
      let draft = null;
      let error = null;
      const ready = !!(supplier && accountCode);
      if (ready) {
        try {
          draft = metaReceiptDraft({ record: r, supplierId: supplier.id, accountCode, dopRate });
        } catch (e) {
          error = e?.message || String(e);
        }
      }
      return {
        receipt: r,
        id: r.id,
        periodLabel: billingPeriodLabel(r.periodStartAt),
        adAccountId: r.adAccountId,
        currency: r.currency,
        amount: round2(r.amount || 0),
        amountDop: draft ? draft.base : (r.amountDop != null ? round2(r.amountDop) : null),
        source: r.source,
        invoiceUrl: r.invoiceUrl || null,
        invoiceNumber: r.invoiceNumber || null,
        accountName: nameByCode.get(accountCode) || '',
        needsSupplier: !supplier,
        needsAccount: !!supplier && !accountCode,
        error,
        draft,
      };
    });

  const totalDop = round2(rows.reduce((s, r) => s + (r.amountDop || 0), 0));
  return { rows, count: rows.length, totalDop, supplier, accountCode };
}
