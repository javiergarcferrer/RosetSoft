/**
 * Tests for the two dashboard ViewModels:
 *  • the Contabilidad dashboard (src/core/accounting/dashboard.js) — cash from
 *    the ledger's Cajas-y-Bancos subtree, CxC balance, month income, and the
 *    e-CF-pending count;
 *  • the seller home (src/core/quote/views/dashboard.js) — the KPI money
 *    rollups (pipeline values, "por cobrar") and per-row money facts the
 *    Inicio page renders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingDashboard, resolveEcfSequenceAlerts } from '../src/core/accounting/dashboard.js';
import { resolveDashboard } from '../src/core/quote/views/dashboard.js';

const ACCOUNTS = [
  { code: '1-00-000-00-00-00', class: 1, nature: 'debit', parentCode: null, level: 1, isPostable: false, name: 'ACTIVOS' },
  { code: '1-01-000-00-00-00', class: 1, nature: 'debit', parentCode: '1-00-000-00-00-00', level: 2, isPostable: false, name: 'AC CORRIENTES' },
  { code: '1-01-001-00-00-00', class: 1, nature: 'debit', parentCode: '1-01-000-00-00-00', level: 3, isPostable: false, name: 'CAJAS Y BANCOS' },
  { code: '1-01-001-02-00-00', class: 1, nature: 'debit', parentCode: '1-01-001-00-00-00', level: 4, isPostable: true, name: 'BANCOS' },
  { code: '4-00-000-00-00-00', class: 4, nature: 'credit', parentCode: null, level: 1, isPostable: false, name: 'INGRESOS' },
  { code: '4-01-001-01-00-00', class: 4, nature: 'credit', parentCode: '4-00-000-00-00-00', level: 4, isPostable: true, name: 'VENTAS' },
];
const MONTH = 1_000_000_000;
const ENTRIES = [{ id: 'e1', postedAt: MONTH + 1 }];
const LINES = [
  { entryId: 'e1', accountCode: '1-01-001-02-00-00', debit: 10000, credit: 0 },
  { entryId: 'e1', accountCode: '4-01-001-01-00-00', debit: 0, credit: 10000 },
];

test('resolveAccountingDashboard rolls up cash, CxC, month income and e-CF pending', () => {
  const d = resolveAccountingDashboard({
    accounts: ACCOUNTS, entries: ENTRIES, lines: LINES,
    salesPostings: [{ customerId: 'c1', postedAt: MONTH + 1, total: 11800, depositApplied: 0, ncf: 'E310000000001', ecfStatus: 'pending' }],
    purchases: [], expenses: [], payments: [], imports: [],
    customersById: new Map([['c1', { id: 'c1', name: 'Cliente A' }]]),
    suppliersById: new Map(),
    monthStart: MONTH, monthEnd: MONTH + 1_000_000,
  });
  assert.equal(d.cash, 10000);          // bank balance from the ledger
  assert.equal(d.cxcBalance, 11800);    // open receivable
  assert.equal(d.ingresosMonth, 10000); // income in the window
  assert.equal(d.utilidadMonth, 10000); // no costs/expenses
  assert.equal(d.ecfPending, 1);        // one un-transmitted e-NCF
  assert.equal(d.cxcTop.length, 1);
});

test('resolveAccountingDashboard builds the Business-overview series + breakdowns', () => {
  const d = resolveAccountingDashboard({
    accounts: ACCOUNTS, entries: ENTRIES, lines: LINES,
    salesPostings: [{ customerId: 'c1', postedAt: MONTH + 1, total: 11800, depositApplied: 0, ncf: 'E310000000001', ecfStatus: 'pending' }],
    purchases: [], expenses: [], payments: [], imports: [],
    customersById: new Map([['c1', { id: 'c1', name: 'Cliente A' }]]),
    suppliersById: new Map(),
    monthStart: MONTH, monthEnd: MONTH + 1_000_000,
  });

  // Per-account cash balances → the "Bank accounts" card.
  assert.equal(d.bankAccounts.length, 1);
  assert.equal(d.bankAccounts[0].code, '1-01-001-02-00-00');
  assert.equal(d.bankAccounts[0].balance, 10000);

  // 6-month series; the operative month (the fixture's only entry) carries the
  // income, the cash inflow and the sale, with nothing flowing out.
  assert.equal(d.monthsSeries.length, 6);
  const cur = d.monthsSeries[d.monthsSeries.length - 1];
  assert.equal(cur.ingresos, 10000);
  assert.equal(cur.cashIn, 10000);
  assert.equal(cur.cashOut, 0);
  assert.equal(cur.sales, 11800);
  assert.equal(cur.utilidad, 10000);

  // No clase-6 accounts in the fixture → an empty gastos donut.
  assert.equal(d.expenseDonut.total, 0);
  assert.equal(d.expenseDonut.segments.length, 0);

  // The whole receivable is unpaid; nothing collected (no payments).
  assert.equal(d.ar.unpaid, 11800);
  assert.equal(d.collected30, 0);
});

/* --------------------- seller home (resolveDashboard) --------------------- */

