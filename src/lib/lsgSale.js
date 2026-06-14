// LSG sale → Shopify decrement mapping (the PUSH half of the two-way sync).
//
// Pure Model: given a quote's lines and a reference→LSG-id map, return the
// inventory adjustments to send to the LifestyleGarden Shopify store when the
// quote is committed to an order — [{ productId: 'lsg-<variantId>', delta: -qty }].
// Pinned by tests/lsgSale.test.js.

import { isPricedLine, isPricedComponent } from './constants.ts';

/**
 * Map a committed quote's PRICED LifestyleGarden lines/components to Shopify
 * inventory decrements. `lsgByRef` maps a product reference (SKU) → its LSG
 * product id (`lsg-<variantId>`); only references present there (brand
 * lifestylegarden) yield an adjustment, so Ligne Roset and free-typed lines are
 * ignored. Optional and non-selected-alternative lines/modules are skipped
 * (isPricedLine/isPricedComponent), so we never decrement a piece the customer
 * didn't actually buy. A compound's component quantities fold in the line qty;
 * a simple line uses its own. Quantities for the same variant are summed, and
 * the result carries NEGATIVE deltas (a sale lowers available stock).
 */
export function lsgSaleAdjustments(lines, lsgByRef) {
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
  return [...byProduct].map(([productId, qty]) => ({ productId, delta: -qty }));
}
