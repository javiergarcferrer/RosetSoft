/**
 * Tests for src/core/jarvis/pulse.js — the JARVIS "honest data" pulse.
 *
 * Pins the money/data rules the panel shows:
 *   - funnel money goes through the canonical per-quote rollup
 *     (core/quote/totals → lib/pricing), so JARVIS agrees with the
 *     dashboard/lists to the cent (ITBIS included, optional lines excluded);
 *   - outstanding receivable follows the quote milestone rules
 *     (nothing paid → full total; deposit → total − deposit; balance → 0);
 *   - weekly buckets are true Monday-aligned weeks;
 *   - the ops feed is real events, newest first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBusinessPulse,
  resolveOpsFeed,
  resolveActivityHeatmap,
  resolveWaBrief,
  resolveFollowUps,
  sparkPoints,
} from '../src/core/jarvis/pulse.js';
import { ITBIS_PCT } from '../src/lib/pricing.js';

const TAX = 1 + ITBIS_PCT / 100;
const DAY = 86_400_000;

// Wednesday 2026-06-10 12:00 local — current week starts Monday 2026-06-08.
const NOW = new Date(2026, 5, 10, 12, 0, 0).getTime();
const MON_THIS_WEEK = new Date(2026, 5, 8).getTime();
const MON_PREV_WEEK = new Date(2026, 5, 1).getTime();

const line = (quoteId, unitPrice, extra = {}) => ({
  id: `l-${quoteId}-${unitPrice}`,
  quoteId,
  kind: 'item',
  qty: 1,
  unitPrice,
  ...extra,
});

test('funnel sums each live stage through the canonical quote rollup', () => {
  const quotes = [
    { id: 'd1', status: 'draft', createdAt: NOW },
    { id: 's1', status: 'sent', createdAt: NOW, sentAt: NOW },
    { id: 'a1', status: 'accepted', createdAt: NOW, acceptedAt: NOW },
    { id: 'x1', status: 'declined', createdAt: NOW }, // out of the funnel
  ];
  const lines = [
    line('d1', 100),
    line('s1', 200),
    line('s1', 50, { isOptional: true }), // optional → never priced
    line('a1', 1000),
    line('x1', 9999),
  ];
  const { funnel, pipelineUsd } = resolveBusinessPulse({ quotes, lines, now: NOW });

  const byKey = Object.fromEntries(funnel.map((f) => [f.key, f]));
  assert.equal(funnel.length, 3);
  assert.equal(byKey.draft.count, 1);
  assert.ok(Math.abs(byKey.draft.totalUsd - 100 * TAX) < 1e-9);
  assert.equal(byKey.sent.count, 1);
  assert.ok(Math.abs(byKey.sent.totalUsd - 200 * TAX) < 1e-9); // optional line excluded
  assert.equal(byKey.accepted.count, 1);
  assert.ok(Math.abs(byKey.accepted.totalUsd - 1000 * TAX) < 1e-9);
  assert.ok(Math.abs(pipelineUsd - 200 * TAX) < 1e-9);
  // share scales bars to the biggest stage
  assert.equal(byKey.accepted.share, 1);
  assert.ok(byKey.draft.share > 0 && byKey.draft.share < 1);
});

test('outstanding receivable follows the milestone rules per accepted quote', () => {
  const quotes = [
    // nothing paid → owes the full total
    { id: 'a1', status: 'accepted', acceptedAt: NOW },
    // deposit landed → owes total − deposit
    { id: 'a2', status: 'accepted', acceptedAt: NOW, depositReceivedAt: NOW, depositAmount: 100 },
    // balance paid → owes nothing
    { id: 'a3', status: 'accepted', acceptedAt: NOW, balancePaidAt: NOW },
  ];
  const lines = [line('a1', 100), line('a2', 1000), line('a3', 500)];
  const { outstandingUsd } = resolveBusinessPulse({ quotes, lines, now: NOW });
  assert.ok(Math.abs(outstandingUsd - (100 * TAX + (1000 * TAX - 100))) < 1e-9);
});

test('won this month counts acceptedAt since the 1st', () => {
  const quotes = [
    { id: 'a1', status: 'accepted', acceptedAt: new Date(2026, 5, 2).getTime() },
    { id: 'a2', status: 'accepted', acceptedAt: new Date(2026, 4, 30).getTime() }, // May → out
  ];
  const lines = [line('a1', 100), line('a2', 100)];
  const { wonMonth } = resolveBusinessPulse({ quotes, lines, now: NOW });
  assert.equal(wonMonth.count, 1);
  assert.ok(Math.abs(wonMonth.totalUsd - 100 * TAX) < 1e-9);
});

test('weekly series buckets are Monday-aligned true weeks ending in the current week', () => {
  const quotes = [
    { id: 'q1', status: 'draft', createdAt: MON_THIS_WEEK + 1 },
    { id: 'q2', status: 'draft', createdAt: MON_PREV_WEEK + 1 },
    { id: 'q3', status: 'accepted', createdAt: MON_PREV_WEEK, acceptedAt: MON_PREV_WEEK + 2 },
    // exactly on the boundary belongs to the NEW week
    { id: 'q4', status: 'draft', createdAt: MON_THIS_WEEK },
  ];
  const { series } = resolveBusinessPulse({ quotes, lines: [], now: NOW, weeks: 4 });
  assert.equal(series.length, 4);
  assert.equal(series[3].start, MON_THIS_WEEK);
  assert.equal(series[2].start, MON_PREV_WEEK);
  assert.equal(series[3].created, 2); // q1 + boundary q4
  assert.equal(series[2].created, 2); // q2 + q3
  assert.equal(series[2].accepted, 1);
  assert.equal(series[3].accepted, 0);
});

test('week-over-week delta compares the current week to the previous one', () => {
  const quotes = [
    { id: 'q1', status: 'draft', createdAt: MON_THIS_WEEK + 1 },
    { id: 'q2', status: 'draft', createdAt: MON_PREV_WEEK + 1 },
    { id: 'q3', status: 'draft', createdAt: MON_PREV_WEEK + 2 },
  ];
  const { weekDelta } = resolveBusinessPulse({ quotes, lines: [], now: NOW });
  assert.deepEqual(weekDelta.created, { cur: 1, prev: 2, pct: -50 });
  // nothing last week → no honest percentage to claim
  assert.equal(weekDelta.accepted.pct, null);
});

test('activity heatmap buckets real events by local day with 0–4 levels', () => {
  const quotes = [
    // 3 events on the same Tuesday (created + sent + accepted)
    { id: 'q1', createdAt: MON_THIS_WEEK + DAY, sentAt: MON_THIS_WEEK + DAY + 1000, acceptedAt: MON_THIS_WEEK + DAY + 2000 },
  ];
  const orders = [{ id: 'o1', createdAt: MON_PREV_WEEK }]; // 1 event prev Monday
  const { cols, max } = resolveActivityHeatmap({ quotes, orders, now: NOW, weeks: 4 });

  assert.equal(cols.length, 4);
  assert.ok(cols.every((c) => c.length === 7));
  assert.equal(max, 3);
  const tue = cols[3][1]; // current week, Tuesday
  assert.equal(tue.count, 3);
  assert.equal(tue.level, 4);
  const prevMon = cols[2][0];
  assert.equal(prevMon.count, 1);
  assert.equal(prevMon.level, 2); // ceil(1/3 · 4) — non-zero never renders as empty
  // days after `now` are flagged so the View can mute them
  assert.equal(cols[3][6].future, true);
});

test('sparkPoints maps a series into the viewbox, max at the top', () => {
  const pts = sparkPoints([0, 4], 100, 28, 2);
  assert.equal(pts, '2.0,26.0 98.0,2.0');
  assert.equal(sparkPoints([]), '');
  // all-zero series stays on the baseline instead of dividing by zero
  assert.equal(sparkPoints([0, 0], 100, 28, 2), '2.0,26.0 98.0,26.0');
});

test('WhatsApp brief counts 7d in/out, unread inbound and newest inbound age', () => {
  const msgs = [
    { direction: 'in', createdAt: NOW - 1000, readAt: null },
    { direction: 'in', createdAt: NOW - 2 * DAY, readAt: NOW - DAY },
    { direction: 'in', createdAt: NOW - 10 * DAY, readAt: null }, // old but unread still counts
    { direction: 'out', createdAt: NOW - 3 * DAY },
    { direction: 'out', createdAt: NOW - 9 * DAY }, // outside 7d window
  ];
  const b = resolveWaBrief(msgs, NOW);
  assert.equal(b.in7, 2);
  assert.equal(b.out7, 1);
  assert.equal(b.unread, 2);
  assert.equal(b.lastInAt, NOW - 1000);
  assert.ok(b.lastInAgo);
});

test('ops feed is real events newest first, capped at limit', () => {
  const quotes = [
    { id: 'q1', number: 7, customerId: 'c1', createdAt: NOW - 3000, sentAt: NOW - 2000, acceptedAt: NOW - 1000 },
  ];
  const customers = [{ id: 'c1', name: 'Ana', createdAt: NOW - 5000 }];
  const orders = [{ id: 'o1', number: 3, createdAt: NOW - 4000 }];
  const feed = resolveOpsFeed({ quotes, orders, customers, now: NOW });

  assert.deepEqual(feed.map((e) => e.kind), ['won', 'sent', 'quote', 'order', 'cliente']);
  assert.ok(feed[0].text.includes('aceptada'));
  assert.ok(feed.every((e) => e.ago));
  assert.equal(resolveOpsFeed({ quotes, orders, customers, now: NOW, limit: 2 }).length, 2);
});

// ── resolveFollowUps — stalled sent quotes, ranked by money at risk ──────
test('flags only sent quotes gone quiet past staleDays, ranked by value', () => {
  const quotes = [
    { id: 'q1', status: 'sent', sentAt: NOW - 10 * DAY, customerId: 'c1' }, // quiet, big
    { id: 'q2', status: 'sent', sentAt: NOW - 5 * DAY, customerId: 'c2' },  // quiet, small
    { id: 'q3', status: 'sent', sentAt: NOW - 1 * DAY, customerId: 'c3' },  // fresh — excluded
    { id: 'q4', status: 'accepted', sentAt: NOW - 9 * DAY, customerId: 'c4' }, // not sent — excluded
    { id: 'q5', status: 'draft', createdAt: NOW - 9 * DAY }, // not sent — excluded
  ];
  const lines = [line('q1', 1000), line('q2', 100), line('q3', 5000), line('q4', 9000)];
  const { items, count, atRiskUsd } = resolveFollowUps({ quotes, lines, now: NOW });
  assert.deepEqual(items.map((i) => i.id), ['q1', 'q2']); // big money first
  assert.equal(count, 2);
  assert.ok(items[0].valueUsd > items[1].valueUsd);
  assert.equal(Math.round(atRiskUsd), Math.round(items[0].valueUsd + items[1].valueUsd));
  assert.equal(items[0].quietDays, 10);
});

test('recent WhatsApp traffic (by quote or customer) resets the quiet clock', () => {
  const quotes = [
    { id: 'q1', status: 'sent', sentAt: NOW - 10 * DAY, customerId: 'c1' },
    { id: 'q2', status: 'sent', sentAt: NOW - 10 * DAY, customerId: 'c2' },
  ];
  const lines = [line('q1', 500), line('q2', 500)];
  const messages = [
    { id: 'm1', quoteId: 'q1', direction: 'in', createdAt: NOW - 1 * DAY }, // q1 is live
    { id: 'm2', customerId: 'c2', direction: 'out', createdAt: NOW - 20 * DAY }, // older than sent — no help
  ];
  const { items } = resolveFollowUps({ quotes, lines, messages, now: NOW, staleDays: 3 });
  assert.deepEqual(items.map((i) => i.id), ['q2']); // q1 silenced by the recent reply
});

test('empty input is safe', () => {
  assert.deepEqual(resolveFollowUps(), { items: [], count: 0, atRiskUsd: 0 });
});
