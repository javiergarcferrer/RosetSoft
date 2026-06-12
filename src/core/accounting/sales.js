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

function creatorDisplay(creator) {
  if (!creator) return '';
  if (creator.name && creator.name.trim()) return creator.name.trim();
  if (creator.email) return creator.email.split('@')[0];
  return '';
}

/**
 * The workspace's refinement over one cycle's entries — deposit tab, vendedor
 * filter, free-text needle and sort — plus the tab counts and the
 * distinct-creator options the search header renders. Extracted from the
 * Workspace View because the commission sort encodes a MONEY rule: a sale
 * whose deposit fell in the cycle ranks by what it actually EARNS
 * (frozen-if-paid), one without ranks by its live potential.
 *
 * Tab counts span the whole cycle (independent of needle/vendedor filter) so
 * each tab reads "how many would I see there".
 *
 * @returns {{ rows: object[], tabs: object[], creatorOptions: object[] }}
 */
export function resolveWorkspaceEntries({
  entries, q = '', tab = 'all', creator = null, sort = { key: 'accepted', dir: 'desc' },
}) {
  const all = entries || [];

  let recibido = 0;
  for (const e of all) if (e.quote.depositReceivedAt) recibido += 1;
  const tabs = [
    { key: 'all', label: 'Todas', count: all.length },
    { key: 'recibido', label: 'Recibido', count: recibido },
    { key: 'pendiente', label: 'Pendiente', count: all.length - recibido },
  ];

  const seen = new Map();
  for (const e of all) {
    const id = e.creator?.id;
    if (!id || seen.has(id)) continue;
    const label = creatorDisplay(e.creator);
    if (label) seen.set(id, label);
  }
  const creatorOptions = [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const needle = q.trim().toLowerCase();
  const filtered = all
    .filter((e) => {
      if (tab === 'recibido') return Boolean(e.quote.depositReceivedAt);
      if (tab === 'pendiente') return !e.quote.depositReceivedAt;
      return true;
    })
    .filter((e) => (creator ? e.creator?.id === creator : true))
    .filter((e) => {
      if (!needle) return true;
      const num = String(e.quote.number || '');
      const cust = (e.customer?.company || e.customer?.name || '').toLowerCase();
      const vend = (e.creator?.name || e.creator?.email || '').toLowerCase();
      return num.includes(needle) || cust.includes(needle) || vend.includes(needle);
    });

  const mul = sort.dir === 'asc' ? 1 : -1;
  const rows = [...filtered].sort((a, b) => {
    if (sort.key === 'total') return (a.grandTotal - b.grandTotal) * mul;
    if (sort.key === 'commission') {
      const ac = a.depositIn ? a.earnedCommission : a.potentialCommission;
      const bc = b.depositIn ? b.earnedCommission : b.potentialCommission;
      return (ac - bc) * mul;
    }
    if (sort.key === 'customer') {
      const an = (a.customer?.company || a.customer?.name || '').toLowerCase();
      const bn = (b.customer?.company || b.customer?.name || '').toLowerCase();
      return an.localeCompare(bn) * mul;
    }
    return ((a.quote.acceptedAt || 0) - (b.quote.acceptedAt || 0)) * mul;
  });

  return { rows, tabs, creatorOptions };
}

/**
 * Company-wide roll-up of one cycle's `resolveSales` result — the admin's
 * full-scope header: both commission streams summed (seller + professional),
 * each split paid/pending, plus the sale count and taxable base behind them.
 * Pure aggregation over the rollup rows, so it can never disagree with the
 * per-person tables it sits above.
 *
 * @returns {{ salesCount, base, seller: {commission,paid,pending},
 *   professional: {commission,paid,pending}, total: {commission,paid,pending} }}
 */
export function resolveCommissionsOverview({ entries, vendedorRows, profRows }) {
  const sum = (rows, key) => rows.reduce((acc, r) => acc + (r[key] || 0), 0);
  const seller = {
    commission: sum(vendedorRows, 'commission'),
    paid: sum(vendedorRows, 'paid'),
    pending: sum(vendedorRows, 'pending'),
  };
  const professional = {
    commission: sum(profRows, 'commission'),
    paid: sum(profRows, 'paid'),
    pending: sum(profRows, 'pending'),
  };
  return {
    salesCount: entries.length,
    base: sum(entries, 'base'),
    seller,
    professional,
    total: {
      commission: seller.commission + professional.commission,
      paid: seller.paid + professional.paid,
      pending: seller.pending + professional.pending,
    },
  };
}
