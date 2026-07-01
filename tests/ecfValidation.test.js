/**
 * Tests for the e-CF pre-transmit validator (src/lib/accounting/ecfValidation.ts).
 * Data-integrity: this is the checklist that stops a sale from burning an e-NCF
 * on a comprobante DGII would reject (CA4404). Every check maps to a documented
 * DGII rule; the tests pin the rule, not the wording.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateEcfPayload } from '../src/lib/accounting/ecfValidation.js';

/** A structurally-valid tipo-31 sale: gravado 10000 + 18% ITBIS = 11800. */
function goodCreditFiscal(over = {}) {
  return {
    ecfType: '31',
    eNcf: 'E310000000001',
    emisor: { rnc: '130000001', name: 'AlcoverSoft SRL' },
    comprador: { rnc: '131000002', name: 'Cliente SRL' },
    items: [{ name: 'Sofá Togo', qty: 1, unitPrice: 10000, amount: 10000 }],
    gravado: 10000,
    itbis: 1800,
    total: 11800,
    itbisRate: 18,
    fechaEmision: Date.UTC(2026, 5, 1),
    tipoPago: 1,
    ...over,
  };
}

const codes = (r) => r.issues.map((i) => i.code);

test('a well-formed crédito fiscal passes with no errors', () => {
  const r = validateEcfPayload(goodCreditFiscal());
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('e-NCF type must match the comprobante type', () => {
  const r = validateEcfPayload(goodCreditFiscal({ eNcf: 'E320000000001' }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('ENCF_TIPO_MISMATCH'));
});

test('malformed e-NCF is rejected', () => {
  const r = validateEcfPayload(goodCreditFiscal({ eNcf: 'B0100000001' }));
  assert.ok(codes(r).includes('ENCF_MALFORMED'));
});

test('expired sequence is rejected (CA4404 #5)', () => {
  const r = validateEcfPayload(
    goodCreditFiscal({ sequenceExpiresAt: Date.UTC(2025, 0, 1) }),
    { now: Date.UTC(2026, 5, 1) },
  );
  assert.ok(codes(r).includes('SECUENCIA_VENCIDA'));
});

test('emisor RNC must be 9 digits', () => {
  const r = validateEcfPayload(goodCreditFiscal({ emisor: { rnc: '12345', name: 'X' } }));
  assert.ok(codes(r).includes('EMISOR_RNC_LONGITUD'));
});

test('tipo 31 requires the buyer id', () => {
  const r = validateEcfPayload(goodCreditFiscal({ comprador: null }));
  assert.ok(codes(r).includes('COMPRADOR_ID_FALTA'));
});

test('consumo (32) under RD$250k does NOT require a buyer', () => {
  const r = validateEcfPayload({
    ...goodCreditFiscal(),
    ecfType: '32',
    eNcf: 'E320000000001',
    comprador: null,
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('consumo (32) at/over RD$250k requires a buyer', () => {
  const r = validateEcfPayload({
    ecfType: '32',
    eNcf: 'E320000000001',
    emisor: { rnc: '130000001', name: 'AlcoverSoft SRL' },
    comprador: null,
    items: [{ name: 'Comedor', qty: 1, unitPrice: 250000, amount: 250000 }],
    gravado: 250000,
    itbis: 45000,
    total: 295000,
    itbisRate: 18,
  });
  assert.ok(codes(r).includes('COMPRADOR_ID_FALTA'));
});

test('buyer id must be RNC(9) or cédula(11) length', () => {
  const r = validateEcfPayload(goodCreditFiscal({ comprador: { rnc: '1234567', name: 'X' } }));
  assert.ok(codes(r).includes('COMPRADOR_ID_LONGITUD'));
});

test('nota de crédito requires the modified e-NCF reference', () => {
  const r = validateEcfPayload(goodCreditFiscal({ ecfType: '34', eNcf: 'E340000000001', referencia: null }));
  assert.ok(codes(r).includes('REF_NCF_FALTA'));
});

test('nota de crédito past 30 days must carry no ITBIS (Reglamento 293-11)', () => {
  const original = Date.UTC(2026, 0, 1);
  const late = Date.UTC(2026, 2, 1); // ~59 days later
  const r = validateEcfPayload(
    goodCreditFiscal({
      ecfType: '34',
      eNcf: 'E340000000001',
      referencia: { ncfModificado: 'E310000000009' },
      // still carrying ITBIS → must fail
      gravado: 10000, itbis: 1800, total: 11800,
    }),
    { now: late, originalFechaEmision: original },
  );
  assert.ok(codes(r).includes('NC_ITBIS_30DIAS'));
});

test('nota de crédito within 30 days keeps ITBIS (no 30-day error)', () => {
  const original = Date.UTC(2026, 0, 1);
  const within = Date.UTC(2026, 0, 20);
  const r = validateEcfPayload(
    goodCreditFiscal({
      ecfType: '34', eNcf: 'E340000000001',
      referencia: { ncfModificado: 'E310000000009' },
    }),
    { now: within, originalFechaEmision: original },
  );
  assert.ok(!codes(r).includes('NC_ITBIS_30DIAS'));
});

test('credit sale (TipoPago 2) requires a due date', () => {
  const r = validateEcfPayload(goodCreditFiscal({ tipoPago: 2, fechaLimitePago: null }));
  assert.ok(codes(r).includes('CREDITO_SIN_FECHA'));
});

test('ITBIS that does not match the rate is flagged', () => {
  const r = validateEcfPayload(goodCreditFiscal({ itbis: 1000, total: 11000 }));
  assert.ok(codes(r).includes('ITBIS_NO_CUADRA'));
});

test('total that does not reconcile is flagged', () => {
  const r = validateEcfPayload(goodCreditFiscal({ total: 99999 }));
  assert.ok(codes(r).includes('TOTAL_NO_CUADRA'));
});

test('no line items is an error', () => {
  const r = validateEcfPayload(goodCreditFiscal({ items: [], gravado: 0, itbis: 0, total: 0 }));
  assert.ok(codes(r).includes('SIN_ITEMS'));
});

test('collects MULTIPLE errors at once (not fail-fast)', () => {
  const r = validateEcfPayload({
    ecfType: '31',
    eNcf: 'nonsense',
    emisor: { rnc: '', name: '' },
    comprador: null,
    items: [],
    gravado: 100, itbis: 999, total: 5,
  });
  // e-NCF malformed + emisor rnc + emisor name + buyer missing + no items +
  // ITBIS + total mismatches — well over one.
  assert.ok(r.errors.length >= 5, `expected many errors, got ${r.errors.length}`);
});

test('line amount drift is a warning, not a blocking error', () => {
  const r = validateEcfPayload(goodCreditFiscal({
    items: [{ name: 'Sofá', qty: 2, unitPrice: 10000, amount: 10000 }], // 2×10000 ≠ 10000
  }));
  assert.ok(r.warnings.some((w) => w.code === 'ITEM_MONTO_DRIFT'));
  // the drift alone shouldn't flip ok=false (header totals still reconcile)
  assert.ok(!r.errors.some((e) => e.code === 'ITEM_MONTO_DRIFT'));
});
