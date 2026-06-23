// Compras y gastos — the unified ViewModel behind the merged pane. A purchase
// (inventory / asset) and an expense (gasto) are the same economic event — a
// supplier invoice that posts an asiento and feeds the 606 — so they list in
// ONE filterable table. This projects both tables into a single row shape
// discriminated by `nature` (gasto · mercancía · activo), with the nature /
// supplier / date / free-text filters the pane applies. Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';

/** The three natures of a supplier invoice. `gasto` covers expenses AND the
 *  legacy service purchases; `mercancía` lands in inventory; `activo` capitalizes
 *  to a fixed-asset account. The registration form writes a gasto to `expenses`
 *  and mercancía/activo to `purchases`. */
export const NATURES = [
  { key: 'gasto', label: 'Gasto' },
  { key: 'mercancia', label: 'Mercancía' },
  { key: 'activo', label: 'Activo fijo' },
];
export const NATURE_LABEL = Object.fromEntries(NATURES.map((n) => [n.key, n.label]));

const PAY_LABEL = { cash: 'Efectivo', bank: 'Banco', card: 'Tarjeta', credit: 'Crédito' };

/** Map a stored purchase kind to its nature (legacy `service` → gasto). */
export function purchaseNature(kind) {
  if (kind === 'goods') return 'mercancia';
  if (kind === 'asset') return 'activo';
  return 'gasto';
}

/** Article count of a purchase — its multi-line count, else the legacy single item. */
function articleCount(p) {
  return p.lines?.length ? p.lines.length : (p.kind === 'goods' && p.itemId ? 1 : 0);
}

function inWindow(t, start, end) {
  if (start != null && t < start) return false;
  if (end != null && t > end) return false;
  return true;
}

/** A linked expediente's short label — `#number · BL`. */
function expLabel(e) {
  if (!e) return '';
  return `#${e.number ?? ''}${e.bl ? ` · ${e.bl}` : ''}`.trim();
}

/** `code · name`, or just the code when the name is unknown (no dangling sep). */
function accountLabel(code, name) {
  if (!code) return '';
  return name ? `${code} · ${name}` : code;
}

/**
 * Merge expenses + purchases into one list, joined with supplier / account /
 * expediente names, filtered by nature, supplier, the date window and a
 * free-text query (supplier · NCF · account · description · expediente), newest
 * first. Returns the filtered rows + their totals, plus per-nature counts (over
 * everything EXCEPT the nature filter) so the pane's filter chips show live
 * counts. `nature` of '' / 'all' keeps every nature.
 */
export function resolvePurchasesExpenses({
  expenses, purchases, suppliers, accounts, expedientes, query, nature, supplierId, start, end,
} = {}) {
  const supById = new Map((suppliers || []).map((s) => [s.id, s]));
  const nameByCode = new Map((accounts || []).map((a) => [a.code, a.name]));
  const expById = new Map((expedientes || []).map((e) => [e.id, e]));

  const fromExpense = (e) => {
    const accountName = nameByCode.get(e.accountCode) || '';
    return {
      id: e.id, source: 'expense', nature: 'gasto', doc: e,
      date: e.expenseAt || 0,
      supplierId: e.supplierId || null,
      supplierName: (e.supplierId ? supById.get(e.supplierId)?.name : '') || '',
      accountCode: e.accountCode || '', accountName,
      destination: e.accountCode ? accountLabel(e.accountCode, accountName) : (e.description || 'Gasto'),
      description: e.description || '',
      ncf: e.ncf || '', articles: 0,
      expedienteId: e.expedienteId || null,
      expedienteLabel: e.expedienteId ? expLabel(expById.get(e.expedienteId)) : '',
      base: round2(e.base || 0), itbis: round2(e.itbis || 0),
      retIsr: round2(e.retentionIsr || 0), retItbis: round2(e.retentionItbis || 0),
      total: round2((e.base || 0) + (e.itbis || 0)),
      payment: e.paymentMethod || 'bank', paymentLabel: PAY_LABEL[e.paymentMethod] || e.paymentMethod || '',
    };
  };

  const fromPurchase = (p) => {
    const nat = purchaseNature(p.kind);
    const accountName = p.accountCode ? (nameByCode.get(p.accountCode) || '') : '';
    const articles = articleCount(p);
    const destination = nat === 'mercancia'
      ? `Inventario${articles ? ` · ${articles} artículo${articles === 1 ? '' : 's'}` : ''}`
      : (p.accountCode ? accountLabel(p.accountCode, accountName) : (p.description || NATURE_LABEL[nat]));
    return {
      id: p.id, source: 'purchase', nature: nat, doc: p,
      date: p.purchaseAt || 0,
      supplierId: p.supplierId || null,
      supplierName: (p.supplierId ? supById.get(p.supplierId)?.name : '') || '',
      accountCode: p.accountCode || '', accountName,
      destination,
      description: p.description || '',
      ncf: p.ncf || '', articles,
      expedienteId: p.expedienteId || null,
      expedienteLabel: p.expedienteId ? expLabel(expById.get(p.expedienteId)) : '',
      base: round2(p.base || 0), itbis: round2(p.itbis || 0),
      retIsr: round2(p.retentionIsr || 0), retItbis: round2(p.retentionItbis || 0),
      total: round2((p.base || 0) + (p.itbis || 0)),
      payment: p.paymentMethod || 'credit', paymentLabel: PAY_LABEL[p.paymentMethod] || p.paymentMethod || '',
    };
  };

  const q = (query || '').trim().toLowerCase();
  const wantNature = nature && nature !== 'all' ? nature : '';

  // Everything in the window + supplier + query (BEFORE the nature filter) — the
  // base for both the per-nature chip counts and the filtered rows.
  const base = [...(expenses || []).map(fromExpense), ...(purchases || []).map(fromPurchase)]
    .filter((r) => inWindow(r.date, start, end))
    .filter((r) => !supplierId || r.supplierId === supplierId)
    .filter((r) => !q || [r.supplierName, r.ncf, r.accountName, r.description, r.expedienteLabel]
      .some((v) => (v || '').toLowerCase().includes(q)));

  const counts = base.reduce((acc, r) => { acc[r.nature] = (acc[r.nature] || 0) + 1; return acc; },
    { gasto: 0, mercancia: 0, activo: 0 });
  counts.all = base.length;

  const rows = base
    .filter((r) => !wantNature || r.nature === wantNature)
    .sort((a, b) => (b.date || 0) - (a.date || 0));

  const totals = rows.reduce((acc, r) => ({
    base: acc.base + r.base, itbis: acc.itbis + r.itbis,
    retIsr: acc.retIsr + r.retIsr, retItbis: acc.retItbis + r.retItbis,
    total: acc.total + r.total,
  }), { base: 0, itbis: 0, retIsr: 0, retItbis: 0, total: 0 });
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);

  return { rows, totals, count: rows.length, counts };
}

