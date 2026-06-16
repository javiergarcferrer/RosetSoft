// LSG stock ↔ Shopify mapping (the PUSH half of the two-way LifestyleGarden
// sync) — PURE Model, pinned by tests/lsgSale.test.js.
//
// The catalog PULL keeps `products.stock_qty` fresh FROM the lifestylegarden.do
// Shopify store; this module owns the math for closing the loop the OTHER way:
// when an LSG product is committed to a sale inside ALCOVER, lower its available
// count on Shopify so the storefront can't oversell the same piece — and add it
// back when the sale is reverted.
//
// Robustness model (why this is a desired-state reconciler, not a one-shot
// decrement): every quote carries a COMMITTED snapshot — the units of each LSG
// product currently deducted from Shopify on its behalf. A transition recomputes
// the DESIRED units and pushes only the DELTA (committed → desired). That makes
// the push idempotent (re-running with no change is a no-op) and reversible (a
// revert drives desired back to 0, so the delta restocks exactly what was taken)
// — no double-deduction on a re-attach, no lost restock on a cancel. The
// effectful orchestration (load rows, push, persist the ledger) lives in
// lib/lsgStock.js; the arithmetic lives here so it can be pinned without a DB.

import { isPricedLine, isPricedComponent } from './constants.ts';

/**
 * The DESIRED LSG units for a committed quote: a Map productId → units, summed
 * over the quote's PRICED LifestyleGarden lines/components. `lsgByRef` maps a
 * product reference (SKU) → its LSG product id (`lsg-<variantId>`); only
 * references present there (brand lifestylegarden) contribute, so Ligne Roset
 * and free-typed lines are ignored. Optional and non-selected-alternative
 * lines/modules are skipped (isPricedLine/isPricedComponent), so we never count
 * a piece the customer didn't actually buy. A compound folds the line qty into
 * each component qty; a simple line uses its own. Same variant across
 * lines/components is summed.
 */
export function lsgDesiredUnits(lines, lsgByRef) {
  const byProduct = new Map();
  const map = lsgByRef instanceof Map ? lsgByRef : new Map(Object.entries(lsgByRef || {}));
  const add = (ref, qty) => {
    const id = ref && map.get(ref);
    const n = Number(qty);
    if (!id || !(n > 0)) return;
    byProduct.set(id, (byProduct.get(id) || 0) + n);
  };
  for (const l of lines || []) {
    if (!l || l.kind === 'section' || !isPricedLine(l)) continue;
    const lineQty = Number(l.qty) || 1;
    const comps = Array.isArray(l.components) ? l.components : [];
    if (comps.length) {
      for (const c of comps) {
        if (isPricedComponent(c)) add(c.reference, lineQty * (Number(c.qty) || 1));
      }
    } else {
      add(l.reference, lineQty);
    }
  }
  return byProduct;
}

/**
 * Map a committed quote's PRICED LifestyleGarden lines to one-shot Shopify
 * decrements — [{ productId: 'lsg-<variantId>', delta: -qty }]. Kept for the
 * sale-time mapping shape; built on lsgDesiredUnits so the two never drift.
 */
export function lsgSaleAdjustments(lines, lsgByRef) {
  return [...lsgDesiredUnits(lines, lsgByRef)].map(([productId, qty]) => ({ productId, delta: -qty }));
}

/** Coerce a committed/desired snapshot ({ productId: units } or Map) to a Map
 *  of positive integers (zero/blank/negative entries dropped). */
function unitsMap(snapshot) {
  const out = new Map();
  const entries = snapshot instanceof Map ? snapshot.entries() : Object.entries(snapshot || {});
  for (const [id, v] of entries) {
    const n = Math.trunc(Number(v));
    if (id && n > 0) out.set(id, n);
  }
  return out;
}

/**
 * The Shopify available-stock deltas that move a quote's COMMITTED snapshot to
 * its DESIRED one — [{ productId, delta }] where delta = committed − desired:
 *
 *   • desired > committed (need to deduct more) → delta < 0 → lowers Shopify;
 *   • desired < committed (revert / smaller)    → delta > 0 → restocks Shopify;
 *   • equal                                     → no entry (idempotent no-op).
 *
 * Applying a delta moves committed[id] to desired[id] exactly, so the ledger is
 * self-correcting. Sorted by productId for a deterministic push order.
 */
export function lsgCommitmentDeltas(committed, desired) {
  const c = unitsMap(committed);
  const d = unitsMap(desired);
  const ids = new Set([...c.keys(), ...d.keys()]);
  const out = [];
  for (const id of ids) {
    const delta = (c.get(id) || 0) - (d.get(id) || 0);
    if (delta) out.push({ productId: id, delta });
  }
  return out.sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
}

/**
 * Does this quote currently HOLD LSG stock — i.e. should its LifestyleGarden
 * pieces be deducted from the Shopify storefront right now? An ACCEPTED quote
 * holds when it is a committed sale, by either path:
 *
 *   • Order-attached (an import / special order) → held while the order is LIVE.
 *     Detaching, deleting the order (orderId → null), cancelling it, or a
 *     missing order row (deleted) all release the hold → the reconciler restocks.
 *   • Floor sale (NO order — the usual path for LSG, our own warehouse stock) →
 *     the piece leaves the floor at the deposit, so it's committed the moment
 *     `depositReceivedAt` is set. This is the SAME committed-sale signal the rest
 *     of the app uses for a floor sale (readyToInvoice / quoteOutstanding /
 *     commissions). Without it an LSG sale — which almost never gets an order —
 *     would never deduct from Shopify.
 *
 * Un-accepting, un-marking the deposit, or declining/archiving the quote all
 * flip this to false → the reconciler restocks exactly what was taken.
 */
export function quoteHoldsLsgStock(quote, order) {
  if (!quote || quote.status !== 'accepted') return false;
  if (quote.orderId) return !!order && order.status !== 'cancelled';
  return !!quote.depositReceivedAt;
}
