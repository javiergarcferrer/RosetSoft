// PURE Model for the Shopify orders control center — no React, no db, no
// supabase. Operates on the order shape the `ordersHandler.listOrders` Edge
// Function returns ({ name, displayFulfillmentStatus, lineItems.nodes[],
// fulfillmentOrders.nodes[] … }). Pinned by tests/shopifyOrders.test.js.

export interface ShopifyOrderLineItem { title?: string; quantity?: number; sku?: string | null; }
export interface ShopifyFulfillmentOrderLine { id: string; remainingQuantity?: number; }
export interface ShopifyFulfillmentOrder {
  id: string;
  status?: string;
  lineItems?: { nodes?: ShopifyFulfillmentOrderLine[] };
}
export interface ShopifyOrder {
  id?: string;
  name?: string;
  createdAt?: string;
  displayFinancialStatus?: string;
  displayFulfillmentStatus?: string;
  customer?: { firstName?: string | null; lastName?: string | null } | null;
  lineItems?: { nodes?: ShopifyOrderLineItem[] };
  fulfillmentOrders?: { nodes?: ShopifyFulfillmentOrder[] };
}

export type FulfillmentState = 'unfulfilled' | 'partial' | 'fulfilled';

/**
 * Normalize an order's fulfillment into one of three states. Shopify's
 * `displayFulfillmentStatus` is the source of truth (FULFILLED / PARTIALLY_*
 * / UNFULFILLED / etc.); we collapse it to the three the UI cares about.
 */
export function fulfillmentState(order: ShopifyOrder | null | undefined): FulfillmentState {
  const s = String(order?.displayFulfillmentStatus || '').toUpperCase();
  if (s === 'FULFILLED') return 'fulfilled';
  if (s.includes('PARTIAL')) return 'partial';
  return 'unfulfilled';
}

/**
 * The first open fulfillmentOrder with remaining quantity to fulfill, or null.
 * "Marcar como preparado" targets this id.
 */
export function openFulfillmentOrder(order: ShopifyOrder | null | undefined): ShopifyFulfillmentOrder | null {
  const fos = order?.fulfillmentOrders?.nodes ?? [];
  for (const fo of fos) {
    const status = String(fo?.status || '').toUpperCase();
    if (status === 'CLOSED' || status === 'CANCELLED' || status === 'INCOMPLETE') continue;
    const remaining = (fo?.lineItems?.nodes ?? []).reduce((n, li) => n + (Number(li?.remainingQuantity) || 0), 0);
    if (remaining > 0) return fo;
  }
  return null;
}

/**
 * Can this order be fulfilled right now? True when it's not already fully
 * fulfilled AND there's an open fulfillmentOrder with remaining quantity.
 */
export function canFulfill(order: ShopifyOrder | null | undefined): boolean {
  if (fulfillmentState(order) === 'fulfilled') return false;
  return openFulfillmentOrder(order) != null;
}

export interface OrderTotals { lines: number; units: number; }

/** Item counts for an order: distinct line items and total units. */
export function orderTotals(order: ShopifyOrder | null | undefined): OrderTotals {
  const items = order?.lineItems?.nodes ?? [];
  return {
    lines: items.length,
    units: items.reduce((n, li) => n + (Number(li?.quantity) || 0), 0),
  };
}

/** "First Last" or '' for an order's customer. */
export function customerName(order: ShopifyOrder | null | undefined): string {
  const c = order?.customer;
  if (!c) return '';
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
}
