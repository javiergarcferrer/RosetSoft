// DGII "Formato de Envío" builders — the official pipe-delimited TXT the
// Oficina Virtual accepts for the 606 (compras) and 607 (ventas), per the DGII
// instructivos (Norma 07-18 layouts, 23 fields each, AAAAMMDD dates, point
// decimals). The projections (resolve606 / resolveSales607) carry the data;
// this module only formats. Pure: no React, no db.
import { round2 } from '../../lib/accounting/ledger.js';

/** Strip a fiscal id to bare digits (the TXT carries no dashes). */
function digits(v) {
  return String(v || '').replace(/\D/g, '');
}

/** DGII "Tipo Id": 1 = RNC (9 digits), 2 = cédula (11). 607 also allows 3 =
 *  pasaporte/ID tributaria (any other non-empty id). Empty id ⇒ ''. */
function tipoId(rnc, { allowPassport = false } = {}) {
  const d = digits(rnc);
  if (d.length === 9) return '1';
  if (d.length === 11) return '2';
  if (allowPassport && String(rnc || '').trim()) return '3';
  return '';
}

/** AAAAMMDD (local time), or '' when there's no date. */
function ymd8(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** Money field: two decimals, point separator, no thousands marks. */
function amt(n) {
  return round2(n).toFixed(2);
}

/** AAAAMM period for a window end (the month being reported). */
export function dgiiPeriod(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** "Forma de Pago" (606 casilla 23) from the doc's payment method. */
const FORMA_PAGO_606 = { cash: '1', bank: '2', card: '3', credit: '4' };

/**
 * Formato 606 TXT. `rows` are resolve606 rows (rnc/ncf/date/base/itbis/
 * retIsr/retItbis/tipo606/pay). Layout (header + 23 fields per record):
 *   606|RNC emisor|AAAAMM|cantidad
 *   RNC | TipoId | TipoBienesServicios | NCF | NCF modificado |
 *   FechaComprobante | FechaPago | MontoServicios | MontoBienes | TotalMonto |
 *   ITBIS Facturado | ITBIS Retenido | ITBIS Proporcionalidad | ITBIS al Costo |
 *   ITBIS por Adelantar | ITBIS Percibido | TipoRetencionISR | MontoRetencionRenta |
 *   ISR Percibido | Selectivo | OtrosImpuestos | PropinaLegal | FormaPago
 * Defaults the data can't know: servicios vs. bienes split follows tipo606
 * (09/10 ⇒ bienes), retention type defaults to 02 (honorarios por servicios),
 * fecha de pago = doc date for paid docs (blank for credit without retention).
 */
export function dgii606Txt({ rows, rncEmisor, period } = {}) {
  const list = rows || [];
  const out = [`606|${digits(rncEmisor)}|${period}|${list.length}`];
  for (const r of list) {
    const isBienes = r.tipo606 === '09' || r.tipo606 === '10';
    const hasRetention = (r.retIsr || 0) > 0 || (r.retItbis || 0) > 0;
    const fechaPago = r.pay !== 'credit' || hasRetention ? ymd8(r.date) : '';
    out.push([
      digits(r.rnc),                       // 1  RNC o Cédula
      tipoId(r.rnc),                       // 2  Tipo Id
      r.tipo606 || '02',                   // 3  Tipo de bienes y servicios
      r.ncf || '',                         // 4  NCF
      '',                                  // 5  NCF o documento modificado
      ymd8(r.date),                        // 6  Fecha comprobante
      fechaPago,                           // 7  Fecha pago
      isBienes ? amt(0) : amt(r.base),     // 8  Monto facturado en servicios
      isBienes ? amt(r.base) : amt(0),     // 9  Monto facturado en bienes
      amt(r.base),                         // 10 Total monto facturado
      amt(r.itbis),                        // 11 ITBIS facturado
      amt(r.retItbis),                     // 12 ITBIS retenido
      amt(0),                              // 13 ITBIS sujeto a proporcionalidad
      amt(0),                              // 14 ITBIS llevado al costo
      amt(r.itbis),                        // 15 ITBIS por adelantar
      '',                                  // 16 ITBIS percibido (no habilitado)
      (r.retIsr || 0) > 0 ? '02' : '',     // 17 Tipo retención ISR
      amt(r.retIsr),                       // 18 Monto retención renta
      '',                                  // 19 ISR percibido (no habilitado)
      amt(0),                              // 20 Impuesto selectivo al consumo
      amt(0),                              // 21 Otros impuestos/tasas
      amt(0),                              // 22 Monto propina legal
      FORMA_PAGO_606[r.pay] || '2',        // 23 Forma de pago
    ].join('|'));
  }
  return out.join('\r\n');
}

/**
 * Per-invoice collection split for the 607's payment columns, from the cobros'
 * invoice allocations. A payment's retention figures prorate by allocation
 * share. Returns Map<postingId, {efectivo, cheque, tarjeta, retItbis, retIsr,
 * fechaRet}>.
 */
export function collectionSplit(payments) {
  const map = new Map();
  const ensure = (id) => {
    if (!map.has(id)) map.set(id, { efectivo: 0, cheque: 0, tarjeta: 0, retItbis: 0, retIsr: 0, fechaRet: null });
    return map.get(id);
  };
  for (const p of payments || []) {
    if (p.direction !== 'in' || p.partyType !== 'customer') continue;
    const allocs = p.allocations || [];
    const allocTotal = allocs.reduce((s, a) => s + (Number(a.amount) || 0), 0);
    for (const a of allocs) {
      const amount = Number(a.amount) || 0;
      if (!a.docId || amount <= 0) continue;
      const slot = ensure(a.docId);
      if (p.method === 'cash') slot.efectivo = round2(slot.efectivo + amount);
      else if (p.method === 'card') slot.tarjeta = round2(slot.tarjeta + amount);
      else slot.cheque = round2(slot.cheque + amount);
      const share = allocTotal > 0 ? amount / allocTotal : 0;
      const retI = round2((Number(p.itbisRetained) || 0) * share);
      const retR = round2((Number(p.isrRetained) || 0) * share);
      if (retI > 0) slot.retItbis = round2(slot.retItbis + retI);
      if (retR > 0) slot.retIsr = round2(slot.retIsr + retR);
      if ((retI > 0 || retR > 0) && !slot.fechaRet) slot.fechaRet = p.paidAt || null;
    }
  }
  return map;
}

/**
 * Formato 607 TXT. `rows` are resolveSales607 rows; `payments` (optional)
 * fills the payment-form columns from each invoice's allocated cobros. Layout
 * (header + 23 fields per record):
 *   607|RNC emisor|AAAAMM|cantidad
 *   RNC | TipoId | NCF | NCF modificado | TipoIngreso | FechaComprobante |
 *   FechaRetencion | MontoFacturado | ITBIS Facturado | ITBIS RetenidoTerceros |
 *   ITBIS Percibido | RetencionRentaTerceros | ISR Percibido | Selectivo |
 *   OtrosImpuestos | PropinaLegal | Efectivo | Cheque/Transf | Tarjeta |
 *   VentaCredito | Bonos | Permuta | OtrasFormas
 * Defaults: tipo de ingreso 1 (operaciones); the deposit applied at invoicing
 * (collected before the cobros module sees it) reports as cheque/transferencia
 * — the house's deposit channel; the uncollected remainder as venta a crédito.
 */
export function dgii607Txt({ rows, payments, rncEmisor, period } = {}) {
  const list = rows || [];
  const split = collectionSplit(payments);
  const out = [`607|${digits(rncEmisor)}|${period}|${list.length}`];
  for (const r of list) {
    const s = split.get(r.id) || { efectivo: 0, cheque: 0, tarjeta: 0, retItbis: 0, retIsr: 0, fechaRet: null };
    const deposit = round2(r.depositApplied || 0);
    const collected = round2(s.efectivo + s.cheque + s.tarjeta + deposit);
    const credito = round2(Math.max(0, (r.total || 0) - collected));
    out.push([
      digits(r.rnc),                          // 1  RNC/Cédula/Pasaporte
      tipoId(r.rnc, { allowPassport: true }), // 2  Tipo identificación
      r.ncf || '',                            // 3  NCF
      r.modifiesNcf || '',                    // 4  NCF modificado (nota de crédito E34)
      '1',                                    // 5  Tipo de ingreso (operaciones)
      ymd8(r.date),                           // 6  Fecha comprobante
      ymd8(s.fechaRet),                       // 7  Fecha retención
      amt(r.base),                            // 8  Monto facturado
      amt(r.itbis),                           // 9  ITBIS facturado
      amt(s.retItbis),                        // 10 ITBIS retenido por terceros
      '',                                     // 11 ITBIS percibido (no habilitado)
      amt(s.retIsr),                          // 12 Retención renta por terceros
      '',                                     // 13 ISR percibido (no habilitado)
      amt(0),                                 // 14 Impuesto selectivo al consumo
      amt(0),                                 // 15 Otros impuestos/tasas
      amt(0),                                 // 16 Monto propina legal
      amt(s.efectivo),                        // 17 Efectivo
      amt(round2(s.cheque + deposit)),        // 18 Cheque/transferencia/depósito
      amt(s.tarjeta),                         // 19 Tarjeta débito/crédito
      amt(credito),                           // 20 Venta a crédito
      amt(0),                                 // 21 Bonos o certificados de regalo
      amt(0),                                 // 22 Permuta
      amt(0),                                 // 23 Otras formas de ventas
    ].join('|'));
  }
  return out.join('\r\n');
}

/** Standard download name, e.g. DGII_606_131223344_202605.txt */
export function dgiiTxtFilename(formato, rncEmisor, period) {
  return `DGII_${formato}_${digits(rncEmisor)}_${period}.txt`;
}
