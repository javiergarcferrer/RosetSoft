/**
 * Tests for the panel analytics ViewModels (src/core/accounting/analytics.js)
 * — comparison periods (mes/trimestre/año + prev + YoY), KPI deltas, the
 * Odoo-style sales segmentation, the trailing-months comparative table, the
 * expense category comparison, and the importaciones roll-up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePeriod, stepPeriodRef, deltaPct, resolveComparativeKpis,
  resolveSalesSegmented, resolveMonthlyComparative, resolveExpenseComparative,
  resolveImportPanel,
} from '../src/core/accounting/analytics.js';

const JUN = new Date(2026, 5, 15).getTime(); // mid-June 2026

/* ------------------------------ periods --------------------------------- */

test('resolvePeriod(month) builds the window + prev + yoy', () => {
  const p = resolvePeriod({ kind: 'month', ref: JUN });
  assert.equal(p.label, 'junio 2026');
  assert.equal(new Date(p.start).getDate(), 1);
  assert.equal(new Date(p.end).getMonth(), 5);
  assert.equal(p.prev.label, 'mayo 2026');
  assert.equal(p.yoy.label, 'junio 2025');
  assert.equal(new Date(p.yoy.start).getFullYear(), 2025);
});

test('resolvePeriod(quarter) crosses the year boundary backwards', () => {
  const p = resolvePeriod({ kind: 'quarter', ref: new Date(2026, 1, 10).getTime() }); // Q1
  assert.equal(p.label, 'T1 2026');
  assert.equal(p.prev.label, 'T4 2025');
  assert.equal(p.yoy.label, 'T1 2025');
});

test('resolvePeriod(year) prev === yoy', () => {
  const p = resolvePeriod({ kind: 'year', ref: JUN });
  assert.equal(p.label, '2026');
  assert.equal(p.prev.label, '2025');
  assert.equal(p.yoy.label, '2025');
});

test('stepPeriodRef moves one unit per kind', () => {
  const back = resolvePeriod({ kind: 'month', ref: stepPeriodRef('month', JUN, -1) });
  assert.equal(back.label, 'mayo 2026');
  const fwdQ = resolvePeriod({ kind: 'quarter', ref: stepPeriodRef('quarter', JUN, 1) });
  assert.equal(fwdQ.label, 'T3 2026');
});

test('deltaPct: signed fraction, null when no base', () => {
  assert.equal(deltaPct(120, 100), 0.2);
  assert.equal(deltaPct(80, 100), -0.2);
  assert.equal(deltaPct(50, 0), null);
});

/* -------------------------------- KPIs ---------------------------------- */

test('resolveComparativeKpis measures the three windows with deltas', () => {
  const p = resolvePeriod({ kind: 'month', ref: JUN });
  const mk = (ts, total) => ({ postedAt: ts, total, base: total, itbis: 0 });
  const kpis = resolveComparativeKpis({
    salesPostings: [
      mk(JUN, 11800),                                  // current
      mk(new Date(2026, 4, 10).getTime(), 5900),       // prev (may)
      mk(new Date(2025, 5, 10).getTime(), 10000),      // yoy (jun 2025)
    ],
    payments: [{ direction: 'in', partyType: 'customer', paidAt: JUN, amount: 4000 }],
    expenses: [{ expenseAt: JUN, base: 1000 }],
    period: p,
  });
  const ventas = kpis.find((k) => k.key === 'ventas');
  assert.equal(ventas.current, 11800);
  assert.equal(ventas.previous, 5900);
  assert.equal(ventas.yoy, 10000);
  assert.equal(ventas.deltaPrev, 1); // doubled
  assert.equal(ventas.deltaYoy, 0.18);
  assert.equal(kpis.find((k) => k.key === 'cobrado').current, 4000);
  assert.equal(kpis.find((k) => k.key === 'gastos').current, 1000);
});

/* ---------------------------- segmentation ------------------------------ */

const SEG_DATA = {
  salesPostings: [
    { postedAt: JUN, customerId: 'c1', quoteId: 'q1', base: 100, itbis: 18, total: 118, ecfType: '31' },
    { postedAt: JUN, customerId: 'c1', quoteId: 'q2', base: 200, itbis: 36, total: 236, ecfType: '32' },
    { postedAt: JUN, customerId: 'c2', quoteId: 'q3', base: 400, itbis: 72, total: 472, ecfType: '31' },
  ],
  quotes: [
    { id: 'q1', createdByUserId: 'u1', orderId: null },
    { id: 'q2', createdByUserId: 'u1', orderId: 'o1' },
    { id: 'q3', createdByUserId: 'u2', orderId: null },
  ],
  customersById: new Map([['c1', { name: 'Ana' }], ['c2', { name: 'Beto' }]]),
  profileById: new Map([['u1', { name: 'Vendedor Uno' }], ['u2', { name: 'Vendedor Dos' }]]),
  start: JUN - 1000, end: JUN + 1000,
};

