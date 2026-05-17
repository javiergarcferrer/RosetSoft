import { stageIndex } from './containerStages.js';

/**
 * Order lifecycle definitions — single source of truth for the order
 * status stepper, transition CTAs, and the rules that derive an order's
 * visible state from its embedded containers.
 *
 * The lifecycle has six declared states. The first four are linear
 * milestones the dealer triggers (acceptance → deposit → placement →
 * delivery); `cancelled` is the off-track terminal. While an order is
 * `placed`, its container.stage values carry the fulfillment narrative
 * (filling → submitting → ordered → in_transit → landing → received) —
 * the order itself doesn't tick through one declared state per
 * container milestone, the dealer just watches the containers.
 *
 *   draft              → pre-acceptance scaffolding (manual create only;
 *                        most orders skip this and appear at 'accepted'
 *                        the moment a quote is accepted)
 *   accepted           → customer signed off on at least one quote
 *   deposit_received   → funds cleared
 *   placed             → order sent to Ligne Roset; container(s) take over
 *                        the narrative until every container has been received
 *   delivered          → customer took delivery of every quote line (terminal)
 *   cancelled          → won't be fulfilled (terminal)
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
    key: 'placed',
    label: 'Ordenado',
    description: 'Orden colocada con Ligne Roset; siguiendo en contenedores.',
    timestampField: 'placedAt',
  },
  {
    key: 'delivered',
    label: 'Entregado',
    description: 'Cliente recibió todas las piezas.',
    timestampField: 'deliveredAt',
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
 * Derive a presentational sub-status for an order in 'placed'. While in
 * placed, the visible state comes from the most-advanced container in the
 * order — the order is "behind" whichever container has progressed
 * furthest. Returns the container-stage key, or null if the order isn't
 * in 'placed' or has no containers.
 */
export function orderContainerStage(order, containers) {
  if (!order || order.status !== 'placed') return null;
  if (!containers || containers.length === 0) return null;
  // Pick the most-advanced container (higher stage index = further along).
  // Falls back to 'filling' (index 0) for rows missing a stage value.
  let max = null;
  let maxIdx = -1;
  for (const c of containers) {
    const i = stageIndex(c.stage || 'filling');
    if (i > maxIdx) { maxIdx = i; max = c.stage || 'filling'; }
  }
  return max;
}

/**
 * Can the dealer mark this order as 'delivered'? Only true once every
 * container in the order is at the 'received' terminal — partial
 * deliveries aren't yet a concept (and the user said as much: "When a
 * container is received only then can a quote be delivered").
 */
export function canMarkDelivered(order, containers) {
  if (!order || order.status !== 'placed') return false;
  if (!containers || containers.length === 0) return false;
  return containers.every((c) => (c.stage || 'filling') === 'received');
}
