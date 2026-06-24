/**
 * Per-line tax Model — the curated Dominican tax presets a vendor-bill or sales
 * invoice LINE can carry (Odoo "account.tax" style), plus the pure function that
 * turns a line's base + selected taxes into the ITBIS and the retentions.
 *
 * One line may carry several taxes at once (e.g. "ITBIS 18%" + "Retención 30%
 * ITBIS"), exactly like the Odoo bill: the ITBIS taxes compute on the line base;
 * the ITBIS-retention computes on that ITBIS (it withholds a slice of it); the
 * ISR-retention computes on the base. The owner-confirmed statutory rates match
 * the accounting config (ITBIS 18%, Ret. ISR servicios 10%, Ret. ITBIS 30%);
 * the rest are the standard Dominican variants.
 *
 * Worked example (the reference screenshot): base 5 000 with ITBIS 18% +
 * Retención 30% ITBIS → itbis 900, retItbis 270, so the net ITBIS the supplier
 * keeps is 630 and the bill totals 5 630. Pure: no React, no Supabase.
 */
import { round2 } from './ledger.js';

export type TaxKind = 'itbis' | 'retIsr' | 'retItbis';

export interface TaxPreset {
  id: string;
  label: string;
  /** Short tag for the line chip (e.g. "ITBIS 18%", "Ret. ITBIS 30%"). */
  short: string;
  kind: TaxKind;
  /** Percent. */
  rate: number;
  /** What the percent applies to: the line base, or the line's ITBIS. */
  on: 'base' | 'itbis';
}

/**
 * The curated Dominican tax list (owner-endorsed). ITBIS is the input/output
 * tax; the retentions are what the BUYER withholds when paying certain
 * suppliers (the seller side shows them as informativas). Add more in a future
 * "configurable codes" pass — for now this covers the real cases.
 */
export const DR_TAX_PRESETS: readonly TaxPreset[] = [
  { id: 'itbis18', label: 'ITBIS 18%', short: 'ITBIS 18%', kind: 'itbis', rate: 18, on: 'base' },
  { id: 'itbis16', label: 'ITBIS 16%', short: 'ITBIS 16%', kind: 'itbis', rate: 16, on: 'base' },
  { id: 'exento', label: 'Exento / 0%', short: 'Exento', kind: 'itbis', rate: 0, on: 'base' },
  { id: 'retItbis30', label: 'Retención 30% ITBIS (persona jurídica)', short: 'Ret. ITBIS 30%', kind: 'retItbis', rate: 30, on: 'itbis' },
  { id: 'retItbis100', label: 'Retención 100% ITBIS (persona física)', short: 'Ret. ITBIS 100%', kind: 'retItbis', rate: 100, on: 'itbis' },
  { id: 'retIsr10', label: 'Retención 10% ISR (honorarios / servicios)', short: 'Ret. ISR 10%', kind: 'retIsr', rate: 10, on: 'base' },
  { id: 'retIsr2', label: 'Retención 2% ISR (otras rentas)', short: 'Ret. ISR 2%', kind: 'retIsr', rate: 2, on: 'base' },
  { id: 'retIsr27', label: 'Retención 27% ISR (pagos al exterior)', short: 'Ret. ISR 27%', kind: 'retIsr', rate: 27, on: 'base' },
];

const BY_ID = new Map(DR_TAX_PRESETS.map((t) => [t.id, t]));

/** Look up a preset by id (null if unknown). */
export function taxPresetById(id: string | null | undefined): TaxPreset | null {
  return (id && BY_ID.get(id)) || null;
}

export interface LineTaxResult {
  /** Full ITBIS on the line (before any retention). */
  itbis: number;
  /** ISR withheld from the supplier. */
  retIsr: number;
  /** ITBIS withheld from the supplier. */
  retItbis: number;
}

/**
 * Resolve a line's selected taxes against its base. ITBIS and ISR-retention
 * compute on the base; the ITBIS-retention computes on the line's resulting
 * ITBIS (it withholds part of it). Several taxes of a kind sum. Unknown ids are
 * ignored. Every figure is clamped ≥ 0 and rounded to cents so the asiento it
 * feeds can't drift off-balance. Pure.
 */
export function applyLineTaxes(
  base: number,
  taxIds: readonly string[] | null | undefined,
): LineTaxResult {
  const b = round2(Math.max(0, Number(base) || 0));
  const presets = (taxIds || [])
    .map((id) => BY_ID.get(id))
    .filter((t): t is TaxPreset => !!t);

  const itbis = round2(
    presets.filter((t) => t.kind === 'itbis').reduce((s, t) => s + (b * t.rate) / 100, 0),
  );
  const retIsr = round2(
    presets.filter((t) => t.kind === 'retIsr').reduce((s, t) => s + (b * t.rate) / 100, 0),
  );
  const retItbis = round2(
    presets.filter((t) => t.kind === 'retItbis').reduce((s, t) => s + (itbis * t.rate) / 100, 0),
  );
  return { itbis, retIsr, retItbis };
}
