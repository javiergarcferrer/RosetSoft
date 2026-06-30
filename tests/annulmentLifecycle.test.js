/**
 * Annulment / reversal lifecycle — the books stay sound when a factura is
 * reversed. Pins the guards that keep quote → invoice → cobro honest:
 *
 *   • a voided posting drops out of receivables (its charge is gone);
 *   • a factura can be re-invoiced after it's anulada (the DB allows it now —
 *     this test pins the Model guards that gate the UI around that);
 *   • the cardinal rule: never anul a factura that already has a cobro applied
 *     (otherwise the FIFO silently re-applies that money to the customer's other
 *     invoices and the refund we owe vanishes). canVoidPosting blocks it.
 *
 * These Model guards mirror the server-side void_sale / post_payment RPCs across
 * the Deno↔Vite wall — same rule, two layers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAccountingConfig } from '../src/lib/accounting/config.js';
import { buildSaleEntry, buildCreditNoteEntry } from '../src/lib/accounting/sale.js';
import { debitTotal, creditTotal } from '../src/lib/accounting/ledger.js';
import { resolveReceivables } from '../src/core/accounting/receivables.js';
import {
  canVoidPosting, canCollectPosting, paymentsAllocatedTo, amountCollectedOn,
} from '../src/lib/accounting/reversalGuards.js';

const config = resolveAccountingConfig(null);
function ids() { let n = 0; return () => `id${++n}`; }

/* ------------------------------ void guard ------------------------------ */

test('canVoidPosting allows a clean, not-yet-transmitted sale', () => {
  const p = { id: 'sp1', ncf: 'E310000000001', ecfStatus: 'pending', voidedAt: null };
  assert.deepEqual(canVoidPosting(p, []), { ok: true });
});

test('canVoidPosting blocks an already-anulada factura', () => {
  const p = { id: 'sp1', ncf: 'E310000000001', ecfStatus: 'pending', voidedAt: 123 };
  const r = canVoidPosting(p, []);
  assert.equal(r.ok, false);
  assert.match(r.reason, /ya está anulada/);
});

test('canVoidPosting blocks a transmitted e-CF (use a nota de crédito)', () => {
  for (const ecfStatus of ['sent', 'accepted']) {
    const r = canVoidPosting({ id: 'sp1', ncf: 'E31...', ecfStatus, voidedAt: null }, []);
    assert.equal(r.ok, false);
    assert.match(r.reason, /nota de crédito/);
  }
});

test('canVoidPosting blocks a nota de crédito itself', () => {
  const r = canVoidPosting({ id: 'nc1', ncf: 'E340000000001', ecfStatus: 'pending', voidedAt: null }, []);
  assert.equal(r.ok, false);
});

test('canVoidPosting blocks a factura with cobros applied — the cardinal rule', () => {
  const posting = { id: 'sp1', ncf: 'E310000000001', ecfStatus: 'pending', voidedAt: null };
  const payments = [{ id: 'pay1', allocations: [{ docId: 'sp1', amount: 5000 }] }];
  const r = canVoidPosting(posting, payments);
  assert.equal(r.ok, false);
  assert.match(r.reason, /cobros aplicados/);
});

/* ----------------------------- collect guard ---------------------------- */

