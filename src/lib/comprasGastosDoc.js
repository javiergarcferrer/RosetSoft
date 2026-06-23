// Effectful helpers shared by the Compras/Gastos detail page (Eliminar) and the
// registration form (Editar): reversing a posted compra/gasto and recomputing
// the inventory it touched. Kept OUT of lib/accounting (which is pure, no db) —
// these touch the Dexie-shaped db, like lib/salePosting.
import { db } from '../db/database.js';
import { resolveKardex } from './accounting/inventory.js';

/**
 * Reverse the posting of one compra/gasto: undo its asiento and, for a mercancía
 * purchase, its kardex INs — recomputing each touched item from its REMAINING
 * movements (so an item minted only by this invoice is removed). Does NOT delete
 * the document row: the caller deletes it (Eliminar) or overwrites it (Editar).
 * Idempotent and order-independent.
 * @returns {Promise<{ touched: string[] }>} inventory item ids it touched.
 */
export async function reverseComprasGastoPosting({ id, source, journalEntryId }) {
  let touched = [];
  if (source === 'purchase') {
    const moves = (await db.inventoryMovements.where('refId').equals(id).toArray())
      .filter((m) => m.refTable === 'purchases');
    touched = [...new Set(moves.map((m) => m.itemId).filter(Boolean))];
    if (journalEntryId) {
      const jl = await db.journalLines.where('entryId').equals(journalEntryId).toArray();
      await db.journalLines.bulkDelete(jl.map((l) => l.id));
      await db.journalEntries.delete(journalEntryId);
    }
    await db.inventoryMovements.bulkDelete(moves.map((m) => m.id));
    for (const itemId of touched) {
      const remaining = await db.inventoryMovements.where('itemId').equals(itemId).toArray();
      if (!remaining.length) { await db.inventoryItems.delete(itemId); continue; }
      const k = resolveKardex(remaining);
      await db.inventoryItems.update(itemId, { qtyOnHand: k.qty, avgCost: k.avgCost });
    }
  } else if (journalEntryId) {
    const jl = await db.journalLines.where('entryId').equals(journalEntryId).toArray();
    await db.journalLines.bulkDelete(jl.map((l) => l.id));
    await db.journalEntries.delete(journalEntryId);
  }
  return { touched };
}

/**
 * Recompute the given inventory items from ALL their movements (full
 * chronological kardex). Used after an Editar re-posts: the edited document may
 * not be chronologically last, so weighted-average-at-end would be wrong —
 * a full recompute over every movement is always correct.
 */
export async function recomputeItems(itemIds) {
  for (const itemId of [...new Set((itemIds || []).filter(Boolean))]) {
    const all = await db.inventoryMovements.where('itemId').equals(itemId).toArray();
    if (!all.length) { await db.inventoryItems.delete(itemId); continue; }
    const k = resolveKardex(all);
    await db.inventoryItems.update(itemId, { qtyOnHand: k.qty, avgCost: k.avgCost });
  }
}
