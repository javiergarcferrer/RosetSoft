/**
 * Tests for the e-CF Model — e-NCF formatting/parsing + sequence logic
 * (src/lib/accounting/ecf.ts) and the e-CF payload builder
 * (src/lib/accounting/ecfPayload.ts). Data-integrity: a wrong e-NCF or a payload
 * whose totals don't reconcile is a rejected comprobante.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  padSeq, formatENcf, parseENcf, saleEcfType, saleTipoPago, saleDueDate, isValidFiscalId, isCreditNote, parseEcfFechaEmision, consumoRequiresBuyerId, sequenceState, pickSequence, ecfTypeLabel, ecfQrUrl,
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

test('saleTipoPago: contado when the deposit covers the total, else crédito', () => {
  assert.equal(saleTipoPago(11800, 11800), 1); // exactly covered
  assert.equal(saleTipoPago(12000, 11800), 1); // overpaid
  assert.equal(saleTipoPago(5000, 11800), 2);  // balance remains
  assert.equal(saleTipoPago(0, 11800), 2);
});

test('saleDueDate: net-30 from emission', () => {
  assert.equal(saleDueDate(Date.UTC(2026, 5, 1)), Date.UTC(2026, 5, 1) + 30 * 86400000);
});

test('parseEcfFechaEmision pulls FechaEmision (dd-mm-yyyy) out of e-CF XML', () => {
  assert.equal(parseEcfFechaEmision('<Emisor><FechaEmision>15-03-2026</FechaEmision></Emisor>'), new Date(2026, 2, 15).getTime());
  assert.equal(parseEcfFechaEmision('<ns:FechaEmision> 01-06-2026 </ns:FechaEmision>'), new Date(2026, 5, 1).getTime());
  assert.equal(parseEcfFechaEmision('no date here'), null);
  assert.equal(parseEcfFechaEmision(null), null);
});

test('consumoRequiresBuyerId: RD$250,000 is the buyer-ID threshold for a consumo', () => {
  assert.equal(consumoRequiresBuyerId(249999.99), false);
  assert.equal(consumoRequiresBuyerId(250000), true);
  assert.equal(consumoRequiresBuyerId(2349087.95), true);
  assert.equal(consumoRequiresBuyerId(0), false);
});

test('buildEcfPayload (32) THROWS for a RD$250k+ consumo with no buyer — fail at build, not a DGII 400', () => {
  assert.throws(() => buildEcfPayload({
    ecfType: '32', eNcf: 'E320000000001',
    emisor: { rnc: '131996035', name: 'ALCOVER SRL' },
    items: [{ name: 'Sofá', qty: 1, unitPrice: 1990752.5, amount: 1990752.5 }],
    gravado: 1990752.5, itbis: 358335.45, total: 2349087.95,
  }), /250,?000|comprador/i);
});

test('buildEcfPayload (32) UNDER the threshold needs no buyer', () => {
  const p = buildEcfPayload({
    ecfType: '32', eNcf: 'E320000000002',
    emisor: { rnc: '131996035', name: 'ALCOVER SRL' },
    items: [{ name: 'Mesa', qty: 1, unitPrice: 5000, amount: 5000 }],
    gravado: 5000, itbis: 900, total: 5900,
  }).ECF;
  assert.equal(p.Encabezado.Comprador, undefined);
  assert.equal(p.Encabezado.Totales.MontoTotal, 5900);
});

test('isCreditNote: true only for an E34 e-NCF', () => {
  assert.equal(isCreditNote('E340000000001'), true);
  assert.equal(isCreditNote('E310000000001'), false);
  assert.equal(isCreditNote('E320000000001'), false);
  assert.equal(isCreditNote(''), false);
  assert.equal(isCreditNote(null), false);
});

test('saleEcfType: 31 with a fiscal id, 32 without', () => {
  assert.equal(saleEcfType(true), '31');
  assert.equal(saleEcfType(false), '32');
});

test('isValidFiscalId: 9-digit RNC or 11-digit cédula, formatting ignored', () => {
  assert.equal(isValidFiscalId('131996035'), true);        // RNC
  assert.equal(isValidFiscalId('001-1234567-8'), true);    // cédula with dashes
  assert.equal(isValidFiscalId('12345'), false);
  assert.equal(isValidFiscalId(''), false);
  assert.equal(isValidFiscalId(null), false);
});

test('ecfTypeLabel resolves known types', () => {
  assert.equal(ecfTypeLabel('31'), 'Factura de Crédito Fiscal');
  assert.equal(ecfTypeLabel('32'), 'Factura de Consumo');
});

test('ecfQrUrl builds the DGII timbre URL (31 vs 32 path)', () => {
  const u31 = ecfQrUrl({ environment: 'cert', ecfType: '31', rncEmisor: '131996035', eNcf: 'E310000000001', total: 11800, fechaEmision: '01-06-2026', securityCode: 'abc123' });
  assert.match(u31, /certecf\/consultatimbre\?/);
  assert.match(u31, /rncemisor=131996035/);
  assert.match(u31, /encf=E310000000001/);
  assert.match(u31, /codigoseguridad=abc123/);
  const u32 = ecfQrUrl({ environment: 'prod', ecfType: '32', eNcf: 'E320000000001' });
  assert.match(u32, /\/ecf\/consultatimbrefc\?/);
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

test('buildEcfPayload (31) THROWS without the buyer RNC — fail at build, not at the DGII', () => {
  assert.throws(() => buildEcfPayload({
    ecfType: '31', eNcf: 'E310000000001',
    emisor: { rnc: '131996035', name: 'ALCOVER SRL' },
    comprador: null,
    items: [{ name: 'Sofá', qty: 1, unitPrice: 10000, amount: 10000 }],
    gravado: 10000, itbis: 1800, total: 11800,
  }), /RNC/);
});

test('buildEcfPayload (34 nota de crédito) carries InformacionReferencia + CodigoModificacion', () => {
  const p = buildEcfPayload({
    ecfType: '34', eNcf: 'E340000000007',
    emisor: { rnc: '131996035', name: 'ALCOVER SRL' },
    comprador: { rnc: '101010101', name: 'CLIENTE SRL' },
    items: [{ name: 'Anulación venta E310000000001', qty: 1, unitPrice: 10000, amount: 10000 }],
    gravado: 10000, itbis: 1800, total: 11800,
    referencia: { ncfModificado: 'E310000000001', fechaNcfModificado: Date.UTC(2026, 5, 1, 12), codigoModificacion: 1 },
  }).ECF;
  assert.equal(p.Encabezado.IdDoc.TipoeCF, '34');
  // InformacionReferencia is a TOP-LEVEL ECF child (sibling of Encabezado), not nested.
  assert.equal(p.InformacionReferencia.NCFModificado, 'E310000000001');
  assert.equal(p.InformacionReferencia.FechaNCFModificado, '01-06-2026');
  assert.equal(p.InformacionReferencia.CodigoModificacion, 1);
  // The credited buyer rides along just like the original 31.
  assert.equal(p.Encabezado.Comprador.RNCComprador, '101010101');
});

test('buildEcfPayload (34) defaults CodigoModificacion to 1 (anulación total)', () => {
  const p = buildEcfPayload({
    ecfType: '34', eNcf: 'E340000000008',
    emisor: { rnc: '131996035', name: 'ALCOVER SRL' },
    comprador: { rnc: '101010101', name: 'CLIENTE SRL' },
    items: [{ name: 'x', qty: 1, unitPrice: 100, amount: 100 }],
    gravado: 100, itbis: 18, total: 118,
    referencia: { ncfModificado: 'E310000000002' },
  }).ECF;
  assert.equal(p.InformacionReferencia.CodigoModificacion, 1);
});

test('buildEcfPayload (34) THROWS without the modified e-NCF — fail at build, not at the DGII', () => {
  assert.throws(() => buildEcfPayload({
    ecfType: '34', eNcf: 'E340000000009',
    emisor: { rnc: '131996035', name: 'ALCOVER SRL' },
    comprador: { rnc: '101010101', name: 'CLIENTE SRL' },
    items: [{ name: 'x', qty: 1, unitPrice: 100, amount: 100 }],
    gravado: 100, itbis: 18, total: 118,
  }), /NCFModificado/);
});

test('buildEcfPayload (31/32) never emit InformacionReferencia', () => {
  const p31 = buildEcfPayload({
    ecfType: '31', eNcf: 'E310000000001',
    emisor: { rnc: '131996035', name: 'ALCOVER SRL' },
    comprador: { rnc: '101010101', name: 'CLIENTE SRL' },
    items: [{ name: 'x', qty: 1, unitPrice: 100, amount: 100 }],
    gravado: 100, itbis: 18, total: 118,
  }).ECF;
  assert.equal(p31.InformacionReferencia, undefined);
});

test('buildEcfPayload (31) emits the DGII XSD sequence — Comprador BEFORE Totales, Paginacion + TotalITBIS1', () => {
  const ecf = buildEcfPayload({
    ecfType: '31', eNcf: 'E310000000001',
    emisor: { rnc: '131996035', name: 'ALCOVER SRL' },
    comprador: { rnc: '101010101', name: 'CLIENTE SRL' },
    items: [{ name: 'Sofá', qty: 1, unitPrice: 10000, amount: 10000 }],
    gravado: 10000, itbis: 1800, total: 11800,
    sequenceExpiresAt: Date.UTC(2027, 11, 31),
  }).ECF;
  // Encabezado sequence: Version, IdDoc, Emisor, Comprador, Totales — order is
  // load-bearing (DGII rejects a misordered <xs:sequence> as "XML Inválido").
  const enc = Object.keys(ecf.Encabezado);
  assert.ok(enc.indexOf('Comprador') < enc.indexOf('Totales'), 'Comprador must precede Totales');
  assert.deepEqual(enc, ['Version', 'IdDoc', 'Emisor', 'Comprador', 'Totales']);
  // Top-level ECF sequence ends Encabezado → DetallesItems → Paginacion.
  assert.deepEqual(Object.keys(ecf), ['Encabezado', 'DetallesItems', 'Paginacion']);
  assert.equal(ecf.Encabezado.IdDoc.TotalPaginas, 1);
  // ITBIS at rate 1 is required alongside the global TotalITBIS.
  assert.equal(ecf.Encabezado.Totales.TotalITBIS1, 1800);
  // Paginacion subtotals mirror Totales so the per-page cross-check balances.
  assert.equal(ecf.Paginacion.Pagina.MontoSubtotalPagina, 11800);
  assert.equal(ecf.Paginacion.Pagina.SubtotalItbis1Pagina, 1800);
  assert.equal(ecf.Paginacion.Pagina.NoLineaHasta, 1);
});

test('buildEcfPayload carries TipoPago: 1 contado (default), 2 crédito with FechaLimitePago', () => {
  const base = {
    ecfType: '32', eNcf: 'E320000000001',
    emisor: { rnc: '131996035', name: 'ALCOVER SRL' },
    items: [{ name: 'Mesa', qty: 1, unitPrice: 5000, amount: 5000 }],
    gravado: 5000, itbis: 900, total: 5900,
  };
  const contado = buildEcfPayload(base).ECF.Encabezado.IdDoc;
  assert.equal(contado.TipoPago, 1);
  assert.equal(contado.FechaLimitePago, undefined); // contado never carries one
  const credito = buildEcfPayload({ ...base, tipoPago: 2, fechaLimitePago: Date.UTC(2026, 6, 1) }).ECF.Encabezado.IdDoc;
  assert.equal(credito.TipoPago, 2);
  assert.equal(credito.FechaLimitePago, '01-07-2026'); // DGII-required for crédito
});

test('buildEcfPayload (crédito) THROWS without FechaLimitePago — fail at build, not at the DGII', () => {
  assert.throws(() => buildEcfPayload({
    ecfType: '32', eNcf: 'E320000000001',
    emisor: { rnc: '131996035', name: 'ALCOVER SRL' },
    items: [{ name: 'Mesa', qty: 1, unitPrice: 5000, amount: 5000 }],
    gravado: 5000, itbis: 900, total: 5900,
    tipoPago: 2,
  }), /FechaLimitePago|crédito/i);
});

test('buildEcfPayload items carry IndicadorBienoServicio (1=bien default, 2=servicio) in XSD order', () => {
  const p = buildEcfPayload({
    ecfType: '32', eNcf: 'E320000000001',
    emisor: { rnc: '131996035', name: 'ALCOVER SRL' },
    items: [
      { name: 'Sofá', qty: 1, unitPrice: 1000, amount: 1000 },
      { name: 'Instalación', qty: 1, unitPrice: 500, amount: 500, indicadorBienoServicio: 2 },
    ],
    gravado: 1500, itbis: 270, total: 1770,
  }).ECF;
  assert.equal(p.DetallesItems.Item[0].IndicadorBienoServicio, 1); // bien (default)
  assert.equal(p.DetallesItems.Item[1].IndicadorBienoServicio, 2); // servicio
  // XSD order: IndicadorBienoServicio sits between NombreItem and CantidadItem.
  const keys = Object.keys(p.DetallesItems.Item[0]);
  assert.ok(keys.indexOf('IndicadorBienoServicio') > keys.indexOf('NombreItem'));
  assert.ok(keys.indexOf('IndicadorBienoServicio') < keys.indexOf('CantidadItem'));
});