test('canCollectPosting blocks a cobro on an anulada factura', () => {
  const r = canCollectPosting({ ncf: 'E310000000001', voidedAt: 123 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /anulada/);
});

test('canCollectPosting allows a cobro on an active factura, blocks a nota', () => {
  assert.equal(canCollectPosting({ ncf: 'E310000000001', voidedAt: null }).ok, true);
  assert.equal(canCollectPosting({ ncf: 'E340000000001', voidedAt: null }).ok, false);
});

/* --------------------------- allocation helpers -------------------------- */

test('paymentsAllocatedTo / amountCollectedOn sum a posting\'s cobros', () => {
  const payments = [
    { id: 'p1', allocations: [{ docId: 'sp1', amount: 3000 }, { docId: 'sp2', amount: 1000 }] },
    { id: 'p2', allocations: [{ docId: 'sp1', amount: 2000 }] },
    { id: 'p3', allocations: [{ docId: 'sp9', amount: 9000 }] },
  ];
  assert.equal(paymentsAllocatedTo('sp1', payments).length, 2);
  assert.equal(amountCollectedOn('sp1', payments), 5000);
  assert.equal(amountCollectedOn('sp2', payments), 1000);
  assert.equal(amountCollectedOn('absent', payments), 0);
});

/* ----------------------------- audit linkage ---------------------------- */

test('buildCreditNoteEntry stamps reversesId when anulling a sale', () => {
  const sale = buildSaleEntry({
    newId: ids(), config,
    sale: { id: 'sp1', customerId: 'c1', base: 10000, itbis: 1800, deposit: 0, ncf: 'E310000000001' },
  });
  const nc = buildCreditNoteEntry({
    newId: ids(), config, reversesEntryId: sale.entry.id,
    note: { id: 'sp1', customerId: 'c1', base: 10000, itbis: 1800, depositToRestore: 0, ncf: null },
  });
  assert.equal(nc.entry.reversesId, sale.entry.id);
  assert.equal(debitTotal(nc.lines), creditTotal(nc.lines));
});

/* -------------------------- receivables lifecycle ------------------------ */

test('a voided posting drops out of receivables entirely', () => {
  const salesPostings = [
    { id: 'sp1', customerId: 'c1', ncf: 'E310000000001', postedAt: 1000, total: 11800, depositApplied: 0, voidedAt: null },
    { id: 'sp2', customerId: 'c1', ncf: 'E310000000002', postedAt: 2000, total: 5000, depositApplied: 0, voidedAt: 3000 },
  ];
  const { totals } = resolveReceivables({ salesPostings, payments: [], customersById: new Map() });
  // Only the active sp1 ages; the anulada sp2 contributes nothing.
  assert.equal(totals.balance, 11800);
});

test('an active factura with a partial cobro shows the right open balance', () => {
  const salesPostings = [
    { id: 'sp1', customerId: 'c1', ncf: 'E310000000001', postedAt: 1000, total: 11800, depositApplied: 0, voidedAt: null },
  ];
  const payments = [
    { id: 'p1', direction: 'in', partyType: 'customer', partyId: 'c1', paidAt: 1500, amount: 4000, allocations: [{ docId: 'sp1', amount: 4000 }] },
  ];
  const { rows } = resolveReceivables({ salesPostings, payments, customersById: new Map() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].balance, 7800);
});

test('regression: anulling a paid factura would misapply the cobro — the guard forbids it', () => {
  // Customer c1 has two invoices: sp1 (paid in full) and sp2 (open). If sp1 were
  // anulada WITHOUT first reversing its cobro, resolveReceivables would drop sp1
  // and the orphaned $11,800 cobro would FIFO onto sp2 — making sp2 look settled
  // while a refund for sp1 silently disappears. canVoidPosting blocks that.
  const sp1 = { id: 'sp1', customerId: 'c1', ncf: 'E310000000001', postedAt: 1000, total: 11800, depositApplied: 0, voidedAt: null };
  const payments = [
    { id: 'p1', direction: 'in', partyType: 'customer', partyId: 'c1', paidAt: 1500, amount: 11800, allocations: [{ docId: 'sp1', amount: 11800 }] },
  ];
  const guard = canVoidPosting(sp1, payments);
  assert.equal(guard.ok, false, 'voiding a factura with a cobro must be refused');

  // Prove the hazard the guard prevents: with sp1 voided and the cobro left in
  // place, the books misreport sp2 as paid.
  const sp2 = { id: 'sp2', customerId: 'c1', ncf: 'E310000000002', postedAt: 2000, total: 11800, depositApplied: 0, voidedAt: null };
  const sp1Voided = { ...sp1, voidedAt: 3000 };
  const { totals } = resolveReceivables({ salesPostings: [sp1Voided, sp2], payments, customersById: new Map() });
  // c1 truly owes 11,800 (sp2) and is owed 11,800 (sp1 refund) → net 0, but the
  // open invoice sp2 is hidden. The guard keeps this state unreachable.
  assert.equal(totals.balance, 0);
});
