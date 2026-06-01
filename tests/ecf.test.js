/**
 * Tests for the e-CF Model — e-NCF formatting/parsing + sequence logic
 * (src/lib/accounting/ecf.ts) and the e-CF payload builder
 * (src/lib/accounting/ecfPayload.ts). Data-integrity: a wrong e-NCF or a payload
 * whose totals don't reconcile is a rejected comprobante.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  padSeq, formatENcf, parseENcf, saleEcfType, sequenceState, pickSequence, ecfTypeLabel,
} from '../src/lib/accounting/ecf.js';
import { buildEcfPayload, formatEcfDate } from '../src/lib/accounting/ecfPayload.js';

/* ------------------------------- e-NCF ---------------------------------- */

test('formatENcf builds the 13-char e-NCF: E + tipo + secuencia(10)', () => {
  assert.equal(formatENcf('31', 1), 'E310000000001');
  assert.equal(formatENcf('32', 5000201), 'E320005000201');
  assert.equal(padSeq(42).length, 10);
});

test('parseENcf round-trips', () => {
  assert.deepEqual(parseENcf('E310000000001'), { type: '31', seq: 1 });
  assert.equal(parseENcf('B0100000001'), null); // legacy NCF, not e-NCF
  assert.equal(parseENcf('garbage'), null);
});

test('saleEcfType: 31 with a fiscal id, 32 without', () => {
  assert.equal(saleEcfType(true), '31');
  assert.equal(saleEcfType(false), '32');
});

test('ecfTypeLabel resolves known types', () => {
  assert.equal(ecfTypeLabel('31'), 'Factura de Crédito Fiscal');
  assert.equal(ecfTypeLabel('32'), 'Factura de Consumo');
});

/* ----------------------------- sequences -------------------------------- */

const NOW = 1_000_000;
const baseSeq = { id: 's1', profileId: 'team', ecfType: '31', seqFrom: 1, seqTo: 100, nextSeq: 1, expiresAt: NOW + 1000, active: true };

test('sequenceState: usable sequence reports the next e-NCF + remaining', () => {
  const st = sequenceState(baseSeq, NOW);
  assert.equal(st.nextENcf, 'E310000000001');
  assert.equal(st.remaining, 100);
  assert.equal(st.expired, false);
  assert.equal(st.exhausted, false);
});

test('sequenceState: expired / exhausted / inactive are unusable', () => {
  assert.equal(sequenceState({ ...baseSeq, expiresAt: NOW - 1 }, NOW).nextENcf, null);
  assert.equal(sequenceState({ ...baseSeq, nextSeq: 101 }, NOW).nextENcf, null);
  assert.equal(sequenceState({ ...baseSeq, active: false }, NOW).nextENcf, null);
});

test('pickSequence chooses the usable range with the lowest next', () => {
  const seqs = [
    { ...baseSeq, id: 'a', nextSeq: 50 },
    { ...baseSeq, id: 'b', nextSeq: 10 },
    { ...baseSeq, id: 'c', ecfType: '32', nextSeq: 1 },
  ];
  assert.equal(pickSequence(seqs, '31', NOW).id, 'b');
  assert.equal(pickSequence(seqs, '32', NOW).id, 'c');
  assert.equal(pickSequence(seqs, '34', NOW), null);
});

/* ------------------------------ payload --------------------------------- */

test('formatEcfDate is dd-mm-yyyy', () => {
  assert.equal(formatEcfDate(Date.UTC(2026, 5, 1, 12)), '01-06-2026');
});

test('buildEcfPayload (31) carries Comprador + reconciled totals', () => {
  const p = buildEcfPayload({
    ecfType: '31', eNcf: 'E310000000001', sequenceExpiresAt: Date.UTC(2026, 11, 31),
    emisor: { rnc: '131996035', name: 'ALCOVER SRL' },
    comprador: { rnc: '101010101', name: 'CLIENTE SRL' },
    items: [{ name: 'Sofá', qty: 1, unitPrice: 10000, amount: 10000 }],
    gravado: 10000, itbis: 1800, total: 11800,
  }).ECF;
  assert.equal(p.Encabezado.IdDoc.eNCF, 'E310000000001');
  assert.equal(p.Encabezado.IdDoc.TipoeCF, '31');
  assert.equal(p.Encabezado.Comprador.RNCComprador, '101010101');
  assert.equal(p.Encabezado.Totales.MontoGravadoTotal, 10000);
  assert.equal(p.Encabezado.Totales.TotalITBIS, 1800);
  assert.equal(p.Encabezado.Totales.MontoTotal, 11800);
  assert.equal(p.DetallesItems.Item.length, 1);
  assert.equal(p.DetallesItems.Item[0].MontoItem, 10000);
});

test('buildEcfPayload (32 consumidor final) omits Comprador', () => {
  const p = buildEcfPayload({
    ecfType: '32', eNcf: 'E320000000001',
    emisor: { rnc: '131996035', name: 'ALCOVER SRL' },
    items: [{ name: 'Mesa', qty: 2, unitPrice: 2500, amount: 5000 }],
    gravado: 5000, itbis: 900, total: 5900,
  }).ECF;
  assert.equal(p.Encabezado.Comprador, undefined);
  assert.equal(p.Encabezado.Totales.MontoTotal, 5900);
});
