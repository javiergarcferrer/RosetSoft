// Orders mode for shopify-sync — READ + FULFILL against the 'alcover' store
// (alcoversdq.myshopify.com), where the team's real orders live.
//
// Two operations over the authenticated `gql` (client.ts):
//   • listOrders  — a paged window of recent orders with the fulfillment data a
//                   "mark as prepared" workflow needs (each order's open
//                   fulfillmentOrders + their remaining line quantities).
//   • fulfillOrder — create a fulfillment for one fulfillmentOrder
//                    (fulfillmentCreateV2), optionally for specific lines and/or
//                    with tracking info.
//
// PURE of app code — talks Shopify only through `gql`; returns tidy JSON the
// index.ts shell forwards verbatim. Mirrors the other handlers' shape
// ({ ok, …, error }).

import type { Gql } from './client.ts';

const ORDER_FIELDS = `
  id
  name
  createdAt
  displayFinancialStatus
  displayFulfillmentStatus
  customer { firstName lastName }
  lineItems(first: 50) { nodes { title quantity sku } }
  fulfillmentOrders(first: 10) {
    nodes {
      id
      status
      lineItems(first: 50) { nodes { id remainingQuantity } }
    }
  }
`;

export interface ListOrdersOpts {
  cursor?: string | null;
  limit?: number;
  /** Shopify search query fragment, e.g. 'fulfillment_status:unfulfilled'. */
  status?: string | null;
}

export interface ListOrdersResult {
  ok: boolean;
  orders?: unknown[];
  nextCursor?: string | null;
  error?: string;
}

/**
 * A page of recent orders, newest first. `status` is an optional Shopify search
 * fragment (e.g. 'fulfillment_status:unfulfilled') folded into the query.
 * Returns up to `limit` (clamped 1..50) orders plus the cursor to fetch the next
 * page (null when there are no more).
 */
export async function listOrders(gql: Gql, opts: ListOrdersOpts = {}): Promise<ListOrdersResult> {
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 50);
  const query = String(opts.status || '').trim();
  try {
    const data = await gql<{
      orders: {
        nodes: unknown[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(
      `query ListOrders($first: Int!, $after: String, $query: String) {
        orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
          nodes { ${ORDER_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: limit, after: opts.cursor || null, query: query || null },
    );
    const orders = data.orders?.nodes ?? [];
    const page = data.orders?.pageInfo;
    return {
      ok: true,
      orders,
      nextCursor: page?.hasNextPage ? (page.endCursor ?? null) : null,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface FulfillOrderOpts {
  fulfillmentOrderId: string;
  /** Optional partial fulfillment: [{ id (fulfillmentOrderLineItem id), quantity }]. */
  lineItems?: Array<{ id: string; quantity: number }>;
  /** Optional tracking: { number?, company?, url? }. */
  tracking?: { number?: string; company?: string; url?: string };
}

export interface FulfillOrderResult {
  ok: boolean;
  fulfillment?: unknown;
  error?: string;
}

/**
 * Create a fulfillment for ONE fulfillmentOrder (fulfillmentCreateV2). Omit
 * `lineItems` to fulfill all remaining quantities; pass them to fulfill a
 * subset. `tracking` is forwarded as the fulfillment's trackingInfo. Surfaces a
 * Shopify userError (e.g. already fulfilled) as `{ ok:false, error }`.
 */
export async function fulfillOrder(gql: Gql, opts: FulfillOrderOpts): Promise<FulfillOrderResult> {
  const foId = String(opts.fulfillmentOrderId || '').trim();
  if (!foId) return { ok: false, error: 'Falta el fulfillmentOrderId.' };

  const lineItemsByFulfillmentOrder: Record<string, unknown> = { fulfillmentOrderId: foId };
  if (Array.isArray(opts.lineItems) && opts.lineItems.length) {
    lineItemsByFulfillmentOrder.fulfillmentOrderLineItems = opts.lineItems.map((li) => ({
      id: li.id,
      quantity: Number(li.quantity) || 0,
    }));
  }

  const fulfillment: Record<string, unknown> = {
    lineItemsByFulfillmentOrder: [lineItemsByFulfillmentOrder],
  };
  if (opts.tracking && (opts.tracking.number || opts.tracking.company || opts.tracking.url)) {
    fulfillment.trackingInfo = {
      number: opts.tracking.number || undefined,
      company: opts.tracking.company || undefined,
      url: opts.tracking.url || undefined,
    };
  }

  try {
    const data = await gql<{
      fulfillmentCreateV2: {
        fulfillment: { id: string; status: string } | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(
      `mutation FulfillOrder($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment { id status }
          userErrors { field message }
        }
      }`,
      { fulfillment },
    );
    const res = data.fulfillmentCreateV2;
    const errs = res?.userErrors ?? [];
    if (errs.length) return { ok: false, error: errs.map((e) => e.message).join('; ') };
    if (!res?.fulfillment) return { ok: false, error: 'Shopify no creó la preparación.' };
    return { ok: true, fulfillment: res.fulfillment };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
