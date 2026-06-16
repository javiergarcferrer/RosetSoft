import { createContext } from 'react';

/**
 * The LSG units THIS quote already holds on the brand store, keyed by product
 * id (`{ 'lsg-<variantId>': units }`) — the quote's committed reservation from
 * `lsg_stock_commitments` (see lib/lsgStock). Provided by the quote `Workspace`
 * and read by `LineStockNotice` so a quote whose deposit deducted its pieces
 * adds them BACK before gating: the store's live `stockQty` is net of this
 * quote's own deduction, so without the add-back the quote that CAUSED the
 * deduction would falsely warn "insufficient stock" against the figure it
 * lowered. A draft / un-committed quote has no row → the empty default → 0.
 *
 * Its own module (like FamiliesContext) so provider + consumers don't import a
 * context out of the 2k-LOC line-item UI.
 */
export const HeldStockContext = createContext(/** @type {Record<string, number>} */ ({}));
