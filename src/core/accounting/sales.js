// Accounting Model — the per-sale commission derivation for the Contabilidad
// workspace.
//
// MVVM: pages/accounting/Workspace.jsx renders THIS; the heavy domain logic
// (which accepted quotes count as "sales" in the cycle, each one's seller +
// professional commission streams, and the two payout rollups) lives here, in
// the Model, not inline in the page. Pure — the page passes the cycle-scoped
// data plus a `totalsFor(quote)` resolver (the page owns the line lookup).
import { QUOTE_STATUS_ACCEPTED } from '../../lib/constants.js';
import { clampPct } from '../../lib/commissionCycle.js';
import {
  baseCommissionPct, commissionAmount, decoratorBilling,
  commissionOwedAt, reportedCommission,
} from '../../lib/commissions.js';

/**
 * ONE entry per accepted quote ("sale") whose acceptedAt OR depositReceivedAt
 * lands inside `cycle`. Each entry carries the Odoo figures AND both commission
 * streams owed on the sale; the two rollups aggregate the same per-sale numbers
 * so the accountant can batch payouts.
 *
 * @returns {{ entries: object[], vendedorRows: object[], profRows: object[] }}
 */
export function resolveSales({ quotes, cycle, customerById, profileById, professionalById, totalsFor }) {
  const entries = [];
  const vendedorRoll = new Map();
  const profRoll = new Map();

  for (const q of quotes || []) {
    if (q.status !== QUOTE_STATUS_ACCEPTED) continue;
    const acceptedIn = q.acceptedAt && q.acceptedAt >= cycle.start && q.acceptedAt <= cycle.end;
    const depositIn  = q.depositReceivedAt && q.depositReceivedAt >= cycle.start && q.depositReceivedAt <= cycle.end;
    if (!acceptedIn && !depositIn) continue;

    const customer = q.customerId ? customerById.get(q.customerId) : null;
    const creator  = q.createdByUserId ? profileById.get(q.createdByUserId) : null;
    const professional = q.professionalId ? professionalById.get(q.professionalId) : null;
    const t = totalsFor(q);

    // ── Seller (vendedor) commission ──────────────────────────────────
    const pct = clampPct(creator?.commissionPct);
    const potentialCommission = t.taxableBase * (pct / 100);
    // Once PAID, the figure freezes to the amount snapshotted at payout
    // (sellerCommissionPaidAmount) so editing the seller's profile rate
    // later can't restate it; unpaid stays live. `earnedCommission` keeps
    // its cycle gate (deposit-in-window) but now carries the frozen-if-paid
    // value, so the rollup + CSV report what was paid.
    const sellerReported = reportedCommission(
      q.sellerCommissionPaidAt, q.sellerCommissionPaidAmount, potentialCommission,
    );
    const earnedCommission = depositIn ? sellerReported : 0;
    const sellerPayable = Boolean(q.depositReceivedAt);
    const sellerPaid = Boolean(q.sellerCommissionPaidAt);

    // ── Professional (decorator/architect) settlement ─────────────────
    const mode = professional ? decoratorBilling(q) : null;
    const trade = mode === 'trade_discount';
    const proPct = professional ? baseCommissionPct(q) : 0;
    const proAmount = professional ? commissionAmount(t, proPct) : 0;
    // Frozen at payout (commissionPaidAmount) so a later order_type toggle /
    // base-rate change can't restate a paid commission; unpaid stays live.
    const proReported = reportedCommission(q.commissionPaidAt, q.commissionPaidAmount, proAmount);
    // Trade discount: bill the DECORATOR at their % off (no commission).
    const decoratorPct = trade ? proPct : 0;
    const tradeDiscount = trade ? proAmount : 0;
    // Commission modality only: owed per commissionOwedAt.
    const proOwedAt = mode === 'commission' ? commissionOwedAt(q) : null;
    const proOwed = proOwedAt != null;
    const proPayable = proOwed;                       // can be ticked paid
    const proPaid = Boolean(q.commissionPaidAt);

    entries.push({
      quote: q,
      customer,
      creator,
      professional,
      mode,
      trade,
      decoratorPct,
      tradeDiscount,
      base: t.taxableBase,
      // computeTotals exposes the tax amount as `taxAmt`; ITBIS is just
      // the DR-specific label for the same figure.
      itbis: t.taxAmt,
      grandTotal: t.grandTotal,
      totals: t,
      acceptedIn,
      depositIn,
      // seller cut
      commissionPct: pct,
      potentialCommission,        // live — passed to the toggle as the snapshot
      sellerReported,             // frozen-if-paid — what we display/report
      earnedCommission,
      sellerPayable,
      sellerPaid,
      // professional cut
      proPct,
      proAmount,                  // live — passed to the toggle as the snapshot
      proReported,                // frozen-if-paid — what we display/report
      proOwedAt,
      proOwed,
      proPayable,
      proPaid,
    });

    if (creator && earnedCommission > 0) {
      if (!vendedorRoll.has(creator.id)) {
        vendedorRoll.set(creator.id, {
          user: creator, pct, count: 0, base: 0, commission: 0, paid: 0, pending: 0,
        });
      }
      const row = vendedorRoll.get(creator.id);
      row.count += 1;
      row.base += t.taxableBase;
      row.commission += earnedCommission;
      if (sellerPaid) row.paid += earnedCommission; else row.pending += earnedCommission;
    }

    if (professional && mode === 'commission' && proOwed) {
      if (!profRoll.has(professional.id)) {
        profRoll.set(professional.id, {
          professional, count: 0, commission: 0, paid: 0, pending: 0,
        });
      }
      const row = profRoll.get(professional.id);
      row.count += 1;
      row.commission += proReported;
      if (proPaid) row.paid += proReported; else row.pending += proReported;
    }
  }

  entries.sort((a, b) => (b.quote.acceptedAt || 0) - (a.quote.acceptedAt || 0));
  const vendedorRows = [...vendedorRoll.values()].sort((a, b) => b.pending - a.pending);
  const profRows = [...profRoll.values()].sort((a, b) => b.pending - a.pending);

  return { entries, vendedorRows, profRows };
}

