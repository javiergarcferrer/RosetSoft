// Panel analytics ViewModels — the comparative engine behind the accounting
// dashboard: period windows (mes/trimestre/año) with their previous and
// year-over-year twins, KPI deltas, Odoo-style segmented sales (group-by +
// free-text filter), the trailing-months comparative table, the expense
// category comparison, and the importaciones 360° roll-up. Pure: no React,
// no db.
import { round2 } from '../../lib/accounting/ledger.js';
import { expedienteLanded, expedienteCreditableItbis } from '../../lib/accounting/expediente.js';
import { landedCost } from '../../lib/accounting/importLiquidation.js';
import { buildChartIndex, chartRoots, leafCodesUnder } from '../../lib/accounting/chart.js';
import { naturalBalance } from '../../lib/accounting/ledger.js';
import { resolveIncomeStatement } from './ledger.js';

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_ES_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function monthWindow(y, m) {
  return { start: new Date(y, m, 1).getTime(), end: new Date(y, m + 1, 0, 23, 59, 59, 999).getTime() };
}
function quarterWindow(y, q) {
  return { start: new Date(y, q * 3, 1).getTime(), end: new Date(y, q * 3 + 3, 0, 23, 59, 59, 999).getTime() };
}
function yearWindow(y) {
  return { start: new Date(y, 0, 1).getTime(), end: new Date(y, 11, 31, 23, 59, 59, 999).getTime() };
}

/**
 * A comparison-ready period around `ref` (ms): the window itself plus its
 * `prev` (immediately preceding period) and `yoy` (same period last year).
 * kind: 'month' | 'quarter' | 'year'.
 */
export function resolvePeriod({ kind = 'month', ref = Date.now() } = {}) {
  const d = new Date(ref);
  const y = d.getFullYear();
  if (kind === 'year') {
    return {
      kind, ref,
      label: String(y),
      ...yearWindow(y),
      prev: { label: String(y - 1), ...yearWindow(y - 1) },
      yoy: { label: String(y - 1), ...yearWindow(y - 1) },
    };
  }
  if (kind === 'quarter') {
    const q = Math.floor(d.getMonth() / 3);
    const pq = q === 0 ? { y: y - 1, q: 3 } : { y, q: q - 1 };
    return {
      kind, ref,
      label: `T${q + 1} ${y}`,
      ...quarterWindow(y, q),
      prev: { label: `T${pq.q + 1} ${pq.y}`, ...quarterWindow(pq.y, pq.q) },
      yoy: { label: `T${q + 1} ${y - 1}`, ...quarterWindow(y - 1, q) },
    };
  }
  const m = d.getMonth();
  const pm = m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 };
  return {
    kind, ref,
    label: `${MONTHS_ES[m]} ${y}`,
    ...monthWindow(y, m),
    prev: { label: `${MONTHS_ES[pm.m]} ${pm.y}`, ...monthWindow(pm.y, pm.m) },
    yoy: { label: `${MONTHS_ES[m]} ${y - 1}`, ...monthWindow(y - 1, m) },
  };
}

/** Step a period reference one unit forward/back (for the ‹ › arrows). */
export function stepPeriodRef(kind, ref, delta) {
  const d = new Date(ref);
  if (kind === 'year') return new Date(d.getFullYear() + delta, 6, 1).getTime();
  if (kind === 'quarter') return new Date(d.getFullYear(), d.getMonth() + 3 * delta, 15).getTime();
  return new Date(d.getFullYear(), d.getMonth() + delta, 15).getTime();
}

// A missing start/end bound is OPEN on that side (else an unbounded window
// silently drops every row instead of including it).
function inWin(t, w) {
  if (t == null || !w) return false;
  if (w.start != null && t < w.start) return false;
  if (w.end != null && t > w.end) return false;
  return true;
}
function sumIn(rows, dateField, w, value) {
  return round2((rows || []).reduce((s, r) => (inWin(r[dateField], w) ? s + (Number(value(r)) || 0) : s), 0));
}

/** current vs previous as a signed fraction (null when prev has no base). */
export function deltaPct(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 1000;
}

/** Landed total for the import docs (expedientes + legacy) in a window. */
function landedIn(expedientes, imports, w) {
  const exp = (expedientes || []).reduce((s, e) => (inWin(e.liquidatedAt, w) ? s + expedienteLanded(e) : s), 0);
  const leg = (imports || []).reduce((s, l) => (inWin(l.liquidatedAt, w) ? s + landedCost(l) : s), 0);
  return round2(exp + leg);
}

/**
 * The panel's headline KPIs measured over the period AND its two comparison
 * windows, each with delta fractions. Keys: ventas (facturado), cobrado,
 * gastos, compras, importado (landed), utilidad (ledger 4−5−6).
 */