// Fixture: one quote per pipeline state, all owned by 'me', each with one
// $1,000-base line (totals then carry the fixed 18% ITBIS — the assertions
// read totalByQuote instead of hard-coding the tax math).
const NOW = Date.parse('2026-06-10T12:00:00Z');
const SELLER_QUOTES = [
  { id: 'qd', profileId: 't', status: 'draft', createdByUserId: 'me', updatedAt: NOW - 1 },
  { id: 'qs', profileId: 't', status: 'sent', createdByUserId: 'me', sentAt: NOW - 10 * 86400000 },
  // Accepted this month, deposit received → the balance is what's owed.
  { id: 'qa', profileId: 't', status: 'accepted', createdByUserId: 'me', acceptedAt: NOW - 86400000, depositReceivedAt: NOW - 86400000, depositAmount: 500 },
  // Accepted LAST month, nothing paid → the full total is owed.
  { id: 'qb', profileId: 't', status: 'accepted', createdByUserId: 'me', acceptedAt: NOW - 40 * 86400000 },
];
const SELLER_LINES = SELLER_QUOTES.map((q) => ({
  id: `l-${q.id}`, quoteId: q.id, kind: 'item', qty: 1, unitPrice: 1000,
}));

test('resolveDashboard pairs every KPI count with its USD pipeline value', () => {
  const d = resolveDashboard({
    quotes: SELLER_QUOTES, customers: [], lines: SELLER_LINES,
    orders: [], containers: [], scopeIsTeam: false, meId: 'me', now: NOW,
  });
  const total = (id) => d.totalByQuote.get(id);

  assert.equal(d.kpis.draftCount, 1);
  assert.equal(d.kpis.draftValue, total('qd'));
  assert.equal(d.kpis.sentCount, 1);
  assert.equal(d.kpis.sentValue, total('qs'));
  assert.equal(d.kpis.staleCount, 1); // sent 10 days ago ≥ STALE_DAYS
});

test('resolveDashboard "por cobrar" = balance after deposit + untouched totals', () => {
  const d = resolveDashboard({
    quotes: SELLER_QUOTES, customers: [], lines: SELLER_LINES,
    orders: [], containers: [], scopeIsTeam: false, meId: 'me', now: NOW,
  });
  const total = (id) => d.totalByQuote.get(id);

  // Per-row dues: qa owes total − 500 (deposit landed), qb owes everything.
  const byId = new Map(d.accepted.map((a) => [a.q.id, a]));
  assert.equal(byId.get('qa').due, total('qa') - 500);
  assert.equal(byId.get('qa').total, total('qa'));
  assert.equal(byId.get('qb').due, total('qb'));
  // The KPI is the sum of the same per-row rule — one money source.
  assert.equal(d.kpis.dueValue, byId.get('qa').due + byId.get('qb').due);
});

test('resolveDashboard stamps active orders with when they entered their stage', () => {
  const d = resolveDashboard({
    quotes: [], customers: [], lines: [],
    orders: [
      { id: 'o1', status: 'in_customs', inCustomsAt: NOW - 5 * 86400000, updatedAt: NOW },
      { id: 'o2', status: 'draft', updatedAt: NOW - 1 },
      { id: 'o3', status: 'received', receivedAt: NOW }, // done — excluded
    ],
    containers: [], scopeIsTeam: true, meId: null, now: NOW,
  });
  const byId = new Map(d.activeOrders.map((a) => [a.order.id, a]));
  assert.equal(byId.get('o1').stageAt, NOW - 5 * 86400000);
  assert.equal(byId.get('o2').stageAt, null); // draft has no stage timestamp
  assert.equal(byId.has('o3'), false);
});

