/**
 * Tests for the Quotes-list ViewModel summary (src/core/quote/views/lists.js).
 *
 * Money/data invariant: the Shopify-orders-style stat strip on top of the
 * quotes list reads `summary`, and the per-row Total column reads
 * `totalByQuoteId`. These two MUST agree — a card that says a different number
 * than the rows it summarises is a bug. So the pins here assert the cards are
 * exactly the per-row totals re-bucketed, plus the lifecycle bucketing
 * (open = draft/sent, won = accepted/deposit) and the Mías/Equipo scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveQuotesList } from '../src/core/quote/views/lists.js';

// A priced line is just unitPrice × qty (no compound/optional flags), so each
// quote gets a distinct, non-zero grand total we can sum and re-bucket.
function quote(id, status, createdByUserId, extra = {}) {
  return {
    id, status, createdByUserId, customerId: `c-${id}`, updatedAt: 1, ...extra,
  };
}
function line(quoteId, unitPrice) {
  return { id: `l-${quoteId}`, quoteId, unitPrice, qty: 1 };
}

function build() {
  const quotes = [
    quote('a', 'draft', 'u1'),
    quote('b', 'sent', 'u1'),
    quote('c', 'accepted', 'u2'),
    quote('d', 'accepted', 'u2', { depositReceivedAt: 999 }), // → deposito_recibido
    quote('e', 'declined', 'u1'),
    quote('f', 'archived', 'u2'),
  ];
  const lines = [
    line('a', 100), line('b', 200), line('c', 300),
    line('d', 400), line('e', 500), line('f', 600),
  ];
  const customers = quotes.map((q) => ({ id: q.customerId, name: `Cliente ${q.id}` }));
  return { quotes, lines, customers };
}

const BASE = {
  professionals: [], profiles: [], orders: [], containers: [],
  q: '', tab: 'all', filters: {}, sort: { key: 'recent', dir: 'desc' },
};

test('summary money agrees to the cent with the per-row totals (team scope)', () => {
  const { quotes, lines, customers } = build();
  const r = resolveQuotesList({
    ...BASE, quotes, lines, customers, scope: 'team', meId: null,
  });

  // Re-derive the expected sums straight from the row totals the table shows.
  const sumOver = (ids) => ids.reduce((s, id) => s + (r.totalByQuoteId.get(id) || 0), 0);
  const allIds = quotes.map((q) => q.id);

  assert.equal(r.summary.count, 6);
  assert.equal(r.summary.totalValue, sumOver(allIds));
  // open = draft (a) + sent (b)
  assert.equal(r.summary.openCount, 2);
  assert.equal(r.summary.openValue, sumOver(['a', 'b']));
  // won = accepted (c) + deposit (d)
  assert.equal(r.summary.wonCount, 2);
  assert.equal(r.summary.wonValue, sumOver(['c', 'd']));
  // every figure is a positive, finite number (the lines are all priced)
  assert.ok(r.summary.totalValue > r.summary.openValue);
  assert.ok(r.summary.totalValue > r.summary.wonValue);
});

test('summary follows the Mías scope — only the signed-in seller’s quotes count', () => {
  const { quotes, lines, customers } = build();
  const r = resolveQuotesList({
    ...BASE, quotes, lines, customers, scope: 'mine', meId: 'u1',
  });

  // u1 authored a (draft), b (sent), e (declined) → 3 quotes, no wins.
  const sumOver = (ids) => ids.reduce((s, id) => s + (r.totalByQuoteId.get(id) || 0), 0);
  assert.equal(r.summary.count, 3);
  assert.equal(r.summary.totalValue, sumOver(['a', 'b', 'e']));
  assert.equal(r.summary.openCount, 2);
  assert.equal(r.summary.openValue, sumOver(['a', 'b']));
  assert.equal(r.summary.wonCount, 0);
  assert.equal(r.summary.wonValue, 0);
});

test('summary ignores the search/tab filter — it summarises the whole scope', () => {
  const { quotes, lines, customers } = build();
  // Drill into a single-row tab + a search needle; the summary must NOT shrink.
  const r = resolveQuotesList({
    ...BASE, quotes, lines, customers, scope: 'team', meId: null,
    tab: 'draft', q: 'Cliente a',
  });
  assert.equal(r.rows.length, 1); // the filtered table is narrowed…
  assert.equal(r.summary.count, 6); // …but the headline overview is not.
});
