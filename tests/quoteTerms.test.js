/**
 * Tests for src/lib/quoteTerms.js — the named terms-preset library: the picker
 * projection (which preset is `suggested` for a quote's orderType / `applied`
 * when it equals the quote's terms) and the new-draft prefill precedence
 * (matching preset → legacy quoteTerms → first preset → '').
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_QUOTE_TERMS_PRESETS,
  resolveTermsPresets,
  resolveTermsPresetPicker,
  initialQuoteTerms,
} from '../src/lib/quoteTerms.js';

test('resolveTermsPresets — falls back to defaults when unset/empty/garbage', () => {
  assert.deepEqual(resolveTermsPresets(null), DEFAULT_QUOTE_TERMS_PRESETS);
  assert.deepEqual(resolveTermsPresets({}), DEFAULT_QUOTE_TERMS_PRESETS);
  assert.deepEqual(resolveTermsPresets({ quoteTermsPresets: [] }), DEFAULT_QUOTE_TERMS_PRESETS);
  assert.deepEqual(resolveTermsPresets({ quoteTermsPresets: 'nope' }), DEFAULT_QUOTE_TERMS_PRESETS);
  // Drops malformed entries (missing id/body, null) and keeps the valid one.
  const mixed = { quoteTermsPresets: [{ id: 'a', body: 'A' }, { id: 'b' }, null, { body: 'no id' }] };
  assert.deepEqual(resolveTermsPresets(mixed), [{ id: 'a', body: 'A' }]);
});

test('resolveTermsPresetPicker — flags the orderType match as suggested', () => {
  const settings = { quoteTermsPresets: [
    { id: 'p', label: 'Piso', orderType: 'floor', body: 'PISO' },
    { id: 's', label: 'Especial', orderType: 'special', body: 'ESP' },
    { id: 'x', label: 'Genérico', body: 'GEN' },
  ] };
  assert.deepEqual(
    resolveTermsPresetPicker(settings, { orderType: 'floor', terms: '' }).map((c) => c.suggested),
    [true, false, false],
  );
  assert.deepEqual(
    resolveTermsPresetPicker(settings, { orderType: 'special', terms: '' }).map((c) => c.suggested),
    [false, true, false],
  );
  // An unset orderType defaults to floor.
  assert.equal(resolveTermsPresetPicker(settings, {})[0].suggested, true);
});

test('resolveTermsPresetPicker — flags the applied preset (exact body match, trimmed)', () => {
  const settings = { quoteTermsPresets: [
    { id: 'p', orderType: 'floor', body: 'PISO terms' },
    { id: 's', orderType: 'special', body: 'ESP terms' },
  ] };
  assert.deepEqual(
    resolveTermsPresetPicker(settings, { orderType: 'floor', terms: '  ESP terms  ' }).map((c) => c.applied),
    [false, true],
  );
  // Empty terms ⇒ nothing applied.
  assert.deepEqual(
    resolveTermsPresetPicker(settings, { orderType: 'floor', terms: '' }).map((c) => c.applied),
    [false, false],
  );
});

test('initialQuoteTerms — prefers the orderType match', () => {
  const settings = { quoteTermsPresets: [
    { id: 'p', orderType: 'floor', body: 'PISO' },
    { id: 's', orderType: 'special', body: 'ESP' },
  ] };
  assert.equal(initialQuoteTerms(settings, 'floor'), 'PISO');
  assert.equal(initialQuoteTerms(settings, 'special'), 'ESP');
  // Default orderType is floor.
  assert.equal(initialQuoteTerms(settings), 'PISO');
});

test('initialQuoteTerms — falls back to legacy quoteTerms, then first preset', () => {
  // No orderType match → the legacy single quoteTerms wins.
  const legacy = { quoteTermsPresets: [{ id: 'x', body: 'GEN' }], quoteTerms: 'LEGACY' };
  assert.equal(initialQuoteTerms(legacy, 'special'), 'LEGACY');
  // No match, no legacy → the first preset.
  const firstOnly = { quoteTermsPresets: [{ id: 'x', body: 'GEN' }] };
  assert.equal(initialQuoteTerms(firstOnly, 'special'), 'GEN');
});

test('initialQuoteTerms — empty config uses the default presets', () => {
  assert.equal(initialQuoteTerms(null, 'floor'), DEFAULT_QUOTE_TERMS_PRESETS[0].body);
  assert.equal(initialQuoteTerms(null, 'special'), DEFAULT_QUOTE_TERMS_PRESETS[1].body);
});