test('resolveDashboard rolls container ETAs up to the LATEST per order, valid codes only', async () => {
  const { iso6346CheckDigit } = await import('../src/lib/containerTracking.js');
  const codeA = 'HLCU123456' + iso6346CheckDigit('HLCU123456');
  const codeB = 'MSCU123456' + iso6346CheckDigit('MSCU123456');
  const etaA = NOW + 3 * 86400000;
  const etaB = NOW + 9 * 86400000;

  const d = resolveDashboard({
    quotes: [], customers: [], lines: [],
    orders: [{ id: 'o1', status: 'in_transit', inTransitAt: NOW - 1, updatedAt: NOW }],
    containers: [
      { id: 'c1', orderId: 'o1', code: codeA },
      { id: 'c2', orderId: 'o1', code: ` ${codeB.toLowerCase()} ` }, // normalizes
      { id: 'c3', orderId: 'o1', code: 'NOT-A-CONTAINER' },          // dropped
    ],
    scopeIsTeam: true, meId: null, now: NOW,
    etaByCode: new Map([
      [codeA, { etaAt: etaA, etaLocation: 'Caucedo' }],
      [codeB, { etaAt: etaB, etaLocation: 'Rio Haina' }],
    ]),
  });

  const [a] = d.activeOrders;
  // Only the two valid ISO 6346 numbers are exposed for tracking.
  assert.deepEqual(a.containerCodes, [codeA, codeB]);
  // The order is fully landed with its LAST container → the later estimate wins.
  assert.equal(a.eta.at, etaB);
  assert.equal(a.eta.location, 'Rio Haina');
  assert.equal(a.eta.code, codeB);
});

test('resolveDashboard leaves eta null when no ETAs are known (yet)', () => {
  const d = resolveDashboard({
    quotes: [], customers: [], lines: [],
    orders: [{ id: 'o1', status: 'in_transit', inTransitAt: NOW - 1, updatedAt: NOW }],
    containers: [{ id: 'c1', orderId: 'o1', code: 'HLCU1234568' }],
    scopeIsTeam: true, meId: null, now: NOW,
    // no etaByCode at all — first render, tracking still in flight
  });
  assert.equal(d.activeOrders[0].eta, null);
  assert.deepEqual(d.activeOrders[0].containerCodes, ['HLCU1234568']);
});

/* ----------------------- e-NCF sequence alerts -------------------------- */

const DAY = 86_400_000;
const SEQ_NOW = Date.parse('2026-06-12T12:00:00');

test('resolveEcfSequenceAlerts: silent without configured ranges, warns when dry/low/expiring', () => {
  // No ranges at all → pre-e-CF operation, no noise.
  assert.equal(resolveEcfSequenceAlerts([], { now: SEQ_NOW }).length, 0);

  const seq = (over) => ({
    ecfType: '31', seqFrom: 1, seqTo: 100, nextSeq: 1, active: true,
    expiresAt: SEQ_NOW + 365 * DAY, ...over,
  });

  // Ranges exist for 31 but all are exhausted → 'none'.
  const dry = resolveEcfSequenceAlerts([seq({ nextSeq: 101 })], { now: SEQ_NOW });
  assert.equal(dry.length, 1);
  assert.equal(dry[0].kind, 'none');
  assert.equal(dry[0].type, '31');

  // Few numbers left → 'low' with the remaining count.
  const low = resolveEcfSequenceAlerts([seq({ nextSeq: 95 })], { now: SEQ_NOW });
  assert.equal(low[0].kind, 'low');
  assert.equal(low[0].remaining, 6);

  // Plenty left but the range dies within 30 days → 'expiring'.
  const expiring = resolveEcfSequenceAlerts([seq({ expiresAt: SEQ_NOW + 10 * DAY })], { now: SEQ_NOW });
  assert.equal(expiring[0].kind, 'expiring');
  assert.equal(expiring[0].expiresAt, SEQ_NOW + 10 * DAY);

  // Healthy range → silent.
  assert.equal(resolveEcfSequenceAlerts([seq()], { now: SEQ_NOW }).length, 0);
});
