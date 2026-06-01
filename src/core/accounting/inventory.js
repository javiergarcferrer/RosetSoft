// Inventory ViewModels — stock valuation + per-item kardex, projected from the
// movements via the weighted-average Model. Pure: no React, no db.
import { resolveKardex } from '../../lib/accounting/inventory.js';
import { round2 } from '../../lib/accounting/ledger.js';

/** Per-item on-hand qty + average cost + value (from the kardex), plus the
 *  total stock value. */
export function resolveInventory({ items, movements } = {}) {
  const byItem = new Map();
  for (const m of movements || []) {
    if (!byItem.has(m.itemId)) byItem.set(m.itemId, []);
    byItem.get(m.itemId).push(m);
  }
  const rows = (items || [])
    .map((item) => {
      const k = resolveKardex(byItem.get(item.id) || []);
      return { item, qty: k.qty, avgCost: k.avgCost, value: k.value };
    })
    .sort((a, b) => (a.item.name || '').localeCompare(b.item.name || ''));
  return { rows, totalValue: round2(rows.reduce((s, r) => s + r.value, 0)), count: rows.length };
}

/** The kardex for a single item (running qty/avg/value). */
export function resolveItemKardex({ movements, itemId } = {}) {
  return resolveKardex((movements || []).filter((m) => m.itemId === itemId));
}
