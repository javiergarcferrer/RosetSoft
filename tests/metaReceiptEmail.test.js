/**
 * Meta Ads payment-receipt email parser — pins the heuristic extraction that the
 * Gmail ingestion path depends on (amount + currency + charge date + reference),
 * the sender/intent gate, and the monthly sum. This is the Vite-side canonical
 * copy; the Deno mirror in supabase/functions/meta-receipts must stay identical.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMetaReceiptEmail, parseMetaReceiptEmail, sumReceipts,
} from '../src/lib/accounting/metaReceiptEmail.js';

const EN = {
  from: 'Meta Platforms <advertise-noreply@facebookmail.com>',
  subject: 'Your Meta ads payment receipt',
  text: [
    'Thanks for advertising with Meta.',
    'Your ad account was billed for recent activity.',
    'Amount billed: US$1,250.00',
    'Payment method: Visa ending in 1234',
    'Reference number: 9988776655',
    'Transaction date: Jun 15, 2026',
  ].join('\n'),
  dateMs: Date.UTC(2026, 5, 15, 14, 30),
  messageId: 'msg-en-1',
};

const ES = {
  from: 'Facebook <noreply@facebookmail.com>',
  subject: 'Recibo de pago de tus anuncios',
  text: [
    'Gracias por anunciarte en Meta.',
    'Se realizó un cargo a tu cuenta publicitaria.',
    'Importe facturado: RD$700.00',
    'Referencia: ABC123456',
  ].join('\n'),
  dateMs: Date.UTC(2026, 5, 20, 9, 0),
  messageId: 'msg-es-1',
};

test('isMetaReceiptEmail gates on sender + payment + ads intent', () => {
  assert.equal(isMetaReceiptEmail(EN), true);
  assert.equal(isMetaReceiptEmail(ES), true);
  // A newsletter from Meta (no payment intent) is not a receipt.
  assert.equal(isMetaReceiptEmail({ from: 'noreply@facebookmail.com', subject: 'New features for your ads', text: 'Check out Reels' }), false);
  // A payment receipt from someone else is not a Meta receipt.
  assert.equal(isMetaReceiptEmail({ from: 'billing@stripe.com', subject: 'Your payment receipt', text: 'Amount paid: $10 for ads' }), false);
});

test('parseMetaReceiptEmail extracts USD amount, currency, date, reference', () => {
  const r = parseMetaReceiptEmail(EN);
  assert.equal(r.amount, 1250);
  assert.equal(r.currency, 'USD');
  assert.equal(r.chargedAt, EN.dateMs);
  assert.equal(r.receiptId, '9988776655');
});

test('parseMetaReceiptEmail handles RD$ (DOP) and Spanish labels', () => {
  const r = parseMetaReceiptEmail(ES);
  assert.equal(r.amount, 700);
  assert.equal(r.currency, 'DOP');
  assert.equal(r.receiptId, 'ABC123456');
});

test('parseMetaReceiptEmail prefers the labeled total over smaller line items', () => {
  const m = {
    ...EN,
    text: 'Subtotal: US$1,000.00\nTax: US$250.00\nAmount billed: US$1,250.00\nReference number: 5551112222',
  };
  assert.equal(parseMetaReceiptEmail(m).amount, 1250);
});

test('parseMetaReceiptEmail falls back to the largest money token when unlabeled', () => {
  const m = {
    from: 'noreply@facebookmail.com', subject: 'Payment receipt for your ad account',
    text: 'We charged your card. You were charged $42.50 USD today. Card ending 1111.',
    dateMs: Date.UTC(2026, 5, 1), messageId: 'msg-x',
  };
  const r = parseMetaReceiptEmail(m);
  assert.equal(r.amount, 42.5);
  assert.equal(r.currency, 'USD');
  assert.equal(r.receiptId, 'msg-x'); // no reference → message id
});

test('parseMetaReceiptEmail returns null for non-receipts', () => {
  assert.equal(parseMetaReceiptEmail({ from: 'noreply@facebookmail.com', subject: 'Weekly ads digest', text: 'Your reach grew' }), null);
});

test('parseMetaReceiptEmail parses an HTML-only body', () => {
  const m = {
    from: 'advertise-noreply@facebookmail.com', subject: 'Meta ads receipt',
    html: '<table><tr><td>Amount billed:</td><td><b>US$88.00</b></td></tr><tr><td>Reference number: 7001</td></tr></table>',
    dateMs: Date.UTC(2026, 4, 30), messageId: 'msg-html',
  };
  const r = parseMetaReceiptEmail(m);
  assert.equal(r.amount, 88);
  assert.equal(r.currency, 'USD');
});

test('sumReceipts totals a month of charges, latest date, count', () => {
  const a = parseMetaReceiptEmail(EN);          // 1250 on Jun 15
  const b = parseMetaReceiptEmail({ ...EN, text: 'Amount billed: US$300.00\nReference number: 1', dateMs: Date.UTC(2026, 5, 22) });
  const s = sumReceipts([a, b]);
  assert.equal(s.amount, 1550);
  assert.equal(s.currency, 'USD');
  assert.equal(s.count, 2);
  assert.equal(s.chargedAt, Date.UTC(2026, 5, 22)); // latest
});

test('sumReceipts is null for an empty month', () => {
  assert.equal(sumReceipts([]), null);
  assert.equal(sumReceipts([null]), null);
});
