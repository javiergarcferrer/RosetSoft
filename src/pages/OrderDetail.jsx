import { userMessageFor } from '../lib/errorMessages.js';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Plus, Trash2, ExternalLink, Truck, Ban, MoreHorizontal, X,
  FileText, CheckCircle2, Package, DollarSign, Wallet,
  AlertCircle, FileDown, Loader2,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import BackLink from '../components/BackLink.jsx';
import Dropdown, { DropdownItem } from '../components/primitives/Dropdown.jsx';
import Stepper from '../components/primitives/Stepper.jsx';
import Modal from '../components/Modal.jsx';
import { DebouncedInput } from '../components/DebouncedInput.jsx';
import { useLiveQuery, useLiveQueryStatus } from '../db/hooks.js';
import EmptyState from '../components/EmptyState.jsx';
import { SheetErrorBanner } from '../components/sheet/cells.jsx';
import { useToast } from '../components/ConfirmProvider.jsx';
import { db, newId, invalidate, assignSequenceNumber } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { displayRatesFor } from '../lib/exchangeRate.js';
import { ORDER_STAGES, orderStageIndex } from '../lib/orderStages.js';
import {
  canMarkDeposit, canMarkBalance, canMarkDelivered, deliveryBlockedReason,
} from '../lib/quoteMilestones.js';
import {
  validateContainerNo, detectCarrier, normalizeContainerNo,
} from '../lib/containerTracking.js';
import ContainerTracking from '../components/ContainerTracking.jsx';
import { reconcileQuoteStock, reconcileOrderStock } from '../lib/lsgStock.js';
import { resolveOrderDetail } from '../core/quote/views/detail.js';
import { viewerCompanySettings } from '../core/quote/index.js';
import { resolveOrderRegistration } from '../core/quote/views/registration.js';
import { safeDynamicImport } from '../lib/dynamicImport.js';

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
 *   2. Containers section — every container in this order. Each shows a
 *      fill toggle and its ISO 6346 number; a valid number tracks itself
 *      automatically (Hapag-Lloyd Track & Trace) with a voyage map and a
 *      dropdown of every tracking point. Add a container with the header
 *      button.
 *
 *   3. Quotes section — every quote attached to this order. Attaching
 *      pulls from the quotes that aren't yet in an order (and that match
 *      the order's customer if set, so the dealer doesn't accidentally
 *      mix customers).
 */
