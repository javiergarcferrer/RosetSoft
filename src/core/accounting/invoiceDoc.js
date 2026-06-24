/**
 * Invoice print Model — assembles everything the InvoiceDocument PDF renders for
 * one posted sale, so the View just hands the result to `generateInvoicePdf`.
 *
 * Handles BOTH a signed e-CF (carries the DGII timbre QR) AND a plain sale with
 * no e-NCF (a sale is still a sale — it prints a factura, just without the QR).
 * Crucially it builds the PAYMENT ACTIVITY: the deposit applied at posting plus
 * every cobro allocated to this sale, dated and sorted, with the running balance
 * — that's what makes it a real invoice rather than a bare total.
 *
 * Pure: no React, no Supabase, no pdf-lib.
 */
import { round2 } from '../../lib/accounting/ledger.js';
import { parseENcf, ecfQrUrl, ecfTypeLabel } from '../../lib/accounting/ecf.js';
import { formatEcfDate } from '../../lib/accounting/ecfPayload.js';
import { montoEnLetras } from '../../lib/numeroEnLetras.js';

const PAYMENT_METHOD_LABELS = { cash: 'Efectivo', bank: 'Transferencia', card: 'Tarjeta', credit: 'Crédito' };
const digits = (s) => String(s || '').replace(/\D/g, '');

/**
 * @returns the InvoiceDocument props (minus the rasterized QR, which
 *   `generate.tsx` builds from `qrUrl`).
 */
export function resolveInvoiceDoc({ posting, customer, quote, payments = [], settings, config, environment } = {}) {
  const p = posting || {};
  const ncf = p.ncf || '';
  const isEcf = !!parseENcf(ncf);
  const ecfType = p.ecfType || '';
  const buyerRnc = digits(p.rnc);
  const base = round2(p.base || 0);
  const itbis = round2(p.itbis || 0);
  const total = round2(p.total || 0);

  // Payment activity: the deposit applied at posting (dated to when the deposit
  // milestone was marked, falling back to the posting date) plus every inbound
  // cobro that allocates to THIS sale (by posting id, or the quote it came from).
  const docIds = new Set([p.id, p.quoteId].filter(Boolean));
  const activity = [];
  const depositApplied = round2(p.depositApplied || 0);
  if (depositApplied > 0) {
    activity.push({
      date: quote?.depositReceivedAt || p.postedAt || null,
      method: 'Depósito', reference: '', amount: depositApplied,
    });
  }
  for (const pm of payments || []) {
    if (pm?.direction !== 'in') continue;
    const allocated = (pm.allocations || [])
      .filter((a) => docIds.has(a.docId))
      .reduce((s, a) => s + (Number(a.amount) || 0), 0);
    if (allocated > 0) {
      activity.push({
        date: pm.paidAt || null,
        method: PAYMENT_METHOD_LABELS[pm.method] || pm.method || 'Pago',
        reference: pm.reference || '', amount: round2(allocated),
      });
    }
  }
  activity.sort((a, b) => (a.date || 0) - (b.date || 0));
  const amountPaid = round2(activity.reduce((s, a) => s + a.amount, 0));
  const balanceDue = round2(Math.max(0, total - amountPaid));

  const docLabel = isEcf
    ? `${ecfTypeLabel(ecfType)} (e-CF ${ecfType})`
    : (ncf ? `Factura · NCF ${ncf}` : 'Factura de venta');

  const emisorRnc = digits(settings?.companyRnc);
  return {
    emisor: {
      name: settings?.companyName || '', rnc: emisorRnc,
      address: settings?.companyAddress, phone: settings?.companyPhone, email: settings?.companyEmail,
    },
    comprador: { name: customer?.name, rnc: buyerRnc },
    ecfType: ecfType || '32',
    eNcf: ncf,
    isEcf,
    docLabel,
    fechaEmision: p.postedAt,
    items: [{
      name: `Venta${quote?.number ? ` · cotización #${quote.number}` : ''}`,
      qty: 1, unitPrice: base, amount: base,
    }],
    gravado: base, itbis, total, itbisRate: config?.itbisRate ?? 18,
    totalEnLetras: montoEnLetras(total),
    securityCode: p.securityCode || '',
    fechaFirma: p.fechaFirma || '',
    payments: activity, amountPaid, balanceDue,
    // The DGII timbre QR is only meaningful for a signed e-CF.
    qrUrl: (isEcf && p.securityCode)
      ? ecfQrUrl({
        environment: environment || settings?.ecfEnvironment || 'cert',
        ecfType: ecfType || '31', rncEmisor: emisorRnc, rncComprador: buyerRnc,
        eNcf: ncf, total, fechaEmision: formatEcfDate(p.postedAt),
        fechaFirma: p.fechaFirma || '', securityCode: p.securityCode,
      })
      : '',
  };
}
