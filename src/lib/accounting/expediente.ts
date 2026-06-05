/**
 * Import-EXPEDIENTE Model — lands a whole shipment (one BL) at its real RD cost.
 *
 * Where `importLiquidation` handles a single article, an expediente carries the
 * shipment's product LINES (each with a CIF value) plus an itemized COST SHEET
 * (agenciamiento, transporte, puerto, tasa DGA, seguro, almacenaje…). For every
 * cost the NET (`amount − itbis`) capitalizes into the landed cost — prorated
 * across the lines by CIF value — while the ITBIS portions are recoverable input
 * credit. A cost carrying a DR supplier + NCF lands in the 606.
 *
 *   Debit  Inventario          landedTotal = cif + duty + Σ(cost.net)
 *   Debit  ITBIS adelantado     importItbis + Σ(cost.itbis)
 *   Credit Mercancía en tránsito  cif        (clears the in-transit goods)
 *   Credit <bank|caja>            duty + importItbis   (aduanas)
 *   Credit <CxP|bank|caja>        cost.amount          (one per cost line)
 *
 * The caller records a kardex IN per line at its landed unit cost
 * (`allocateExpediente`). Pure: no React, no Supabase.
 */
import { round2, buildJournalEntry, type DraftLine } from './ledger.js';
import { requireAccount, type ResolvedAccountingConfig } from './config.js';
import { computeImportTaxes, allocateShipment, type ShipmentAllocation } from './importLiquidation.js';
import type { ImportExpediente, ImportCost, JournalEntry, JournalLine, PaymentMethod } from '../../types/domain.ts';

/** The preset cost concepts an expediente itemizes. `otro` covers anything else. */
export const COST_CONCEPTS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'agenciamiento', label: 'Agenciamiento aduanal' },
  { key: 'transporte', label: 'Transporte terrestre' },
  { key: 'puerto', label: 'Puerto / manejo (Caucedo)' },
  { key: 'tasaDga', label: 'Tasa / servicio DGA' },
  { key: 'almacenaje', label: 'Almacenaje' },
  { key: 'seguro', label: 'Seguro' },
  { key: 'otro', label: 'Otro' },
];

/** Display name for a cost line — its free-text label, else the concept's name. */
export function costLabel(c: ImportCost): string {
  if (c?.label?.trim()) return c.label.trim();
  return COST_CONCEPTS.find((x) => x.key === c?.concept)?.label || c?.concept || 'Costo';
}

/** Map a payment method to the chart role that settles it. */
function payRole(method: PaymentMethod | undefined | null): string {
  if (method === 'credit') return 'accountsPayable';
  if (method === 'cash') return 'cash';
  return 'bank';
}

/**
 * Totals over the cost sheet: `gross` = Σ amount, `itbis` = Σ recoverable ITBIS,
 * `net` = Σ (amount − itbis) = what capitalizes. Each addend is rounded to cents
 * so `net + itbis === gross` exactly (money inputs are 2-dp) and the asiento
 * cannot drift off-balance.
 */
export function expedienteCostTotals(costs: readonly ImportCost[] | null | undefined): { gross: number; itbis: number; net: number } {
  let gross = 0;
  let itbis = 0;
  let net = 0;
  for (const c of costs || []) {
    const a = round2(c?.amount || 0);
    const t = round2(c?.itbis || 0);
    gross = round2(gross + a);
    itbis = round2(itbis + t);
    net = round2(net + round2(a - t));
  }
  return { gross, itbis, net };
}

/** Capitalized landed total = CIF + gravamen + Σ(cost net). Excludes recoverable ITBIS. */
export function expedienteLanded(e: Pick<ImportExpediente, 'cif' | 'duty' | 'costs'>): number {
  return round2(round2(e.cif) + round2(e.duty) + expedienteCostTotals(e.costs).net);
}

/** All recoverable input ITBIS = import ITBIS + Σ(service ITBIS). */
export function expedienteCreditableItbis(e: Pick<ImportExpediente, 'importItbis' | 'costs'>): number {
  return round2(round2(e.importItbis) + expedienteCostTotals(e.costs).itbis);
}

/**
 * Does the entered gravamen / import ITBIS match what the rates (20% / 18% by
 * config) would compute from the CIF? Surfaced as a verification banner — a
 * mismatch usually means the goods' HS arancel isn't the default rate.
 */
