/**
 * Tests for src/core/jarvis/command.js — the cross-domain command deck.
 *
 * Pins the two rules that make the obligations strip trustworthy:
 *   - ranking is by urgency tier (danger → warn → info), soonest/biggest first
 *     within a tier, and money is passed through RAW (the View formats it);
 *   - the inbox brief reduces the WhatsApp/IG/scheduler resolver OUTPUTS to the
 *     glance figures + an "oldest waiting first" merged list — it never invents
 *     a count the upstream resolvers didn't already produce.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveObligations, resolveCommsBrief } from '../src/core/jarvis/command.js';

const DAY = 86_400_000;
const NOW = new Date(2026, 5, 17, 12, 0, 0).getTime();

test('filings always show, tone hardens as the deadline nears', () => {
  const deadlines = [
    { code: '607', label: 'Ventas (607)', to: '/x607', kind: 'sales', daysLeft: 9 },   // info (>7)
    { code: '606', label: 'Compras (606)', to: '/x606', kind: 'purchases', daysLeft: 5 }, // warn
    { code: 'IT-1', label: 'ITBIS (IT-1)', to: '/xit1', kind: 'liquidation', daysLeft: 2 }, // danger
  ];
  const { items } = resolveObligations({ deadlines, itbis: { aPagar: 12_400, aFavor: 0 }, now: NOW });
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId['filing-607'].tone, 'info');
  assert.equal(byId['filing-606'].tone, 'warn');
  assert.equal(byId['filing-IT-1'].tone, 'danger');
  // The IT-1 carries the ITBIS actually due, raw + tagged DOP (View formats).
  assert.equal(byId['filing-IT-1'].amount, 12_400);
  assert.equal(byId['filing-IT-1'].currency, 'DOP');
  // 606/607 carry no money.
  assert.equal(byId['filing-607'].amount, null);
  // Danger sorts ahead of warn ahead of info.
  assert.deepEqual(items.map((i) => i.id), ['filing-IT-1', 'filing-606', 'filing-607']);
});

test('e-CF exhaustion is a hard stop; low ≤5 escalates to danger', () => {
  const ecfAlerts = [
    { type: '31', label: 'Factura', kind: 'none' },
    { type: '32', label: 'Consumo', kind: 'low', remaining: 4 },
  ];
  const { items, urgent } = resolveObligations({ ecfAlerts, now: NOW });
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId['ecf-31'].tone, 'danger');
  assert.equal(byId['ecf-32'].tone, 'danger'); // remaining 4 ≤ 5
  assert.equal(urgent, 2);
});

test('receivable +90 is danger and forwards the raw DOP amount', () => {
  const { items } = resolveObligations({ arOverdue: 80_000, now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'ar');
  assert.equal(items[0].tone, 'danger');
  assert.equal(items[0].amount, 80_000);
  assert.equal(items[0].currency, 'DOP');
});

test('operational signals only appear when there is something waiting', () => {
  const quiet = resolveObligations({
    shipments: { alerts: 0 }, followUps: { count: 0, atRiskUsd: 0 },
    comms: { waUnread: 0, igUnread: 0, postsOverdue: 0, nextPostAt: null }, now: NOW,
  });
  assert.equal(quiet.count, 0);

  const busy = resolveObligations({
    shipments: { alerts: 2 },
    followUps: { count: 3, atRiskUsd: 5_000 },
    comms: { waUnread: 4, waOldestWaitingAt: NOW - 2 * DAY, igUnread: 1, postsOverdue: 1, nextPostAt: null },
    now: NOW,
  });
  const byId = Object.fromEntries(busy.items.map((i) => [i.id, i]));
  assert.equal(byId.customs.detail, '2 contenedores +7 d');
  assert.equal(byId.followups.amount, 5_000);
  assert.equal(byId.followups.currency, 'USD');
  // WhatsApp waited > 1 day → warn, not info.
  assert.equal(byId.wa.tone, 'warn');
  assert.equal(byId.posts.tone, 'warn'); // overdue beats a future "next post"
});

test('next-post countdown shows only when nothing is overdue', () => {
  const { items } = resolveObligations({
    comms: { waUnread: 0, igUnread: 0, postsOverdue: 0, nextPostAt: NOW + 3 * 3_600_000 },
    now: NOW,
  });
  const posts = items.find((i) => i.kind === 'posts');
  assert.equal(posts.id, 'posts-next');
  assert.equal(posts.detail, 'en 3 h');
  assert.equal(posts.tone, 'info');
});

// ── resolveCommsBrief — reduce the inbox resolver outputs to a glance ────────
test('comms brief sums unread and merges waiting threads oldest-first', () => {
  const conversations = [
    { key: 'p1', name: 'Ana', unread: 2, awaitingReply: true, lastInboundAt: NOW - 3 * DAY },
    { key: 'p2', name: 'Luis', unread: 0, awaitingReply: false, lastInboundAt: NOW - DAY },
    { key: 'p3', name: 'Sara', unread: 1, awaitingReply: true, lastInboundAt: NOW - 1 * DAY },
  ];
  const igConversations = [
    { threadKey: 't1', username: 'pepe', unread: 3, awaitingReply: true, lastInboundAt: NOW - 5 * DAY },
  ];
  const agenda = { upcoming: [
    { id: 's1', at: NOW - DAY, pending: true },   // overdue
    { id: 's2', at: NOW + 2 * DAY, pending: true }, // future → next
  ] };
  const b = resolveCommsBrief({ conversations, igConversations, agenda, now: NOW });

  assert.equal(b.waUnread, 3);          // 2 + 0 + 1
  assert.equal(b.waWaitingCount, 2);    // Ana + Sara
  assert.equal(b.igUnread, 3);
  assert.equal(b.igWaitingCount, 1);
  assert.equal(b.postsOverdue, 1);
  assert.equal(b.postsUpcoming, 2);
  assert.equal(b.nextPostAt, NOW + 2 * DAY);
  // Oldest waiting first across channels: IG pepe (5d) → Ana (3d) → Sara (1d).
  assert.deepEqual(b.waiting.map((w) => w.id), ['ig-t1', 'wa-p1', 'wa-p3']);
  assert.ok(b.waiting.every((w) => w.ago));
  assert.equal(b.waiting[0].to, '/marketing');
  assert.equal(b.waiting[1].to, '/chats?chat=p1');
});

test('comms brief is safe on empty input', () => {
  const b = resolveCommsBrief();
  assert.equal(b.waUnread, 0);
  assert.equal(b.igUnread, 0);
  assert.equal(b.postsOverdue, 0);
  assert.equal(b.nextPostAt, null);
  assert.deepEqual(b.waiting, []);
});
