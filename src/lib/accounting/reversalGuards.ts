// Reversal / annulment guards — the books-honesty gates that keep a factura's
// lifecycle sound when something is reversed. Pure: no React, no db, no SQL.
//
// These mirror the server-side checks in the `void_sale` RPC and the
// `post_payment` allocation guard (the Deno↔Vite wall means the rule lives at
// BOTH layers on purpose — the client gives the dealer an instant, friendly
// message; the RPC is the authoritative backstop a stale UI can never bypass).
//
// The cardinal rule: never anul a factura that already has cobros applied. If we
// did, the receivables FIFO would silently re-apply that money to the customer's
// OTHER open invoices (and the refund we now owe would vanish from the books).
// Reverse the cobro first — then the anulación is clean.

import type { Payment, SalePosting } from '../../types/domain';

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/** Every payment carrying an allocation that names this posting. */
export function paymentsAllocatedTo(
  postingId: string | null | undefined,
  payments: Payment[] | null | undefined,
): Payment[] {
  if (!postingId) return [];
  return (payments || []).filter((p) =>
    (p.allocations || []).some((a) => a.docId === postingId),
  );
}

/** Total DOP allocated against this posting across all cobros. */
export function amountCollectedOn(
  postingId: string | null | undefined,
  payments: Payment[] | null | undefined,
): number {
  return paymentsAllocatedTo(postingId, payments).reduce(
    (sum, p) =>
      sum +
      (p.allocations || [])
        .filter((a) => a.docId === postingId)
        .reduce((x, a) => x + (Number(a.amount) || 0), 0),
    0,
  );
}

const isCreditNoteNcf = (ncf: string | null | undefined): boolean => /^E34/.test(ncf || '');

/**
 * Can this posting be anulada (voided in place)? A not-yet-transmitted e-CF
 * leaves a DGII-compliant sequence gap; an ISSUED one (sent/accepted) is only
 * cancelled with a nota de crédito. A posting that already has cobros is blocked
 * until the cobro is reversed.
 */
export function canVoidPosting(
  posting: Pick<SalePosting, 'id' | 'ncf' | 'ecfStatus' | 'voidedAt'> | null | undefined,
  payments: Payment[] | null | undefined,
): GuardResult {
  if (!posting) return { ok: false, reason: 'Factura no encontrada.' };
  if (posting.voidedAt) return { ok: false, reason: 'La factura ya está anulada.' };
  if (posting.ecfStatus === 'sent' || posting.ecfStatus === 'accepted') {
    return { ok: false, reason: 'Un e-CF ya transmitido a la DGII sólo se cancela con una nota de crédito.' };
  }
  if (isCreditNoteNcf(posting.ncf)) {
    return { ok: false, reason: 'Una nota de crédito no se anula por aquí.' };
  }
  if (paymentsAllocatedTo(posting.id, payments).length > 0) {
    return { ok: false, reason: 'Esta factura tiene cobros aplicados. Revierte el cobro antes de anular.' };
  }
  return { ok: true };
}

/**
 * Can a cobro be applied to this posting? An anulada factura no longer exists in
 * receivables, so a payment allocated to it would orphan (and the FIFO would
 * misapply it). A nota de crédito is never collected.
 */
export function canCollectPosting(
  posting: Pick<SalePosting, 'ncf' | 'voidedAt'> | null | undefined,
): GuardResult {
  if (!posting) return { ok: false, reason: 'Factura no encontrada.' };
  if (posting.voidedAt) return { ok: false, reason: 'La factura está anulada; no admite cobros.' };
  if (isCreditNoteNcf(posting.ncf)) return { ok: false, reason: 'Una nota de crédito no se cobra.' };
  return { ok: true };
}
