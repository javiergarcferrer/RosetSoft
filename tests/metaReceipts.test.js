/**
 * Meta Ads receipts → Gasto draft Model — pins the two things the books must
 * never get wrong for a foreign online-service vendor: the USD→DOP money
 * conversion, and the DGII/exterior shape of the draft (blank NCF, ITBIS 0,
 * 606 tipo '02', card). Plus the (account, cycle) dedup key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  billingPeriod,
  billingPeriodLabel,
  metaReceiptKey,
  metaAmountToDop,
  metaReceiptDraft,
} from '../src/lib/accounting/metaReceipts.js';

const JUNE = {
  adAccountId: 'act_123456',
  periodStartAt: Date.UTC(2026, 5, 1),
  periodEndAt: Date.UTC(2026, 5, 30),
  amount: 500,
  currency: 'USD',
  source: 'spend',
  invoiceUrl: 'https://business.facebook.com/billing/123',
  invoiceNumber: null,
};

test('billingPeriod + label are UTC and stable', () => {
  assert.equal(billingPeriod(JUNE.periodStartAt), '2026-06');
  assert.equal(billingPeriodLabel(JUNE.periodStartAt), 'junio 2026');
});

test('metaReceiptKey strips act_ and keys by (account, cycle) — re-sync upserts', () => {
  assert.equal(metaReceiptKey('act_123456', JUNE.periodStartAt), 'metarcpt-123456-2026-06');
  // Same account+cycle, with/without prefix → identical key (idempotent sync).
  assert.equal(metaReceiptKey('123456', JUNE.periodStartAt), metaReceiptKey('act_123456', JUNE.periodStartAt));
  // A different cycle is a different row.
  assert.notEqual(metaReceiptKey('act_123456', Date.UTC(2026, 6, 1)), metaReceiptKey('act_123456', JUNE.periodStartAt));
});

test('metaAmountToDop converts USD at the rate, passes DOP through', () => {
  assert.equal(metaAmountToDop(500, 'USD', 58.5), 29250);
  assert.equal(metaAmountToDop(500, 'usd', 58.5), 29250); // case-insensitive
  assert.equal(metaAmountToDop(1234.56, 'DOP', 58.5), 1234.56); // rate ignored for DOP
  assert.equal(metaAmountToDop(0, 'USD', 58.5), 0);
});

test('metaAmountToDop refuses a missing rate or an unsupported currency', () => {
  assert.throws(() => metaAmountToDop(500, 'USD', 0));
  assert.throws(() => metaAmountToDop(500, 'USD', null));
  assert.throws(() => metaAmountToDop(500, 'EUR', 58.5));
});

test('metaReceiptDraft yields a foreign-vendor gasto: DOP base, blank NCF, ITBIS 0, 606=02, card', () => {
  const d = metaReceiptDraft({ record: JUNE, supplierId: 'sup-meta', accountCode: '6-02-01', dopRate: 58.5 });
  assert.equal(d.supplierId, 'sup-meta');
  assert.equal(d.accountCode, '6-02-01');
  assert.equal(d.base, 29250);          // 500 USD × 58.5
  assert.equal(d.itbis, 0);
  assert.equal(d.itbisCreditable, false);
  assert.equal(d.ncf, '');              // Meta issues no Dominican NCF
  assert.equal(d.retentionIsr, 0);
  assert.equal(d.retentionItbis, 0);
  assert.equal(d.tipo606, '02');        // servicios
  assert.equal(d.paymentMethod, 'card');
  assert.equal(d.expenseAt, JUNE.periodEndAt); // booked at cycle close
  assert.equal(d.description, 'Meta Ads — junio 2026');
  // The receipt link rides along — the document is PRE-ATTACHED.
  assert.equal(d.attachmentUrl, JUNE.invoiceUrl);
});

test('metaReceiptDraft uses the invoice number in the attachment name when present', () => {
  const rec = { ...JUNE, source: 'invoice', invoiceNumber: 'FB-2026-0042' };
  const d = metaReceiptDraft({ record: rec, supplierId: 'sup-meta', accountCode: '6-02-01', dopRate: 58.5 });
  assert.equal(d.attachmentName, 'Meta FB-2026-0042');
});

test('metaReceiptDraft honors an explicit description override', () => {
  const d = metaReceiptDraft({ record: JUNE, supplierId: 'sup-meta', accountCode: '6-02-01', dopRate: 58.5, description: 'Campaña Togo' });
  assert.equal(d.description, 'Campaña Togo');
});
