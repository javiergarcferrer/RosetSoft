/**
 * e-CF pre-transmit validation — the CA4404 checklist as a pure function.
 *
 * DGII rejects an e-CF (and BURNS the e-NCF sequence number) for a fixed set of
 * reasons published as CA4404. `buildEcfPayload` already fail-fasts on a few of
 * them by throwing, but a thrown error stops at the first problem and can't tell
 * the dealer everything that's wrong before they transmit. This validator runs
 * the WHOLE checklist over the sale inputs and returns every issue at once, so
 * Facturación can show a "fix these before enviar" panel instead of discovering
 * rejections one burned e-NCF at a time.
 *
 * Sourced from DGII CA4404 (official rejection list), the e-CF format v1.0
 * tables, and Reglamento 293-11 (the nota-crédito 30-day ITBIS rule). It is
 * deliberately CONSERVATIVE: every check maps to a documented DGII rule, and
 * anything the docs leave ambiguous is a `warning`, never a hard `error`, so the
 * dealer is never blocked by our uncertainty. Pure: no React, no Supabase.
 */
import { round2 } from './ledger.js';
import { parseENcf, isValidFiscalId, CONSUMO_BUYER_ID_THRESHOLD } from './ecf.js';
import type { EcfPayloadInput } from './ecfPayload.js';

export type EcfIssueLevel = 'error' | 'warning';

export interface EcfIssue {
  /** Stable code so the UI can map to a help string / DGII CA4404 item. */
  code: string;
  level: EcfIssueLevel;
  /** Spanish message for the dealer. */
  message: string;
  /** The payload field this concerns, when it maps to one. */
  field?: string;
}

export interface EcfValidationResult {
  ok: boolean;            // no errors (warnings allowed)
  errors: EcfIssue[];
  warnings: EcfIssue[];
  issues: EcfIssue[];     // errors + warnings, in discovery order
}

/** e-CF types whose 2-digit code must match the eNCF type digits. */
const KNOWN_TYPES = new Set(['31', '32', '33', '34', '41', '43', '44', '45', '46', '47']);
const REFERENCING_TYPES = new Set(['33', '34']);
/** Types that always require the buyer's fiscal id (CA4404 buyer rules). */
const BUYER_REQUIRED_TYPES = new Set(['31', '33', '34', '44', '45']);

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Validate a sale's e-CF inputs against the DGII pre-transmit checklist.
 *
 * @param input the same shape `buildEcfPayload` consumes.
 * @param opts.now emission clock (defaults to input.fechaEmision, else Date.now()).
 * @param opts.originalFechaEmision emission ms of the e-CF a 33/34 modifies —
 *   enables the 30-day ITBIS rule for notas de crédito.
 */
