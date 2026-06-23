/**
 * Aprobación / Rechazo Comercial Model (ACECF) — the buyer's commercial accept
 * or reject of an e-CF it RECEIVED, per DGII "Formato Aprobación Comercial v1.0".
 * Two uses: certification step 3 (Pruebas de Datos — Aprobaciones Comerciales),
 * and the runtime "approve a supplier's e-CF we received" action.
 *
 * Mirrors `buildEcfPayload`: it assembles the nested JSON (camelCase, DGII) that
 * the sign/send layer (`dgii-ecf`'s `Transformer.json2xml` → XAdES →
 * `ECF.sendCommercialApproval`) turns into signed XML. The element set + order
 * match the library's `IACECF` (DetalleAprobacionComercial). Pure: no React,
 * no Supabase.
 */
import { formatEcfDate } from './ecfPayload.js';

/** ACECF Estado: 1 = Aprobado, 2 = Rechazado. */
export const ACECF_ESTADO = { APROBADO: 1, RECHAZADO: 2 } as const;

/** DGII datetime: dd-mm-yyyy HH:mm:ss (local components, like formatEcfDate). */
export function formatEcfDateTime(ms: number | null | undefined): string {
  if (ms == null) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface CommercialApprovalInput {
  /** RNC of the e-CF's ISSUER (the supplier whose document we're approving). */
  rncEmisor: string;
  /** The e-NCF being approved/rejected. */
  eNcf: string;
  /** Emission date of that e-CF (ms). */
  fechaEmision: number;
  /** Its total (DOP). */
  montoTotal: number;
  /** Our RNC (the receptor issuing this approval). */
  rncComprador: string;
  /** 1 = aprobado (default), 2 = rechazado. */
  estado?: number;
  /** Required when estado = 2 (rechazado). */
  motivoRechazo?: string;
  /** Preformatted dd-mm-yyyy HH:mm:ss; defaults from `fechaHora`/now. */
  fechaHoraAprobacion?: string;
  /** ms fallback used to format the approval timestamp when no string given. */
  fechaHora?: number;
}

/**
 * Build the ACECF object. REQUIRES both RNCs and the e-NCF, and (when rejecting)
 * a motivo — throws otherwise, so a malformed approval fails at build time, not
 * as a DGII rejection. Field order tracks DGII's DetalleAprobacionComercial.
 */
export function buildCommercialApproval(input: CommercialApprovalInput): Record<string, unknown> {
  const rncEmisor = String(input.rncEmisor || '').replace(/\D/g, '');
  const rncComprador = String(input.rncComprador || '').replace(/\D/g, '');
  const eNcf = String(input.eNcf || '').trim();
  if (!rncEmisor || !rncComprador) {
    throw new Error('La aprobación comercial requiere el RNC del emisor y del comprador.');
  }
  if (!eNcf) throw new Error('La aprobación comercial requiere el e-NCF.');
  const estado = input.estado ?? ACECF_ESTADO.APROBADO;
  if (estado === ACECF_ESTADO.RECHAZADO && !String(input.motivoRechazo || '').trim()) {
    throw new Error('Un rechazo comercial requiere el motivo (DetalleMotivoRechazo).');
  }
  const fechaHora = input.fechaHoraAprobacion || formatEcfDateTime(input.fechaHora ?? Date.now());

  const detalle: Record<string, unknown> = {
    Version: '1.0',
    RNCEmisor: rncEmisor,
    eNCF: eNcf,
    FechaEmision: formatEcfDate(input.fechaEmision),
    MontoTotal: input.montoTotal,
    RNCComprador: rncComprador,
    Estado: estado,
    ...(estado === ACECF_ESTADO.RECHAZADO ? { DetalleMotivoRechazo: String(input.motivoRechazo).trim() } : {}),
    FechaHoraAprobacionComercial: fechaHora,
  };

  return { ACECF: { DetalleAprobacionComercial: detalle } };
}
