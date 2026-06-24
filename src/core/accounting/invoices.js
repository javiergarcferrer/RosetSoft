// Invoice pipeline ViewModel — the AR funnel at a glance: every posted sale
// bucketed by payment status (por cobrar / vencida / cobrada) plus the e-CF
// backlog (assigned but not transmitted, or rejected). Pure: no React, no db.
// `receivables` is a resolveReceivables result — its per-doc `open` drives the
// paid/open split (allocations + FIFO already applied there).
import { round2 } from '../../lib/accounting/ledger.js';

const DAY = 86400000;

export function resolveInvoicePipeline({ salesPostings, receivables, customersById, now, overdueDays = 30 } = {}) {
  const at = now || 0;
  const openByDoc = new Map();
  for (const row of receivables?.rows || []) {
    for (const d of row.docs || []) openByDoc.set(d.docId, d.open);
  }

  const invoices = (salesPostings || []).map((s) => {
    const open = round2(openByDoc.get(s.id) ?? 0);
    const ecf = s.ecfStatus || '';
    const age = Math.floor((at - (s.postedAt || 0)) / DAY);
    const status = open <= 0.01 ? 'paid' : age > overdueDays ? 'overdue' : 'open';
    return {
      id: s.id,
      number: s.number ?? null,
      ncf: s.ncf || '',
      ecfStatus: ecf,
      customer: (customersById && customersById.get(s.customerId)) || null,
      postedAt: s.postedAt || 0,
      total: round2(s.total || 0),
      open,
      age,
      status,
      needsEcf: ecf === 'pending' || ecf === 'rejected',
    };
  });

  const sum = (arr, f) => round2(arr.reduce((acc, i) => acc + f(i), 0));
  const buckets = [
    { key: 'open', label: 'Por cobrar' },
    { key: 'overdue', label: 'Vencida' },
    { key: 'paid', label: 'Cobrada' },
  ].map((b) => {
    const inv = invoices.filter((i) => i.status === b.key).sort((a, c) => (c.postedAt || 0) - (a.postedAt || 0));
    return { ...b, count: inv.length, amount: sum(inv, (i) => (b.key === 'paid' ? i.total : i.open)), invoices: inv };
  });

  const ecfPending = invoices.filter((i) => i.needsEcf).sort((a, c) => (c.postedAt || 0) - (a.postedAt || 0));

  return {
    buckets,
    pendingEcf: { count: ecfPending.length, amount: sum(ecfPending, (i) => i.total), invoices: ecfPending },
    totalInvoiced: sum(invoices, (i) => i.total),
    totalOpen: sum(invoices.filter((i) => i.status !== 'paid'), (i) => i.open),
    count: invoices.length,
  };
}
