// Shared accounting-ViewModel helpers — small pure functions reused across the
// resolveX modules so a single rule (window test, expediente-cost shaping, the
// payable charge) can't drift between surfaces. Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';

/** Inclusive [start, end] window test; a null bound is open on that side. */
export function inWindow(t, start, end) {
  if (start != null && t < start) return false;
  if (end != null && t > end) return false;
  return true;
}

/**
 * Normalize one expediente cost line's money: amount clamped ≥ 0, its
 * recoverable ITBIS clamped to [0, amount], and the net base (amount − itbis).
 * The single source the 606 docs, the IT-1 crédito sum and the compras pane all
 * read, so the three can never compute a cost's split differently.
 */
export function shapeExpedienteCost(c) {
  const amount = Math.max(0, Number(c?.amount) || 0);
  const itbis = Math.min(Math.max(0, Number(c?.itbis) || 0), amount);
  return { amount: round2(amount), itbis: round2(itbis), base: round2(amount - itbis) };
}

/**
 * The amount a credit supplier doc adds to cuentas por pagar / a vendor
 * statement: base + ITBIS, net of the ISR/ITBIS retentions withheld. The single
 * source for resolvePayables and resolveStatementFor so the aging table and the
 * printed estado de cuenta never disagree.
 */
export function payableCharge(d) {
  return round2((d.base || 0) + (d.itbis || 0) - (d.retentionIsr || 0) - (d.retentionItbis || 0));
}
