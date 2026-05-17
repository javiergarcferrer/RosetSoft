import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, Plus, Trash2, ExternalLink, Truck, Ban, MoreHorizontal, X,
  FileText, CheckCircle2, Undo2,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import Stepper from '../components/primitives/Stepper.jsx';
import Modal from '../components/Modal.jsx';
import { DebouncedInput, DebouncedTextarea } from '../components/DebouncedInput.jsx';
import { useLiveQuery } from '../db/hooks.js';
import { db, newId, invalidate } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import {
  ORDER_STAGES, ORDER_STAGE_BY_KEY,
  currentOrderStage, nextOrderStage, orderStageIndex,
  canMarkReceived, canDeliverQuote, orderDispatchThreshold,
} from '../lib/orderStages.js';
import {
  STAGES, STAGE_BY_KEY, currentStage, nextStage, stageIndex,
} from '../lib/containerStages.js';

/**
 * One order's detail view — the operational dashboard that ties accepted
 * quotes to the containers fulfilling them.
 *
 * Layout (top to bottom):
 *
 *   1. Order header + status stepper (5 main stages + cancelled).
 *      The stepper drives the order's own state; while in 'ordered' the
 *      containers section below carries the moment-to-moment narrative
 *      until all containers reach 'received' and the order itself can
 *      advance to 'received'.
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
  const { profileId, settings } = useApp();

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

  // Block advance to 'received' until every container has reached its
  // terminal stage. canMarkReceived() enforces both the "containers
  // exist" and "every container is at 'received'" rules. Earlier
  // transitions (accepted → deposit_received → ordered) have no
  // container precondition — the dealer might place the LR order before
  // any container row exists.
  const canAdvance = (() => {
    if (!nxt) return false;
    if (nxt.key === 'received') return canMarkReceived(order, containers);
    return true;
  })();

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
    if (!confirm('¿Reactivar el pedido (estado: Aceptado)?')) return;
    await db.orders.update(orderId, {
      status: 'accepted',
      cancelledAt: null,
      updatedAt: Date.now(),
    });
  }

  async function addContainer() {
    const settings = await db.settings.get(profileId).catch(() => null);
    const number = (settings?.containerCounter || 100) + 1;
    const id = newId();
    const now = Date.now();
    await db.containers.put({
      id,
      profileId,
      orderId,
      number,
      name: '',
      code: '',
      stage: 'filling',
      notes: '',
      createdAt: now,
      updatedAt: now,
    });
    await db.settings.update(profileId, { containerCounter: number, updatedAt: now });
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

  // Roll-up: sum of all quote totals attached to this order. Per the
  // user's rule ("todas las cotizaciones aportan a ese total sin
  // importar a cual contenedor pertenecen") this is order-wide and
  // doesn't try to attribute totals to specific containers.
  const orderTotal = quotes.reduce((acc, q) => acc + (totalByQuote.get(q.id) || 0), 0);

  // Dispatch threshold scales with the number of container rows. Floor
  // of 1 means a fresh order without any containers still gets a
  // meaningful "minimum to place" indicator.
  const perContainerThreshold = Number(settings?.dispatchThreshold) || 50000;
  const { containerCount, threshold } = orderDispatchThreshold(containers, perContainerThreshold);
  const thresholdMet = orderTotal >= threshold;

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
        currentDescription={
          // Show the "blocked by containers" reason when relevant, so the
          // dealer knows why the Advance button isn't available.
          nxt && nxt.key === 'received' && !canMarkReceived(order, containers)
            ? (containers.length === 0
                ? 'Añade al menos un contenedor antes de marcar como recibido.'
                : 'Marcar como recibido requiere que todos los contenedores estén en "Recibido".')
            : stageDef.description
        }
        onAdvance={advance}
        onUndo={undo}
        cancelled={isCancelled}
      />

      {/* Dispatch threshold widget — shown until the order is placed. After
          'ordered' the threshold has served its purpose (the LR order is
          out the door) so we hide it to reduce visual clutter. */}
      {!isCancelled && idx < orderStageIndex('ordered') && (
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
// Container row inside an order. Each container gets its own mini-stepper
// (6 stages) and inline-editable name/code/notes. Advancing or undoing a
// container's stage is local to that container; the order's status is
// independent (the order moves on dealer command, not automatically on
// container progress).
// ---------------------------------------------------------------------------
function ContainerRow({ container }) {
  const stg = currentStage(container);
  const stageDef = STAGE_BY_KEY[stg];
  const idx = stageIndex(stg);
  const nxt = nextStage(stg);
  const prev = idx > 0 ? STAGES[idx - 1] : null;

  async function update(patch) {
    await db.containers.update(container.id, { ...patch, updatedAt: Date.now() });
  }

  async function advance(to) {
    const now = Date.now();
    const patch = { stage: to.key, updatedAt: now };
    if (to.timestampField) patch[to.timestampField] = now;
    await update(patch);
  }

  async function undo(current) {
    if (!prev) return;
    const patch = { stage: prev.key, updatedAt: Date.now() };
    if (current.timestampField) patch[current.timestampField] = null;
    await update(patch);
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
            <span className="text-sm font-semibold">Contenedor #{container.number || '—'}</span>
            <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium ${stageStyle(stg)}`}>
              {stageDef.label}
            </span>
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

      <Stepper
        stages={STAGES}
        currentIndex={idx}
        row={container}
        nextStage={nxt}
        prevStage={prev}
        currentLabel={stageDef.label}
        currentDescription={stageDef.description}
        onAdvance={advance}
        onUndo={undo}
      />
    </li>
  );
}

const STAGE_PILL_STYLES = {
  filling:    'bg-blue-100 text-blue-800',
  submitting: 'bg-amber-100 text-amber-800',
  ordered:    'bg-violet-100 text-violet-800',
  in_transit: 'bg-sky-100 text-sky-800',
  landing:    'bg-orange-100 text-orange-800',
  received:   'bg-emerald-100 text-emerald-800',
};
function stageStyle(stg) {
  return STAGE_PILL_STYLES[stg] || 'bg-ink-100 text-ink-700';
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
function QuoteRow({ quote, order, total, onDetach }) {
  const canDeliver = canDeliverQuote(order);
  const delivered = !!quote.deliveredAt;

  async function toggleDelivered() {
    const patch = delivered
      ? { deliveredAt: null }
      : { deliveredAt: Date.now() };
    await db.quotes.update(quote.id, { ...patch, updatedAt: Date.now() });
  }

  return (
    <li className="px-5 py-3 flex items-center gap-3 flex-wrap">
      <Link
        to={`/quotes/${quote.id}`}
        className="flex-1 min-w-[180px] hover:text-brand-700 transition-colors"
      >
        <div className="text-sm font-semibold truncate">
          #{quote.number || '—'}{quote.name ? ` · ${quote.name}` : ''}
        </div>
        <div className="text-[11px] text-ink-500">
          {delivered
            ? <>Entregada · {formatDateTime(quote.deliveredAt)}</>
            : <>Act. {formatDateTime(quote.updatedAt)}</>}
        </div>
      </Link>

      <div className="text-sm font-medium tabular-nums whitespace-nowrap">
        {formatMoney(total, quote.currencyCode || 'USD', quote.rates || { USD: 1 })}
      </div>

      {/* Delivery toggle — only meaningful after the order is received. */}
      {canDeliver ? (
        <button
          type="button"
          onClick={toggleDelivered}
          title={delivered ? 'Marcar como pendiente' : 'Marcar como entregada al cliente'}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
            delivered
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
              : 'bg-white text-ink-600 border border-ink-200 hover:border-ink-400 hover:text-ink-900'
          }`}
        >
          {delivered ? (
            <>
              <CheckCircle2 size={12} />
              Entregada
            </>
          ) : (
            <>
              Marcar entregada
            </>
          )}
        </button>
      ) : (
        // Order isn't received yet — show the disabled state as a hint so
        // the dealer knows the action exists but isn't ready yet.
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-ink-300 bg-ink-50 border border-ink-100"
          title="Disponible cuando el pedido esté en 'Recibido'."
        >
          Entrega pendiente
        </span>
      )}

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
    </li>
  );
}

// ---------------------------------------------------------------------------
// Dispatch-threshold widget — visible while the order is still being
// filled. Shows the order's running total against `containerCount ×
// per-container minimum`, with a progress bar that turns green once the
// minimum is met. Hidden after the order moves to 'ordered' since the
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
                #{q.number || '—'}{q.name ? ` · ${q.name}` : ''}
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