export function resolveComparativeKpis({
  salesPostings, payments, expenses, purchases, expedientes, imports,
  accounts, entries, lines, period,
} = {}) {
  const cobros = (payments || []).filter((p) => p.direction === 'in' && p.partyType === 'customer');
  const sales = (salesPostings || []).filter((s) => !s.voidedAt);
  const windows = { current: period, previous: period.prev, yoy: period.yoy };
  const measure = (w) => ({
    ventas: sumIn(sales, 'postedAt', w, (r) => r.total),
    cobrado: sumIn(cobros, 'paidAt', w, (r) => r.amount),
    gastos: sumIn(expenses, 'expenseAt', w, (r) => r.base),
    compras: sumIn(purchases, 'purchaseAt', w, (r) => r.base),
    importado: landedIn(expedientes, imports, w),
    utilidad: resolveIncomeStatement({ accounts, lines, entries, start: w.start, end: w.end }).netIncome,
  });
  const m = {};
  for (const [k, w] of Object.entries(windows)) m[k] = measure(w);

  const LABELS = {
    ventas: 'Ventas facturadas', cobrado: 'Cobrado', gastos: 'Gastos',
    compras: 'Compras locales', importado: 'Importado (costo destino)', utilidad: 'Utilidad neta',
  };
  return Object.keys(LABELS).map((key) => ({
    key,
    label: LABELS[key],
    current: m.current[key],
    previous: m.previous[key],
    yoy: m.yoy[key],
    deltaPrev: deltaPct(m.current[key], m.previous[key]),
    deltaYoy: deltaPct(m.current[key], m.yoy[key]),
  }));
}

const CANAL_LABELS = { piso: 'Venta de piso', pedido: 'Pedido especial' };

/**
 * Odoo-style segmented sales: group the period's posted sales by a dimension
 * and rank the segments. groupBy ∈ 'customer' | 'seller' | 'canal' | 'ecfType';
 * `query` filters segments by label substring (the filter-bar text). Seller and
 * canal join through the quote (creator / tied-to-order ⇒ pedido especial).
 */
export function resolveSalesSegmented({
  salesPostings, quotes, customersById, profileById, start, end, groupBy = 'customer', query = '',
} = {}) {
  const quoteById = new Map((quotes || []).map((q) => [q.id, q]));
  const segs = new Map();
  let totalAll = 0;

  for (const p of (salesPostings || []).filter((s) => !s.voidedAt)) {
    if (!inWin(p.postedAt, { start, end })) continue;
    const quote = p.quoteId ? quoteById.get(p.quoteId) : null;
    let key = '—';
    let label = 'Sin asignar';
    if (groupBy === 'customer') {
      key = p.customerId || '—';
      label = (customersById && customersById.get(p.customerId)?.name) || 'Sin cliente';
    } else if (groupBy === 'seller') {
      key = quote?.createdByUserId || '—';
      const prof = profileById && profileById.get(quote?.createdByUserId);
      label = prof?.name || prof?.email || 'Sin vendedor';
    } else if (groupBy === 'canal') {
      key = quote?.orderId ? 'pedido' : 'piso';
      label = CANAL_LABELS[key];
    } else if (groupBy === 'ecfType') {
      key = p.ecfType || (p.ncf ? 'manual' : '—');
      label = p.ecfType ? `e-CF ${p.ecfType}` : p.ncf ? 'NCF manual' : 'Sin NCF';
    }
    let s = segs.get(key);
    if (!s) { s = { key, label, count: 0, base: 0, itbis: 0, total: 0 }; segs.set(key, s); }
    s.count += 1;
    s.base = round2(s.base + (p.base || 0));
    s.itbis = round2(s.itbis + (p.itbis || 0));
    s.total = round2(s.total + (p.total || 0));
    totalAll = round2(totalAll + (p.total || 0));
  }

  const q = (query || '').trim().toLowerCase();
  const rows = [...segs.values()]
    .filter((s) => !q || s.label.toLowerCase().includes(q))
    .sort((a, b) => b.total - a.total)
    .map((s) => ({ ...s, share: totalAll > 0 ? Math.round((s.total / totalAll) * 1000) / 1000 : 0 }));

  return {
    rows,
    totals: rows.reduce((acc, r) => ({
      count: acc.count + r.count,
      base: round2(acc.base + r.base),
      itbis: round2(acc.itbis + r.itbis),
      total: round2(acc.total + r.total),
    }), { count: 0, base: 0, itbis: 0, total: 0 }),
    grandTotal: totalAll,
  };
}

/**
 * Trailing-months comparative — one entry per month (oldest first): ventas +
 * the same month LAST year (the YoY pairing every retail dashboard leads
 * with), cobrado, gastos, compras, importado. Feeds both the comparative
 * chart (bars + small-multiple sparklines) and its table view.
 */
