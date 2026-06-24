/**
 * Invoice pipeline — bucket posted sales into por cobrar / vencida / cobrada by
 * the per-doc open balance + age, and surface the e-CF backlog.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInvoicePipeline } from '../src/core/accounting/invoices.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 5, 1);

const salesPostings = [
  { id: 's1', number: 1, ncf: 'E310001', customerId: 'c1', postedAt: NOW - 5 * DAY, total: 1000, ecfStatus: 'accepted' },   // open, recent
  { id: 's2', number: 2, ncf: 'E310002', customerId: 'c1', postedAt: NOW - 45 * DAY, total: 2000, ecfStatus: 'accepted' },  // overdue
  { id: 's3', number: 3, ncf: 'E310003', customerId: 'c2', postedAt: NOW - 10 * DAY, total: 1500, ecfStatus: 'accepted' },  // paid
  { id: 's4', number: 4, ncf: 'E310004', customerId: 'c2', postedAt: NOW - 2 * DAY, total: 800, ecfStatus: 'pending' },     // open + e-CF backlog
];
// per-doc open (as resolveReceivables would yield): s1 fully open, s2 fully open,
// s3 fully paid (absent), s4 fully open.
const receivables = {
  rows: [
    { partyId: 'c1', docs: [{ docId: 's1', open: 1000 }, { docId: 's2', open: 2000 }] },
    { partyId: 'c2', docs: [{ docId: 's4', open: 800 }] },
  ],
};

test('buckets sales by payment status with the right amounts', () => {
  const p = resolveInvoicePipeline({ salesPostings, receivables, now: NOW });
  const by = Object.fromEntries(p.buckets.map((b) => [b.key, b]));
  assert.equal(by.open.count, 2);        // s1 + s4
  assert.equal(by.open.amount, 1800);    // 1000 + 800 open
  assert.equal(by.overdue.count, 1);     // s2 (45 days > 30)
  assert.equal(by.overdue.amount, 2000);
  assert.equal(by.paid.count, 1);        // s3 (no open balance)
  assert.equal(by.paid.amount, 1500);    // paid shows the face value
});

test('e-CF backlog counts assigned-but-not-transmitted / rejected', () => {
  const p = resolveInvoicePipeline({ salesPostings, receivables, now: NOW });
  assert.equal(p.pendingEcf.count, 1);   // s4 pending
  assert.equal(p.pendingEcf.amount, 800);
  assert.equal(p.totalInvoiced, 5300);
  assert.equal(p.totalOpen, 3800);       // 1000 + 2000 + 800
  assert.equal(p.count, 4);
});
