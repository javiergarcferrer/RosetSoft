import { Link } from 'react-router-dom';
import { Package, ArrowRight, Plus } from 'lucide-react';
import { useLiveQuery } from '../../db/hooks.js';
import { db, newId, invalidate, nextSequenceNumber } from '../../db/database.js';
import { currentOrderStage, ORDER_STAGE_BY_KEY } from '../../lib/orderStages.js';

/**
 * Order indicator surfaced in the quote header. Three states:
 *
 *   1. Quote isn't accepted yet     → render nothing (no order exists; the
 *                                     status stepper will offer to create
 *                                     one when the dealer flips to 'accepted')
 *   2. Quote accepted, no order yet → "Crear pedido" CTA (one click creates
 *                                     an order with this quote attached)
 *   3. Quote attached to an order   → chip linking to the order detail
 *                                     page, with the order's current stage
 *                                     as a sub-label
 *
 * The chip deliberately does NOT let the dealer re-assign the quote to a
 * different order from here — that's a low-frequency action and lives on
 * the order detail page where the dealer can see both sides of the move.
 */
export default function OrderChip({ quote, profileId, onAttach }) {
  const order = useLiveQuery(
    () => (quote.orderId ? db.orders.get(quote.orderId) : Promise.resolve(null)),
    [quote.orderId],
    null,
  );

  // Quote isn't in a state where attaching to an order makes sense.
  if (quote.status !== 'accepted' && !quote.orderId) return null;

  // Accepted but unattached — offer the one-click create.
  if (!quote.orderId) {
    return (
      <button
        type="button"
        onClick={() => createOrderFromQuote({ quote, profileId, onAttach })}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-brand-700 bg-brand-50 border border-brand-100 hover:bg-brand-100 transition-colors"
      >
        <Plus size={12} />
        Crear pedido
      </button>
    );
  }

  if (!order) {
    // Order id present but the row hasn't loaded yet (or was deleted).
    // Show a quiet placeholder rather than blank space so the layout
    // doesn't shift when the live query resolves.
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-ink-400 bg-ink-50 border border-ink-100">
        <Package size={12} /> Pedido…
      </span>
    );
  }

  const stage = ORDER_STAGE_BY_KEY[currentOrderStage(order)];
  return (
    <Link
      to={`/orders/${order.id}`}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-ink-700 bg-white border border-ink-200 hover:border-ink-400 hover:text-ink-900 transition-colors"
      title={stage?.description}
    >
      <Package size={12} className="text-ink-500" />
      <span className="tabular-nums">Pedido #{order.number ?? order.id.slice(-4)}</span>
      <span className="text-ink-400">·</span>
      <span className="text-ink-500">{stage?.label || order.status}</span>
      <ArrowRight size={11} className="text-ink-400" />
    </Link>
  );
}

/**
 * Spin up a fresh order with this quote attached. The dealer can also
 * later move the quote to a different order from OrderDetail; this is
 * just the happy-path one-click that runs on quote acceptance.
 *
 * The order inherits the quote's customer and a sensible default name
 * ("Pedido — {customer}"). Status starts at 'accepted' since the trigger
 * is precisely the quote-accept event.
 */
async function createOrderFromQuote({ quote, profileId, onAttach }) {
  const id = newId();
  const number = await nextSequenceNumber('orders', profileId, 101);

  // Use the linked customer's name when available so the orders list reads
  // human-meaningfully ("Pedido — García & Asociados") instead of "Pedido O-101".
  let displayName = '';
  if (quote.customerId) {
    const cust = await db.customers.get(quote.customerId).catch(() => null);
    if (cust?.company) displayName = cust.company;
    else if (cust?.name) displayName = cust.name;
  }

  const now = Date.now();
  // New orders start as 'draft' (Borrador) — the order's own lifecycle
  // begins when the dealer is ready to place it with Ligne Roset.
  // Commerce milestones (deposit / balance / delivery) live on the
  // attached quote, not on the order, so we don't pre-record an
  // 'accepted' or 'depositReceived' state here just because a quote
  // got accepted.
  await db.orders.put({
    id,
    profileId,
    number,
    name: displayName,
    customerId: quote.customerId || null,
    status: 'draft',
    notes: '',
    depositAmount: 0,
    deliveryAddress: '',
    createdAt: now,
    updatedAt: now,
  });
  invalidate();
  if (onAttach) onAttach(id);
}
