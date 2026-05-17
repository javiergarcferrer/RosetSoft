import { STAGE_BY_KEY } from './containerStages.js';

/**
 * Order lifecycle definitions — single source of truth for the order
 * status stepper, transition CTAs, and the rules that derive an order's
 * visible state from its embedded containers.
 *
 * The lifecycle has five declared states. The first four are linear
 * milestones the dealer triggers (acceptance → deposit → ordering →
 * reception); `cancelled` is the off-track terminal. While an order is
 * `ordered`, its container.stage values carry the fulfillment narrative
 * (filling → submitting → ordered → in_transit → landing → received) —
 * the order itself doesn't tick through one declared state per
 * container milestone, the dealer just watches the containers.
 *
 *   draft              → pre-acceptance scaffolding (manual create only;
 *                        most orders skip this and appear at 'accepted'
 *                        the moment a quote is accepted)
 *   accepted           → customer signed off on at least one quote
 *   deposit_received   → funds cleared
 *   ordered            → order placed with Ligne Roset; container(s) take
 *                        over the moment-to-moment narrative
 *   received           → every container has been received in DR. Quotes
 *                        in this order now open for individual delivery
 *                        (per-quote `deliveredAt` is the next step, but
 *                        that's tracked on the quote, not as an order
 *                        status transition — different customers take
 *                        delivery on different days).
 *   cancelled          → won't be fulfilled (terminal alt)
 *
 * Mirrors the shape of containerStages.js so the stepper renders with the
 * same visual vocabulary and the timestamp-extraction helpers are
 * interchangeable.
 */

export const ORDER_STAGES = [
  {
    key: 'draft',
    label: 'Borrador',
    description: 'Pedido en preparación.',
    timestampField: null,
  },
  {
    key: 'accepted',
    label: 'Aceptado',
    description: 'Cliente aceptó la cotización.',
    timestampField: 'acceptedAt',
  },
  {
    key: 'deposit_received',
    label: 'Depósito',
    description: 'Depósito recibido — listo para ordenar.',
    timestampField: 'depositReceivedAt',
  },
  {
    key: 'ordered',
    label: 'Ordenado',
    description: 'Orden colocada con Ligne Roset; siguiendo en contenedores.',
    timestampField: 'orderedAt',
  },
  {
    key: 'received',
    label: 'Recibido',
    description: 'Todos los contenedores llegaron a RD. Cada cotización puede entregarse al cliente cuando esté lista.',
    timestampField: 'receivedAt',
  },
];

export const ORDER_TERMINAL_STAGES = [
  {
    key: 'cancelled',
    label: 'Cancelado',
    description: 'Pedido cancelado.',
    timestampField: 'cancelledAt',
  },
];

export const ALL_ORDER_STAGES = [...ORDER_STAGES, ...ORDER_TERMINAL_STAGES];

export const ORDER_STAGE_BY_KEY = Object.fromEntries(
  ALL_ORDER_STAGES.map((s) => [s.key, s]),
);

/** Numeric index in the main stepper (0..4). Cancelled returns -1. */
export function orderStageIndex(key) {
  return ORDER_STAGES.findIndex((s) => s.key === key);
}

/** The next main-track stage, or null if at the end (or cancelled). */
export function nextOrderStage(key) {
  const idx = orderStageIndex(key);
  if (idx === -1 || idx >= ORDER_STAGES.length - 1) return null;
  return ORDER_STAGES[idx + 1];
}

/** Read the current stage from an order row, defaulting to 'draft'. */
export function currentOrderStage(order) {
  if (!order) return 'draft';
  const s = order.status;
  if (s && ORDER_STAGE_BY_KEY[s]) return s;
  return 'draft';
}

/** True if the given stage is a terminal alternate (cancelled). */
export function isTerminalOrderStage(key) {
  return ORDER_TERMINAL_STAGES.some((s) => s.key === key);
}

/**
 * Can the dealer mark this order as 'received'? Only true once every
 * container in the order has reached its terminal stage. With zero
 * containers the answer is no — there's nothing physical to receive
 * yet, the dealer needs to add a container first.
 *
 * The user's words: "Todas las cotizaciones aportan a ese total sin
 * importar a cual contenedor pertenecen" — quotes don't pin to specific
 * containers, so we can't open per-quote delivery until *all* containers
 * have arrived (otherwise we'd risk marking a quote delivered when its
 * pieces are still on a boat).
 */
export function canMarkReceived(order, containers) {
  if (!order || order.status !== 'ordered') return false;
  if (!containers || containers.length === 0) return false;
  return containers.every((c) => (c.stage || 'filling') === 'received');
}

/**
 * Can the dealer mark this specific quote as delivered? Only after the
 * parent order has been received (the goods are physically in DR).
 * Before then the per-quote delivery action is hidden, since the items
 * aren't yet available to hand to the customer.
 */
export function canDeliverQuote(order) {
  return order?.status === 'received';
}

/**
 * Compute the dispatch threshold for an order: number of attached
 * containers (with a floor of 1) × the per-container minimum from
 * settings. Returns { containerCount, threshold } so callers can render
 * both ("Pedido necesita 2 contenedores · $87k / $100k mínimo") with a
 * single helper call.
 *
 * Floor of 1: an order that hasn't yet had any container added still
 * has a meaningful minimum — the dealer needs at least one container's
 * worth of orders before placing the purchase with Ligne Roset. As soon
 * as a second container row appears, the threshold doubles.
 */
export function orderDispatchThreshold(containers, perContainerThreshold) {
  const count = Math.max(1, containers?.length || 0);
  return {
    containerCount: count,
    threshold: count * (perContainerThreshold || 0),
  };
}

/**
 * Look up a container-stage definition. Re-export the container map so
 * callers that already use the order-stage helpers don't have to import
 * two modules to render a mixed view (e.g. OrderDetail rendering both
 * the order's own steppers and the per-container nested steppers).
 */
export { STAGE_BY_KEY as CONTAINER_STAGE_BY_KEY };
