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
import { round2, round4 } from './ledger.js';
import type { InventoryMovement } from '../../types/domain.ts';

// Re-export the canonical 4-dp rounder so existing importers (the
// `core/accounting` barrel) keep resolving `round4` from here.
export { round4 } from './ledger.js';

/** New moving-average cost after receiving `inQty` at `inCost`. A NEGATIVE
 *  running qty (a prior over-draw) is treated as 0 stock for the re-weight — its
 *  (negative qty × avg) "value" must not be folded in, or it wipes/poisons the
 *  average against the incoming cost. */
export function weightedAverageIn(qty: number, avgCost: number, inQty: number, inCost: number): number {
  const onHand = Math.max(0, Number(qty) || 0);
  const incoming = Number(inQty) || 0;
  const totalQty = onHand + incoming;
  if (totalQty <= 0) return 0;
  return round4(((onHand * avgCost) + (incoming * inCost)) / totalQty);
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
    // Valuation is clamped at 0: a negative on-hand (over-draw) is a quantity
    // error, not negative money sitting in inventory. The average is preserved so
    // a later receipt re-weights against real cost (see weightedAverageIn).
    const value = round2(Math.max(0, qty) * avg);
    rows.push({ movement: m, qty: round4(qty), avgCost: round4(avg), value, costOut });
  }
  return { rows, qty: round4(qty), avgCost: round4(avg), value: round2(Math.max(0, qty) * avg) };
}
