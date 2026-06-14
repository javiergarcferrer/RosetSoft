import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Package, ArrowRight, Plus } from 'lucide-react';
import { useLiveQuery } from '../../db/hooks.js';
import { db, newId, invalidate, assignSequenceNumber } from '../../db/database.js';
import { currentOrderStage, ORDER_STAGE_BY_KEY } from '../../lib/orderStages.js';
import { lsgSaleAdjustments } from '../../lib/lsgSale.js';
import { pushLsgInventoryAdjust } from '../../lib/shopifySync.js';
import Modal from '../Modal.jsx';

/**
 * Order indicator for the quote header. It owns its own row (QuoteHeader
 * renders it OUTSIDE the horizontally-scrolling meta strip) so the
 * primary post-accept action is always thumb-reachable on a phone instead
 * of scrolled off the right edge. Three states:
 *
 *   1. Quote isn't accepted yet     → render nothing (no order makes sense
 *                                     yet; the status stepper offers to
 *                                     attach one when the dealer accepts)
 *   2. Quote accepted, no order yet → full-width "Agregar a pedido" CTA
 *                                     (auto-width on desktop) opening a
 *                                     bottom-sheet picker: assign this quote
 *                                     to an EXISTING order, or create a new
 *                                     one. A quote can ride along with
 *                                     sibling quotes in one order, so
 *                                     "create" is no longer the only door.
 *   3. Quote attached to an order   → chip linking to the order detail page
 *                                     with the order's current stage label
 *
 * Re-assigning a quote to a DIFFERENT order still lives on the order detail
 * page (detach there, then re-attach) — once it's in an order the chip is a
 * link, not a picker, to keep the common case one tap.
 */
export default function OrderChip({ quote, profileId, onAttach, inline = false }) {
  const order = useLiveQuery(
    () => (quote.orderId ? db.orders.get(quote.orderId) : Promise.resolve(null)),
    [quote.orderId],
    null,
  );

  // `inline` drops the own-row margin so the chip can sit in the header's
  // status row (opposite the quote number); otherwise it owns its row.
  const wrap = inline ? '' : 'mt-2.5';

  // Quote isn't in a state where attaching to an order makes sense.
  if (quote.status !== 'accepted' && !quote.orderId) return null;

  // Accepted but unattached — the assign-or-create CTA owns the row.
  if (!quote.orderId) {
    return (
      <div className={wrap}>
        <AttachCta quote={quote} profileId={profileId} onAttach={onAttach} inline={inline} />
      </div>
    );
  }

  if (!order) {
    // Order id present but the row hasn't loaded yet (or was deleted).
    // Quiet placeholder so the layout doesn't shift when it resolves.
    return (
      <div className={wrap}>
        <span className="inline-flex items-center gap-1.5 px-2.5 min-h-8 coarse:min-h-11 rounded-full text-xs text-ink-400 bg-ink-50 border border-ink-100 ring-1 ring-inset ring-black/5">
          <Package size={12} /> Pedido…
        </span>
      </div>
    );
  }

  const stage = ORDER_STAGE_BY_KEY[currentOrderStage(order)];
  return (
    <div className={wrap}>
      <Link
        to={`/orders/${order.id}`}
        className="inline-flex items-center gap-1.5 px-3 min-h-8 coarse:min-h-11 rounded-full text-xs font-medium text-ink-700 bg-surface border border-ink-200 hover:border-ink-400 hover:text-ink-900 hover:bg-ink-50 transition-all active:scale-[0.98] ring-1 ring-inset ring-black/5"
        title={stage?.description}
      >
        <Package size={13} className="text-ink-400 flex-shrink-0" />
        <span className="tabular-nums font-semibold">Pedido #{order.number ?? order.id.slice(-4)}</span>
        <span className="text-ink-300">·</span>
        <span className="text-ink-400">{stage?.label || order.status}</span>
        <ArrowRight size={12} className="text-ink-300 flex-shrink-0" />
      </Link>
    </div>
  );
}

/**
 * The accepted-but-unattached affordance: a prominent button (full-width on
 * a phone, auto on desktop) that opens a bottom-sheet / dialog picker. The
 * sheet lists the dealer's open orders so this quote can join one that
 * already groups sibling quotes, plus a "Crear pedido nuevo" action.
 *
 * Why a Modal and not an inline dropdown: the header meta area sits inside
 * an `overflow-x-auto` strip, which would clip an absolutely-positioned
 * popover. The portal-based Modal escapes that and gives a native bottom
 * sheet with full-size touch targets.
 */