test('resolveSalesSegmented groups by customer with shares', () => {
  const r = resolveSalesSegmented({ ...SEG_DATA, groupBy: 'customer' });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].label, 'Beto'); // 472 ranks above Ana's 354
  assert.equal(r.totals.total, 826);
  const ana = r.rows.find((x) => x.label === 'Ana');
  assert.equal(ana.count, 2);
  assert.equal(ana.total, 354);
  assert.equal(ana.share, Math.round((354 / 826) * 1000) / 1000);
});

test('resolveSalesSegmented groups by seller and canal', () => {
  const bySeller = resolveSalesSegmented({ ...SEG_DATA, groupBy: 'seller' });
  assert.equal(bySeller.rows.find((x) => x.label === 'Vendedor Uno').total, 354);
  assert.equal(bySeller.rows.find((x) => x.label === 'Vendedor Dos').total, 472);
  const byCanal = resolveSalesSegmented({ ...SEG_DATA, groupBy: 'canal' });
  assert.equal(byCanal.rows.find((x) => x.key === 'pedido').total, 236);
  assert.equal(byCanal.rows.find((x) => x.key === 'piso').total, 590);
});

test('resolveSalesSegmented applies the free-text filter', () => {
  const r = resolveSalesSegmented({ ...SEG_DATA, groupBy: 'customer', query: 'ana' });
  assert.equal(r.rows.length, 1);
  assert.equal(r.totals.total, 354);
  assert.equal(r.grandTotal, 826); // share base stays the unfiltered total
});

/* --------------------------- monthly table ------------------------------ */

test('resolveMonthlyComparative aligns each month with its YoY twin', () => {
  const rows = resolveMonthlyComparative({
    salesPostings: [
      { postedAt: JUN, total: 1000 },
      { postedAt: new Date(2025, 5, 10).getTime(), total: 500 },
    ],
    months: 3,
    end: JUN,
  });
  assert.equal(rows.length, 3);
  const jun = rows[2];
  assert.equal(jun.label, 'jun 26');
  assert.equal(jun.ventas, 1000);
  assert.equal(jun.ventasYoy, 500);
  assert.equal(jun.deltaYoy, 1);
});

/* ------------------------ expense comparison ---------------------------- */

test('resolveExpenseComparative buckets by class-6 category with deltas', () => {
  const accounts = [
    { code: '6-00-000-00-00-00', name: 'GASTOS', class: 6, parentCode: null, isPostable: false, nature: 'debit', level: 1 },
    { code: '6-01-000-00-00-00', name: 'PERSONAL', class: 6, parentCode: '6-00-000-00-00-00', isPostable: false, nature: 'debit', level: 2 },
    { code: '6-01-001-00-00-00', name: 'Sueldos', class: 6, parentCode: '6-01-000-00-00-00', isPostable: true, nature: 'debit', level: 3 },
  ];
  const p = resolvePeriod({ kind: 'month', ref: JUN });
  const rows = resolveExpenseComparative({
    expenses: [
      { expenseAt: JUN, base: 900, accountCode: '6-01-001-00-00-00' },
      { expenseAt: new Date(2026, 4, 10).getTime(), base: 450, accountCode: '6-01-001-00-00-00' },
      { expenseAt: JUN, base: 100, accountCode: '9-99' }, // unmapped → Sin categoría
    ],
    accounts, period: p,
  });
  const personal = rows.find((r) => r.name === 'PERSONAL');
  assert.equal(personal.current, 900);
  assert.equal(personal.previous, 450);
  assert.equal(personal.delta, 1);
  assert.equal(rows.find((r) => r.name === 'Sin categoría').current, 100);
});

/* ------------------------------ imports --------------------------------- */

test('resolveImportPanel rolls up landed, ITBIS aduanal and the landed factor', () => {
  const p = resolvePeriod({ kind: 'month', ref: JUN });
  const r = resolveImportPanel({
    expedientes: [{
      liquidatedAt: JUN, cif: 100000, duty: 20000, selectivo: 0, importItbis: 21600,
      costs: [{ id: 'c1', amount: 11800, itbis: 1800 }],
    }],
    imports: [],
    accounts: [], lines: [],
    period: p,
  });
  assert.equal(r.landed, 130000);          // cif + duty + cost net (10k)
  assert.equal(r.itbisAduanal, 23400);     // 21600 + 1800
  assert.equal(r.expedientesCount, 1);
  assert.equal(r.landedFactor, 1.3);       // landed ÷ cif
  assert.equal(r.inTransit, 0);
});
