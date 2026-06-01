/**
 * e-CF payload builder — assembles the e-CF JSON (camelCase, DGII 1.0) that the
 * sign/send layer (`dgii-ecf`'s `json2xml` → XAdES) turns into the signed XML.
 *
 * Targets the two types RosetSoft issues — 31 (crédito fiscal, buyer has RNC)
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
}

export interface EcfPayloadInput {
  ecfType: string;          // '31' | '32'
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
}

/**
 * Build the nested e-CF object. Type 31 carries the Comprador block (buyer's
 * RNC + razón social); type 32 (consumo) omits it unless a name is known.
 */
export function buildEcfPayload(input: EcfPayloadInput): Record<string, unknown> {
  const rate = input.itbisRate ?? 18;
  const encab: Record<string, unknown> = {
    Version: '1.0',
    IdDoc: {
      TipoeCF: input.ecfType,
      eNCF: input.eNcf,
      ...(input.sequenceExpiresAt ? { FechaVencimientoSecuencia: formatEcfDate(input.sequenceExpiresAt) } : {}),
      IndicadorMontoGravado: 0, // prices are net of ITBIS
      TipoIngresos: '01',
      TipoPago: input.tipoPago ?? 1,
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

  // Comprador: required for 31; included for 32 only if we have a buyer.
  const buyerRnc = input.comprador?.rnc?.replace(/\D/g, '') || '';
  if (input.ecfType === '31' || buyerRnc) {
    encab.Comprador = {
      ...(buyerRnc ? { RNCComprador: buyerRnc } : {}),
      ...(input.comprador?.name ? { RazonSocialComprador: input.comprador.name } : {}),
    };
  }

  const items = (input.items || []).map((it, i) => ({
    NumeroLinea: i + 1,
    IndicadorFacturacion: 1, // gravado 18%
    NombreItem: it.name,
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
