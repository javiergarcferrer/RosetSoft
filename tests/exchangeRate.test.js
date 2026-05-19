/**
 * Tests for src/lib/exchangeRate.js.
 *
 * effectiveDopRate routes between bsc-buy / bsc-sell / custom + the
 * legacy bpd-* / market modes. effectiveRates packages that single
 * value into the { USD: 1, DOP } shape that formatMoney + the PDF
 * generator consume.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveDopRate,
  effectiveRates,
  displayRatesFor,
  rateSourceLabel,
  readBscRates,
} from '../src/lib/exchangeRate.js';

/* -------------------------- effectiveDopRate -------------------------- */

test('effectiveDopRate: bsc-sell mode reads bsc.sell', () => {
  const settings = { dopRateMode: 'bsc-sell', bsc: { buy: 60, sell: 62.5 } };
  assert.equal(effectiveDopRate(settings), 62.5);
});

test('effectiveDopRate: bsc-buy mode reads bsc.buy', () => {
  const settings = { dopRateMode: 'bsc-buy', bsc: { buy: 60, sell: 62.5 } };
  assert.equal(effectiveDopRate(settings), 60);
});

test('effectiveDopRate: custom mode reads currencyRates.DOP', () => {
  const settings = { dopRateMode: 'custom', currencyRates: { USD: 1, DOP: 64.25 } };
  assert.equal(effectiveDopRate(settings), 64.25);
});

test('effectiveDopRate: legacy bpd-sell mode resolves to bsc-sell', () => {
  const settings = { dopRateMode: 'bpd-sell', bsc: { buy: 60, sell: 62.5 } };
  assert.equal(effectiveDopRate(settings), 62.5);
});

test('effectiveDopRate: legacy market mode resolves to bsc-sell', () => {
  const settings = { dopRateMode: 'market', bsc: { buy: 60, sell: 62.5 } };
  assert.equal(effectiveDopRate(settings), 62.5);
});

test('effectiveDopRate: falls back to the other side when the requested rate is missing', () => {
  // bsc-buy requested but only sell is set — fall back to sell so we
  // never display 60.0 placeholder when the dealer has real data.
  const settings = { dopRateMode: 'bsc-buy', bsc: { buy: null, sell: 62 } };
  assert.equal(effectiveDopRate(settings), 62);
});

test('effectiveDopRate: defaults to 60.0 when nothing is set', () => {
  assert.equal(effectiveDopRate(null), 60);
  assert.equal(effectiveDopRate({}), 60);
});

test('effectiveDopRate: custom mode with empty currencyRates → 60', () => {
  // The dealer picked "custom" but never typed a value. Don't crash;
  // default to 60 so totals still render.
  assert.equal(effectiveDopRate({ dopRateMode: 'custom' }), 60);
});

/* ---------------------------- effectiveRates ----------------------------- */

test('effectiveRates: always pins USD=1 and pulls DOP from the active mode', () => {
  const settings = { dopRateMode: 'bsc-sell', bsc: { sell: 63 } };
  assert.deepEqual(effectiveRates(settings), { USD: 1, DOP: 63 });
});

test('effectiveRates: switching mode flips the DOP value', () => {
  const buyMode  = { dopRateMode: 'bsc-buy',  bsc: { buy: 60, sell: 64 } };
  const sellMode = { dopRateMode: 'bsc-sell', bsc: { buy: 60, sell: 64 } };
  const custom   = { dopRateMode: 'custom',   currencyRates: { DOP: 70 } };
  assert.equal(effectiveRates(buyMode).DOP,  60);
  assert.equal(effectiveRates(sellMode).DOP, 64);
  assert.equal(effectiveRates(custom).DOP,   70);
});

test('effectiveRates: null settings yields the safe default', () => {
  assert.deepEqual(effectiveRates(null), { USD: 1, DOP: 60 });
});

/* ---------------------------- readBscRates ----------------------------- */

test('readBscRates: prefers bsc, falls back to legacy bpd', () => {
  assert.deepEqual(
    readBscRates({ bsc: { buy: 60, sell: 62, updatedAt: 123 } }),
    { buy: 60, sell: 62, updatedAt: 123 },
  );
  assert.deepEqual(
    readBscRates({ bpd: { buy: 58, sell: 60, updatedAt: 99 } }),
    { buy: 58, sell: 60, updatedAt: 99 },
  );
  assert.deepEqual(readBscRates({}), { buy: null, sell: null, updatedAt: null });
});

/* ---------------------------- displayRatesFor ---------------------------- */

test('displayRatesFor: draft quote → live rates from settings', () => {
  const settings = { dopRateMode: 'bsc-sell', bsc: { sell: 64 } };
  const quote = { status: 'draft', rates: { USD: 1, DOP: 55 } };
  // Live, not snapshot — even though the quote has its own DOP=55, we
  // overlay 64 because the dealer's still working on the quote and
  // the workspace shows 64.
  assert.deepEqual(displayRatesFor(quote, settings), { USD: 1, DOP: 64 });
});

test('displayRatesFor: sent quote → live rates from settings', () => {
  const settings = { dopRateMode: 'custom', currencyRates: { DOP: 70 } };
  const quote = { status: 'sent', rates: { USD: 1, DOP: 55 } };
  assert.deepEqual(displayRatesFor(quote, settings), { USD: 1, DOP: 70 });
});

test('displayRatesFor: accepted quote → snapshot (preserve historical rate)', () => {
  const settings = { dopRateMode: 'bsc-sell', bsc: { sell: 64 } };
  const quote = { status: 'accepted', rates: { USD: 1, DOP: 55 } };
  assert.deepEqual(displayRatesFor(quote, settings), { USD: 1, DOP: 55 });
});

test('displayRatesFor: declined / archived preserve snapshot', () => {
  const settings = { dopRateMode: 'bsc-sell', bsc: { sell: 64 } };
  assert.deepEqual(
    displayRatesFor({ status: 'declined', rates: { DOP: 55 } }, settings),
    { DOP: 55 },
  );
  assert.deepEqual(
    displayRatesFor({ status: 'archived', rates: { DOP: 55 } }, settings),
    { DOP: 55 },
  );
});

test('displayRatesFor: missing quote → safe USD-only default', () => {
  assert.deepEqual(displayRatesFor(null, {}), { USD: 1 });
});

test('displayRatesFor: active quote with no rates snapshot still gets live values', () => {
  const settings = { dopRateMode: 'bsc-sell', bsc: { sell: 64 } };
  assert.deepEqual(
    displayRatesFor({ status: 'draft' }, settings),
    { USD: 1, DOP: 64 },
  );
});

/* --------------------------- rateSourceLabel --------------------------- */

test('rateSourceLabel: returns the dealer-facing string for each mode', () => {
  assert.equal(rateSourceLabel({ dopRateMode: 'bsc-buy' }),  'Banco Santa Cruz — tasa de compra');
  assert.equal(rateSourceLabel({ dopRateMode: 'bsc-sell' }), 'Banco Santa Cruz — tasa de venta');
  assert.equal(rateSourceLabel({ dopRateMode: 'custom' }),   'Tasa personalizada');
  // Unset mode falls through to bsc-sell (the safe retail default).
  assert.equal(rateSourceLabel(null),                         'Banco Santa Cruz — tasa de venta');
});