export function validateEcfPayload(
  input: EcfPayloadInput,
  opts: { now?: number; originalFechaEmision?: number | null } = {},
): EcfValidationResult {
  const issues: EcfIssue[] = [];
  const err = (code: string, message: string, field?: string) =>
    issues.push({ code, level: 'error', message, field });
  const warn = (code: string, message: string, field?: string) =>
    issues.push({ code, level: 'warning', message, field });

  const type = String(input.ecfType || '').trim();
  const total = Number(input.total) || 0;
  const emisorRnc = String(input.emisor?.rnc || '').replace(/\D/g, '');
  const buyerRnc = String(input.comprador?.rnc || '').replace(/\D/g, '');

  /* --- A. Tipo e-CF & e-NCF (CA4404 #4, #6) ---------------------------- */
  if (!KNOWN_TYPES.has(type)) {
    err('TIPO_ECF_INVALID', `Tipo de e-CF desconocido: "${type}".`, 'ecfType');
  }
  const parsed = parseENcf(input.eNcf);
  if (!parsed) {
    err('ENCF_MALFORMED', `El e-NCF "${input.eNcf}" no tiene el formato E + tipo(2) + secuencia(10).`, 'eNcf');
  } else if (parsed.type !== type) {
    err('ENCF_TIPO_MISMATCH', `El e-NCF es tipo ${parsed.type} pero el comprobante es tipo ${type}.`, 'eNcf');
  } else if (parsed.seq <= 0) {
    err('ENCF_SECUENCIA_CERO', 'La secuencia del e-NCF debe ser mayor que cero.', 'eNcf');
  }
  // Sequence expiry (CA4404 #5): a range whose FechaVencimientoSecuencia has
  // passed is rejected. `sequenceExpiresAt` is the authorized range's expiry.
  const now = opts.now ?? input.fechaEmision ?? Date.now();
  if (input.sequenceExpiresAt != null && input.sequenceExpiresAt < now) {
    err('SECUENCIA_VENCIDA', 'La secuencia autorizada del e-NCF está vencida (FechaVencimientoSecuencia).', 'sequenceExpiresAt');
  }

  /* --- B. Identity / RNC (CA4404 #1 emisor, buyer rules) --------------- */
  if (!emisorRnc) {
    err('EMISOR_RNC_FALTA', 'Falta el RNC del emisor.', 'emisor.rnc');
  } else if (emisorRnc.length !== 9) {
    // The emisor is a juridical taxpayer → 9-digit RNC.
    err('EMISOR_RNC_LONGITUD', `El RNC del emisor debe tener 9 dígitos (tiene ${emisorRnc.length}).`, 'emisor.rnc');
  }
  if (!input.emisor?.name?.trim()) {
    err('EMISOR_RAZON_FALTA', 'Falta la razón social del emisor.', 'emisor.name');
  }

  const buyerRequired = BUYER_REQUIRED_TYPES.has(type)
    || (type === '32' && total >= CONSUMO_BUYER_ID_THRESHOLD);
  if (buyerRequired && !buyerRnc) {
    err(
      'COMPRADOR_ID_FALTA',
      type === '32'
        ? `Una factura de consumo (32) de RD$${CONSUMO_BUYER_ID_THRESHOLD.toLocaleString('es-DO')} o más requiere el RNC/cédula del comprador.`
        : `El tipo ${type} requiere el RNC/cédula del comprador.`,
      'comprador.rnc',
    );
  }
  if (buyerRnc && !isValidFiscalId(buyerRnc)) {
    err('COMPRADOR_ID_LONGITUD', `El RNC/cédula del comprador debe tener 9 (RNC) u 11 (cédula) dígitos (tiene ${buyerRnc.length}).`, 'comprador.rnc');
  }
  if (buyerRnc && buyerRnc === emisorRnc) {
    warn('COMPRADOR_IGUAL_EMISOR', 'El RNC del comprador es igual al del emisor.', 'comprador.rnc');
  }

  /* --- C. Notas de crédito/débito (33/34) reference (CA4404 mandatory) - */
  if (REFERENCING_TYPES.has(type)) {
    const ref = input.referencia;
    if (!ref?.ncfModificado) {
      err('REF_NCF_FALTA', 'La nota de crédito/débito requiere el e-NCF que modifica (NCFModificado).', 'referencia.ncfModificado');
    } else if (!parseENcf(ref.ncfModificado)) {
      err('REF_NCF_MALFORMADO', `El e-NCF modificado "${ref.ncfModificado}" no tiene formato válido.`, 'referencia.ncfModificado');
    }
    // Reglamento 293-11 Arts. 8 & 28: a nota de crédito issued MORE than 30
    // calendar days after the original loses the ITBIS — it must be issued
    // WITHOUT ITBIS. Only checkable when we know the original's emission date.
    if (type === '34' && opts.originalFechaEmision != null) {
      const ageMs = now - opts.originalFechaEmision;
      const itbis = Number(input.itbis) || 0;
      if (ageMs > THIRTY_DAYS_MS && round2(itbis) !== 0) {
        err(
          'NC_ITBIS_30DIAS',
          'La nota de crédito se emite a más de 30 días del comprobante original: el ITBIS ya no es recuperable y debe emitirse sin ITBIS (Reglamento 293-11).',
          'itbis',
        );
      }
    }
  }

  /* --- D. Payment terms (DGII TipoPago rule) --------------------------- */
  const tipoPago = input.tipoPago ?? 1;
  if (tipoPago === 2 && !input.fechaLimitePago) {
    err('CREDITO_SIN_FECHA', 'Una venta a crédito (TipoPago 2) requiere la fecha límite de pago (FechaLimitePago).', 'fechaLimitePago');
  }

  /* --- E. Totals reconciliation (CA4404 #7) --------------------------- */
  const gravado = Number(input.gravado) || 0;
  const itbis = Number(input.itbis) || 0;
  const rate = input.itbisRate ?? 18;
  if (gravado < 0) err('GRAVADO_NEGATIVO', 'El monto gravado no puede ser negativo (las devoluciones van por nota de crédito).', 'gravado');
  if (itbis < 0) err('ITBIS_NEGATIVO', 'El ITBIS no puede ser negativo.', 'itbis');
  if (total < 0) err('TOTAL_NEGATIVO', 'El monto total no puede ser negativo.', 'total');

  // ITBIS must equal base × rate (single-rate operations). Header ITBIS may be
  // a sum of per-line ROUNDED ITBIS, and each line can contribute up to half a
  // cent of legitimate rounding — so the tolerance scales with the line count
  // (1 line → 1 centavo). Beyond that it's a reconciliation failure DGII flags.
  const expectedItbis = round2(gravado * (rate / 100));
  const itbisTol = Math.max(0.01, 0.005 * (input.items || []).length);
  if (Math.abs(round2(itbis) - expectedItbis) > itbisTol) {
    err('ITBIS_NO_CUADRA', `El ITBIS (${round2(itbis)}) no cuadra con ${rate}% del gravado (esperado ${expectedItbis}).`, 'itbis');
  }
  // MontoTotal must equal gravado + ITBIS (no exempt ops in this book).
  const expectedTotal = round2(gravado + itbis);
  if (Math.abs(round2(total) - expectedTotal) > 0.01) {
    err('TOTAL_NO_CUADRA', `El monto total (${round2(total)}) no cuadra con gravado + ITBIS (esperado ${expectedTotal}).`, 'total');
  }

  /* --- F. Items (CA4404 #7 line/header cross-check) -------------------- */
  const items = input.items || [];
  if (items.length === 0) {
    err('SIN_ITEMS', 'El comprobante no tiene líneas de detalle.', 'items');
  }
  let lineSum = 0;
  items.forEach((it, i) => {
    const n = i + 1;
    if (!it.name?.trim()) err('ITEM_SIN_NOMBRE', `La línea ${n} no tiene descripción.`, `items[${i}].name`);
    const qty = Number(it.qty) || 0;
    if (qty <= 0) err('ITEM_CANTIDAD', `La línea ${n} tiene cantidad inválida (${it.qty}).`, `items[${i}].qty`);
    const amount = Number(it.amount) || 0;
    if (amount < 0) err('ITEM_MONTO_NEG', `La línea ${n} tiene monto negativo.`, `items[${i}].amount`);
    // Line amount should equal qty × unitPrice (2-decimal). Warn (not error):
    // legitimate global discounts can make this drift and DGII tolerates it at
    // the header level, so we don't hard-block.
    const expected = round2(qty * (Number(it.unitPrice) || 0));
    if (Math.abs(round2(amount) - expected) > 0.01) {
      warn('ITEM_MONTO_DRIFT', `La línea ${n}: monto ${round2(amount)} ≠ cantidad × precio (${expected}).`, `items[${i}].amount`);
    }
    lineSum += amount;
  });
  // The sum of lines should reconcile with the declared gravado base (net of
  // ITBIS since IndicadorMontoGravado = 0). Warn — global discounts/charges can
  // legitimately separate the two, and the header totals are authoritative.
  if (items.length > 0 && Math.abs(round2(lineSum) - gravado) > 0.01) {
    warn('LINEAS_VS_GRAVADO', `La suma de líneas (${round2(lineSum)}) no coincide con el gravado declarado (${gravado}).`, 'items');
  }

  const errors = issues.filter((x) => x.level === 'error');
  const warnings = issues.filter((x) => x.level === 'warning');
  return { ok: errors.length === 0, errors, warnings, issues };
}
