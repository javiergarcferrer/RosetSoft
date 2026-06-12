/**
 * Tests for the DGII Formato de Envío TXT builders
 * (src/core/accounting/dgiiFormats.js) — the official 606/607 pipe layouts:
 * header line, 23 fields per record, the code mappings, and the 607's
 * per-invoice collection split. These pin the Oficina Virtual file format.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dgii606Txt, dgii607Txt, dgiiPeriod, dgiiTxtFilename, collectionSplit,
} from '../src/core/accounting/dgiiFormats.js';

const D = Date.parse('2026-05-12T12:00:00');

test('dgii606Txt: header + 23 pipe-delimited fields per record', () => {
  const txt = dgii606Txt({
    rncEmisor: '1-31-22334-4', period: '202605',
    rows: [{
      rnc: '101-01010-1', ncf: 'B0100000001', date: D,
      base: 1000, itbis: 180, retIsr: 0, retItbis: 0, tipo606: '02', pay: 'bank',
    }],
  });
  const [head, row] = txt.split('\r\n');
  assert.equal(head, '606|131223344|202605|1');
  const f = row.split('|');
  assert.equal(f.length, 23);
  assert.equal(f[0], '101010101');     // RNC, digits only
  assert.equal(f[1], '1');             // 9 digits → RNC
  assert.equal(f[2], '02');            // tipo bienes/servicios
  assert.equal(f[5], '20260512');      // fecha comprobante AAAAMMDD
  assert.equal(f[6], '20260512');      // fecha pago (paid doc)
  assert.equal(f[7], '1000.00');       // servicios (tipo 02)
  assert.equal(f[8], '0.00');          // bienes
  assert.equal(f[9], '1000.00');       // total
  assert.equal(f[10], '180.00');       // ITBIS facturado
  assert.equal(f[14], '180.00');       // ITBIS por adelantar
  assert.equal(f[22], '2');            // forma de pago: banco
});

test('dgii606Txt: bienes split, retention fields, credit without retention has no fecha pago', () => {
  const txt = dgii606Txt({
    rncEmisor: '131223344', period: '202605',
    rows: [
      { rnc: '00112345678', ncf: 'B02', date: D, base: 1000, itbis: 180, retIsr: 100, retItbis: 54, tipo606: '09', pay: 'credit' },
      { rnc: '101010101', ncf: 'B03', date: D, base: 500, itbis: 90, retIsr: 0, retItbis: 0, tipo606: '10', pay: 'credit' },
    ],
  });
  const [, r1, r2] = txt.split('\r\n');
  const f1 = r1.split('|');
  assert.equal(f1[1], '2');            // 11 digits → cédula
  assert.equal(f1[6], '20260512');     // retention forces fecha pago
  assert.equal(f1[8], '1000.00');      // tipo 09 → bienes column
  assert.equal(f1[11], '54.00');       // ITBIS retenido
  assert.equal(f1[16], '02');          // tipo retención ISR (honorarios)
  assert.equal(f1[17], '100.00');      // monto retención renta
  assert.equal(f1[22], '4');           // compra a crédito
  const f2 = r2.split('|');
  assert.equal(f2[6], '');             // credit, no retention → no fecha pago
});

test('dgii607Txt: header + 23 fields; deposit→cheque column, remainder→crédito', () => {
  const txt = dgii607Txt({
    rncEmisor: '131223344', period: '202605',
    rows: [{
      id: 'sp1', rnc: '101010101', ncf: 'E310000000001', date: D,
      base: 100000, itbis: 18000, total: 118000, depositApplied: 50000,
    }],
  });
  const [head, row] = txt.split('\r\n');
  assert.equal(head, '607|131223344|202605|1');
  const f = row.split('|');
  assert.equal(f.length, 23);
  assert.equal(f[1], '1');             // tipo identificación RNC
  assert.equal(f[4], '1');             // tipo de ingreso: operaciones
  assert.equal(f[7], '100000.00');     // monto facturado
  assert.equal(f[8], '18000.00');      // ITBIS facturado
  assert.equal(f[17], '50000.00');     // depósito → cheque/transferencia
  assert.equal(f[19], '68000.00');     // resto → venta a crédito
});

test('dgii607Txt: consumo sin RNC keeps id fields empty', () => {
  const txt = dgii607Txt({
    rncEmisor: '131223344', period: '202605',
    rows: [{ id: 'sp2', rnc: '', ncf: 'E320000000001', date: D, base: 1000, itbis: 180, total: 1180, depositApplied: 0 }],
  });
  const f = txt.split('\r\n')[1].split('|');
  assert.equal(f[0], '');
  assert.equal(f[1], '');
  assert.equal(f[19], '1180.00'); // all open → venta a crédito
});

test('collectionSplit groups allocated cobros by method and prorates retentions', () => {
  const split = collectionSplit([
    {
      direction: 'in', partyType: 'customer', method: 'card', paidAt: D,
      amount: 10000, itbisRetained: 300, isrRetained: 200,
      allocations: [{ docId: 'a', amount: 7500 }, { docId: 'b', amount: 2500 }],
    },
    { direction: 'in', partyType: 'customer', method: 'cash', paidAt: D, amount: 1000, allocations: [{ docId: 'a', amount: 1000 }] },
    { direction: 'out', partyType: 'supplier', method: 'bank', paidAt: D, amount: 99, allocations: [{ docId: 'a', amount: 99 }] },
  ]);
  const a = split.get('a');
  assert.equal(a.tarjeta, 7500);
  assert.equal(a.efectivo, 1000);
  assert.equal(a.retItbis, 225);  // 300 × 75%
  assert.equal(a.retIsr, 150);    // 200 × 75%
  assert.equal(a.fechaRet, D);
  const b = split.get('b');
  assert.equal(b.tarjeta, 2500);
  assert.equal(b.retItbis, 75);
});

test('607 payment split feeds the retention columns + fecha retención', () => {
  const txt = dgii607Txt({
    rncEmisor: '131223344', period: '202605',
    rows: [{ id: 'a', rnc: '101010101', ncf: 'E31', date: D, base: 10000, itbis: 1800, total: 11800, depositApplied: 0 }],
    payments: [{
      direction: 'in', partyType: 'customer', method: 'card', paidAt: D,
      amount: 11800, itbisRetained: 540, isrRetained: 0,
      allocations: [{ docId: 'a', amount: 11800 }],
    }],
  });
  const f = txt.split('\r\n')[1].split('|');
  assert.equal(f[6], '20260512');    // fecha retención
  assert.equal(f[9], '540.00');      // ITBIS retenido por terceros
  assert.equal(f[18], '11800.00');   // tarjeta
  assert.equal(f[19], '0.00');       // nothing left on credit
});

test('dgiiPeriod + dgiiTxtFilename', () => {
  assert.equal(dgiiPeriod(D), '202605');
  assert.equal(dgiiTxtFilename('606', '1-31-22334-4', '202605'), 'DGII_606_131223344_202605.txt');
});
