/**
 * Tests for the per-line tax Model (src/lib/accounting/taxPresets.ts) — the
 * curated Dominican tax presets and applyLineTaxes(base, taxIds). Pins the math
 * against the reference Odoo bill: base 5 000 + ITBIS 18% + Ret. ITBIS 30% →
 * net 5 630.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyLineTaxes, taxPresetById, DR_TAX_PRESETS } from '../src/lib/accounting/taxPresets.js';

test('applyLineTaxes: ITBIS 18% on the base', () => {
  assert.deepEqual(applyLineTaxes(5000, ['itbis18']), { itbis: 900, retIsr: 0, retItbis: 0 });
});

test('applyLineTaxes: ITBIS 18% + Ret. ITBIS 30% — the reference bill (net 5 630)', () => {
  const base = 5000;
  const r = applyLineTaxes(base, ['itbis18', 'retItbis30']);
  assert.equal(r.itbis, 900);
  assert.equal(r.retItbis, 270);             // 30% of the 900 ITBIS
  assert.equal(r.retIsr, 0);
  assert.equal(base + r.itbis - r.retIsr - r.retItbis, 5630); // Odoo bill total
  assert.equal(r.itbis - r.retItbis, 630);   // net ITBIS shown on the bill
});

test('applyLineTaxes: ITBIS 18% + Ret. ISR 10% + Ret. ITBIS 30% all stack', () => {
  assert.deepEqual(applyLineTaxes(5000, ['itbis18', 'retIsr10', 'retItbis30']),
    { itbis: 900, retIsr: 500, retItbis: 270 });
});

test('applyLineTaxes: exento → no ITBIS', () => {
  assert.deepEqual(applyLineTaxes(5000, ['exento']), { itbis: 0, retIsr: 0, retItbis: 0 });
});

test('applyLineTaxes: Ret. ITBIS 100% (persona física) withholds the whole ITBIS', () => {
  const r = applyLineTaxes(1000, ['itbis18', 'retItbis100']);
  assert.equal(r.itbis, 180);
  assert.equal(r.retItbis, 180);
});

test('applyLineTaxes: a retention with no ITBIS tax withholds nothing', () => {
  assert.deepEqual(applyLineTaxes(5000, ['retItbis30']), { itbis: 0, retIsr: 0, retItbis: 0 });
});

test('applyLineTaxes: unknown / empty ids ignored; base clamped ≥ 0', () => {
  assert.deepEqual(applyLineTaxes(5000, ['nope']), { itbis: 0, retIsr: 0, retItbis: 0 });
  assert.deepEqual(applyLineTaxes(5000, []), { itbis: 0, retIsr: 0, retItbis: 0 });
  assert.deepEqual(applyLineTaxes(5000, null), { itbis: 0, retIsr: 0, retItbis: 0 });
  assert.deepEqual(applyLineTaxes(-100, ['itbis18']), { itbis: 0, retIsr: 0, retItbis: 0 });
});

test('taxPresetById + the curated list shape', () => {
  assert.equal(taxPresetById('itbis18')?.rate, 18);
  assert.equal(taxPresetById('nope'), null);
  assert.ok(DR_TAX_PRESETS.length >= 6);
  for (const t of DR_TAX_PRESETS) assert.ok(['itbis', 'retIsr', 'retItbis'].includes(t.kind));
});
