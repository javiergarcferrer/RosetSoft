/**
 * e-CF payload builder — assembles the e-CF JSON (camelCase, DGII 1.0) that the
 * sign/send layer (`dgii-ecf`'s `json2xml` → XAdES) turns into the signed XML.
 *
 * Targets the two types AlcoverSoft issues — 31 (crédito fiscal, buyer has RNC)
 * and 32 (consumo) — at the 18% rate (no exempt operations). The exact field
 * set is validated against DGII's TesteCF environment when the cert lands; this
 * is the structurally-complete starting point. Pure: no React, no Supabase.
 */
import { round2 } from './ledger.js';

/** DGII date format: dd-mm-yyyy. */
export function formatEcfDate(ms: number | null | undefined): string {
  if (ms == null) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

export interface EcfItemInput {
  name: string;
  qty: number;
  unitPrice: number;
  /** Line amount (qty × unitPrice), DOP. */
  amount: number;
  /** DGII-required item classifier: 1 = bien (default), 2 = servicio. */
  indicadorBienoServicio?: number;
}

export interface EcfReferenceInput {
  /** The e-NCF this nota de crédito/débito modifies (NCFModificado). */
  ncfModificado: string;
  /** Emission date of the modified e-CF (ms); DGII FechaNCFModificado. */
  fechaNcfModificado?: number | null;
  /**
   * RazónModificación / CodigoModificacion: 1 = anulación total, 2 = corrige
   * texto, 3 = corrige montos, 4 = reemplazo contingencia, 5 = ref. consumo
   * electrónica. A straight cancel is 1; a partial credit is 3.
   */
  codigoModificacion?: number;
  /** RNC of the other contributor, when it differs from the buyer. */
  rncOtroContribuyente?: string;
}

export interface EcfPayloadInput {
  ecfType: string;          // '31' | '32' | '34'
  eNcf: string;             // E31...
  sequenceExpiresAt?: number | null;
  emisor: { rnc: string; name: string; commercialName?: string; address?: string };
  comprador?: { rnc?: string; name?: string } | null;
  items: EcfItemInput[];
  /** Totals in DOP. */
  gravado: number;          // base imponible
  itbis: number;
  total: number;
  itbisRate?: number;       // default 18
  fechaEmision?: number;    // ms; default now
  /** 1 = contado, 2 = crédito. */
  tipoPago?: number;
  /** FechaLimitePago (ms) — DGII-required whenever tipoPago = 2 (crédito). */
  fechaLimitePago?: number | null;
  /**
   * The modified-document reference — REQUIRED for a nota de crédito (34) /
   * débito (33), which exist only to modify a prior e-CF. Omitted for 31/32.
   */
  referencia?: EcfReferenceInput | null;
}

/** e-CF types that modify a prior comprobante and so carry InformacionReferencia. */
const REFERENCING_TYPES = new Set(['33', '34']);

/**
 * Build the nested e-CF object. Type 31 carries the Comprador block (buyer's
 * RNC + razón social) and REQUIRES the buyer's fiscal id — throws without it,
 * so a bad 31 fails at build time, not as a DGII rejection after the e-NCF was
 * burned. Type 32 (consumo) omits the block unless a buyer is known. Types
 * 33/34 (nota de débito/crédito) REQUIRE the InformacionReferencia pointing at
 * the e-NCF they modify — throws without it, same fail-fast rationale.
 */
export function buildEcfPayload(input: EcfPayloadInput): Record<string, unknown> {
  const rate = input.itbisRate ?? 18;
  const buyerRnc = input.comprador?.rnc?.replace(/\D/g, '') || '';
  if (input.ecfType === '31' && !buyerRnc) {
    throw new Error('La factura de crédito fiscal (tipo 31) requiere el RNC/cédula del comprador.');
  }
  const referencing = REFERENCING_TYPES.has(input.ecfType);
  if (referencing && !input.referencia?.ncfModificado) {
    throw new Error('La nota de crédito/débito requiere el e-NCF que modifica (NCFModificado).');
  }
  // A credit sale (TipoPago 2) MUST carry a payment-due date — DGII rejects it
  // otherwise. Fail at build, not as a rejection after the e-NCF is burned.
  const tipoPago = input.tipoPago ?? 1;
  if (tipoPago === 2 && !input.fechaLimitePago) {
    throw new Error('Una venta a crédito (TipoPago 2) requiere la fecha límite de pago (FechaLimitePago).');
  }
  const encab: Record<string, unknown> = {
    Version: '1.0',
    IdDoc: {
      TipoeCF: input.ecfType,
      eNCF: input.eNcf,
      ...(input.sequenceExpiresAt ? { FechaVencimientoSecuencia: formatEcfDate(input.sequenceExpiresAt) } : {}),
      IndicadorMontoGravado: 0, // prices are net of ITBIS
      TipoIngresos: '01',
      TipoPago: tipoPago,
      ...(tipoPago === 2 ? { FechaLimitePago: formatEcfDate(input.fechaLimitePago) } : {}),
    },
    Emisor: {
      RNCEmisor: input.emisor.rnc,
      RazonSocialEmisor: input.emisor.name,
      ...(input.emisor.commercialName ? { NombreComercial: input.emisor.commercialName } : {}),
      ...(input.emisor.address ? { DireccionEmisor: input.emisor.address } : {}),
      FechaEmision: formatEcfDate(input.fechaEmision ?? Date.now()),
    },
    Totales: {
      MontoGravadoTotal: round2(input.gravado),
      MontoGravadoI1: round2(input.gravado),
      ITBIS1: rate,
      TotalITBIS: round2(input.itbis),
      MontoTotal: round2(input.total),
    },
  };

  // Comprador: required for 31 (validated above); included for 32 only if we
  // have a buyer. A 34 crediting a 31 carries the same buyer.
  if (input.ecfType === '31' || buyerRnc) {
    encab.Comprador = {
      ...(buyerRnc ? { RNCComprador: buyerRnc } : {}),
      ...(input.comprador?.name ? { RazonSocialComprador: input.comprador.name } : {}),
    };
  }

  // InformacionReferencia: the modified-document pointer for 33/34.
  if (referencing && input.referencia) {
    encab.InformacionReferencia = {
      NCFModificado: input.referencia.ncfModificado,
      ...(input.referencia.rncOtroContribuyente
        ? { RNCOtroContribuyente: input.referencia.rncOtroContribuyente.replace(/\D/g, '') }
        : {}),
      ...(input.referencia.fechaNcfModificado != null
        ? { FechaNCFModificado: formatEcfDate(input.referencia.fechaNcfModificado) }
        : {}),
      CodigoModificacion: input.referencia.codigoModificacion ?? 1,
    };
  }

  const items = (input.items || []).map((it, i) => ({
    NumeroLinea: i + 1,
    IndicadorFacturacion: 1, // gravado 18%
    NombreItem: it.name,
    // DGII-required classifier; furniture is a good (1), services are 2. Sits
    // between NombreItem and CantidadItem per the e-CF XSD field order.
    IndicadorBienoServicio: it.indicadorBienoServicio ?? 1,
    CantidadItem: it.qty,
    PrecioUnitarioItem: round2(it.unitPrice),
    MontoItem: round2(it.amount),
  }));

  return {
    ECF: {
      Encabezado: encab,
      DetallesItems: { Item: items },
    },
  };
}
