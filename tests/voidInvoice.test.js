import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSales607, resolveItbisLiquidation, resolveReceivables,
  resolveInvoiceRegister, invoiceRowTotals,
} from '../src/core/accounting/index.js';

// Pins the anulación (void) invariant: a posting flagged `voidedAt` drops out of
// the 607 fiscal file, the IT-1 débito, and receivables — but stays VISIBLE in
// the register as 'voided' (Anulada), excluded from the active counts/totals.
// An issued e-CF is never voided (cancelled via nota de crédito); this is the
// not-transmitted-gap path.

const M0 = Date.UTC(2026, 5, 1);
const M1 = Date.UTC(2026, 5, 30);
const NOW = Date.UTC(2026, 5, 15);
const sale = (over = {}) => ({
  id: 's1', profileId: 'team', customerId: 'c1', postedAt: NOW,
  ncf: 'E310000000001', ecfType: '31', ecfStatus: 'pending',
  base: 1000, itbis: 180, total: 1180, depositApplied: 0, ...over,
});

test('a voided sale drops out of the 607, the ITBIS débito and receivables', () => {
  const live = sale();
  const voided = sale({ id: 's2', ncf: 'E310000000002', voidedAt: NOW + 1000 });
  const postings = [live, voided];

  const s607 = resolveSales607({ salesPostings: postings, customersById: new Map(), start: M0, end: M1 });
  assert.equal(s607.count, 1, 'only the live sale is in the 607');
  assert.equal(s607.rows[0].id, 's1');
  assert.equal(s607.totals.total, 1180);

  const itbis = resolveItbisLiquidation({ salesPostings: postings, start: M0, end: M1 });
  assert.equal(itbis.debitoFiscal, 180, 'voided ITBIS does not inflate débito fiscal');

  const recv = resolveReceivables({
    salesPostings: postings, payments: [],
    customersById: new Map([['c1', { id: 'c1', name: 'Cliente' }]]), asOf: NOW + 2000,
  });
  assert.equal(recv.totals.balance, 1180, 'a voided sale is not owed');
});

test('the register marks voided as Anulada — out of active counts/totals, into anuladas', () => {
  const live = sale();
  const voided = sale({ id: 's2', ncf: 'E310000000002', voidedAt: NOW + 1000 });
  const recv = resolveReceivables({ salesPostings: [live, voided], payments: [], customersById: new Map(), asOf: NOW + 2000 });
  const reg = resolveInvoiceRegister({ salesPostings: [live, voided], receivables: recv, customersById: new Map(), now: NOW + 2000 });

  assert.equal(reg.rows.find((r) => r.id === 's2').status, 'voided');
  assert.equal(reg.counts.todas, 1, 'voided not counted in Todas');
  assert.equal(reg.counts.anuladas, 1);
  assert.equal(invoiceRowTotals(reg.rows).total, 1180, 'totals skip the voided row');
});
