// Purchase orders ViewModel — list/totals for the PO → bill workflow. A PO is
// not fiscal; only the resulting bill (with its NCF) posts to the 606. Pure.
import { round2 } from '../../lib/accounting/ledger.js';

export const PO_STATUS_LABEL = { open: 'Abierta', received: 'Recibida', billed: 'Facturada', cancelled: 'Cancelada' };

/** Quantity + amount totals for a PO's lines. */
export function poTotals(po) {
  const lines = (po && po.lines) || [];
  return {
    qty: round2(lines.reduce((s, l) => s + (Number(l.qty) || 0), 0)),
    total: round2(lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0)),
  };
}

export function resolvePurchaseOrders({ orders, suppliersById, query, statusFilter } = {}) {
  const q = (query || '').trim().toLowerCase();
  let rows = (orders || []).map((po) => {
    const t = poTotals(po);
    return {
      po,
      supplier: (suppliersById && po.supplierId && suppliersById.get(po.supplierId)) || null,
      status: po.status || 'open',
      statusLabel: PO_STATUS_LABEL[po.status] || po.status || 'Abierta',
      qty: t.qty,
      total: t.total,
      lineCount: (po.lines || []).length,
    };
  }).sort((a, b) => (b.po.orderedAt || 0) - (a.po.orderedAt || 0));

  if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
  if (q) rows = rows.filter((r) => [r.supplier?.name, r.po.number, r.po.notes].some((v) => String(v || '').toLowerCase().includes(q)));

  const byStatus = {};
  for (const po of orders || []) byStatus[po.status || 'open'] = (byStatus[po.status || 'open'] || 0) + 1;
  return {
    rows,
    count: rows.length,
    byStatus,
    openTotal: round2(rows.filter((r) => r.status === 'open' || r.status === 'received').reduce((s, r) => s + r.total, 0)),
  };
}
