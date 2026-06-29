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
 *   Debit  Inventario           landed = Σ(cif + gravamen + selectivo + cost net)
 *   Debit  ITBIS adelantado     Σ(line ITBIS) + Σ(cost itbis)
 *   Credit Mercancía en tránsito  CIF, split per foreign supplier (each clears)
 *   Credit <bank|caja>            gravamen + selectivo + import ITBIS  (aduanas)
 *   Credit <CxP|bank|caja>        cost.amount                          (one per cost)
 *
 * The caller records a kardex IN per line at its landed unit cost (read straight
 * off `resolveExpediente`). Pure: no React, no Supabase.
 */
import { round2, round4, buildJournalEntry, type DraftLine } from './ledger.js';
import { requireAccount, type ResolvedAccountingConfig } from './config.js';
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

/**
 * CIF per line from its FOB: each line carries its prorated share of the
 * embarque's flete + seguro, by FOB weight (rounding drift → last line), so
 * Σ(line CIF) === FOB + flete + seguro. Mirrors how the DUA builds the valor en
 * aduana (Total CIF = Total FOB + Flete + Seguro). Pure.
 */
export function prorateCif<T extends { fob?: number | null }>(
  lines: readonly T[] | null | undefined,
  flete: number = 0,
  seguro: number = 0,
): Array<T & { cif: number }> {
  const list = lines || [];
  // Money inputs are clamped at 0 — a negative FOB/flete/seguro (DevTools or a
  // bad import) would poison every other line's prorated share.
  const extras = round2(Math.max(0, Number(flete) || 0) + Math.max(0, Number(seguro) || 0));
  const totalFob = round2(list.reduce((s, l) => s + Math.max(0, Number(l.fob) || 0), 0));
  let assigned = 0;
  return list.map((l, i) => {
    const fob = round2(Math.max(0, Number(l.fob) || 0));
    let share = totalFob > 0 ? round2((extras * fob) / totalFob) : 0;
    if (i === list.length - 1) share = round2(extras - assigned); // drift → last
    assigned = round2(assigned + share);
    return { ...l, cif: round2(fob + share) };
  });
}

/**
 * The DR import-tax cascade for ONE product line, calibrated to Alcover's DUA:
 *   gravamen  = dutyRate%  × CIF                         (20% on every product)
 *   selectivo = ISC (given — varies by HS arancel, 0 for most)
 *   ITBIS     = itbisRate% × (CIF + gravamen + selectivo)
 * Gravamen + selectivo CAPITALIZE into landed cost; the ITBIS is recoverable
 * input credit. Returns each component rounded to cents.
 */
export function computeLineTaxes({ cif, selectivo = 0, config }: {
  cif: number; selectivo?: number; config: ResolvedAccountingConfig;
}): { gravamen: number; selectivo: number; itbis: number } {
  const c = round2(cif);
  const gravamen = round2((c * config.dutyRate) / 100);
  const sel = round2(selectivo || 0);
  const itbis = round2(((c + gravamen + sel) * config.itbisRate) / 100);
  return { gravamen, selectivo: sel, itbis };
}

/** One product line of an expediente, fully resolved: its CIF, the tax cascade,
 *  its share of the shared cost sheet, and the resulting landed cost. */
export interface ResolvedExpLine {
  embarqueId: string; bl: string; facturaId: string; supplierId: string | null;
  id: string; itemId: string | null; name: string; reference: string; qty: number;
  fob: number; cif: number; gravamen: number; selectivo: number; itbis: number;
  costShare: number; landedTotal: number; landedUnitCost: number;
}

export interface ResolvedExpediente {
  lines: ResolvedExpLine[];
  totals: {
    fob: number; cif: number; gravamen: number; selectivo: number; importItbis: number;
    impuestos: number; costGross: number; costNet: number; costItbis: number;
    landed: number; creditableItbis: number;
  };
}

/**
 * Resolve a multi-level expediente (embarques → facturas → lines) into the per-
 * line landed cost + rolled-up totals. Within each embarque a line gets its CIF
 * (FOB + prorated flete/seguro) and the tax cascade (gravamen 20% + selectivo +
 * ITBIS 18%); then the shared cost-sheet NET is prorated across ALL lines by CIF
 * (drift → last). Landed per line = CIF + gravamen + selectivo + cost share; the
 * ITBIS (import + service) is the recoverable credit. Pure — the single source
 * the workspace, the asiento, and the kardex all read from.
 */
