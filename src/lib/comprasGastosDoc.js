// Effectful helpers shared by the document detail pages (Eliminar) and the
// registration/expediente forms (Editar): reversing a posted document and
// recomputing the inventory it touched. Kept OUT of lib/accounting (which is
// pure, no db) — these touch the Dexie-shaped db, like lib/salePosting.
import { db } from '../db/database.js';
import { resolveKardex } from './accounting/inventory.js';

/**
 * Reverse a posting's asiento + its kardex INs (tagged by refTable/refId):
 * delete the journal entry + lines, delete the movements, and recompute each
 * touched item from its REMAINING movements.
 *
 * `keepOrphanItems` controls what happens to an item left with NO movements:
 *  - false (Eliminar): delete the item — it was minted only by this document.
 *  - true  (Editar): zero its qty/avg but KEEP the row, so the re-post can
 *    re-add its movement and recompute it (deleting then updating would strand
 *    the re-posted movement against a missing item).
 * Idempotent and order-independent.
 * @returns {Promise<{ touched: string[] }>}
 */
async function reverseInventoryPosting({ refId, refTable, journalEntryId, keepOrphanItems = false }) {
  const moves = (await db.inventoryMovements.where('refId').equals(refId).toArray())
    .filter((m) => m.refTable === refTable);
  const touched = [...new Set(moves.map((m) => m.itemId).filter(Boolean))];
  if (journalEntryId) {
    const jl = await db.journalLines.where('entryId').equals(journalEntryId).toArray();
    await db.journalLines.bulkDelete(jl.map((l) => l.id));
    await db.journalEntries.delete(journalEntryId);
  }
  await db.inventoryMovements.bulkDelete(moves.map((m) => m.id));
  for (const itemId of touched) {
    const remaining = await db.inventoryMovements.where('itemId').equals(itemId).toArray();
    if (!remaining.length) {
      if (keepOrphanItems) await db.inventoryItems.update(itemId, { qtyOnHand: 0, avgCost: 0 });
      else await db.inventoryItems.delete(itemId);
      continue;
    }
    const k = resolveKardex(remaining);
    await db.inventoryItems.update(itemId, { qtyOnHand: k.qty, avgCost: k.avgCost });
  }
  return { touched };
}

/**
 * Reverse a compra/gasto. A mercancía purchase also undoes its kardex INs; a
 * gasto/activo only has the asiento. Does NOT delete the document row — the
 * caller deletes it (Eliminar) or overwrites it (Editar).
 */
export async function reverseComprasGastoPosting({ id, source, journalEntryId, keepOrphanItems = false }) {
  if (source === 'purchase') {
    return reverseInventoryPosting({ refId: id, refTable: 'purchases', journalEntryId, keepOrphanItems });
  }
  if (journalEntryId) {
    const jl = await db.journalLines.where('entryId').equals(journalEntryId).toArray();
    await db.journalLines.bulkDelete(jl.map((l) => l.id));
    await db.journalEntries.delete(journalEntryId);
  }
  return { touched: [] };
}

/**
 * Reverse a POSTED import expediente — its liquidación asiento + the landed
 * kardex INs (refTable 'import_expedientes'). Shared by the detail Eliminar
 * (keepOrphanItems false) and the editor's re-liquidar (keepOrphanItems true).
 */
export async function reverseExpedientePosting({ id, journalEntryId, keepOrphanItems = false }) {
  return reverseInventoryPosting({ refId: id, refTable: 'import_expedientes', journalEntryId, keepOrphanItems });
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
    if (!all.length) { await db.inventoryItems.update(itemId, { qtyOnHand: 0, avgCost: 0 }); continue; }
    const k = resolveKardex(all);
    await db.inventoryItems.update(itemId, { qtyOnHand: k.qty, avgCost: k.avgCost });
  }
}
