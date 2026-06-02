/**
 * Import-liquidation Model (liquidación aduanal / DGA) — lands imported goods at
 * their real RD cost.
 *
 * Landed cost = CIF + gravamen (duty) + clearance fees + other costs (everything
 * but the recoverable ITBIS). The import ITBIS is input credit.
 *
 *   Debit  Inventario          landedCost
 *   Debit  ITBIS adelantado     importItbis
 *   Credit <bank | suplidores>  landedCost + importItbis
 *
 * The caller also records a kardex IN at landedCost / qty. Pure.
 */
import { round2, buildJournalEntry, type DraftLine } from './ledger.js';
import { requireAccount, type ResolvedAccountingConfig } from './config.js';
import type { JournalEntry, JournalLine, PaymentMethod } from '../../types/domain.ts';

export interface ImportCostParts {
  cif: number;
  duty?: number;
  clearanceFees?: number;
  otherCosts?: number;
}

/** Capitalized landed cost (excludes the recoverable import ITBIS). */
export function landedCost(p: ImportCostParts): number {
  return round2((p.cif || 0) + (p.duty || 0) + (p.clearanceFees || 0) + (p.otherCosts || 0));
}

/**
 * Suggested customs figures from the CIF: duty at the configured rate (20% by
 * default), and import ITBIS on (CIF + duty) — the DR import-ITBIS base.
 */
export function computeImportTaxes({ cif, config }: { cif: number; config: ResolvedAccountingConfig }): { duty: number; importItbis: number } {
  const c = round2(cif);
  const duty = round2((c * config.dutyRate) / 100);
  const importItbis = round2(((c + duty) * config.itbisRate) / 100);
  return { duty, importItbis };
}

/** Landed unit cost for the kardex IN. */
export function landedUnitCost(parts: ImportCostParts, qty: number): number {
  const q = Number(qty) || 0;
  if (q <= 0) return 0;
  return Math.round((landedCost(parts) / q) * 10000) / 10000;
}

function payRole(method: PaymentMethod): string {
  if (method === 'credit') return 'accountsPayable';
  if (method === 'cash') return 'cash';
  return 'bank';
}

export interface ImportPostInput {
  id: string;
  supplierId?: string | null;
  cif: number;
  duty?: number;
  importItbis?: number;
  clearanceFees?: number;
  otherCosts?: number;
  paymentMethod: PaymentMethod;
  memo?: string;
}

export function buildImportEntry({
  newId, config, liq, postedAt,
}: {
  newId: () => string;
  config: ResolvedAccountingConfig;
  liq: ImportPostInput;
  postedAt?: number;
}): { entry: JournalEntry; lines: JournalLine[] } {
  const landed = landedCost(liq);
  const importItbis = round2(liq.importItbis || 0);
  if (landed <= 0) throw new Error('La importación no tiene costo a capitalizar.');
  const net = round2(landed + importItbis);

  const lines: DraftLine[] = [
    { accountCode: requireAccount(config, 'inventory'), debit: landed, memo: liq.memo || '' },
  ];
  if (importItbis > 0) lines.push({ accountCode: requireAccount(config, 'itbisCredit'), debit: importItbis });
  lines.push({
    accountCode: requireAccount(config, payRole(liq.paymentMethod)),
    credit: net,
    thirdPartyType: liq.supplierId ? 'supplier' : null,
    thirdPartyId: liq.supplierId || null,
  });

  return buildJournalEntry({
    newId,
    postedAt,
    source: 'import',
    memo: liq.memo || 'Liquidación de importación',
    refTable: 'import_liquidations',
    refId: liq.id,
    lines,
  });
}

/* ---- Batch liquidation: spread one shipment's import costs over its pieces ---- */

export interface ShipmentExtras {
  /** Gravamen (duty) for the whole shipment. */
  duty?: number;
  clearanceFees?: number;
  otherCosts?: number;
  /** Recoverable import ITBIS (input credit — NOT capitalized into cost). */
  importItbis?: number;
}

export interface AllocatedPiece<T> {
  line: T;
  /** CIP value of this piece = unitCostUsd × quantity. */
  cipValue: number;
  /** Share of (duty + clearance + other) assigned to this piece, by CIP weight. */
  allocatedExtras: number;
  /** cipValue + allocatedExtras. */
  landedTotal: number;
  /** landedTotal / quantity — the kardex IN unit cost. */
  landedUnitCost: number;
}

export interface ShipmentAllocation<T> {
  pieces: AllocatedPiece<T>[];
  totalCip: number;
  duty: number;
  clearanceFees: number;
  otherCosts: number;
  importItbis: number;
  /** totalCip + duty + clearance + other (excludes recoverable ITBIS). */
  landedTotal: number;
}

/**
 * Allocate one shipment's capitalizable import costs (duty + clearance + other)
 * across its pieces in proportion to each piece's CIP value, yielding a landed
 * unit cost per piece for the kardex. Rounding drift is absorbed by the last
 * piece so Σ allocatedExtras === the extras total and Σ landedTotal === landed.
 * The recoverable import ITBIS is carried through (input credit), not spread.
 * Pieces with no quantity or no unit cost are dropped. Pure.
 */
export function allocateShipment<T extends { quantity: number; unitCostUsd: number }>(
  lines: readonly T[],
  extras: ShipmentExtras = {},
): ShipmentAllocation<T> {
  const valid = (lines || []).filter((l) => (Number(l.quantity) || 0) > 0 && (Number(l.unitCostUsd) || 0) > 0);
  const totalCip = round2(valid.reduce((s, l) => s + l.unitCostUsd * l.quantity, 0));
  const duty = round2(extras.duty || 0);
  const clearanceFees = round2(extras.clearanceFees || 0);
  const otherCosts = round2(extras.otherCosts || 0);
  const importItbis = round2(extras.importItbis || 0);
  const spread = round2(duty + clearanceFees + otherCosts);

  let assigned = 0;
  const pieces: AllocatedPiece<T>[] = valid.map((line, i) => {
    const cipValue = round2(line.unitCostUsd * line.quantity);
    let allocatedExtras = totalCip > 0 ? round2((spread * cipValue) / totalCip) : 0;
    if (i === valid.length - 1) allocatedExtras = round2(spread - assigned); // drift → last
    assigned = round2(assigned + allocatedExtras);
    const landedTotal = round2(cipValue + allocatedExtras);
    const landedUnitCost = Math.round((landedTotal / line.quantity) * 10000) / 10000;
    return { line, cipValue, allocatedExtras, landedTotal, landedUnitCost };
  });

  return { pieces, totalCip, duty, clearanceFees, otherCosts, importItbis, landedTotal: round2(totalCip + spread) };
}