function AttachCta({ quote, profileId, onAttach, inline = false }) {
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

  // Same-customer orders bubble to the top (the most likely target — it
  // usually already holds this client's other quotes); within a group,
  // most-recently-touched first.
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
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={inline ? 'btn-brand w-auto whitespace-nowrap !min-h-7 coarse:!min-h-9 !px-2.5 !py-1 !text-xs' : 'btn-brand w-full sm:w-auto'}
      >
        <Package size={inline ? 14 : 16} />
        Agregar a pedido
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Agregar a pedido" size="sm">
        <button
          type="button"
          onClick={createNew}
          className="w-full inline-flex items-center gap-3 px-3 py-3 rounded-xl border border-brand-200 bg-brand-50/60 hover:bg-brand-100/70 active:scale-[0.99] transition-all text-left"
        >
          <span className="w-9 h-9 rounded-full bg-white border border-brand-200 flex items-center justify-center flex-shrink-0">
            <Plus size={18} className="text-brand-600" />
          </span>
          <span className="min-w-0">
            <span className="font-display block text-sm font-semibold text-brand-700">Crear pedido nuevo</span>
            <span className="block text-xs text-ink-400">Inicia un pedido con esta cotización</span>
          </span>
        </button>

        {sorted.length > 0 && (
          <>
            <p className="eyebrow mt-5 mb-2">
              O asignar a un pedido existente
            </p>
            <ul className="divide-y divide-ink-100 -mx-1">
              {sorted.map((o) => {
                const stage = ORDER_STAGE_BY_KEY[currentOrderStage(o)];
                const sameCustomer = o.customerId && o.customerId === quote.customerId;
                return (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => assignTo(o.id)}
                      className="w-full text-left px-3 py-3 hover:bg-brand-50/60 active:scale-[0.99] transition-all rounded-lg flex items-center gap-3"
                    >
                      <span className="w-9 h-9 rounded-full bg-ink-50 border border-ink-100 flex items-center justify-center flex-shrink-0">
                        <Package size={16} className="text-ink-400" />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="font-display block text-sm font-semibold text-ink-900 truncate">
                          Pedido #{o.number ?? o.id.slice(-4)}
                          {o.name ? ` — ${o.name}` : ''}
                        </span>
                        <span className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[11px] text-ink-400">{stage?.label || o.status}</span>
                          {sameCustomer && (
                            <span className="chip text-brand-600 bg-brand-50 border border-brand-100">
                              mismo cliente
                            </span>
                          )}
                        </span>
                      </span>
                      <ArrowRight size={15} className="text-ink-300 flex-shrink-0" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Modal>
    </>
  );
}

/**
 * Spin up a fresh order with this quote attached. The dealer can also
 * later move the quote to a different order from OrderDetail; this is
 * the create branch of the accept-time assign-or-create picker.
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

  // Two-way LSG sync (PUSH): committing the quote to an order means its
  // LifestyleGarden pieces are sold, so decrement them on the LSG Shopify store
  // — its live storefront can't then oversell the same unit. Creating the order
  // is a once-per-quote action (the chip flips to the attached order after), so
  // this fires once. Best-effort and fully detached: a Shopify hiccup, a
  // missing scope, or no LSG lines never blocks or delays the order.
  pushLsgSaleFor(quote).catch(() => {});
}

/**
 * Resolve a quote's PRICED LifestyleGarden lines to Shopify decrements and push
 * them. Loads the quote's lines + the LSG catalog (to map a line's SKU back to
 * its `lsg-<variantId>` id), then hands off to pushLsgInventoryAdjust. Pure
 * mapping lives in lib/lsgSale (lsgSaleAdjustments), pinned by tests.
 */
async function pushLsgSaleFor(quote) {
  const lines = await db.quoteLines.where('quoteId').equals(quote.id).toArray();
  const refs = new Set();
  for (const l of lines) {
    if (l.reference) refs.add(l.reference);
    for (const c of l.components || []) if (c?.reference) refs.add(c.reference);
  }
  if (!refs.size) return;
  const lsg = await db.products.where('brand').equals('lifestylegarden').toArray();
  const lsgByRef = new Map();
  for (const p of lsg) if (refs.has(p.reference)) lsgByRef.set(p.reference, p.id);
  if (!lsgByRef.size) return;
  const adjustments = lsgSaleAdjustments(lines, lsgByRef);
  if (adjustments.length) await pushLsgInventoryAdjust(adjustments);
}