/**
 * Admin monthly payout rollup — the OTHER seller-commission surface
 * (pages/admin/Commissions.jsx). Same cycle-commission math as resolveSales,
 * kept here so both surfaces share one source of truth. Pure — the page passes
 * the cycle-scoped maps plus a `totalsFor(quote)` resolver (the page owns the
 * line lookup).
 *
 * A quote counts iff it has a deposit landing inside `window` AND a creator we
 * can attribute it to. Commissions pay on the base imponible (`base`); the
 * grand total is informational, surfaced only in the per-quote drill-down.
 * Quotes attributed to a deleted profile are skipped (silently under-report
 * rather than credit a random dealer). `depositedCount` counts every in-window
 * deposit, including those later dropped for a missing creator.
 *
 * @returns {{ rows: object[], cycleBase: number, cycleCommission: number,
 *   depositedCount: number, activeEmployees: number }}
 */
export function resolveCommissionPayout({ quotes, profilesById, customersById, totalsFor, window }) {
  // Quotes in the window: deposited within window AND attributable to a user.
  const inWindow = (quotes || []).filter((q) =>
    q.depositReceivedAt &&
    q.depositReceivedAt >= window.start &&
    q.depositReceivedAt <= window.end &&
    q.createdByUserId
  );

  // Group by creator.
  const byUser = new Map();
  let cycleBase = 0;
  let cycleCommission = 0;
  for (const q of inWindow) {
    const user = profilesById.get(q.createdByUserId);
    if (!user) continue;          // attributed to a deleted profile
    const { base, grandTotal } = totalsFor(q);
    const pct = clampPct(user.commissionPct);
    const commission = base * (pct / 100);
    cycleBase += base;
    cycleCommission += commission;
    if (!byUser.has(user.id)) {
      byUser.set(user.id, {
        user,
        pct,
        quotes: [],
        base: 0,
        commission: 0,
      });
    }
    const entry = byUser.get(user.id);
    entry.quotes.push({
      quote: q,
      customer: q.customerId ? customersById.get(q.customerId) : null,
      base,
      grandTotal,
      commission,
    });
    entry.base += base;
    entry.commission += commission;
  }

  const rows = [...byUser.values()]
    // Don't show 0-commission rows — better to omit than render a
    // zero that looks like a bug.
    .filter((r) => r.commission > 0 || r.base > 0)
    .sort((a, b) => b.commission - a.commission);

  return {
    rows,
    cycleBase,
    cycleCommission,
    depositedCount: inWindow.length,
    activeEmployees: rows.length,
  };
}