export default function OrderDetail() {
  const { orderId } = useParams();
  const { profileId, settings, profiles, isAdmin } = useApp();

  const { data: order, loaded: orderLoaded } = useLiveQueryStatus(
    () => db.orders.get(orderId), [orderId], null,
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

  // For the quote attach picker — only ACCEPTED, unattached quotes are
  // eligible. A pedido is built from quotes the client has signed off on;
  // offering drafts/sent quotes here would let unconfirmed work slip into
  // an order.
  const unattachedQuotes = useLiveQuery(
    () =>
      db.quotes
        .where('profileId')
        .equals(profileId || '')
        .filter((q) => !q.orderId && q.status === 'accepted')
        .toArray(),
    [profileId],
    [],
  );

  // Customers for this profile, indexed (in the ViewModel) by id — used to
  // label each quote (attached and candidate) with its client name.
  const customers = useLiveQuery(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );

  // Lines drive the per-quote grand-total roll-up.
  const allLines = useLiveQuery(() => db.quoteLines.toArray(), [], []);

  // Professionals label each quote's decorator on the LR registration doc.
  const professionals = useLiveQuery(
    () => db.professionals.where('profileId').equals(profileId || '').toArray(),
    [profileId],
    [],
  );

  // The ViewModel: per-quote totals (attached + the unattached attach-picker
  // candidates), the customer index, the order-wide total, the dispatch-
  // threshold figures and the stage machine (current/next/prev + the advance
  // gates). Tolerates a null `order` so it can run above the loading guard.
  const vm = useMemo(
    () => resolveOrderDetail({
      order,
      quotes,
      unattachedQuotes,
      containers,
      customers,
      lines: allLines,
      // Company-account cost is admin-only here too; tax-exemption is preserved.
      settings: viewerCompanySettings(settings, isAdmin),
    }),
    [order, quotes, unattachedQuotes, containers, customers, allLines, settings, isAdmin],
  );

  const [picker, setPicker] = useState(false);
  const [registering, setRegistering] = useState(false);
  // Last failed action, surfaced in an inline banner (no native alert). A
  // mutating handler that throws sets this; the banner dismisses on its X or
  // on the next successful action.
  const [error, setError] = useState('');
  const toast = useToast();

  // "Registro LR" — the simple reference·product·qty document (grouped per
  // quote with customer/decorator/seller) the dealer uses to register this
  // pedido with Ligne Roset. Pure projection (resolveOrderRegistration) +
  // the code-split PDF renderer; explicitly NOT an invoice.
  async function exportRegistration() {
    if (registering) return;
    setRegistering(true);
    try {
      const { generateOrderRegistrationPdf, downloadBlob } = await safeDynamicImport(
        () => import('../pdf/order/index.js'),
      );
      const data = resolveOrderRegistration({
        order, quotes, lines: allLines, customers, professionals, profiles,
      });
      if (data.rowCount === 0) {
        setError('No hay artículos para registrar — añade cotizaciones con líneas al pedido.');
        return;
      }
      const blob = await generateOrderRegistrationPdf({
        companyName: settings?.companyName || '',
        ...data,
      });
      await downloadBlob(blob, `Registro LR Pedido ${order?.number ? `#${order.number}` : ''}`.trim() + '.pdf');
      setError('');
    } catch (e) {
      setError(userMessageFor(e));
    } finally {
      setRegistering(false);
    }
  }

  if (!order) {
    // Distinguish first-fetch-in-flight from a genuinely missing record: a
    // deleted/bad id used to spin "Cargando pedido…" forever.
    if (!orderLoaded) {
      return (
        <div className="card card-pad py-16 flex flex-col items-center gap-3 text-center">
          <span className="w-11 h-11 rounded-full bg-ink-50 flex items-center justify-center">
            <Package size={20} className="text-ink-300" />
          </span>
          <p className="text-sm text-ink-500">Cargando pedido…</p>
        </div>
      );
    }
    return (
      <>
        <BackLink to="/orders">Volver a pedidos</BackLink>
        <EmptyState
          icon={Package}
          title="Pedido no encontrado"
          description="Este pedido no existe o fue eliminado."
          action={<Link to="/orders" className="btn-brand">Ver pedidos</Link>}
        />
      </>
    );
  }

  const {
    customerById, totalByQuote,
    stage, stageDef, isCancelled, nxt, idx, prev,
    orderTotal, containerCount, threshold, thresholdMet,
    canAdvance, blockedReason,
  } = vm;

  async function advance(to) {
    if (!canAdvance) return;
    const now = Date.now();
    const patch = { status: to.key, updatedAt: now };
    if (to.timestampField) patch[to.timestampField] = now;
    await db.orders.update(orderId, patch);
  }

  async function undo() {
    // Stepper passes the PREVIOUS stage to onUndo, but the timestamp we must
    // clear is the CURRENT stage's (the one we're leaving) — derive both from
    // `stage` so the arg can't push us into nulling the wrong field. Mirrors
    // QuoteStatusStepper.undo, which nulls the current stageDef.timestampField.
    const currentIdx = orderStageIndex(stage);
    const cur = ORDER_STAGES[currentIdx] || null;
    const prev = currentIdx > 0 ? ORDER_STAGES[currentIdx - 1] : null;
    if (!prev) return;
    const patch = { status: prev.key, updatedAt: Date.now() };
    if (cur?.timestampField) patch[cur.timestampField] = null;
    await db.orders.update(orderId, patch);
  }

  async function cancelOrder() {
    if (!confirm('¿Cancelar el pedido? Las cotizaciones quedarán libres pero no se eliminan.')) return;
    try {
      await db.orders.update(orderId, {
        status: 'cancelled',
        cancelledAt: Date.now(),
        updatedAt: Date.now(),
      });
      setError('');
    } catch (e) {
      setError(userMessageFor(e));
      return;
    }
    // A cancelled order frees its quotes — add their LSG pieces back on Shopify.
    // Best-effort sync: surface a non-blocking toast if it fails so a silent
    // Shopify drift doesn't go unnoticed.
    reconcileOrderStock(orderId).catch(() =>
      toast('No se pudo sincronizar el stock en Shopify.', { tone: 'error' }));
  }

  async function uncancel() {
    if (!confirm('¿Reactivar el pedido (estado: Borrador)?')) return;
    // Reactivated orders go back to draft — the dealer re-drives the
    // lifecycle from there. The previous flow restored to 'accepted'
    // which is no longer a valid order status.
    try {
      await db.orders.update(orderId, {
        status: 'draft',
        cancelledAt: null,
        updatedAt: Date.now(),
      });
      setError('');
    } catch (e) {
      setError(userMessageFor(e));
      return;
    }
    // Reactivating re-commits the accepted quotes — re-deduct their LSG pieces.
    reconcileOrderStock(orderId).catch(() =>
      toast('No se pudo sincronizar el stock en Shopify.', { tone: 'error' }));
  }

  async function addContainer() {
    const id = newId();
    const now = Date.now();
    // Containers are now structurally just an identifier + a single
    // filledAt timestamp (nullable). No stage machine, no per-stage
    // timestamps. The dealer marks each as packed when they pack it.
    // Race-safe assign — UNIQUE(profile_id, number) catches double-
    // tap or two-tab collisions and the helper retries.
    try {
      await assignSequenceNumber({
        table: 'containers',
        profileId,
        start: 101,
        build: (number) => ({
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
        }),
      });
      invalidate();
      setError('');
    } catch (e) {
      setError(userMessageFor(e));
    }
  }

  async function attachQuote(quoteId) {
    try {
      await db.quotes.update(quoteId, { orderId, updatedAt: Date.now() });
      invalidate();
      setError('');
    } catch (e) {
      setError(userMessageFor(e));
      return;
    }
    // Committing the quote to this order deducts its LSG pieces from Shopify.
    reconcileQuoteStock(quoteId).catch(() => {});
    setPicker(false);
  }

  async function detachQuote(quoteId) {
    if (!confirm('¿Quitar la cotización de este pedido? La cotización seguirá existiendo.')) return;
    try {
      await db.quotes.update(quoteId, { orderId: null, updatedAt: Date.now() });
      invalidate();
      setError('');
    } catch (e) {
      setError(userMessageFor(e));
      return;
    }
    // Freed from the order — add its LSG pieces back on Shopify.
    reconcileQuoteStock(quoteId).catch(() => {});
  }

  return (
    <>
      <BackLink to="/orders">Volver a pedidos</BackLink>
      <PageHeader
        title={`Pedido #${order.number || order.id.slice(-4)}`}
        subtitle={
          <span className="flex flex-wrap gap-x-1.5 gap-y-0.5">
            <span>{stageDef.label}</span>
            <span aria-hidden="true" className="text-ink-300">·</span>
            <span className="tabular-nums">{quotes.length} cotización{quotes.length === 1 ? '' : 'es'}</span>
            <span aria-hidden="true" className="text-ink-300 hidden sm:inline">·</span>
            <span className="hidden sm:inline tabular-nums">Actualizado {formatDateTime(order.updatedAt)}</span>
          </span>
        }
        actions={
          <>
            <button
              type="button"
              onClick={exportRegistration}
              disabled={registering || quotes.length === 0}
              className="btn-secondary"
              title={quotes.length === 0
                ? 'Añade cotizaciones al pedido primero'
                : 'Documento para registrar el pedido con Ligne Roset (sin precios)'}
            >
              {registering
                ? <Loader2 size={14} className="animate-spin" />
                : <FileDown size={14} />}
              Registro LR
            </button>
            <OrderOverflow
              cancelled={isCancelled}
              onCancel={cancelOrder}
              onUncancel={uncancel}
            />
          </>
        }
      />

      <SheetErrorBanner message={error} onDismiss={() => setError('')} />

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

      {/* Dispatch threshold widget — the dealer wants the dispatch minimum
          visible in every active stage as a persistent reference, not just
          while building toward it in Borrador. Only a cancelled order hides
          it (the minimum is moot once the order is dead). */}
      {!isCancelled && (
        <DispatchThresholdCard
          containerCount={containerCount}
          threshold={threshold}
          orderTotal={orderTotal}
          thresholdMet={thresholdMet}
        />
      )}

      <div className="space-y-6 mt-6">
          {/* Containers section */}
          <section className="card overflow-hidden">
            <header className="card-header flex-wrap gap-y-2">
              <div className="min-w-0 flex items-start gap-3">
                <span className="w-7 h-7 rounded-lg bg-ink-100 text-ink-600 ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Truck size={13} />
                </span>
                <div className="min-w-0">
                  <h2>Contenedores
                    {containers.length > 0 && (
                      <span className="ml-1.5 text-ink-400 font-normal text-sm">({containers.length})</span>
                    )}
                  </h2>
                  <p className="text-[11px] text-ink-500 mt-0.5">
                    Cada contenedor sigue su propio ciclo de despacho. Un pedido
                    puede tener varios contenedores cuando los artículos llegan
                    en envíos separados.
                  </p>
                </div>
              </div>
              <button onClick={addContainer} className="btn-secondary flex-shrink-0">
                <Plus size={14} /> Contenedor
              </button>
            </header>
            {containers.length === 0 ? (
              <div className="px-5 py-12 flex flex-col items-center gap-3 text-center">
                <span className="w-12 h-12 rounded-full bg-ink-50 flex items-center justify-center">
                  <Truck size={22} className="text-ink-300" />
                </span>
                <div>
                  <p className="text-sm font-medium text-ink-700">Sin contenedores</p>
                  <p className="text-xs text-ink-400 mt-0.5">Crea uno cuando recibas la confirmación de envío de Ligne Roset.</p>
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-ink-100">
                {containers.map((c) => (
                  <ContainerRow
                    key={c.id}
                    container={c}
                    orderId={orderId}
                    onError={setError}
                    arrivalAction={
                      // HL reports arrival but the order still says "En ruta" —
                      // suggest the next stage; the dealer confirms with a tap.
                      !isCancelled && stage === 'in_transit' && nxt ? (
                        <button
                          type="button"
                          onClick={() => advance(nxt)}
                          disabled={!canAdvance}
                          className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 min-h-9 coarse:min-h-11 text-xs font-medium text-amber-800 hover:bg-amber-100 active:scale-[0.98] transition-all disabled:opacity-50"
                          title={canAdvance ? 'El rastreo reporta llegada a destino' : (blockedReason || '')}
                        >
                          <Truck size={12} aria-hidden /> Llegada reportada — ¿marcar {nxt.label}?
                        </button>
                      ) : null
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          {/* Quotes section */}
          <section className="card overflow-hidden">
            <header className="card-header flex-wrap gap-y-2">
              <div className="min-w-0 flex items-start gap-3">
                <span className="w-7 h-7 rounded-lg bg-brand-50 text-brand-700 ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <FileText size={13} />
                </span>
                <div className="min-w-0">
                  <h2>Cotizaciones
                    {quotes.length > 0 && (
                      <span className="ml-1.5 text-ink-400 font-normal text-sm">({quotes.length})</span>
                    )}
                  </h2>
                  <p className="text-[11px] text-ink-500 mt-0.5">
                    Las ventas que componen este pedido. Suma{' '}
                    <span className="font-medium text-ink-700 tabular-nums">{formatMoney(orderTotal, 'USD', { USD: 1 })}</span>.
                  </p>
                </div>
              </div>
              <button onClick={() => setPicker(true)} className="btn-secondary flex-shrink-0">
                <Plus size={14} /> Cotización
              </button>
            </header>
            {quotes.length === 0 ? (
              <div className="px-5 py-12 flex flex-col items-center gap-3 text-center">
                <span className="w-12 h-12 rounded-full bg-brand-50 flex items-center justify-center">
                  <FileText size={22} className="text-brand-400" />
                </span>
                <div>
                  <p className="text-sm font-medium text-ink-700">Sin cotizaciones</p>
                  <p className="text-xs text-ink-400 mt-0.5">Acepta una desde la cotización o añade una existente.</p>
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-ink-100">
                {quotes.map((q) => (
                  <QuoteRow
                    key={q.id}
                    quote={q}
                    order={order}
                    settings={settings}
                    customer={q.customerId ? customerById.get(q.customerId) : null}
                    creator={q.createdByUserId ? (profiles || []).find((p) => p.id === q.createdByUserId) : null}
                    total={totalByQuote.get(q.id) || 0}
                    onDetach={() => detachQuote(q.id)}
                  />
                ))}
              </ul>
            )}
          </section>
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
          customerById={customerById}
        />
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Container row — collapsed from a 6-stage stepper to a single "Lleno"
// toggle plus an inline-editable container code (the shipping-line id,
// e.g. MSCU1234567). There's no free-text name: a container is identified
// by its number + code, nothing else. The dealer's words:
// "Los contenedores no tienen estatus cambiantes. Solo se marca si están
// llenos." A container is now structurally just an identifier with one
// boolean event — packed at the warehouse, yes or no. All the shipping
// narrative that used to live per-container moved up to the order
// (placed → confirmed → in_transit → in_customs → received).
// ---------------------------------------------------------------------------
function ContainerRow({ container, arrivalAction = null, onError }) {
  const filled = !!container.filledAt;

  // The container number lives in `code`. Validate it (ISO 6346 check
  // digit) so a typo is caught before we track it, and hint the carrier
  // from the owner prefix.
  const validation = validateContainerNo(container.code);
  const carrier = detectCarrier(container.code);
  const trackable = validation.status === 'valid';

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
    try {
      await db.containers.delete(container.id);
      onError?.('');
    } catch (e) {
      onError?.(userMessageFor(e));
    }
  }

  return (
    <li className="px-5 py-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`w-6 h-6 rounded-md ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0 ${filled ? 'bg-emerald-50 text-emerald-700' : 'bg-ink-100 text-ink-500'}`}>
              <Package size={12} />
            </span>
            <span className="font-display text-sm font-semibold text-ink-900">Contenedor #{container.number || '—'}</span>
            {filled ? (
              <span className="status-pill status-pill-accepted">
                <CheckCircle2 size={11} /> Lleno · {formatDateTime(container.filledAt)}
              </span>
            ) : (
              <span className="status-pill status-pill-draft">Por llenar</span>
            )}
          </div>

          {/* Container number + fill toggle, side by side. ISO 6346 is a
              fixed 11 characters (4 letters + 7 digits), so the field is
              sized to exactly that — no wider. */}
          <div className="mt-2.5 flex items-start gap-2 flex-wrap">
            <div>
              <DebouncedInput
                className="input font-mono text-xs uppercase w-auto"
                size={11}
                placeholder="MSCU1234567"
                aria-label="Número de contenedor"
                value={container.code || ''}
                onCommit={(v) => update({ code: normalizeContainerNo(v) })}
              />
              <ContainerNoHint validation={validation} carrier={carrier} />
            </div>
            <button
              type="button"
              onClick={toggleFilled}
              aria-pressed={filled}
              className={`inline-flex items-center gap-1.5 px-3 min-h-9 coarse:min-h-11 rounded-md text-xs font-medium transition-all active:scale-[0.98] ${
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
        </div>
        <button
          onClick={del}
          className="btn-icon-danger flex-shrink-0"
          title="Eliminar contenedor"
          aria-label="Eliminar contenedor"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* A valid number tracks itself — no button to press. */}
      {trackable && <ContainerTracking containerNo={validation.value} arrivalAction={arrivalAction} />}
    </li>
  );
}

// Inline feedback under the container-number field: a green "valid" line
// (with the carrier guessed from the prefix) or an amber hint explaining
// why the number is rejected. Empty input shows nothing.
function ContainerNoHint({ validation, carrier }) {
  if (validation.status === 'empty') return null;
  if (validation.status === 'invalid') {
    const msg = validation.reason === 'checkDigit'
      ? `Dígito de control inválido${validation.expectedCheckDigit != null ? ` (se esperaba …${validation.expectedCheckDigit})` : ''}`
      : 'Formato inválido — 4 letras + 7 dígitos (p. ej. MSCU1234567)';
    return (
      <p className="mt-1 text-[11px] text-amber-600 flex items-center gap-1">
        <AlertCircle size={11} className="flex-shrink-0" /> {msg}
      </p>
    );
  }
  return (
    <p className="mt-1 text-[11px] text-emerald-600 flex items-center gap-1">
      <CheckCircle2 size={11} className="flex-shrink-0" /> Número válido{carrier ? ` · ${carrier}` : ''}
    </p>
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
function QuoteRow({ quote, order, settings, customer, creator, total, onDetach }) {
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
  // Lead each row with the client so the dealer can tell whose order this is
  // at a glance — the quote number alone doesn't identify the customer.
  const clientLabel = customer?.name?.trim() || 'Sin cliente asignado';

  async function setMilestone(field, on) {
    await db.quotes.update(quote.id, {
      [field]: on ? Date.now() : null,
      updatedAt: Date.now(),
    });
  }

  return (
    <li className="group px-5 py-3.5 space-y-2 hover:bg-brand-50/60 transition-colors duration-150">
      <div className="flex items-center gap-3 flex-wrap">
        <Link
          to={`/quotes/${quote.id}`}
          className="flex-1 min-w-0 basis-36"
        >
          <div className="font-display text-sm font-semibold truncate text-ink-900 group-hover:text-brand-700 transition-colors">
            {clientLabel}
          </div>
          <div className="text-[11px] text-ink-500 truncate">
            #{quote.number || '—'}
            {creatorLabel && <> · creada por {creatorLabel}</>}
            {' · '}Act. {formatDateTime(quote.updatedAt)}
          </div>
        </Link>
        <div className="text-sm font-medium tabular-nums whitespace-nowrap text-ink-900">
          {formatMoney(total, quote.currencyCode || 'USD', displayRatesFor(quote, settings))}
        </div>
        <Link
          to={`/quotes/${quote.id}`}
          className="btn-ghost text-xs flex-shrink-0"
          title="Abrir cotización"
        >
          <ExternalLink size={13} aria-hidden /> Abrir
        </Link>
        <button
          onClick={onDetach}
          className="btn-icon-danger flex-shrink-0"
          title="Quitar del pedido"
          aria-label="Quitar del pedido"
        >
          <X size={14} />
        </button>
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
function MilestonePill({ icon: Icon, label, done, doneAt, enabled, disabledHint, onToggle }) {
  if (done) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title="Clic para desmarcar"
        aria-pressed={true}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 min-h-8 coarse:min-h-11 rounded-md text-xs font-medium border transition-colors active:scale-[0.97] bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
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
        className="inline-flex items-center gap-1.5 px-2.5 py-1 min-h-8 coarse:min-h-11 rounded-md text-xs font-medium text-ink-300 bg-ink-50 border border-ink-100 cursor-default"
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
      aria-pressed={false}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 min-h-8 coarse:min-h-11 rounded-md text-xs font-medium bg-surface text-ink-700 border border-ink-200 hover:border-brand-300 hover:text-brand-700 hover:bg-brand-50 active:scale-[0.97] transition-all duration-150"
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
    <div className="card overflow-hidden mt-4">
      <div className="card-pad space-y-3">
        <div className="flex items-start gap-3">
          <span className={`w-7 h-7 rounded-lg ring-1 ring-inset ring-black/5 flex items-center justify-center flex-shrink-0 mt-0.5 ${thresholdMet ? 'bg-emerald-50 text-emerald-700' : 'bg-ink-100 text-ink-500'}`}>
            <Truck size={13} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="eyebrow tracking-wide mb-1">Mínimo de despacho</div>
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <div className="text-sm font-medium text-ink-900">
                {containerCount === 1
                  ? '1 contenedor'
                  : `${containerCount} contenedores`}
                <span className="text-ink-500 font-normal tabular-nums"> · {formatMoney(threshold, 'USD', { USD: 1 })}</span>
              </div>
              <div className="text-right">
                <div className={`text-sm font-semibold tabular-nums ${thresholdMet ? 'text-emerald-600' : 'text-ink-700'}`}>
                  {formatMoney(orderTotal, 'USD', { USD: 1 })}
                </div>
                <div className="text-[11px] text-ink-400 tabular-nums">{Math.round(pct)}% del mínimo</div>
              </div>
            </div>
          </div>
        </div>
        {/* Native <progress> (themed in index.css: ink-100 track, brand-500
            fill). When the minimum is met the `.is-complete` modifier recolours
            the value bar emerald — the same green-on-complete cue the old
            hand-rolled bar gave. value/max are the raw figures; the browser
            clamps the fill to 100%, matching the previous Math.min(100,…). */}
        <progress
          className={`h-1.5 ${thresholdMet ? 'is-complete' : ''}`}
          max={threshold}
          value={Math.min(orderTotal, threshold)}
          aria-label={`${Math.round(pct)}% del mínimo de despacho`}
        />
        <p className="text-[11px] text-ink-400 leading-relaxed">
          El mínimo se multiplica por el número de contenedores en el pedido.
          Todas las cotizaciones aportan al total, sin importar a cuál contenedor pertenezcan.
        </p>
      </div>
    </div>
  );
}

function QuoteAttachList({ candidates, onPick, totalByQuote, customerById }) {
  if (!candidates.length) {
    return (
      <div className="py-12 flex flex-col items-center gap-3 text-center">
        <span className="w-11 h-11 rounded-full bg-brand-50 flex items-center justify-center">
          <FileText size={20} className="text-brand-400" />
        </span>
        <div>
          <p className="text-sm font-medium text-ink-700">Sin cotizaciones disponibles</p>
          <p className="text-xs text-ink-400 mt-0.5">Acepta una cotización para vincularla aquí.</p>
        </div>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-ink-100 -mx-1">
      {candidates.map((q) => {
        const client = customerById?.get(q.customerId);
        return (
        <li key={q.id}>
          <button
            type="button"
            onClick={() => onPick(q.id)}
            className="w-full text-left px-4 py-3 hover:bg-brand-50/60 active:scale-[0.99] transition-all duration-150 flex items-center gap-3 rounded-md"
          >
            <div className="flex-1 min-w-0 mr-2">
              <div className="font-display text-sm font-semibold truncate text-ink-900">
                {client?.name || 'Sin cliente asignado'}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                <span className="text-[11px] text-ink-500 tabular-nums">#{q.number || '—'}</span>
                <span className={`status-pill status-pill-${q.status || 'draft'} !py-0`}>{q.status || 'draft'}</span>
                <span className="text-[11px] text-ink-400">{formatDateTime(q.updatedAt)}</span>
              </div>
            </div>
            <div className="text-sm font-medium tabular-nums whitespace-nowrap text-ink-900">
              {formatMoney(totalByQuote.get(q.id) || 0, q.currencyCode || 'USD', q.rates || { USD: 1 })}
            </div>
          </button>
        </li>
        );
      })}
    </ul>
  );
}

function OrderOverflow({ cancelled, onCancel, onUncancel }) {
  return (
    <Dropdown
      chevron={false}
      ariaLabel="Más acciones"
      label={<MoreHorizontal size={14} aria-hidden />}
      className="!px-1.5"
      align="right"
    >
      {({ close }) => (cancelled ? (
        <DropdownItem onSelect={() => { close(); onUncancel(); }}>
          <Plus size={14} className="mt-0.5 text-ink-500 flex-shrink-0" aria-hidden />
          <span className="min-w-0">
            <span className="block font-medium">Reactivar pedido</span>
            <span className="block text-xs text-ink-500">Vuelve al estado Borrador.</span>
          </span>
        </DropdownItem>
      ) : (
        <DropdownItem
          onSelect={() => { close(); onCancel(); }}
          className="!text-red-600 hover:!bg-red-50 focus:!bg-red-50"
        >
          <Ban size={14} className="mt-0.5 flex-shrink-0" aria-hidden />
          <span className="min-w-0">
            <span className="block font-medium">Cancelar pedido</span>
            <span className="block text-xs text-ink-500">Las cotizaciones quedan libres; no se eliminan.</span>
          </span>
        </DropdownItem>
      ))}
    </Dropdown>
  );
}
