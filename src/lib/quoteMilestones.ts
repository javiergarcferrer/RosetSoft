/**
 * Quote-level commerce milestones — the three timestamps that track
 * what the *customer* has done with their cotización, independent of
 * the order's logistics lifecycle (which lives in orderStages.js).
 *
 *   depositReceivedAt  →  client paid the down payment.
 *                         The dealer's words: "el acto de confirmar
 *                         la cotización es recibir el depósito".
 *                         This is the moment a quote becomes a
 *                         committed sale.
 *
 *   balancePaidAt      →  client paid the remaining balance.
 *                         Required before delivery: "el balance se
 *                         debe marcar antes de entregar".
 *
 *   deliveredAt        →  client has taken physical delivery of
 *                         their goods.
 *
 * The chain is strictly ordered for marking: you can't record a
 * balance without a deposit, and you can't record a delivery without
 * a balance and without the parent order being in 'recibido'. Each
 * step can still be UN-marked freely (the dealer may need to correct
 * a typo or a wrong date); the gates only restrict the forward edge.
 *
 * Why a separate file from orderStages.js
 * ---------------------------------------
 * The order's stage lives on the order row; these three live on the
 * quote row. Keeping the helpers next to the data they read from
 * makes it obvious which entity each milestone belongs to and avoids
 * the previous version's coupling, where order-level helpers
 * pretended to know about quote-level fulfillment.
 */

import type { Quote, Order } from '../types/domain.ts';

/** Snapshot of which of the three milestones are complete on a quote. */
export interface QuoteMilestoneState {
  deposit: boolean;
  balance: boolean;
  delivered: boolean;
}

/**
 * Can the dealer mark this quote's deposit as received?
 *
 * Only valid for accepted quotes — drafts and rejections shouldn't
 * have a deposit recorded against them. (The picker stays available
 * in the UI so the dealer sees what to do next; this just controls
 * the enabled state.)
 */
export function canMarkDeposit(quote: Quote | null | undefined): boolean {
  if (!quote) return false;
  if (quote.status !== 'accepted') return false;
  return !quote.depositReceivedAt;
}

/**
 * Can the dealer mark the balance as paid? Requires a deposit on
 * record (the dealer's flow: deposit first, balance later) but no
 * order-status precondition — customers sometimes pay the balance
 * while goods are still in transit.
 */
export function canMarkBalance(quote: Quote | null | undefined): boolean {
  if (!quote) return false;
  if (!quote.depositReceivedAt) return false;
  return !quote.balancePaidAt;
}

/**
 * Can the dealer mark this quote as delivered to the customer?
 *
 *   1. The balance must be paid — the dealer's hard rule is that
 *      goods don't leave the warehouse until the customer has paid.
 *   2. The parent order must be in 'received' — the goods must
 *      physically exist in the warehouse before they can be delivered.
 *
 * Both conditions matter; the first is a commerce rule the dealer
 * imposes on themselves, the second is a logistics reality.
 */
export function canMarkDelivered(
  quote: Quote | null | undefined,
  order: Order | null | undefined,
): boolean {
  if (!quote) return false;
  if (quote.deliveredAt) return false;
  if (!quote.balancePaidAt) return false;
  if (!order || order.status !== 'received') return false;
  return true;
}

/**
 * Short Spanish hint describing why the delivery action is blocked.
 * Returned hint is intended for a button tooltip / disabled-state
 * helper text. Returns null when the action is actually available.
 */
export function deliveryBlockedReason(
  quote: Quote | null | undefined,
  order: Order | null | undefined,
): string | null {
  if (!quote || quote.deliveredAt) return null;
  if (!quote.depositReceivedAt) {
    return 'Marca el depósito recibido primero.';
  }
  if (!quote.balancePaidAt) {
    return 'Marca el balance pagado antes de entregar.';
  }
  if (!order || order.status !== 'received') {
    return 'El pedido aún no está en "Recibido".';
  }
  return null;
}

/**
 * A small machine-readable snapshot of which quote milestones are
 * complete. Useful for rendering a per-quote progress strip.
 */
export function quoteMilestoneState(quote: Quote | null | undefined): QuoteMilestoneState {
  return {
    deposit:   !!quote?.depositReceivedAt,
    balance:   !!quote?.balancePaidAt,
    delivered: !!quote?.deliveredAt,
  };
}

/**
 * What the customer still owes on an accepted quote, in the same
 * currency as `total` (the quote's grand total, USD base):
 *
 *   • nothing paid yet        → the full total (the deposit hasn't landed).
 *   • deposit received        → total − depositAmount (the balance).
 *   • balance paid            → 0 — nothing outstanding, delivered or not
 *     (the dealer's rule: goods don't leave until the balance is paid,
 *     so delivery never adds money owed).
 *
 * A deposit recorded without an amount (`depositAmount` null/0) leaves
 * the full total outstanding — better to over-state what's owed than to
 * silently forgive the balance. Clamped at 0 so an over-collected
 * deposit can't show a negative receivable.
 */
export function quoteOutstanding(
  quote: Pick<Quote, 'depositReceivedAt' | 'balancePaidAt' | 'depositAmount'> | null | undefined,
  total: number,
): number {
  if (!quote) return 0;
  if (quote.balancePaidAt) return 0;
  const safeTotal = Math.max(0, Number(total) || 0);
  if (!quote.depositReceivedAt) return safeTotal;
  return Math.max(0, safeTotal - (Number(quote.depositAmount) || 0));
}

/**
 * Floor sale = a quote not attached to an order — the piece left the floor, so
 * there's no delivery cycle: the moment money changes hands (the deposit) it's
 * ready to bill. Special/import orders still wait for delivery.
 */
export function isFloorSale(quote: Pick<Quote, 'orderId'> | null | undefined): boolean {
  return !quote?.orderId;
}

/**
 * Ready to invoice = accepted, and either delivered (any order type) or — for
 * a floor sale — its deposit has been received. The single gate Facturación's
 * "Por facturar" queue and the CRM dashboard tile share.
 */
export function readyToInvoice(
  quote: Pick<Quote, 'status' | 'orderId' | 'deliveredAt' | 'depositReceivedAt'> | null | undefined,
): boolean {
  if (!quote || quote.status !== 'accepted') return false;
  if (quote.deliveredAt) return true;
  return isFloorSale(quote) && !!quote.depositReceivedAt;
}

/** The effective invoice date — delivery if known, else the deposit, else accept. */
export function invoiceReadyAt(
  quote: Pick<Quote, 'deliveredAt' | 'depositReceivedAt' | 'acceptedAt'> | null | undefined,
): number {
  return quote?.deliveredAt || quote?.depositReceivedAt || quote?.acceptedAt || Date.now();
}
