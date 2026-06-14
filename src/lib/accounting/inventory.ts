/**
 * Inventory Model — weighted-average costing over the kardex.
 *
 * Movements are the source of truth; on-hand qty and moving-average cost are
 * derived by replaying them in date order:
 *   • in     → qty up, average re-weighted by the incoming cost
 *   • out    → qty down at the current average (that's the cost of sale)
 *   • adjust → qty change at the current average (no revaluation)
 *
 * Pure: no React, no Supabase.
 */
import { round2 } from './ledger.js';
import type { InventoryMovement } from '../../types/domain.ts';

/** Round a unit cost to 4 dp (finer than money cents — costs divide by qty). */
export function round4(n: number | null | undefined): number {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

/** New moving-average cost after receiving `inQty` at `inCost`. */
export function weightedAverageIn(qty: number, avgCost: number, inQty: number, inCost: number): number {
  const totalQty = (Number(qty) || 0) + (Number(inQty) || 0);
  if (totalQty <= 0) return 0;
  return round4(((qty * avgCost) + (inQty * inCost)) / totalQty);
}

export interface KardexRow {
  movement: InventoryMovement;
  qty: number;       // running on-hand after this movement
  avgCost: number;   // running average after this movement
  value: number;     // running stock value (qty × avgCost)
  /** For 'out': the cost charged (qty × avg at the time). */
  costOut?: number;
}

export interface KardexResult {
  rows: KardexRow[];
  qty: number;
  avgCost: number;
  value: number;
}

/** Replay movements (date order) into a kardex with running qty/avg/value. */
export function resolveKardex(movements: InventoryMovement[] | null | undefined): KardexResult {
  const sorted = (movements || []).slice().sort(
    (a, b) => (a.movedAt || 0) - (b.movedAt || 0) || (a.createdAt || 0) - (b.createdAt || 0),
  );
  let qty = 0;
  let avg = 0;
  const rows: KardexRow[] = [];
  for (const m of sorted) {
    const q = Number(m.qty) || 0;
    let costOut;
    if (m.type === 'in') {
      avg = weightedAverageIn(qty, avg, q, Number(m.unitCost) || 0);
      qty += q;
    } else if (m.type === 'out') {
      costOut = round2(q * avg);
      qty -= q;
    } else { // adjust — qty change at current average (q may be negative)
      qty += q;
      // Emptying/over-drawing the stock leaves the unit cost (avg) untouched —
      // a quantity change never restates what each unit cost.
    }
    rows.push({ movement: m, qty: round4(qty), avgCost: round4(avg), value: round2(qty * avg), costOut });
  }
  return { rows, qty: round4(qty), avgCost: round4(avg), value: round2(qty * avg) };
}
