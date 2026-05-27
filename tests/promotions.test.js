/**
 * Tests for src/lib/promotions.js — the email parser that turns a pasted
 * Ligne Roset promo email into a draft Promotion, plus the activation-window
 * and eligibility helpers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePromotionEmail,
  isPromoActive,
  isPromoExpired,
  lineMatchesPromo,
  suggestEligibleLineIds,
} from '../src/lib/promotions.js';

// A faithful excerpt of the real "Cabinetry & Bedroom Promo" email body.
const EMAIL = `Dear partners,

We are pleased to share with you the marketing materials for our Cabinetry & Bedroom Promo, June 11-23, 2026. This promotion is intended to capture audiences looking to complete their dream bedroom with even more savings.

Registration Code: BED26

Discount:  The promotion will offer a 20% discount, which will be divided evenly between Roset USA and the dealers (10% each), excluding the following is the list of models where the dealer takes the full 20%:
152 - TOGO
14 J - MINI TOGO
172 - MULTY Les Essentiels / First
18D - SAPARELLA
10K - MARECHIARO
10M - CAMMA table in marble
114 - LIGHTING (Guariche)
11B - CLOUDS and CILOS
102 - Samples
99 - Cabinetry samples and touch up pen
ZY - Electrical fittings for cabinetry products

This promotion cannot be combined with the trade or any other discounts and is only valid for new orders. Sales tax and delivery fees are not included.

Best,
Erin Gamboli`;

/* ------------------------------ parsePromotionEmail ------------------------------ */

test('pulls the promo name', () => {
  assert.equal(parsePromotionEmail(EMAIL).name, 'Cabinetry & Bedroom Promo');
});

test('pulls the registration code', () => {
  assert.equal(parsePromotionEmail(EMAIL).code, 'BED26');
});

test('pulls the headline discount', () => {
  assert.equal(parsePromotionEmail(EMAIL).discountPct, 20);
});

test('parses the date window into start/end timestamps', () => {
  const p = parsePromotionEmail(EMAIL);
  const start = new Date(p.startsAt);
  const end = new Date(p.endsAt);
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 5); // June
  assert.equal(start.getDate(), 11);
  assert.equal(end.getMonth(), 5);
  assert.equal(end.getDate(), 23);
  // end is inclusive end-of-day so the promo is active on its last day
  assert.equal(end.getHours(), 23);
  assert.ok(p.endsAt > p.startsAt);
});

test('extracts the dealer-funds-fully model codes', () => {
  const refs = parsePromotionEmail(EMAIL).dealerFullRefs;
  assert.deepEqual(refs, [
    '152', '14 J', '172', '18D', '10K', '10M', '114', '11B', '102', '99', 'ZY',
  ]);
});

test('captures the terms fine print', () => {
  const terms = parsePromotionEmail(EMAIL).terms;
  assert.match(terms, /cannot be combined/i);
  assert.match(terms, /not included\.$/);
});

test('seeds eligible keywords from the name (no stopwords)', () => {
  const kws = parsePromotionEmail(EMAIL).eligibleKeywords;
  assert.deepEqual(kws, ['cabinetry', 'bedroom']);
});

test('decodes HTML-pasted content (entities + block tags)', () => {
  const html = '<p>materials for our Spring &amp; Summer Promo, July 1-15, 2026.</p><p>Registration Code: SUM26</p>';
  const p = parsePromotionEmail(html);
  assert.equal(p.name, 'Spring & Summer Promo');
  assert.equal(p.code, 'SUM26');
  assert.equal(new Date(p.startsAt).getMonth(), 6); // July
});

test('missing fields are simply absent, never throwing', () => {
  const p = parsePromotionEmail('Just a normal email with no promo structure.');
  assert.equal(p.code, undefined);
  assert.equal(p.discountPct, undefined);
  assert.equal(p.dealerFullRefs, undefined);
});

/* ------------------------------ window + eligibility ------------------------------ */

test('isPromoActive respects enabled flag and window', () => {
  const start = new Date(2026, 5, 11).getTime();
  const end = new Date(2026, 5, 23, 23, 59, 59).getTime();
  const promo = { startsAt: start, endsAt: end, isEnabled: true };
  assert.equal(isPromoActive(promo, new Date(2026, 5, 15).getTime()), true);
  assert.equal(isPromoActive(promo, new Date(2026, 5, 1).getTime()), false);  // before
  assert.equal(isPromoActive(promo, new Date(2026, 6, 1).getTime()), false);  // after
  assert.equal(isPromoActive({ ...promo, isEnabled: false }, new Date(2026, 5, 15).getTime()), false);
});

test('isPromoExpired is true only past the end', () => {
  const promo = { endsAt: new Date(2026, 5, 23, 23, 59, 59).getTime() };
  assert.equal(isPromoExpired(promo, new Date(2026, 5, 20).getTime()), false);
  assert.equal(isPromoExpired(promo, new Date(2026, 6, 1).getTime()), true);
});

test('lineMatchesPromo matches by keyword and by excluded-model ref', () => {
  const promo = { eligibleKeywords: ['cabinetry', 'bedroom'], dealerFullRefs: ['152', '14 J'] };
  assert.equal(lineMatchesPromo({ kind: 'item', name: 'Bedroom unit', reference: 'XYZ' }, promo), true);
  assert.equal(lineMatchesPromo({ kind: 'item', name: 'Togo settee', reference: '152' }, promo), true);
  assert.equal(lineMatchesPromo({ kind: 'item', name: 'Dining table', reference: 'ABC' }, promo), false);
  assert.equal(lineMatchesPromo({ kind: 'section', name: 'Bedroom' }, promo), false); // sections never priced
});

test('an empty-rule promo suggests every priced line', () => {
  const promo = {};
  const lines = [
    { id: 'a', kind: 'item', name: 'Sofa' },
    { id: 'b', kind: 'section', name: 'Sala' },
    { id: 'c', kind: 'item', name: 'Chair' },
  ];
  assert.deepEqual(suggestEligibleLineIds(lines, promo), ['a', 'c']);
});
