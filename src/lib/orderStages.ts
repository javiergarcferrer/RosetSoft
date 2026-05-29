/**
 * Order lifecycle — six stages, LR-handoff-narrative.
 *
 *   draft        Borrador     in our system, not yet placed with LR
 *   placed       Colocado     PO sent to Ligne Roset
 *   confirmed    Confirmado   LR has confirmed receipt of the PO
 *   in_transit   En ruta      shipped from the factory
 *   in_customs   En aduanas   arrived at DR customs
 *   received     Recibido     cleared customs, in our warehouse
 *
 *   cancelled    Cancelado    terminal alt
 *
 * The previous version had `accepted` / `deposit_received` stages that
 * conflated commerce milestones (which live on the *quote* — see
 * quote.depositReceivedAt, quote.balancePaidAt, quote.deliveredAt) with
 * the order's own logistics lifecycle. The dealer's distinction:
 *
 *   "El acto de confirmar la cotización es recibir el depósito
 *    literalmente — así que no es un estatus aparte."
 *
 * So the order is now purely the LR-shipment narrative; the cotización
 * tracks who's paid, who's been notified, who's taken delivery.
 *
 * Container gating
 * ----------------
 * Containers are simpler too: a container is either filled or not.
 * No more 6-stage pipeline. The order's `received` state requires
 * every container to have a filledAt timestamp — the dealer can't
 * mark goods as received before they've packed them.
 */

import type { Order, OrderStatus, Container } from '../types/domain.ts';

/** Order fields ending in `At` that are nullable stage-timestamp slots. */
export type OrderTimestampField =
  | 'placedAt'
  | 'confirmedAt'
  | 'inTransitAt'
  | 'inCustomsAt'
  | 'receivedAt'
  | 'cancelledAt';

/** One stage definition in the order lifecycle. */
export interface OrderStage {
  key: OrderStatus;
  label: string;
  description: string;
  timestampField: OrderTimestampField | null;
}

/** Options for the placed-gate advance check. */
export interface AdvanceOpts {
  totalAmount?: number;
  threshold?: number;
}

export const ORDER_STAGES: readonly OrderStage[] = [
  {
    key: 'draft',
    label: 'Borrador',
    description: 'Pedido en preparación. Aún no se ha colocado con Ligne Roset.',
    timestampField: null,
  },
  {
    key: 'placed',
    label: 'Colocado',
    description: 'Orden de compra enviada a Ligne Roset.',
    timestampField: 'placedAt',
  },
  {
    key: 'confirmed',
    label: 'Confirmado',
    description: 'Ligne Roset confirmó la recepción del pedido.',
    timestampField: 'confirmedAt',
  },
  {
    key: 'in_transit',
    label: 'En ruta',
    description: 'Envío en tránsito desde fábrica.',
    timestampField: 'inTransitAt',
  },
  {
    key: 'in_customs',
    label: 'En aduanas',
    description: 'Llegó a aduanas en RD; en proceso de despacho.',
    timestampField: 'inCustomsAt',
  },
  {
    key: 'received',
    label: 'Recibido',
    description: 'Mercancía liberada y en el almacén. Listo para entregar a clientes.',
    timestampField: 'receivedAt',
  },
];

export const ORDER_TERMINAL_STAGES: readonly OrderStage[] = [
  {
    key: 'cancelled',
    label: 'Cancelado',
    description: 'Pedido cancelado.',
    timestampField: 'cancelledAt',
  },
];

export const ALL_ORDER_STAGES: readonly OrderStage[] = [...ORDER_STAGES, ...ORDER_TERMINAL_STAGES];

export const ORDER_STAGE_BY_KEY: Readonly<Partial<Record<OrderStatus, OrderStage>>> =
  Object.fromEntries(
    ALL_ORDER_STAGES.map((s) => [s.key, s]),
  );

/** Numeric index in the main stepper (0..5). Cancelled returns -1. */
export function orderStageIndex(key: string | null | undefined): number {
  return ORDER_STAGES.findIndex((s) => s.key === key);
}

/** The next main-track stage, or null at the end / when cancelled. */
export function nextOrderStage(key: string | null | undefined): OrderStage | null {
  const idx = orderStageIndex(key);
  if (idx === -1 || idx >= ORDER_STAGES.length - 1) return null;
  return ORDER_STAGES[idx + 1];
}

