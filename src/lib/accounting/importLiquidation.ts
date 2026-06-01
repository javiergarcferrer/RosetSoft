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
