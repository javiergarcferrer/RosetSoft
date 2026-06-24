/**
 * Collections / dunning — the escalating cadence (status-gated, dedup against
 * sent), the message templating, and the cobranza queue ranking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveDunningPolicy, DEFAULT_DUNNING_POLICY, dueStepFor, fillTemplate, planReminders,
} from '../src/lib/accounting/dunning.js';
import { resolveCollectionsQueue } from '../src/core/accounting/collections.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 5, 1); // fixed "today"
const pol = resolveDunningPolicy(null); // default: steps at 0, +7, +15; netDays 0

test('resolveDunningPolicy clamps + sorts steps and keeps defaults', () => {
  assert.equal(pol.steps.length, 3);
  assert.deepEqual(pol.steps.map((s) => s.offsetDays), [0, 7, 15]);
  const custom = resolveDunningPolicy({ netDays: 30, steps: [{ offsetDays: 200 }, { offsetDays: -3 }] });
  assert.equal(custom.netDays, 30);
  assert.deepEqual(custom.steps.map((s) => s.offsetDays), [-3, 90]); // clamped to ±90, sorted
});

test('dueStepFor is status-gated and picks the most-escalated unsent step', () => {
  const due20 = NOW - 20 * DAY; // 20 days past due → steps 0,7,15 all reached
  assert.equal(dueStepFor({ open: 1000, dueAt: due20 }, pol, NOW).offsetDays, 15);
  // step 15 already sent → falls back to the next unsent reached step (7)
  assert.equal(dueStepFor({ open: 1000, dueAt: due20 }, pol, NOW, [15]).offsetDays, 7);
  // not yet due (only 3 days past) → only step 0 reached
  assert.equal(dueStepFor({ open: 1000, dueAt: NOW - 3 * DAY }, pol, NOW).offsetDays, 0);
  // paid (no open balance) → never reminds
  assert.equal(dueStepFor({ open: 0, dueAt: due20 }, pol, NOW), null);
});

test('fillTemplate fills cliente/ncf/monto/dias', () => {
  const msg = fillTemplate('Hola {cliente}, factura {ncf} por {monto} ({dias} días).', { cliente: 'Acme', ncf: 'E310001', monto: 1234.5, dias: 7 });
  assert.match(msg, /Hola Acme/);
  assert.match(msg, /E310001/);
  assert.match(msg, /RD\$ 1,234.50/);
  assert.match(msg, /\(7 días\)/);
});

const receivables = {
  rows: [
    { partyId: 'c1', party: { name: 'Cliente A', phone: '8090000001' }, balance: 5000, buckets: { d0_30: 0, d31_60: 0, d61_90: 0, d90: 5000 },
      docs: [{ docId: 'd1', date: NOW - 20 * DAY, label: 'E310001', open: 5000 }] },
    { partyId: 'c2', party: { name: 'Cliente B', phone: '8090000002' }, balance: 800, buckets: { d0_30: 800, d31_60: 0, d61_90: 0, d90: 0 },
      docs: [{ docId: 'd2', date: NOW - 2 * DAY, label: 'E310002', open: 800 }] },
  ],
};

test('planReminders dedups against already-sent steps', () => {
  const all = planReminders({ receivables, reminders: [], policy: pol, now: NOW });
  assert.equal(all.length, 2);
  const a = all.find((r) => r.partyId === 'c1');
  assert.equal(a.stepOffset, 15);
  assert.match(a.message, /Cliente A/);
  assert.match(a.message, /RD\$ 5,000.00/);
  // mark step 15 sent for d1 → c1 falls back to step 7 (still unsent)
  const after = planReminders({ receivables, reminders: [{ docId: 'd1', stepOffset: 15 }], policy: pol, now: NOW });
  assert.equal(after.find((r) => r.partyId === 'c1').stepOffset, 7);
});

test('resolveCollectionsQueue ranks by balance × age and counts who is due', () => {
  const q = resolveCollectionsQueue({ receivables, reminders: [], now: NOW });
  assert.equal(q.count, 2);
  assert.equal(q.rows[0].partyId, 'c1'); // bigger balance + older → top priority
  assert.equal(q.rows[0].oldestDays, 20);
  assert.equal(q.rows[0].dueCount, 1);
  assert.equal(q.dueCount, 2);
  assert.equal(q.totalDue, 5800);
});

test('a fully-collected customer drops out of the queue', () => {
  const collected = { rows: [{ partyId: 'c3', party: { name: 'C' }, balance: 0, buckets: { d0_30: 0, d31_60: 0, d61_90: 0, d90: 0 }, docs: [{ docId: 'd9', date: NOW - 40 * DAY, label: 'X', open: 0 }] }] };
  const q = resolveCollectionsQueue({ receivables: collected, reminders: [], now: NOW });
  assert.equal(q.count, 0);
});