/** Read the current stage from an order row, defaulting to 'draft'. */
export function currentOrderStage(order: Pick<Order, 'status'> | null | undefined): OrderStatus {
  if (!order) return 'draft';
  const s = order.status;
  if (s && ORDER_STAGE_BY_KEY[s]) return s;
  return 'draft';
}

/**
 * Can the dealer move this order forward to its next main-track stage?
 *
 * Two gates matter:
 *
 *   1. draft → placed   The dispatch threshold (container count ×
 *      per-container minimum from settings) must be met. The order
 *      can't be placed with Ligne Roset if the total doesn't clear
 *      the LR-side minimum — the order would be rejected on the
 *      vendor end. We surface this gate up-front so the dealer
 *      knows what they still need to fill.
 *
 *   2. in_customs → received   Every attached container must have a
 *      filledAt timestamp. The dealer can't truthfully say "the
 *      goods arrived" if no container has been packed.
 *
 * Intermediate transitions (placed → confirmed → in_transit →
 * in_customs) carry no precondition — they're dealer-driven as
 * Ligne Roset's external workflow progresses.
 *
 * `opts.totalAmount` and `opts.threshold` are read by the placed-gate
 * check. When the caller doesn't supply them, that gate is treated as
 * unmet (defensive — better to require the dealer to confirm than to
 * let an under-minimum order through silently).
 */
export function canAdvanceOrder(
  order: Pick<Order, 'status'> | null | undefined,
  containers: readonly Pick<Container, 'filledAt'>[] | null | undefined,
  opts: AdvanceOpts = {},
): boolean {
  const next = nextOrderStage(currentOrderStage(order));
  if (!next) return false;
  if (next.key === 'placed') {
    const total = Number(opts.totalAmount) || 0;
    const threshold = Number(opts.threshold) || 0;
    if (threshold > 0 && total < threshold) return false;
    return true;
  }
  if (next.key === 'received') {
    if (!containers || containers.length === 0) return false;
    return containers.every((c) => !!c.filledAt);
  }
  return true;
}

/**
 * Why is the advance button disabled right now? Returns a short
 * Spanish hint, or null if there's no special reason (the button is
 * actually allowed, or there's no next stage).
 */
export function advanceBlockedReason(
  order: Pick<Order, 'status'> | null | undefined,
  containers: readonly Pick<Container, 'filledAt'>[] | null | undefined,
  opts: AdvanceOpts = {},
): string | null {
  const next = nextOrderStage(currentOrderStage(order));
  if (!next) return null;
  if (next.key === 'placed') {
    const total = Number(opts.totalAmount) || 0;
    const threshold = Number(opts.threshold) || 0;
    if (threshold > 0 && total < threshold) {
      const shortfall = threshold - total;
      // Use a plain en-US dollar format for the shortfall — keeps the
      // hint terse and avoids loading a money formatter just for this.
      const fmt = (n: number): string => '$' + Math.round(n).toLocaleString('en-US');
      return `Faltan ${fmt(shortfall)} para alcanzar el mínimo de despacho (${fmt(threshold)}). El pedido no se puede colocar con Ligne Roset hasta cumplir el mínimo.`;
    }
  }
  if (next.key === 'received') {
    if (!containers || containers.length === 0) {
      return 'Añade al menos un contenedor antes de marcar como recibido.';
    }
    if (!containers.every((c) => !!c.filledAt)) {
      return 'Marca todos los contenedores como llenos antes de recibir el pedido.';
    }
  }
  return null;
}

/**
 * Dispatch-threshold helper for the widget above the line items.
 * Returns `{ containerCount, threshold }` — count is the number of
 * container rows attached to the order (with a floor of 1 for orders
 * that haven't added any yet), threshold is `count × the per-container
 * minimum from settings`. Doubling the count doubles the minimum;
 * the dealer never enters this number by hand anywhere.
 */
export function orderDispatchThreshold(
  containers: readonly Container[] | null | undefined,
  perContainerThreshold: number | null | undefined,
): { containerCount: number; threshold: number } {
  const count = Math.max(1, containers?.length || 0);
  return {
    containerCount: count,
    threshold: count * (perContainerThreshold || 0),
  };
}
