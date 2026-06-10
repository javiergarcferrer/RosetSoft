import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Package, ArrowRight, Plus, ChevronDown } from 'lucide-react';
import { useLiveQuery } from '../../db/hooks.js';
import { db, newId, invalidate, assignSequenceNumber } from '../../db/database.js';
import { currentOrderStage, ORDER_STAGE_BY_KEY } from '../../lib/orderStages.js';

/**
 * Order indicator surfaced in the quote header. Three states:
 *
 *   1. Quote isn't accepted yet     → render nothing (no order exists; the
 *                                     status stepper will offer to attach
 *                                     one when the dealer flips to 'accepted')
 *   2. Quote accepted, no order yet → "Agregar a pedido" menu — the dealer
 *                                     either picks an EXISTING order to assign
 *                                     this quote to, or creates a fresh one.
 *                                     (A quote can ride along with sibling
 *                                     quotes in one order, so "create" is no
 *                                     longer the only door.)
 *   3. Quote attached to an order   → chip linking to the order detail
 *                                     page, with the order's current stage
 *                                     as a sub-label
 *
 * Re-assigning a quote to a DIFFERENT order still lives on the order detail
 * page (detach there, then re-attach) — once it's in an order the chip is a
 * link, not a picker, to keep the common case one tap.
 */
export default function OrderChip({ quote, profileId, onAttach }) {
  const order = useLiveQuery(
    () => (quote.orderId ? db.orders.get(quote.orderId) : Promise.resolve(null)),
    [quote.orderId],
    null,
  );

  // Quote isn't in a state where attaching to an order makes sense.
  if (quote.status !== 'accepted' && !quote.orderId) return null;

  // Accepted but unattached — offer the assign-or-create menu.
  if (!quote.orderId) {
    return <AttachMenu quote={quote} profileId={profileId} onAttach={onAttach} />;
  }

  if (!order) {
    // Order id present but the row hasn't loaded yet (or was deleted).
    // Show a quiet placeholder rather than blank space so the layout
    // doesn't shift when the live query resolves.
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 min-h-7 coarse:min-h-9 rounded-full text-xs text-ink-400 bg-ink-50 border border-ink-100 ring-1 ring-inset ring-black/5">
        <Package size={12} /> Pedido…
      </span>
    );
  }

  const stage = ORDER_STAGE_BY_KEY[currentOrderStage(order)];
  return (
    <Link
      to={`/orders/${order.id}`}
      className="inline-flex items-center gap-1.5 px-2.5 min-h-7 coarse:min-h-9 rounded-full text-xs font-medium text-ink-700 bg-white border border-ink-200 hover:border-ink-400 hover:text-ink-900 hover:bg-ink-50 transition-all active:scale-[0.97] ring-1 ring-inset ring-black/5"
      title={stage?.description}
    >
      <Package size={12} className="text-ink-400 flex-shrink-0" />
      <span className="tabular-nums font-semibold">Pedido #{order.number ?? order.id.slice(-4)}</span>
      {/* Stage label hidden on phones — the order page is one tap
          away if the dealer needs it, and dropping it saves enough
          width that all four chips can land on one line at iPhone
          widths instead of wrapping. */}
      <span className="text-ink-300 hidden sm:inline">·</span>
      <span className="text-ink-400 hidden sm:inline">{stage?.label || order.status}</span>
      <ArrowRight size={11} className="text-ink-300 flex-shrink-0" />
    </Link>
  );
}

/**
 * The accepted-but-unattached affordance: a popover that lists the dealer's
 * open orders (so this quote can join an order that already groups sibling
 * quotes) and a "Crear pedido nuevo" action that spins up a fresh one.
 *
 * Existing orders are filtered to non-cancelled and sorted with the quote's
 * own customer first, so the most-likely target sits at the top — the dealer
 * usually wants the order that already holds this client's other quotes.
 */
function AttachMenu({ quote, profileId, onAttach }) {
  const [open, setOpen] = useState(false);

  const orders = useLiveQuery(
    () =>
      db.orders
        .where('profileId')
        .equals(profileId || '')
        .filter((o) => o.status !== 'cancelled')
        .toArray(),
    [profileId],
    [],
  );

  // Same-customer orders bubble up; within a group, most-recent first.
  const sorted = [...orders].sort((a, b) => {
    const am = a.customerId && a.customerId === quote.customerId ? 0 : 1;
    const bm = b.customerId && b.customerId === quote.customerId ? 0 : 1;
    if (am !== bm) return am - bm;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  function assignTo(orderId) {
    setOpen(false);
    onAttach?.(orderId);
  }

  async function createNew() {
    setOpen(false);
    await createOrderFromQuote({ quote, profileId, onAttach });
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Agregar a pedido"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-2.5 min-h-7 coarse:min-h-9 rounded-full text-xs font-semibold text-brand-700 bg-brand-50 border border-brand-200 hover:bg-brand-100 hover:border-brand-300 transition-all active:scale-[0.97] ring-1 ring-inset ring-brand-200/50"
      >
        <Package size={12} />
        Agregar a pedido
        <ChevronDown size={12} className="text-brand-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="absolute left-0 mt-1.5 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-ink-200 bg-white shadow-pop py-1 z-40"
          >
            {sorted.length > 0 && (
              <>
                <p className="px-3 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                  Asignar a un pedido
                </p>
                <ul className="max-h-64 overflow-y-auto">
                  {sorted.map((o) => {
                    const stage = ORDER_STAGE_BY_KEY[currentOrderStage(o)];
                    return (
                      <li key={o.id}>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => assignTo(o.id)}
                          className="w-full text-left px-3 py-2 hover:bg-brand-50/60 transition-colors flex items-center gap-2.5"
                        >
                          <Package size={14} className="text-ink-400 flex-shrink-0" />
                          <span className="flex-1 min-w-0">
                            <span className="block text-sm font-semibold text-ink-900 truncate">
                              Pedido #{o.number ?? o.id.slice(-4)}
                              {o.name ? ` — ${o.name}` : ''}
                            </span>
                            <span className="block text-[11px] text-ink-400">{stage?.label || o.status}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div className="my-1 border-t border-ink-100" />
              </>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={createNew}
              className="w-full text-left px-3 py-2 hover:bg-brand-50/60 transition-colors inline-flex items-center gap-2.5 text-sm font-semibold text-brand-700"
            >
              <span className="w-3.5 flex justify-center flex-shrink-0">
                <Plus size={14} />
              </span>
              Crear pedido nuevo
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Spin up a fresh order with this quote attached. The dealer can also
 * later move the quote to a different order from OrderDetail; this is
 * the create branch of the accept-time assign-or-create menu.
 *
 * The order inherits the quote's customer and a sensible default name
 * ("Pedido — {customer}"). Status starts at 'draft' since the order's
 * own logistics lifecycle begins when the dealer places it with LR.
 */
async function createOrderFromQuote({ quote, profileId, onAttach }) {
  const id = newId();

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
  // got accepted. The assign-helper retries against the (profile_id,
  // number) unique constraint if two browsers race on the same slot.
  await assignSequenceNumber({
    table: 'orders',
    profileId,
    start: 101,
    build: (number) => ({
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
    }),
  });
  invalidate();
  if (onAttach) onAttach(id);
}
