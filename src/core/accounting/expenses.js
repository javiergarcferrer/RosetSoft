// Expense ViewModels — the Gastos list and the DGII 606 (compras de bienes y
// servicios) projection. Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';

function inWindow(t, start, end) {
  if (start != null && t < start) return false;
  if (end != null && t > end) return false;
  return true;
}

/**
 * The Gastos list joined with supplier + account names, newest-first, plus
 * window totals. `query` free-text-filters across supplier, description, NCF
 * and account name (the list page's search box); totals follow the filter.
 */
export function resolveExpensesList({ expenses, suppliers, accounts, start, end, query } = {}) {
  const supById = new Map((suppliers || []).map((s) => [s.id, s]));
  const nameByCode = new Map((accounts || []).map((a) => [a.code, a.name]));
  const q = (query || '').trim().toLowerCase();
  const rows = (expenses || [])
    .filter((e) => inWindow(e.expenseAt, start, end))
    .map((e) => ({
      expense: e,
      supplier: e.supplierId ? supById.get(e.supplierId) || null : null,
      accountName: nameByCode.get(e.accountCode) || '',
      total: round2((e.base || 0) + (e.itbis || 0)),
      net: round2((e.base || 0) + (e.itbis || 0) - (e.retentionIsr || 0) - (e.retentionItbis || 0)),
    }))
    .filter((r) => !q || [r.supplier?.name, r.expense.description, r.expense.ncf, r.accountName]
      .some((v) => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => (b.expense.expenseAt || 0) - (a.expense.expenseAt || 0));

  const totals = rows.reduce((acc, r) => ({
    base: acc.base + (r.expense.base || 0),
    itbis: acc.itbis + (r.expense.itbis || 0),
    retIsr: acc.retIsr + (r.expense.retentionIsr || 0),
    retItbis: acc.retItbis + (r.expense.retentionItbis || 0),
    total: acc.total + r.total,
  }), { base: 0, itbis: 0, retIsr: 0, retItbis: 0, total: 0 });
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);

  return { rows, totals, count: rows.length };
}

/**
 * DGII "Tipo de Bienes y Servicios Comprados" (606 casilla 3) for a doc:
 *   • expense — by its gasto account: 6-01 (personal) → 01, financieros
 *     (6-07/6-08) → 07, a class-5 code → 09, a class-1 code → 10, else 02
 *     (trabajos, suministros y servicios).
 *   • purchase — goods → 09 (costo de venta), asset → 10, service → 02.
 *   • expediente cost — seguro → 11, everything else → 02 (servicios).
 * A default the accountant can refine in the DGII tool; the heavy cases
 * (inventory vs. services vs. assets) are derived from real data.
 */
export function tipo606For(doc, source) {
  // The accountant's explicit pick at registration wins over the derivation.
  if (doc.tipo606) return String(doc.tipo606);
  if (source === 'purchase') {
    if (doc.kind === 'goods') return '09';
    if (doc.kind === 'asset') return '10';
    return '02';
  }
  if (source === 'importCost') return doc.concept === 'seguro' ? '11' : '02';
  const code = String(doc.accountCode || '');
  if (code.startsWith('6-01')) return '01';
  if (code.startsWith('6-07') || code.startsWith('6-08')) return '07';
  if (code.startsWith('5')) return '09';
  if (code.startsWith('1')) return '10';
  return '02';
}

/** DGII 606 casilla 3 — the official "Tipo de Bienes y Servicios Comprados"
 *  names for the codes `tipo606For` derives. */
export const DGII_606_TIPO_LABEL = {
  '01': 'Gastos de personal',
  '02': 'Gastos por trabajos, suministros y servicios',
  '03': 'Arrendamientos',
  '04': 'Gastos de activos fijos',
  '05': 'Gastos de representación',
  '06': 'Otras deducciones admitidas',
  '07': 'Gastos financieros',
  '08': 'Gastos extraordinarios',
  '09': 'Compras y gastos que formarán parte del costo de venta',
  '10': 'Adquisiciones de activos',
  '11': 'Gastos de seguros',
};

function row606(doc, dateField, suppliersById, source) {
  const s = doc.supplierId ? suppliersById.get(doc.supplierId) : null;
  return {
    id: doc.id,
    rnc: s?.rnc || '',
    name: s?.name || '',
    kind: s?.kind || '',
    ncf: doc.ncf || '',
    ncfType: doc.ncfType || '',
    date: doc[dateField],
    base: round2(doc.base || 0),
    itbis: round2(doc.itbis || 0),
    retIsr: round2(doc.retentionIsr || 0),
    retItbis: round2(doc.retentionItbis || 0),
    total: round2((doc.base || 0) + (doc.itbis || 0)),
    tipo606: tipo606For(doc, source),
    pay: doc.paymentMethod || 'bank',
  };
}

/** An expediente's NCF-backed cost lines, shaped like 606 docs (base = amount
 *  net of its ITBIS, dated at the expediente's liquidation). */
function expedienteCostDocs(expedientes) {
  const out = [];
  for (const e of expedientes || []) {
    for (const c of e.costs || []) {
      if (!c?.ncf) continue;
      const amount = Math.max(0, Number(c.amount) || 0);
      const itbis = Math.min(Math.max(0, Number(c.itbis) || 0), amount);
      out.push({
        id: `${e.id}:${c.id}`,
        supplierId: c.supplierId || null,
        costAt: e.liquidatedAt,
        ncf: c.ncf,
        concept: c.concept,
        base: round2(amount - itbis),
        itbis: round2(itbis),
        retentionIsr: 0,
        retentionItbis: 0,
        paymentMethod: c.paymentMethod || 'bank',
      });
    }
  }
  return out;
}

/**
 * Formato 606 — compras de bienes y servicios. One row per expense AND purchase
 * in the window, plus every expediente COST that carries an NCF (agenciamiento,
 * transporte, puerto… — local invoices whose ITBIS the IT-1 credits, so the 606
 * must report them). The RNC + NCF + tax columns match the DGII layout.
 */
export function resolve606({ expenses, purchases, expedientes, pettyCashVouchers, suppliers, start, end } = {}) {
  const supById = new Map((suppliers || []).map((s) => [s.id, s]));
  const rows = [
    ...(expenses || []).filter((e) => inWindow(e.expenseAt, start, end)).map((e) => row606(e, 'expenseAt', supById, 'expense')),
    ...(purchases || []).filter((p) => inWindow(p.purchaseAt, start, end)).map((p) => row606(p, 'purchaseAt', supById, 'purchase')),
    ...expedienteCostDocs(expedientes).filter((c) => inWindow(c.costAt, start, end)).map((c) => row606(c, 'costAt', supById, 'importCost')),
    // Petty-cash vales that carry an NCF are creditable compras too — report
    // them (always cash-paid). Vales without an NCF never reach the 606.
    ...(pettyCashVouchers || [])
      .filter((v) => v.type === 'expense' && v.ncf && inWindow(v.voucherAt, start, end))
      .map((v) => row606({ ...v, paymentMethod: 'cash' }, 'voucherAt', supById, 'expense')),
  ].sort((a, b) => (a.date || 0) - (b.date || 0));

  const totals = rows.reduce((acc, r) => ({
    base: acc.base + r.base,
    itbis: acc.itbis + r.itbis,
    retIsr: acc.retIsr + r.retIsr,
    retItbis: acc.retItbis + r.retItbis,
    total: acc.total + r.total,
  }), { base: 0, itbis: 0, retIsr: 0, retItbis: 0, total: 0 });
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);

  return { rows, totals, count: rows.length };
}
