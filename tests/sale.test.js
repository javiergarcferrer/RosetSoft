/**
 * Nota de crédito draft — the credited base/ITBIS/total a partial or full
 * credit note posts. Pins that a PARTIAL note prorates the ORIGINAL sale's
 * actual ITBIS (never recomputed at the standard rate), so a tax-exempt sale
 * is never charged fabricated ITBIS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCreditNoteDraft } from '../src/lib/accounting/sale.js';

test('partial credit note prorates the original sale ITBIS (normal 18% sale)', () => {
  const d = resolveCreditNoteDraft({ kind: 'partial', creditedBase: 1000, sale: { base: 2000, itbis: 360 } });
  assert.equal(d.base, 1000);
  assert.equal(d.itbis, 180); // 360 * (1000 / 2000)
  assert.equal(d.total, 1180);
  assert.equal(d.codigoModificacion, 3);
  assert.equal(d.depositToRestore, 0);
});

test('partial credit note on a tax-exempt sale credits ZERO ITBIS (no fabrication)', () => {
  const d = resolveCreditNoteDraft({ kind: 'partial', creditedBase: 500, sale: { base: 1000, itbis: 0 }, itbisRate: 18 });
  assert.equal(d.itbis, 0);
  assert.equal(d.total, 500);
});

test('partial credit note prorates a legacy 16% sale at its own effective rate', () => {
  const d = resolveCreditNoteDraft({ kind: 'partial', creditedBase: 500, sale: { base: 1000, itbis: 160 } });
  assert.equal(d.itbis, 80); // 160 * (500 / 1000), not 500 * 18%
});

test('full cancel copies the sale ITBIS verbatim and restores the deposit', () => {
  const d = resolveCreditNoteDraft({ kind: 'full', sale: { base: 2000, itbis: 360, depositApplied: 500 } });
  assert.equal(d.base, 2000);
  assert.equal(d.itbis, 360);
  assert.equal(d.total, 2360);
  assert.equal(d.depositToRestore, 500);
  assert.equal(d.codigoModificacion, 1);
});

test('partial credit note refuses over-crediting beyond the un-credited balance', () => {
  assert.throws(() => resolveCreditNoteDraft({
    kind: 'partial', creditedBase: 1500, priorCreditedBase: 800, sale: { base: 2000, itbis: 360 },
  }), /excede el saldo/);
});
