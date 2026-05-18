import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, Plus, Trash2, ExternalLink, Truck, Ban, MoreHorizontal, X,
  FileText, CheckCircle2, Package, DollarSign, Wallet,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import Stepper from '../components/primitives/Stepper.jsx';
import Modal from '../components/Modal.jsx';
import { DebouncedInput, DebouncedTextarea } from '../components/DebouncedInput.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId, invalidate, nextSequenceNumber } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import {
  ORDER_STAGES, ORDER_STAGE_BY_KEY,
  currentOrderStage, nextOrderStage, orderStageIndex,
  canAdvanceOrder, advanceBlockedReason, orderDispatchThreshold,
} from '../lib/orderStages.js';
import {
  canMarkDeposit, canMarkBalance, canMarkDelivered, deliveryBlockedReason,
} from '../lib/quoteMilestones.js';

/**
 * One order's detail view — the operational dashboard that ties accepted
 * quotes to the containers fulfilling them.
 *
 * Layout (top to bottom):
 *
 *   1. Order header + status stepper (5 main stages + cancelled).
 *      The order's lifecycle has six stages (draft → placed → confirmed
 *      → in_transit → in_customs → received). The dealer drives each
 *      transition manually; the only gated step is the last one, which
 *      requires every attached container to be marked filled.
 *
 *   2. Order info card — customer + deposit + delivery address + notes.
 *
 *   3. Containers section — every container in this order, each rendered
 *      as its own card with a 6-stage container stepper. Each container
 *      can be advanced/undone independently. Add a new container with the
 *      header button.
 *
 *   4. Quotes section — every quote attached to this order. Attaching
 *      pulls from the quotes that aren't yet in an order (and that match
 *      the order's customer if set, so the dealer doesn't accidentally
 *      mix customers).
 */