export function resolveExpediente(
  expediente: ImportExpediente,
  config: ResolvedAccountingConfig,
): ResolvedExpediente {
  const taxed: ResolvedExpLine[] = [];
  for (const emb of expediente.embarques || []) {
    const flat = (emb.facturas || []).flatMap((f) =>
      (f.lines || []).map((l) => ({
        embarqueId: emb.id, bl: emb.bl || '', facturaId: f.id, supplierId: f.supplierId || null,
        id: l.id, itemId: l.itemId || null, name: l.name || '', reference: l.reference || '',
        qty: round2(Math.max(0, Number(l.qty) || 0)), fob: round2(Math.max(0, Number(l.fob ?? l.cifValue) || 0)),
        selectivo: round2(Math.max(0, Number(l.selectivo) || 0)),
      })),
    );
    for (const l of prorateCif(flat, emb.flete, emb.seguro)) {
      const t = computeLineTaxes({ cif: l.cif, selectivo: l.selectivo, config });
      taxed.push({ ...l, gravamen: t.gravamen, selectivo: t.selectivo, itbis: t.itbis, costShare: 0, landedTotal: 0, landedUnitCost: 0 });
    }
  }
  const totalCif = round2(taxed.reduce((s, l) => s + l.cif, 0));
  const { gross: costGross, net: costNet, itbis: costItbis } = expedienteCostTotals(expediente.costs);

  const totalQty = round2(taxed.reduce((s, l) => s + l.qty, 0));
  let assigned = 0;
  const lines = taxed.map((l, i) => {
    // Allocate the cost sheet by CIF value (the normal basis). If every line's
    // CIF is 0 (costs entered before FOB, or a zero-valued sample shipment),
    // fall back to quantity, then to an even split — never dump the whole sheet
    // on the last line, which would wildly distort its per-unit landed cost and
    // zero out every other line's.
    let share;
    if (totalCif > 0) share = round2((costNet * l.cif) / totalCif);
    else if (totalQty > 0) share = round2((costNet * l.qty) / totalQty);
    else share = round2(costNet / taxed.length);
    if (i === taxed.length - 1) share = round2(costNet - assigned); // drift → last
    assigned = round2(assigned + share);
    const landedTotal = round2(l.cif + l.gravamen + l.selectivo + share);
    const landedUnitCost = l.qty > 0 ? round4(landedTotal / l.qty) : 0;
    return { ...l, costShare: share, landedTotal, landedUnitCost };
  });

  const sum = (f: (l: ResolvedExpLine) => number) => round2(lines.reduce((s, l) => s + f(l), 0));
  const gravamen = sum((l) => l.gravamen);
  const selectivo = sum((l) => l.selectivo);
  const importItbis = sum((l) => l.itbis);
  return {
    lines,
    totals: {
      fob: sum((l) => l.fob), cif: totalCif, gravamen, selectivo, importItbis,
      impuestos: round2(gravamen + selectivo + importItbis),
      costGross, costNet, costItbis,
      landed: sum((l) => l.landedTotal),
      creditableItbis: round2(importItbis + costItbis),
    },
  };
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
    // Clamp: no negative costs, and a cost's ITBIS can never exceed its amount
    // (else the capitalized net would go negative and unbalance the asiento).
    const a = round2(Math.max(0, Number(c?.amount) || 0));
    const t = Math.min(round2(Math.max(0, Number(c?.itbis) || 0)), a);
    gross = round2(gross + a);
    itbis = round2(itbis + t);
    net = round2(net + round2(a - t));
  }
  return { gross, itbis, net };
}

/** Capitalized landed total = CIF + gravamen + selectivo + Σ(cost net). Excludes
 *  recoverable ITBIS. Reads a saved record's stored totals (the list view). */
export function expedienteLanded(e: Pick<ImportExpediente, 'cif' | 'duty' | 'selectivo' | 'costs'>): number {
  return round2(round2(e.cif) + round2(e.duty) + round2(e.selectivo || 0) + expedienteCostTotals(e.costs).net);
}

/** All recoverable input ITBIS = import ITBIS + Σ(service ITBIS). */
export function expedienteCreditableItbis(e: Pick<ImportExpediente, 'importItbis' | 'costs'>): number {
  return round2(round2(e.importItbis) + expedienteCostTotals(e.costs).itbis);
}

