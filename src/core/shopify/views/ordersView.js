// ViewModel for the Shopify orders control center — PURE projection, no React /
// db / supabase. Turns the raw orders array from the Edge Function into exactly
// what src/pages/ShopifyOrders.jsx renders: filtered + searched rows (with the
// derived fulfillment state, customer, item counts, and the fulfillable target)
// plus the header stats.

import { fulfillmentState, canFulfill, orderTotals, customerName, openFulfillmentOrder } from '../../../lib/shopifyOrders.ts';

/**
 * Project the orders list for one render.
 *   • filter — 'all' | 'unfulfilled' | 'fulfilled' (default 'all').
 *   • search — matches order number or customer name (case-insensitive).
 * Returns { rows, stats:{ total, unfulfilled, fulfilled } }. `stats` counts the
 * WHOLE list (so the toolbar shows true totals); `rows` are filtered + searched.
 */
export function resolveOrdersList(orders, { filter = 'all', search = '' } = {}) {
  const list = Array.isArray(orders) ? orders : [];
  const stats = { total: list.length, unfulfilled: 0, fulfilled: 0 };

  const mapped = list.map((order) => {
    const state = fulfillmentState(order);
    if (state === 'fulfilled') stats.fulfilled += 1;
    else stats.unfulfilled += 1;
    const totals = orderTotals(order);
    const fo = openFulfillmentOrder(order);
    return {
      key: order?.id || order?.name || '',
      order,
      number: order?.name || '',
      customer: customerName(order),
      createdAt: order?.createdAt || '',
      financialStatus: order?.displayFinancialStatus || '',
      state,
      lines: totals.lines,
      units: totals.units,
      canFulfill: canFulfill(order),
      fulfillmentOrderId: fo?.id || null,
    };
  });

  const q = String(search || '').trim().toLowerCase();
  const rows = mapped.filter((r) => {
    if (filter === 'unfulfilled' && r.state === 'fulfilled') return false;
    if (filter === 'fulfilled' && r.state !== 'fulfilled') return false;
    if (q && !(`${r.number} ${r.customer}`.toLowerCase().includes(q))) return false;
    return true;
  });

  return { rows, stats };
}
