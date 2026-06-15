// LSG stock reconciler — the effectful half of the two-way LifestyleGarden
// sync, on the Vite side. Owns the closed loop the user asked for:
//
//   accept + order  → the quote's LSG pieces are deducted from Shopify
//   revert / cancel → the same pieces are added back
//
// HOW it stays robust (best practice, not a fire-once decrement):
//   • Desired-state reconciliation. Each call recomputes the units a quote
//     SHOULD hold (lib/lsgSale: quoteHoldsLsgStock + lsgDesiredUnits) and diffs
//     them against the COMMITTED ledger row (lsg_stock_commitments), pushing
//     only the delta. Committing twice is a no-op; a revert drives desired to 0
//     so the delta restocks exactly what was taken. No double-deduct on
//     re-attach, no lost restock on cancel.
//   • Exactly-once accounting. The committed ledger advances ONLY for the
//     deltas Shopify actually applied (the Edge Function echoes them back), so a
//     partial/failed push is simply retried by the next transition — never
//     silently lost or double-counted.
//   • Idempotent at the API too. Each push carries a fresh idempotency key
//     (required by Admin API 2026-04) + a reference URI for Shopify's audit
//     trail (lib/shopifySync.pushLsgInventoryAdjust → shopify-sync/lsgInventory).
//   • Self-healing read model. On success the local products.stock_qty mirror is
//     nudged by the same delta so the quote builder's stock gate is correct
//     immediately; the 15-min catalog cron later reconciles it to Shopify's
//     absolute figure.
//
// Everything is best-effort and fully detached at the call sites (`.catch`),
// and tolerant of the ledger table not existing yet (pre-migration): a Shopify
// hiccup, a missing scope, or no LSG lines never blocks a quote/order action.

import { db } from '../db/database.js';
import { pushLsgInventoryAdjust } from './shopifySync.js';
import { lsgDesiredUnits, lsgCommitmentDeltas, quoteHoldsLsgStock } from './lsgSale.js';

const TEAM_PROFILE_ID = 'team';

/** Read a quote's committed snapshot ({ productId: units }); {} when none /
 *  the ledger table doesn't exist yet (degrades gracefully pre-migration). */
async function readCommitted(quoteId) {
  try {
    const row = await db.lsgStockCommitments.get(quoteId);
    return row && row.committed && typeof row.committed === 'object' ? { ...row.committed } : {};
  } catch {
    return {};
  }
}

/** Persist a quote's committed snapshot, pruning zero/blank entries. An empty
 *  snapshot deletes the row so the ledger only holds live reservations. */
async function writeCommitted(quoteId, committed) {
  const pruned = {};
  for (const [id, v] of Object.entries(committed || {})) {
    const n = Math.trunc(Number(v));
    if (id && n > 0) pruned[id] = n;
  }
  try {
    if (!Object.keys(pruned).length) {
      await db.lsgStockCommitments.delete(quoteId);
      return;
    }
    const existing = await db.lsgStockCommitments.get(quoteId).catch(() => null);
    await db.lsgStockCommitments.put({
      id: quoteId,
      profileId: existing?.profileId || TEAM_PROFILE_ID,
      committed: pruned,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    });
  } catch {
    /* table missing pre-migration — the push still happened; the ledger
       catches up once the migration lands. */
  }
}

/** Build reference(SKU) → LSG product id (`lsg-<variantId>`) for the refs a
 *  quote's lines actually use, so only LifestyleGarden lines map to a push. */
async function buildLsgRefMap(lines) {
  const refs = new Set();
  for (const l of lines || []) {
    if (l?.reference) refs.add(l.reference);
    for (const c of l?.components || []) if (c?.reference) refs.add(c.reference);
  }
  if (!refs.size) return new Map();
  const lsg = await db.products.where('brand').equals('lifestylegarden').toArray();
  const map = new Map();
  for (const p of lsg) if (refs.has(p.reference)) map.set(p.reference, p.id);
  return map;
}

/** Nudge the local stock mirror by the deltas Shopify applied, so the quote
 *  builder's out-of-stock gate is right before the next catalog sync. Only
 *  TRACKED rows move (a null stock_qty stays untracked). Best-effort. */
async function applyLocalMirror(applied) {
  for (const a of applied || []) {
    const id = a?.productId;
    const delta = Math.trunc(Number(a?.delta));
    if (!id || !delta) continue;
    try {
      const p = await db.products.get(id);
      if (!p || p.stockQty == null) continue;
      await db.products.update(id, { stockQty: Number(p.stockQty) + delta, updatedAt: Date.now() });
    } catch {
      /* best-effort — the cron reconciles the absolute figure anyway */
    }
  }
}

/**
 * Reconcile ONE quote's LSG Shopify stock to its current lifecycle state.
 * Idempotent and reversible: safe to call after any transition (accept, revert,
 * attach, detach, decline/archive, order cancel/uncancel, delete). Fire-and-
 * forget — never throws.
 */
export async function reconcileQuoteStock(quoteId) {
  if (!quoteId) return;

  let quote = null;
  try { quote = await db.quotes.get(quoteId); } catch { quote = null; }

  const committed = await readCommitted(quoteId);

  // DESIRED units — only an accepted quote in a live order holds stock; a
  // deleted/declined/detached quote (or cancelled/missing order) holds nothing,
  // which drives the restock without ever touching the catalog.
  let desired = {};
  if (quote) {
    let order = null;
    if (quote.orderId) {
      try { order = await db.orders.get(quote.orderId); } catch { order = null; }
    }
    if (quoteHoldsLsgStock(quote, order)) {
      let lines = [];
      try { lines = await db.quoteLines.where('quoteId').equals(quoteId).toArray(); } catch { lines = []; }
      const refMap = await buildLsgRefMap(lines);
      desired = Object.fromEntries(lsgDesiredUnits(lines, refMap));
    }
  }

  const deltas = lsgCommitmentDeltas(committed, desired);
  if (!deltas.length) return; // already in sync — nothing to push

  let res;
  try {
    res = await pushLsgInventoryAdjust(deltas, { reference: `rosetsoft://quote/${quoteId}` });
  } catch {
    return; // transport failure — leave the ledger; the next transition retries
  }
  if (!res || res.configured === false) return; // Shopify not connected
  const applied = Array.isArray(res.applied) ? res.applied : [];
  if (!applied.length) return; // nothing actually landed (skips / user errors)

  // Advance the ledger ONLY for the products that actually changed on Shopify
  // (an applied delta moves committed[id] to desired[id] exactly).
  const next = { ...committed };
  for (const a of applied) {
    if (a?.productId) next[a.productId] = Number(desired[a.productId]) || 0;
  }
  await writeCommitted(quoteId, next);
  await applyLocalMirror(applied);
}

/**
 * Reconcile every quote attached to an order — for order-level transitions
 * (cancel → restock all; reactivate → re-deduct the accepted ones; delete →
 * restock the freed quotes). Fire-and-forget.
 */
export async function reconcileOrderStock(orderId) {
  if (!orderId) return;
  let quotes = [];
  try { quotes = await db.quotes.where('orderId').equals(orderId).toArray(); } catch { return; }
  // Independent per-quote reconciles (disjoint ledger rows) — run them
  // concurrently, each guarded so one failure can't abort the others.
  await Promise.all(quotes.map((q) => reconcileQuoteStock(q.id).catch(() => {})));
}
