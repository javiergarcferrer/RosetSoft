// Payment-plan collection — the service that turns "collect cuota N" into a real
// cobro on the ledger AND stamps the installment paid on the plan. Shared by the
// quote editor's PaymentPlanCard and the Contabilidad collections board so both
// post identically.
//
// Flow: find the quote's invoice (sales_posting) to allocate against — if none
// yet, the cobro is recorded as an ADVANCE (unallocated; receivables FIFO applies
// it once the sale is invoiced). The CRM→books translation is the bridge's
// `planInstallmentToCobro`; the posting is the shared `recordPayment`.

import { db } from './database.js';
import { recordPayment } from './payments.js';
import { planInstallmentToCobro } from '../core/bridge/index.js';

/**
 * Record a cobro for one installment and mark it paid on the plan.
 *
 * @param {object} args
 * @param {object} args.plan    the payment_plans row.
 * @param {number} args.installmentN  the 1-based cuota to collect.
 * @param {object} args.config  ResolvedAccountingConfig (from resolveAccountingConfig).
 * @param {string} args.scope   profileId.
 * @param {number} args.rate    DOP-per-USD for the cobro (cuotas are stored USD).
 * @param {string} [args.method='bank']
 * @param {number} [args.postedAt] payment date (ms); defaults to now.
 * @returns the updated plan row.
 */
export async function collectInstallment({ plan, installmentN, config, scope, rate, method = 'bank', postedAt }) {
  if (!plan) throw new Error('Plan no encontrado.');
  const schedule = Array.isArray(plan.schedule) ? plan.schedule : [];
  const installment = schedule.find((r) => r.n === installmentN);
  if (!installment) throw new Error('Cuota no encontrada.');
  if (installment.paidAt) return plan; // idempotent — already collected.

  // Allocate to the quote's invoice if it's been posted; else leave it an
  // advance (allowed before invoicing).
  const postings = plan.quoteId
    ? await db.salesPostings.where('quoteId').equals(plan.quoteId).toArray()
    : [];
  const salesPostingId = postings[0]?.id || null;

  const cobro = planInstallmentToCobro({ plan, installment, rate, method, salesPostingId });
  const at = postedAt || Date.now();
  const { id: paymentId } = await recordPayment({ scope, config, payment: cobro, postedAt: at });

  const nextSchedule = schedule.map((r) => (
    r.n === installmentN ? { ...r, paidAt: at, paymentId } : r
  ));
  const allPaid = nextSchedule.every((r) => r.paidAt);
  const row = {
    ...plan,
    schedule: nextSchedule,
    status: allPaid ? 'completed' : (plan.status === 'draft' ? 'active' : plan.status),
    updatedAt: Date.now(),
  };
  await db.paymentPlans.put(row);
  return row;
}