export function expedienteTaxCheck({ cif, duty, importItbis, config }: {
  cif: number; duty: number; importItbis: number; config: ResolvedAccountingConfig;
}): { computed: { duty: number; importItbis: number }; dutyDiff: number; itbisDiff: number; matches: boolean } {
  const computed = computeImportTaxes({ cif: round2(cif), config });
  const dutyDiff = round2(round2(duty) - computed.duty);
  const itbisDiff = round2(round2(importItbis) - computed.importItbis);
  return { computed, dutyDiff, itbisDiff, matches: Math.abs(dutyDiff) < 0.5 && Math.abs(itbisDiff) < 0.5 };
}

/**
 * Prorate the capitalizable extras (gravamen + Σ cost nets) across the product
 * lines by CIF value, yielding a landed unit cost per line for the kardex.
 * Reuses `allocateShipment` (CIF value = weight; rounding drift → last line), so
 * the per-line and whole-expediente costs reconcile to the cent.
 */
export function allocateExpediente(e: Pick<ImportExpediente, 'duty' | 'importItbis' | 'costs' | 'lines'>): ShipmentAllocation<ImportExpediente['lines'][number] & { quantity: number; unitCostUsd: number }> {
  const { net } = expedienteCostTotals(e.costs);
  const adapted = (e.lines || []).map((l) => {
    const qty = Number(l.qty) || 0;
    return { ...l, quantity: qty, unitCostUsd: qty > 0 ? (Number(l.cifValue) || 0) / qty : 0 };
  });
  return allocateShipment(adapted, { duty: round2(e.duty), otherCosts: net, importItbis: round2(e.importItbis) });
}

/**
 * Build the single balanced asiento for an expediente. CIF clears from
 * Mercancía en tránsito into Inventario (the foreign purchase was booked there
 * when the supplier was paid — confirm this with your advisor / remap the role
 * if you book CIF differently). Customs taxes settle per the expediente's
 * payment method; each cost settles per its own (credit → the supplier's CxP,
 * carrying its NCF for the 606; else paid from bank/cash/card).
 */
export function buildExpedienteEntry({ newId, config, expediente, postedAt }: {
  newId: () => string;
  config: ResolvedAccountingConfig;
  expediente: ImportExpediente;
  postedAt?: number;
}): { entry: JournalEntry; lines: JournalLine[] } {
  const cif = round2(expediente.cif);
  const duty = round2(expediente.duty);
  const importItbis = round2(expediente.importItbis);
  const costs = Array.isArray(expediente.costs) ? expediente.costs : [];
  const landedTotal = expedienteLanded(expediente);
  const creditableItbis = expedienteCreditableItbis(expediente);
  if (landedTotal <= 0) throw new Error('El expediente no tiene costo a capitalizar.');

  const lines: DraftLine[] = [
    { accountCode: requireAccount(config, 'inventory'), debit: landedTotal, memo: 'Costo en destino' },
  ];
  if (creditableItbis > 0) {
    lines.push({ accountCode: requireAccount(config, 'itbisCredit'), debit: creditableItbis, memo: 'ITBIS importación + servicios' });
  }
  if (cif > 0) {
    lines.push({
      accountCode: requireAccount(config, 'goodsInTransit'),
      credit: cif,
      thirdPartyType: expediente.supplierId ? 'supplier' : null,
      thirdPartyId: expediente.supplierId || null,
      memo: 'CIF (mercancía en tránsito)',
    });
  }
  const customs = round2(duty + importItbis);
  if (customs > 0) {
    lines.push({ accountCode: requireAccount(config, payRole(expediente.paymentMethod)), credit: customs, memo: 'Aduanas: gravamen + ITBIS' });
  }
  for (const c of costs) {
    const amt = round2(c?.amount || 0);
    if (amt <= 0) continue;
    lines.push({
      accountCode: requireAccount(config, payRole(c.paymentMethod || 'bank')),
      credit: amt,
      thirdPartyType: c.supplierId ? 'supplier' : null,
      thirdPartyId: c.supplierId || null,
      ncf: c.ncf || null,
      memo: costLabel(c),
    });
  }

  return buildJournalEntry({
    newId,
    postedAt,
    source: 'import',
    memo: `Liquidación expediente${expediente.bl ? ` ${expediente.bl}` : ''}`,
    refTable: 'import_expedientes',
    refId: expediente.id,
    lines,
  });
}
