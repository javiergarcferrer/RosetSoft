// 13-week cash-flow forecast ViewModel — project the running cash balance from
// today's cash, the open receivables (inflows at due date), open payables
// (outflows), and active recurring expenses' upcoming occurrences. Surfaces the
// runway low point. Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';
import { nextOccurrence } from '../../lib/accounting/recurring.js';

const DAY = 86400000;
const WEEK = 7 * DAY;

export function resolveCashForecast({
  receivables, payables, recurring, openingCash = 0, now, weeks = 13, arNetDays = 0, apNetDays = 0,
} = {}) {
  const at = now || 0;
  const horizonEnd = at + weeks * WEEK;
  const buckets = Array.from({ length: weeks }, (_, i) => ({ week: i, weekStart: at + i * WEEK, inflow: 0, outflow: 0 }));
  // bucket for a timestamp: overdue (before now) lands in week 0; beyond the
  // horizon returns -1 (dropped).
  const bucketOf = (t) => { const b = Math.floor((t - at) / WEEK); return b < 0 ? 0 : (b >= weeks ? -1 : b); };

  for (const row of receivables?.rows || []) {
    for (const d of row.docs || []) {
      if (!(d.open > 0.001)) continue;
      const b = bucketOf((d.date || at) + arNetDays * DAY);
      if (b >= 0) buckets[b].inflow = round2(buckets[b].inflow + d.open);
    }
  }
  for (const row of payables?.rows || []) {
    for (const d of row.docs || []) {
      if (!(d.open > 0.001)) continue;
      const b = bucketOf((d.date || at) + apNetDays * DAY);
      if (b >= 0) buckets[b].outflow = round2(buckets[b].outflow + d.open);
    }
  }
  for (const t of recurring || []) {
    if (t.status !== 'active') continue;
    const amt = round2((t.payload?.base || 0) + (t.payload?.itbis || 0));
    if (amt <= 0) continue;
    let occ = nextOccurrence(t, at - 1); // first occurrence on/after now
    let guard = 0;
    while (occ <= horizonEnd && guard++ < weeks + 4) {
      const b = bucketOf(occ);
      if (b >= 0) buckets[b].outflow = round2(buckets[b].outflow + amt);
      occ = nextOccurrence(t, occ);
    }
  }

  let bal = round2(openingCash);
  let low = { week: -1, weekStart: at, balance: bal };
  const rows = buckets.map((bk) => {
    const net = round2(bk.inflow - bk.outflow);
    bal = round2(bal + net);
    if (bal < low.balance) low = { week: bk.week, weekStart: bk.weekStart, balance: bal };
    return { ...bk, net, balance: bal };
  });

  return {
    weeks,
    openingCash: round2(openingCash),
    rows,
    totalIn: round2(rows.reduce((s, r) => s + r.inflow, 0)),
    totalOut: round2(rows.reduce((s, r) => s + r.outflow, 0)),
    endingBalance: bal,
    lowPoint: low,
    negativeWeek: rows.find((r) => r.balance < 0) || null,
  };
}
