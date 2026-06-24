/**
 * Tests for the invoice print Model (src/core/accounting/invoiceDoc.js): the
 * payment-activity timeline + balance, and that a sale with NO e-NCF still
 * produces a printable factura (the bug where Imprimir silently no-op'd on an
 * empty NCF).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInvoiceDoc } from '../src/core/accounting/invoiceDoc.js';

const settings = { companyName: 'ALCOVER SRL', companyRnc: '1-31996035', ecfEnvironment: 'cert' };
const config = { itbisRate: 18 };

test('a sale with no e-NCF still prints a plain factura (no QR, no crash)', () => {
  const doc = resolveInvoiceDoc({
    posting: { id: 'sp1', ncf: '', ecfType: '32', base: 375705, itbis: 67626.9, total: 443331.9, depositApplied: 0, postedAt: 1 },
    customer: { name: 'César Carrasco' }, settings, config,
  });
  assert.equal(doc.isEcf, false);
  assert.equal(doc.eNcf, '');
  assert.equal(doc.docLabel, 'Factura de venta');
  assert.equal(doc.qrUrl, ''); // no timbre without a signed e-CF
  assert.equal(doc.total, 443331.9);
  assert.equal(doc.comprador.name, 'César Carrasco');
});

test('an e-NCF with a security code carries the timbre QR + e-CF label', () => {
  const doc = resolveInvoiceDoc({
    posting: { id: 'sp2', ncf: 'E320000000001', ecfType: '32', base: 1000, itbis: 180, total: 1180, securityCode: 'abc123', postedAt: 1, fechaFirma: '01-06-2026 10:00:00' },
    customer: { name: 'X' }, settings, config,
  });
  assert.equal(doc.isEcf, true);
  assert.match(doc.docLabel, /e-CF 32/);
  assert.match(doc.qrUrl, /codigoseguridad=abc123/);
  assert.equal(doc.fechaFirma, '01-06-2026 10:00:00'); // printed as text in the timbre block
});

test('payment activity: deposit + allocated cobros are dated, summed, and net the balance', () => {
  const doc = resolveInvoiceDoc({
    posting: { id: 'sp3', quoteId: 'q3', ncf: 'E310000000001', ecfType: '31', rnc: '101010101', base: 10000, itbis: 1800, total: 11800, depositApplied: 5000, postedAt: 2000 },
    customer: { name: 'CLIENTE SRL' },
    quote: { number: 42, depositReceivedAt: 1000 },
    payments: [
      { direction: 'in', method: 'card', paidAt: 3000, reference: 'AZUL', allocations: [{ docId: 'sp3', amount: 3000 }] },
      { direction: 'in', method: 'cash', paidAt: 4000, allocations: [{ docId: 'other', amount: 999 }] }, // not this sale
      { direction: 'out', method: 'bank', paidAt: 5000, allocations: [{ docId: 'sp3', amount: 1 }] },    // not a cobro
    ],
    settings, config,
  });
  assert.equal(doc.payments.length, 2); // deposit + the one allocated card cobro
  assert.equal(doc.payments[0].method, 'Depósito');
  assert.equal(doc.payments[0].date, 1000); // dated to the deposit milestone
  assert.equal(doc.payments[1].method, 'Tarjeta');
  assert.equal(doc.amountPaid, 8000);
  assert.equal(doc.balanceDue, 3800);
  assert.equal(doc.items[0].name, 'Venta · cotización #42');
});

test('balance never goes negative when overpaid', () => {
  const doc = resolveInvoiceDoc({
    posting: { id: 'sp4', ncf: '', base: 100, itbis: 18, total: 118, depositApplied: 200, postedAt: 1 },
    settings, config,
  });
  assert.equal(doc.balanceDue, 0);
});