export function resolveMonthlyComparative({
  salesPostings, payments, expenses, purchases, expedientes, imports, months = 12, end = Date.now(),
} = {}) {
  const cobros = (payments || []).filter((p) => p.direction === 'in' && p.partyType === 'customer');
  const sales = (salesPostings || []).filter((s) => !s.voidedAt);
  const endD = new Date(end);
  const rows = [];
  for (let i = months - 1; i >= 0; i--) {
    const y = endD.getFullYear();
    const m = endD.getMonth() - i;
    const d = new Date(y, m, 1);
    const w = monthWindow(d.getFullYear(), d.getMonth());
    const wYoy = monthWindow(d.getFullYear() - 1, d.getMonth());
    const ventas = sumIn(sales, 'postedAt', w, (r) => r.total);
    const ventasYoy = sumIn(sales, 'postedAt', wYoy, (r) => r.total);
    rows.push({
      key: `${d.getFullYear()}-${d.getMonth() + 1}`,
      label: `${MONTHS_ES_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`,
      ventas,
      ventasYoy,
      deltaYoy: deltaPct(ventas, ventasYoy),
      cobrado: sumIn(cobros, 'paidAt', w, (r) => r.amount),
      gastos: sumIn(expenses, 'expenseAt', w, (r) => r.base),
      compras: sumIn(purchases, 'purchaseAt', w, (r) => r.base),
      importado: landedIn(expedientes, imports, w),
    });
  }
  return rows;
}

/**
 * Expense comparison by top-level class-6 category: current period vs the
 * previous one, with deltas — "where did spending move".
 */
export function resolveExpenseComparative({ expenses, accounts, period } = {}) {
  const index = buildChartIndex(accounts);
  const class6 = chartRoots(index).find((r) => r.class === 6);
  const catFor = new Map(); // leaf code -> category node
  const cats = [];
  if (class6) {
    for (const cat of index.childrenByParent.get(class6.code) || []) {
      cats.push(cat);
      for (const leaf of leafCodesUnder(index, cat.code)) catFor.set(leaf, cat);
    }
  }
  const buckets = new Map(); // cat code -> {current, previous}
  const add = (cat, slot, v) => {
    const code = cat ? cat.code : 'otros';
    let b = buckets.get(code);
    if (!b) { b = { code, name: cat ? cat.name : 'Sin categoría', current: 0, previous: 0 }; buckets.set(code, b); }
    b[slot] = round2(b[slot] + v);
  };
  for (const e of expenses || []) {
    const cat = catFor.get(e.accountCode) || null;
    const v = Number(e.base) || 0;
    if (inWin(e.expenseAt, period)) add(cat, 'current', v);
    else if (inWin(e.expenseAt, period.prev)) add(cat, 'previous', v);
  }
  return [...buckets.values()]
    .filter((b) => b.current > 0.001 || b.previous > 0.001)
    .sort((a, b) => b.current - a.current)
    .map((b) => ({ ...b, delta: deltaPct(b.current, b.previous) }));
}

/**
 * Importaciones 360° — what the supply side looks like right now: value still
 * on the water (mercancía en tránsito, from the ledger), the period's landed
 * total + creditable customs ITBIS + expediente count, and the landed factor
 * (landed ÷ CIF — how much above invoice value the goods really cost).
 */
export function resolveImportPanel({ expedientes, imports, accounts, lines, period } = {}) {
  // In-transit balance = the goods-in-transit subtree's natural balance, all time.
  const index = buildChartIndex(accounts);
  let inTransit = 0;
  const TRANSIT_ROOT = '1-01-009-00-00-00';
  const transitLeaves = new Set(leafCodesUnder(index, TRANSIT_ROOT));
  if (transitLeaves.size) {
    const sums = new Map();
    for (const l of lines || []) {
      if (!transitLeaves.has(l.accountCode)) continue;
      sums.set(l.accountCode, (sums.get(l.accountCode) || 0) + (Number(l.debit) || 0) - (Number(l.credit) || 0));
    }
    for (const [code, raw] of sums) {
      const node = index.byCode.get(code);
      inTransit += naturalBalance(raw, node?.nature || 'debit');
    }
  }
  const inWindow = (expedientes || []).filter((e) => inWin(e.liquidatedAt, period));
  const cif = round2(inWindow.reduce((s, e) => s + (Number(e.cif) || 0), 0));
  const landed = landedIn(expedientes, imports, period);
  const landedPrev = landedIn(expedientes, imports, period.prev);
  const itbisAduanal = round2(
    inWindow.reduce((s, e) => s + expedienteCreditableItbis(e), 0)
    + (imports || []).reduce((s, l) => (inWin(l.liquidatedAt, period) ? s + (Number(l.importItbis) || 0) : s), 0),
  );
  return {
    inTransit: round2(inTransit),
    landed,
    landedPrev,
    landedDelta: deltaPct(landed, landedPrev),
    itbisAduanal,
    expedientesCount: inWindow.length,
    landedFactor: cif > 0 ? Math.round(((landed / cif)) * 100) / 100 : null,
  };
}
