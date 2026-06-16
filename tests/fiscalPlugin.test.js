/**
 * Tests for the FISCAL JURISDICTION PLUGIN seam
 * (src/core/accounting/fiscal/*). This is the backbone of the country-agnostic
 * accounting engine: every DR-specific rule (ITBIS rate, RNC format, e-CF
 * receipt, 606/607/IT-1 filings) lives behind ONE shape so a jurisdiction move
 * (DR -> PR) swaps the plugin, not the engine.
 *
 * The invariant that matters: the DGII plugin satisfies the contract, the
 * registry resolves by country (defaulting to DR), and the contract names a
 * TAX, not "ITBIS" — i.e. a foreign plugin slots into the identical shape. If
 * someone reaches past the seam and hardcodes a jurisdiction, this goes red.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeFiscalPlugin, dgiiPlugin, FISCAL_PLUGINS,
} from '../src/core/accounting/fiscal/index.js';

test('the DGII plugin satisfies the fiscal contract', () => {
  const p = dgiiPlugin;
  assert.equal(p.country, 'DO');
  assert.equal(p.authority, 'DGII');
  assert.equal(typeof p.label, 'string');

  // Tax — ITBIS at 18%, rounded to cents; the rate is overridable.
  assert.equal(p.tax.name, 'ITBIS');
  assert.equal(p.tax.defaultRate, 18);
  assert.equal(p.tax.on(1000), 180);
  assert.equal(p.tax.on(1000, 16), 160);
  assert.equal(p.tax.on(0), 0);

  // Fiscal id — RNC (9 digits) or cédula (11), anything else rejected.
  assert.equal(p.fiscalId.label, 'RNC / Cédula');
  assert.ok(p.fiscalId.isValid('101023122'));      // 9-digit RNC
  assert.ok(p.fiscalId.isValid('001-1234567-8'));  // 11-digit cédula (formatted)
  assert.ok(!p.fiscalId.isValid('123'));
  assert.ok(!p.fiscalId.isValid(null));

  // Receipt — the electronic e-CF, with the 31/32 sale rule.
  assert.ok(p.receipt);
  assert.equal(p.receipt.electronic, true);
  assert.equal(p.receipt.label, 'e-CF');
  assert.equal(p.receipt.typeForSale(true), '31');  // taxpayer -> crédito fiscal
  assert.equal(p.receipt.typeForSale(false), '32'); // consumo
  assert.ok(p.receipt.types.some((t) => t.code === '31'));
  assert.equal(p.receipt.typeLabel('31'), 'Factura de Crédito Fiscal');

  // Filings — 606 / 607 / IT-1 present, each tagged with a kind so a View can
  // route without knowing the code.
  const byCode = new Map(p.reports.map((r) => [r.code, r]));
  for (const c of ['606', '607', 'IT-1']) assert.ok(byCode.has(c), `missing filing ${c}`);
  assert.equal(byCode.get('606').kind, 'purchases');
  assert.equal(byCode.get('607').kind, 'sales');
  assert.equal(byCode.get('IT-1').kind, 'liquidation');
  for (const r of p.reports) {
    assert.equal(typeof r.label, 'string');
    assert.ok(r.to.startsWith('/accounting/'), `${r.code} routes somewhere`);
  }
});

test('activeFiscalPlugin resolves by country and defaults to DR', () => {
  assert.equal(activeFiscalPlugin(null), dgiiPlugin);
  assert.equal(activeFiscalPlugin(undefined), dgiiPlugin);
  assert.equal(activeFiscalPlugin({}), dgiiPlugin);
  assert.equal(activeFiscalPlugin({ fiscalCountry: 'DO' }), dgiiPlugin);
  // An unregistered jurisdiction must not crash — falls back to DR until its
  // plugin ships.
  assert.equal(activeFiscalPlugin({ fiscalCountry: 'PR' }), dgiiPlugin);
  assert.equal(FISCAL_PLUGINS.DO, dgiiPlugin);
});

test('the contract is jurisdiction-neutral — a foreign plugin uses the SAME shape', () => {
  // A hypothetical Puerto Rico plugin (IVU, EIN, no e-CF, Modelo 480). It must
  // assemble from the identical top-level keys; if DGII grew a DR-only field,
  // this drifts and the test flags the leak.
  const prLike = {
    country: 'PR',
    label: 'Puerto Rico',
    authority: 'Hacienda',
    tax: { name: 'IVU', defaultRate: 11.5, on: (b, r = 11.5) => Math.round((b * r)) / 100 },
    fiscalId: { label: 'EIN / SSN', isValid: (v) => !!v },
    receipt: null,
    reports: [{ code: '480.7', label: 'Informativa', description: '—', to: '/accounting/x', kind: 'sales' }],
  };
  assert.deepEqual(Object.keys(prLike).sort(), Object.keys(dgiiPlugin).sort());
  // And a jurisdiction may legitimately have NO fiscal receipt.
  assert.equal(prLike.receipt, null);
});