export default function OrderDetail() {
  const { orderId } = useParams();
  const { profileId, settings, profiles } = useApp();

  const order = useLiveQuery(() => db.orders.get(orderId), [orderId], null);

  const customer = useLiveQuery(
    () => (order?.customerId ? db.customers.get(order.customerId) : Promise.resolve(null)),
    [order?.customerId],
    null,
  );

  const containers = useLiveQuery(
    () => db.containers.where('orderId').equals(orderId).toArray(),
    [orderId],
    [],
  );

  const quotes = useLiveQuery(
    () => db.quotes.where('orderId').equals(orderId).toArray(),
    [orderId],
    [],
  );

  // For the quote attach picker
  const unattachedQuotes = useLiveQuery(
    () => db.quotes.where('profileId').equals(profileId || '').filter((q) => !q.orderId).toArray(),
    [profileId],
    [],
  );

  // Per-quote totals
  const allLines = useLiveQuery(() => db.quoteLines.toArray(), [], []);
  const totalByQuote = useMemo(() => {
    const m = new Map();
    for (const l of allLines) m.set(l.quoteId, (m.get(l.quoteId) || 0) + (l.qty || 0) * (l.unitPrice || 0));
    return m;
  }, [allLines]);

  const [picker, setPicker] = useState(false);

  if (!order) {
    return (
      <div className="card card-pad text-center text-sm text-ink-500">
        Cargando pedido…
      </div>
    );
  }

  const stage = currentOrderStage(order);
  const stageDef = ORDER_STAGE_BY_KEY[stage];
  const isCancelled = stage === 'cancelled';
  const nxt = isCancelled ? null : nextOrderStage(stage);
  const idx = orderStageIndex(stage);

  // Roll-up: sum of all quote totals attached to this order. Per the
  // dealer's rule ("todas las cotizaciones aportan a ese total sin
  // importar a cual contenedor pertenecen") this is order-wide and
  // doesn't try to attribute totals to specific containers.
  const orderTotal = quotes.reduce((acc, q) => acc + (totalByQuote.get(q.id) || 0), 0);

  // Dispatch threshold scales with the number of container rows. Floor
  // of 1 means a fresh order without any containers still gets a
  // meaningful "minimum to place" indicator.
  const perContainerThreshold = Number(settings?.dispatchThreshold) || 50000;
  const { containerCount, threshold } = orderDispatchThreshold(containers, perContainerThreshold);
  const thresholdMet = orderTotal >= threshold;

  // Two gates fire on stage advance:
  //   • draft → placed   blocked when orderTotal < threshold (the
  //                      dispatch minimum the dealer set in Settings).
  //                      LR rejects under-minimum orders, so the app
  //                      enforces it client-side rather than letting
  //                      the dealer hit "Avanzar" and get a bounce.
  //   • in_customs → received   blocked unless every container is
  //                      packed (each has a filledAt timestamp).
  // The helpers in orderStages.js carry both rules so the OrderDetail
  // page doesn't have to know them per-transition.
  const gateOpts = { totalAmount: orderTotal, threshold };
  const canAdvance = canAdvanceOrder(order, containers, gateOpts);
  const blockedReason = advanceBlockedReason(order, containers, gateOpts);

  async function updateOrder(patch) {
    await db.orders.update(orderId, { ...patch, updatedAt: Date.now() });
  }

  async function advance(to) {
    if (!canAdvance) return;
    const now = Date.now();
    const patch = { status: to.key, updatedAt: now };
    if (to.timestampField) patch[to.timestampField] = now;
    await db.orders.update(orderId, patch);
  }

  async function undo(current) {
    const currentIdx = orderStageIndex(stage);
    const prev = currentIdx > 0 ? ORDER_STAGES[currentIdx - 1] : null;
    if (!prev) return;
    const patch = { status: prev.key, updatedAt: Date.now() };
    if (current.timestampField) patch[current.timestampField] = null;
    await db.orders.update(orderId, patch);
  }

  async function cancelOrder() {
    if (!confirm('¿Cancelar el pedido? Las cotizaciones quedarán libres pero no se eliminan.')) return;
    await db.orders.update(orderId, {
      status: 'cancelled',
      cancelledAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async function uncancel() {
    if (!confirm('¿Reactivar el pedido (estado: Borrador)?')) return;
    // Reactivated orders go back to draft — the dealer re-drives the
    // lifecycle from there. The previous flow restored to 'accepted'
    // which is no longer a valid order status.
    await db.orders.update(orderId, {
      status: 'draft',
      cancelledAt: null,
      updatedAt: Date.now(),
    });
  }

  async function addContainer() {
    const number = await nextSequenceNumber('containers', profileId, 101);
    const id = newId();
    const now = Date.now();
    // Containers are now structurally just an identifier + a single
    // filledAt timestamp (nullable). No stage machine, no per-stage
    // timestamps. The dealer marks each as packed when they pack it.
    await db.containers.put({
      id,
      profileId,
      orderId,
      number,
      name: '',
      code: '',
      filledAt: null,
      notes: '',
      createdAt: now,
      updatedAt: now,
    });
    invalidate();
  }

  async function attachQuote(quoteId) {
    await db.quotes.update(quoteId, { orderId, updatedAt: Date.now() });
    invalidate();
    setPicker(false);
  }

  async function detachQuote(quoteId) {
    if (!confirm('¿Quitar la cotización de este pedido? La cotización seguirá existiendo.')) return;
    await db.quotes.update(quoteId, { orderId: null, updatedAt: Date.now() });
    invalidate();
  }

  // The previous main-track stage (for the "Volver" undo button).
  const prev = idx > 0 ? ORDER_STAGES[idx - 1] : null;

  return (
    <>
      <Link to="/orders" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 mb-3">
        <ArrowLeft size={12} /> Volver
      </Link>
      <PageHeader
        title={`Pedido #${order.number || order.id.slice(-4)}`}
        subtitle={`${stageDef.label} · ${quotes.length} cotización${quotes.length === 1 ? '' : 'es'} · Actualizado ${formatDateTime(order.updatedAt)}`}
        actions={
          <OrderOverflow
            cancelled={isCancelled}
            onCancel={cancelOrder}
            onUncancel={uncancel}
          />
        }
      />

      <Stepper
        stages={ORDER_STAGES}
        currentIndex={idx}
        row={order}
        nextStage={canAdvance ? nxt : null}
        prevStage={prev}
        currentLabel={stageDef.label}
        // When the advance button is disabled, replace the stage's
        // description with the precise reason (no container yet, or
        // some containers still unpacked) so the dealer can act on it.
        currentDescription={blockedReason || stageDef.description}
        onAdvance={advance}
        onUndo={undo}
        cancelled={isCancelled}
      />

      {/* Dispatch threshold widget — shown until the order is placed. After
          'placed' the threshold has served its purpose (the LR order is
          out the door) so we hide it to reduce visual clutter. */}
      {/* Threshold widget is useful while the dealer is still building
          the order toward the LR-side minimum. Once the order is
          actually placed with LR ('placed' and beyond), the minimum
          has served its purpose and the widget would just be clutter. */}
      {!isCancelled && idx < orderStageIndex('placed') && (
        <DispatchThresholdCard
          containerCount={containerCount}
          threshold={threshold}
          orderTotal={orderTotal}
          thresholdMet={thresholdMet}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Containers section */}
          <section className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-ink-100 flex items-center justify-between">
              <div className="min-w-0">
                <h2 className="font-semibold flex items-center gap-2">
                  <Truck size={16} className="text-ink-500" />
                  Contenedores ({containers.length})
                </h2>
                <p className="text-[11px] text-ink-500 mt-0.5">
                  Cada contenedor sigue su propio ciclo de despacho. Un pedido
                  puede tener varios contenedores cuando los artículos llegan
                  en envíos separados.
                </p>
              </div>
              <button onClick={addContainer} className="btn-secondary flex-shrink-0">
                <Plus size={14} /> Contenedor
              </button>
            </div>
            {containers.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-ink-500">
                Sin contenedores aún. Crea uno cuando recibas la confirmación
                de envío de Ligne Roset.
              </div>
            ) : (
              <ul className="divide-y divide-ink-100">
                {containers.map((c) => (
                  <ContainerRow
                    key={c.id}
                    container={c}
                    orderId={orderId}
                  />
                ))}
              </ul>
            )}
          </section>

          {/* Quotes section */}
          <section className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-ink-100 flex items-center justify-between">
              <div className="min-w-0">
                <h2 className="font-semibold flex items-center gap-2">
                  <FileText size={16} className="text-ink-500" />
                  Cotizaciones ({quotes.length})
                </h2>
                <p className="text-[11px] text-ink-500 mt-0.5">
                  Las ventas que componen este pedido. Suma {formatMoney(orderTotal, 'USD', { USD: 1 })}.
                </p>
              </div>
              <button onClick={() => setPicker(true)} className="btn-secondary flex-shrink-0">
                <Plus size={14} /> Cotización
              </button>
            </div>
            {quotes.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-ink-500">
                Sin cotizaciones. Acepta una desde la cotización o añade una existente.
              </div>
            ) : (
              <ul className="divide-y divide-ink-100">
                {quotes.map((q) => (
                  <QuoteRow
                    key={q.id}
                    quote={q}
                    order={order}
                    creator={q.createdByUserId ? profiles.find((p) => p.id === q.createdByUserId) : null}
                    total={totalByQuote.get(q.id) || 0}
                    onDetach={() => detachQuote(q.id)}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Sidebar — order metadata */}
        <aside className="space-y-4">
          <div className="card card-pad space-y-3">
            <h2 className="font-semibold text-sm">Información</h2>
            <div>
              <div className="label">Nombre</div>
              <DebouncedInput
                className="input"
                value={order.name || ''}
                onCommit={(v) => updateOrder({ name: v })}
                placeholder='e.g. "García — Sala 2026"'
              />
            </div>
            <div>
              <div className="label">Cliente principal</div>
              <CustomerLink customer={customer} />
            </div>
            <div>
              <div className="label">Depósito recibido (USD)</div>
              <DebouncedInput
                className="input"
                type="number"
                inputMode="decimal"
                min="0"
                step="100"
                value={order.depositAmount ?? 0}
                onCommit={(v) => updateOrder({ depositAmount: Math.max(0, Number(v) || 0) })}
              />
            </div>
            <div>
              <div className="label">Dirección de entrega</div>
              <DebouncedTextarea
                className="input min-h-[60px]"
                value={order.deliveryAddress || ''}
                onCommit={(v) => updateOrder({ deliveryAddress: v })}
                autoCapitalize="words"
              />
            </div>
            <div>
              <div className="label">Notas</div>
              <DebouncedTextarea
                className="input min-h-[60px]"
                value={order.notes || ''}
                onCommit={(v) => updateOrder({ notes: v })}
                autoCapitalize="sentences"
              />
            </div>
          </div>
        </aside>
      </div>

      {/* Attach-quote picker */}
      <Modal
        open={picker}
        onClose={() => setPicker(false)}
        title="Añadir cotización al pedido"
        size="md"
      >
        <QuoteAttachList
          candidates={unattachedQuotes}
          onPick={attachQuote}
          totalByQuote={totalByQuote}
        />
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Container row — collapsed from a 6-stage stepper to a single "Lleno"
// toggle plus inline-editable name + container code. The dealer's words:
// "Los contenedores no tienen estatus cambiantes. Solo se marca si están
// llenos." A container is now structurally just an identifier with one
// boolean event — packed at the warehouse, yes or no. All the shipping
// narrative that used to live per-container moved up to the order
// (placed → confirmed → in_transit → in_customs → received).
// ---------------------------------------------------------------------------
function ContainerRow({ container }) {
  const filled = !!container.filledAt;

  async function update(patch) {
    await db.containers.update(container.id, { ...patch, updatedAt: Date.now() });
  }

  async function toggleFilled() {
    // Toggling un-marks on second click so the dealer can correct a
    // misfire — same affordance the quote-milestone toggles use below.
    await update({ filledAt: filled ? null : Date.now() });
  }

  async function del() {
    if (!confirm(`¿Eliminar el contenedor #${container.number}?`)) return;
    await db.containers.delete(container.id);
  }

  return (
    <li className="px-5 py-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center gap-2 flex-wrap">
            <Package size={14} className="text-ink-500" />
            <span className="text-sm font-semibold">Contenedor #{container.number || '—'}</span>
            {filled ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[10px] font-medium">
                <CheckCircle2 size={11} /> Lleno · {formatDateTime(container.filledAt)}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-md bg-ink-100 text-ink-600 px-2 py-0.5 text-[10px] font-medium">
                Por llenar
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
            <DebouncedInput
              className="input"
              placeholder='Nombre (e.g. "Cont. Marzo")'
              value={container.name || ''}
              onCommit={(v) => update({ name: v })}
            />
            <DebouncedInput
              className="input font-mono text-xs"
              placeholder="MSCU1234567"
              value={container.code || ''}
              onCommit={(v) => update({ code: v })}
            />
          </div>
        </div>
        <button
          onClick={del}
          className="text-ink-400 hover:text-red-600 p-1.5"
          title="Eliminar contenedor"
          aria-label="Eliminar contenedor"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div>
        <button
          type="button"
          onClick={toggleFilled}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            filled
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
              : 'btn-primary'
          }`}
        >
          {filled ? (
            <><CheckCircle2 size={12} /> Lleno — desmarcar</>
          ) : (
            <><Package size={12} /> Marcar lleno</>
          )}
        </button>
      </div>
    </li>
  );
}

function CustomerLink({ customer }) {
  if (!customer) {
    return <div className="text-sm text-ink-400">Sin cliente asignado</div>;
  }
  return (
    <Link
      to={`/customers`}
      className="text-sm text-ink-900 hover:text-brand-700 transition-colors"
    >
      {customer.name}
      {customer.company ? <span className="text-ink-500"> · {customer.company}</span> : null}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Quote row inside an order's quote list. The per-quote delivery toggle is
// the *only* fulfillment milestone we surface on a quote anymore — the
// other 4 milestones from the old FulfillmentPills moved to the order
// level (deposit, ordering, reception) or were dropped (notification,
// final balance — those are status of the customer relationship, not the
// workflow object).
//
// The toggle only renders after the parent order reaches 'received';
// before then the customer's pieces are still on a boat (or not yet
// ordered) so handing them over isn't possible.
// ---------------------------------------------------------------------------
function QuoteRow({ quote, order, creator, total, onDetach }) {
  // Three commerce milestones live on the quote (not the order):
  //
  //   1. depositReceivedAt — the act of receiving the deposit IS what
  //      the dealer calls "confirming" the cotización; it isn't a
  //      separate quote status.
  //   2. balancePaidAt — must be marked before delivery. Goods don't
  //      leave the warehouse until the customer has paid.
  //   3. deliveredAt — the customer has taken physical delivery.
  //
  // Each step has its own toggle button. Buttons are enabled only
  // when their precondition is met (per canMark…); when disabled
  // they show a subdued state with a tooltip explaining why.
  const deposit   = !!quote.depositReceivedAt;
  const balance   = !!quote.balancePaidAt;
  const delivered = !!quote.deliveredAt;
  const creatorLabel = creator
    ? (creator.name?.trim() || creator.email?.split('@')[0] || '')
    : '';

  async function setMilestone(field, on) {
    await db.quotes.update(quote.id, {
      [field]: on ? Date.now() : null,
      updatedAt: Date.now(),
    });
  }

  return (
    <li className="px-5 py-3 space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <Link
          to={`/quotes/${quote.id}`}
          className="flex-1 min-w-[180px] hover:text-brand-700 transition-colors"
        >
          <div className="text-sm font-semibold truncate">
            #{quote.number || '—'}
            {creatorLabel && (
              <span className="ml-2 text-[11px] font-normal text-ink-500">
                · creada por {creatorLabel}
              </span>
            )}
          </div>
          <div className="text-[11px] text-ink-500">
            Act. {formatDateTime(quote.updatedAt)}
          </div>
        </Link>
        <div className="text-sm font-medium tabular-nums whitespace-nowrap">
          {formatMoney(total, quote.currencyCode || 'USD', quote.rates || { USD: 1 })}
        </div>
        <button
          onClick={onDetach}
          className="text-ink-400 hover:text-red-600 p-1.5"
          title="Quitar del pedido"
          aria-label="Quitar del pedido"
        >
          <X size={14} />
        </button>
        <Link
          to={`/quotes/${quote.id}`}
          className="text-ink-400 hover:text-ink-900 p-1.5"
          title="Abrir cotización"
        >
          <ExternalLink size={14} />
        </Link>
      </div>

      {/* Milestone strip — three pills shown in chronological order.
          Reads top-to-bottom as the quote's commerce timeline. Each
          pill is a button that toggles the milestone on/off (off
          available so the dealer can correct typos). Disabled state
          uses the same dimming + tooltip pattern as the original
          delivery gate. */}
      <div className="flex flex-wrap items-center gap-2">
        <MilestonePill
          icon={Wallet}
          label="Depósito"
          done={deposit}
          doneAt={quote.depositReceivedAt}
          enabled={canMarkDeposit(quote) || deposit}
          disabledHint={
            !quote.status || quote.status !== 'accepted'
              ? 'Disponible cuando la cotización esté aceptada.'
              : null
          }
          onToggle={() => setMilestone('depositReceivedAt', !deposit)}
        />
        <MilestonePill
          icon={DollarSign}
          label="Balance"
          done={balance}
          doneAt={quote.balancePaidAt}
          enabled={canMarkBalance(quote) || balance}
          disabledHint={!deposit ? 'Marca el depósito primero.' : null}
          onToggle={() => setMilestone('balancePaidAt', !balance)}
        />
        <MilestonePill
          icon={CheckCircle2}
          label="Entregada"
          done={delivered}
          doneAt={quote.deliveredAt}
          enabled={canMarkDelivered(quote, order) || delivered}
          disabledHint={deliveryBlockedReason(quote, order)}
          onToggle={() => setMilestone('deliveredAt', !delivered)}
          tone="emerald"
        />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Individual milestone pill — three of these render per quote row.
// `enabled` controls whether the click handler fires; `disabledHint`
// shows up as the title (tooltip) when disabled so the dealer can see
// what's preventing the action.
//
// Three visual states:
//   • done — emerald background, check icon, includes timestamp.
//   • enabled & not done — outlined white pill with the milestone icon.
//   • disabled & not done — subdued gray pill, tooltip explains why.
// ---------------------------------------------------------------------------
function MilestonePill({ icon: Icon, label, done, doneAt, enabled, disabledHint, onToggle, tone }) {
  if (done) {
    const doneClass = tone === 'emerald'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
      : 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100';
    return (
      <button
        type="button"
        onClick={onToggle}
        title="Clic para desmarcar"
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${doneClass}`}
      >
        <CheckCircle2 size={12} />
        <span>{label}</span>
        {doneAt ? (
          <span className="text-emerald-600 opacity-80 hidden sm:inline">
            · {formatDateTime(doneAt)}
          </span>
        ) : null}
      </button>
    );
  }
  if (!enabled) {
    return (
      <span
        title={disabledHint || ''}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-ink-300 bg-ink-50 border border-ink-100"
      >
        <Icon size={12} />
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      title={`Marcar ${label.toLowerCase()}`}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-white text-ink-700 border border-ink-200 hover:border-ink-400 hover:text-ink-900 transition-colors"
    >
      <Icon size={12} />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Dispatch-threshold widget — visible while the order is still being
// filled. Shows the order's running total against `containerCount ×
// per-container minimum`, with a progress bar that turns green once the
// minimum is met. Hidden after the order moves to 'placed' since the
// threshold has served its purpose by then.
//
// The container count comes from the actual number of container rows
// (with a floor of 1 — see orderDispatchThreshold). When the dealer adds
// a second container the threshold doubles; the dealer doesn't enter a
// number manually anywhere.
// ---------------------------------------------------------------------------
function DispatchThresholdCard({ containerCount, threshold, orderTotal, thresholdMet }) {
  const pct = threshold > 0 ? Math.min(100, (orderTotal / threshold) * 100) : 0;
  return (
    <div className="card card-pad mt-4 space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-500">
            Mínimo de despacho
          </div>
          <div className="text-sm font-semibold mt-0.5">
            {containerCount === 1
              ? '1 contenedor'
              : `${containerCount} contenedores`}
            <span className="text-ink-500 font-normal"> · {formatMoney(threshold, 'USD', { USD: 1 })}</span>
          </div>
        </div>
        <div className="text-right">
          <div className={`text-sm font-medium tabular-nums ${thresholdMet ? 'text-emerald-600' : 'text-ink-700'}`}>
            {formatMoney(orderTotal, 'USD', { USD: 1 })}
          </div>
          <div className="text-[11px] text-ink-500">{Math.round(pct)}% del mínimo</div>
        </div>
      </div>
      <div className="h-2 bg-ink-100 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all ${thresholdMet ? 'bg-emerald-500' : 'bg-brand-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[11px] text-ink-500">
        El mínimo se multiplica por el número de contenedores en el pedido.
        Todas las cotizaciones aportan al total, sin importar a cuál contenedor pertenezcan.
      </p>
    </div>
  );
}

function QuoteAttachList({ candidates, onPick, totalByQuote }) {
  if (!candidates.length) {
    return (
      <div className="text-sm text-ink-500 text-center py-8">
        No hay cotizaciones disponibles. Acepta una cotización para vincularla aquí.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-ink-100">
      {candidates.map((q) => (
        <li key={q.id}>
          <button
            type="button"
            onClick={() => onPick(q.id)}
            className="w-full text-left px-3 py-3 hover:bg-ink-50 transition-colors flex items-center gap-3"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate">
                #{q.number || '—'}
              </div>
              <div className="text-[11px] text-ink-500">
                {q.status} · {formatDateTime(q.updatedAt)}
              </div>
            </div>
            <div className="text-sm font-medium tabular-nums">
              {formatMoney(totalByQuote.get(q.id) || 0, q.currencyCode || 'USD', q.rates || { USD: 1 })}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function OrderOverflow({ cancelled, onCancel, onUncancel }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn-icon"
        aria-label="Más acciones"
        aria-haspopup="menu"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 mt-1.5 w-48 rounded-md border border-ink-200 bg-white shadow-pop py-1 z-40">
            {cancelled ? (
              <button
                type="button"
                onClick={() => { onUncancel(); setOpen(false); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-ink-50 inline-flex items-center gap-2"
              >
                <Plus size={14} className="text-ink-500" />
                Reactivar pedido
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { onCancel(); setOpen(false); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-rose-50 text-rose-600 inline-flex items-center gap-2"
              >
                <Ban size={14} />
                Cancelar pedido
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