/**
 * Full drill-down of ONE compra/gasto (whichever of `purchase` / `expense` is
 * present) for the detail page: the unified header fields, the money breakdown
 * (base · ITBIS · retenciones · total · neto), the linked expediente, and — for
 * a mercancía purchase — its article lines dressed with current item names + the
 * kardex unit cost. `reversesInventory` flags the natures whose delete must also
 * undo a kardex IN. Pure; returns null when neither row exists.
 */
export function resolvePurchaseExpenseDetail({ purchase, expense, suppliers, accounts, items, expedientes } = {}) {
  const doc = purchase || expense;
  if (!doc) return null;
  const supById = new Map((suppliers || []).map((s) => [s.id, s]));
  const nameByCode = new Map((accounts || []).map((a) => [a.code, a.name]));
  const itemById = new Map((items || []).map((i) => [i.id, i]));
  const expById = new Map((expedientes || []).map((e) => [e.id, e]));

  const source = purchase ? 'purchase' : 'expense';
  const nature = purchase ? purchaseNature(purchase.kind) : 'gasto';
  const date = purchase ? (purchase.purchaseAt || 0) : (expense.expenseAt || 0);

  const base = round2(doc.base || 0);
  const itbis = round2(doc.itbis || 0);
  const retIsr = round2(doc.retentionIsr || 0);
  const retItbis = round2(doc.retentionItbis || 0);

  const accountName = doc.accountCode ? (nameByCode.get(doc.accountCode) || '') : '';
  const articles = purchase ? (purchase.lines?.length ? purchase.lines.length : (purchase.kind === 'goods' && purchase.itemId ? 1 : 0)) : 0;
  const destination = nature === 'mercancia'
    ? `Inventario${articles ? ` · ${articles} artículo${articles === 1 ? '' : 's'}` : ''}`
    : (doc.accountCode ? accountLabel(doc.accountCode, accountName) : (doc.description || NATURE_LABEL[nature]));

  const lines = (purchase?.lines || []).map((l) => {
    const item = l.itemId ? itemById.get(l.itemId) : null;
    const qty = round2(Math.max(0, Number(l.qty) || 0));
    const cost = round2(Math.max(0, Number(l.cost) || 0));
    return {
      id: l.id,
      name: item?.name || l.name || '—',
      reference: item?.sku || l.reference || '',
      inInventory: !!item,
      qty, cost,
      unitCost: qty > 0 ? Math.round((cost / qty) * 10000) / 10000 : 0,
    };
  });

  const exp = doc.expedienteId ? expById.get(doc.expedienteId) : null;
  return {
    id: doc.id, source, nature, natureLabel: NATURE_LABEL[nature],
    number: doc.number ?? null, date,
    supplierId: doc.supplierId || null,
    supplierName: (doc.supplierId ? supById.get(doc.supplierId)?.name : '') || '',
    accountCode: doc.accountCode || '', accountName, destination,
    description: doc.description || '',
    ncf: doc.ncf || '',
    payment: doc.paymentMethod || (purchase ? 'credit' : 'bank'),
    paymentLabel: PAY_LABEL[doc.paymentMethod] || doc.paymentMethod || '',
    expediente: exp ? { id: exp.id, label: expLabel(exp) } : null,
    base, itbis, retIsr, retItbis,
    total: round2(base + itbis),
    net: round2(base + itbis - retIsr - retItbis),
    lines,
    reversesInventory: nature === 'mercancia',
    journalEntryId: doc.journalEntryId || null,
  };
}
