/**
 * e-CF Model — comprobante fiscal electrónico (DGII) types, e-NCF formatting,
 * and sequence logic. Pure: no React, no Supabase.
 *
 * An e-NCF is `E` + tipo(2) + secuencia(10) = 13 chars (e.g. E310000000001).
 * Sequences are authorized ranges per type with an expiry; this module formats
 * and validates them. The stateful "assign the next one" lives in
 * `lib/ecfSequence.js` (it touches the db); the rules are here.
 */
import type { ECFSequence } from '../../types/domain.ts';

export interface ECFType { code: string; label: string; }

/** The e-CF types DGII defines. RosetSoft issues 31 (crédito fiscal) and 32
 *  (consumo); the rest are listed for completeness / sequence management. */
export const ECF_TYPES: ECFType[] = [
  { code: '31', label: 'Factura de Crédito Fiscal' },
  { code: '32', label: 'Factura de Consumo' },
  { code: '33', label: 'Nota de Débito' },
  { code: '34', label: 'Nota de Crédito' },
  { code: '41', label: 'Compras' },
  { code: '43', label: 'Gastos Menores' },
  { code: '44', label: 'Regímenes Especiales' },
  { code: '45', label: 'Gubernamental' },
  { code: '46', label: 'Exportaciones' },
  { code: '47', label: 'Pagos al Exterior' },
];

export function ecfTypeLabel(code: string): string {
  return ECF_TYPES.find((t) => t.code === code)?.label || code;
}

/** Zero-pad a sequence to the 10-digit e-NCF field. */
export function padSeq(n: number): string {
  return String(Math.trunc(Number(n) || 0)).padStart(10, '0');
}

/** Build the 13-char e-NCF: `E` + tipo + secuencia(10). */
export function formatENcf(ecfType: string, seq: number): string {
  return `E${ecfType}${padSeq(seq)}`;
}

/** Parse an e-NCF back into `{ type, seq }`, or null if malformed. */
export function parseENcf(eNcf: string | null | undefined): { type: string; seq: number } | null {
  const m = /^E(\d{2})(\d{10})$/.exec(String(eNcf || '').trim().toUpperCase());
  return m ? { type: m[1], seq: Number(m[2]) } : null;
}

/**
 * The e-CF type for a sale: 31 (crédito fiscal) when the buyer is a taxpayer
 * with an RNC/cédula, else 32 (consumo).
 */
export function saleEcfType(hasFiscalId: boolean): string {
  return hasFiscalId ? '31' : '32';
}

/** A well-formed DR fiscal id: RNC (9 digits) or cédula (11 digits). */
export function isValidFiscalId(id: string | null | undefined): boolean {
  const digits = String(id || '').replace(/\D/g, '');
  return digits.length === 9 || digits.length === 11;
}

export interface SequenceState {
  active: boolean;
  expired: boolean;
  exhausted: boolean;
  /** e-NCF that WOULD be issued next (informational), or null if unusable. */
  nextENcf: string | null;
  /** How many remain in the range. */
  remaining: number;
}

/** Inspect a sequence: is it usable, and what's next? */
export function sequenceState(seq: ECFSequence | null | undefined, now: number = Date.now()): SequenceState {
  if (!seq) return { active: false, expired: false, exhausted: true, nextENcf: null, remaining: 0 };
  const expired = seq.expiresAt != null && seq.expiresAt < now;
  const exhausted = Number(seq.nextSeq) > Number(seq.seqTo);
  const usable = !!seq.active && !expired && !exhausted;
  return {
    active: !!seq.active,
    expired,
    exhausted,
    nextENcf: usable ? formatENcf(seq.ecfType, seq.nextSeq) : null,
    remaining: Math.max(0, (Number(seq.seqTo) || 0) - (Number(seq.nextSeq) || 0) + 1),
  };
}

/**
 * Pick the usable sequence for a type from a list (active, not expired, not
 * exhausted) — the one with the lowest `nextSeq` so ranges drain in order.
 */
export function pickSequence(sequences: ECFSequence[] | null | undefined, ecfType: string, now: number = Date.now()): ECFSequence | null {
  return (sequences || [])
    .filter((s) => s.ecfType === ecfType && sequenceState(s, now).nextENcf != null)
    .sort((a, b) => Number(a.nextSeq) - Number(b.nextSeq))[0] || null;
}

const ECF_QR_BASE: Record<string, string> = {
  prod: 'https://ecf.dgii.gov.do/ecf',
  cert: 'https://ecf.dgii.gov.do/certecf',
  dev: 'https://ecf.dgii.gov.do/testecf',
};

/**
 * The DGII "consulta timbre" URL encoded in the e-CF QR. Type 32 (consumo) uses
 * the RFCE path (`consultatimbrefc`). The exact field set is validated against
 * DGII; this builds the standard query.
 */
export function ecfQrUrl({
  environment = 'cert', ecfType = '31', rncEmisor, rncComprador, eNcf,
  total, fechaEmision, fechaFirma, securityCode,
}: {
  environment?: string; ecfType?: string; rncEmisor?: string; rncComprador?: string;
  eNcf?: string; total?: number; fechaEmision?: string; fechaFirma?: string; securityCode?: string;
}): string {
  const base = ECF_QR_BASE[environment] || ECF_QR_BASE.cert;
  const path = ecfType === '32' ? 'consultatimbrefc' : 'consultatimbre';
  const p = new URLSearchParams();
  if (rncEmisor) p.set('rncemisor', rncEmisor);
  if (rncComprador) p.set('rnccomprador', rncComprador);
  if (eNcf) p.set('encf', eNcf);
  if (fechaEmision) p.set('fechaemision', fechaEmision);
  if (total != null) p.set('montototal', String(total));
  if (fechaFirma) p.set('fechafirma', fechaFirma);
  if (securityCode) p.set('codigoseguridad', securityCode);
  return `${base}/${path}?${p.toString()}`;
}