/**
 * Does the entered gravamen / import ITBIS match what the rates (20% / 18% by
 * config) would compute from the CIF? Surfaced as a verification banner — a
 * mismatch usually means the goods' HS arancel isn't the default rate.
 *
 * The expected ITBIS base is CIF + gravamen + selectivo (Código Tributario
 * Art. 339): gravamen is rate-derived from the CIF, but the selectivo has no
 * single rate (it varies by HS arancel), so it's taken as entered. Omitting it
 * (selectivo = 0) reproduces the legacy CIF+gravamen base exactly.
 */
export function expedienteTaxCheck({ cif, duty, selectivo = 0, importItbis, config }: {
  cif: number; duty: number; selectivo?: number; importItbis: number; config: ResolvedAccountingConfig;
}): { computed: { duty: number; importItbis: number }; dutyDiff: number; itbisDiff: number; matches: boolean } {
  const c = round2(cif);
  const computedDuty = round2((c * config.dutyRate) / 100);
  const sel = round2(Math.max(0, Number(selectivo) || 0));
  const computedItbis = round2(((c + computedDuty + sel) * config.itbisRate) / 100);
  const dutyDiff = round2(round2(duty) - computedDuty);
  const itbisDiff = round2(round2(importItbis) - computedItbis);
  return {
    computed: { duty: computedDuty, importItbis: computedItbis },
    dutyDiff, itbisDiff,
    matches: Math.abs(dutyDiff) < 0.5 && Math.abs(itbisDiff) < 0.5,
  };
}

/**
 * Build the single balanced asiento for an expediente, over the resolved (multi-
 * embarque) model. CIF clears from Mercancía en tránsito into Inventario — split
 * per foreign supplier so each supplier's in-transit balance zeroes — (the foreign
 * purchase was booked there when the supplier was paid; remap the role if you book
 * CIF differently). Customs (gravamen + selectivo + import ITBIS) settle per the
 * expediente's payment method; each cost settles per its own (credit → the
 * supplier's CxP, carrying its NCF for the 606; else paid from bank/cash/card).
 */
export function buildExpedienteEntry({ newId, config, expediente, postedAt }: {
  newId: () => string;
  config: ResolvedAccountingConfig;
  expediente: ImportExpediente;
  postedAt?: number;
}): { entry: JournalEntry; lines: JournalLine[] } {
  const r = resolveExpediente(expediente, config);
  const { landed, creditableItbis, gravamen, selectivo, importItbis } = r.totals;
  const costs = Array.isArray(expediente.costs) ? expediente.costs : [];
  // A cost sheet only capitalizes through the product lines (prorated by CIF/qty).
  // With no resolvable line, costNet has nowhere to land: its DEBIT (inventory)
  // is 0 while the cost CREDITS below would still be emitted → an off-balance
  // asiento. Fail loud, before assertBalanced would, so the dealer adds a line.
  if (r.lines.length === 0) {
    const hasCosts = costs.some((c) => round2(c?.amount || 0) > 0);
    throw new Error(hasCosts
      ? 'El expediente tiene costos pero ninguna línea de producto donde capitalizarlos. Agrega al menos una línea.'
      : 'El expediente no tiene costo a capitalizar.');
  }
  if (landed <= 0) throw new Error('El expediente no tiene costo a capitalizar.');

  const lines: DraftLine[] = [
    { accountCode: requireAccount(config, 'inventory'), debit: landed, memo: 'Costo en destino' },
  ];
  if (creditableItbis > 0) {
    lines.push({ accountCode: requireAccount(config, 'itbisCredit'), debit: creditableItbis, memo: 'ITBIS importación + servicios' });
  }
  // CIF clears from goods-in-transit, one credit per foreign supplier.
  const cifBySupplier = new Map<string | null, number>();
  for (const l of r.lines) cifBySupplier.set(l.supplierId, round2((cifBySupplier.get(l.supplierId) || 0) + l.cif));
  for (const [supplierId, cif] of cifBySupplier) {
    if (cif <= 0) continue;
    lines.push({
      accountCode: requireAccount(config, 'goodsInTransit'),
      credit: cif,
      thirdPartyType: supplierId ? 'supplier' : null,
      thirdPartyId: supplierId || null,
      memo: 'CIF (mercancía en tránsito)',
    });
  }
  const customs = round2(gravamen + selectivo + importItbis);
  if (customs > 0) {
    lines.push({ accountCode: requireAccount(config, payRole(expediente.paymentMethod)), credit: customs, memo: 'Aduanas: gravamen + selectivo + ITBIS' });
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
