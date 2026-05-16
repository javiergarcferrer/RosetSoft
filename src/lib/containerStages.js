/**
 * Container pipeline definitions — single source of truth for the 6-stage
 * journey a shipment moves through and the per-quote fulfillment milestones
 * within it. Pages render from these maps so adding a stage or relabeling
 * one is a one-line change.
 */

export const STAGES = [
  {
    key: 'filling',
    label: 'Llenando',
    description: 'Aceptando cotizaciones, llenando el contenedor hasta el mínimo de despacho.',
    timestampField: null,            // no transition timestamp — entry stage
  },
  {
    key: 'submitting',
    label: 'Cerrando',
    description: 'Mínimo alcanzado: cerrando especificaciones, cobrando depósitos, preparando la orden a Ligne Roset.',
    timestampField: 'submittedAt',
  },
  {
    key: 'ordered',
    label: 'Ordenado',
    description: 'Orden enviada a Ligne Roset; en producción.',
    timestampField: 'orderedAt',
  },
  {
    key: 'in_transit',
    label: 'En tránsito',
    description: 'Despachado desde fábrica, en el barco.',
    timestampField: 'shippedAt',
  },
  {
    key: 'landing',
    label: 'En aduana',
    description: 'Llegó a República Dominicana: aduanas + agendando entregas.',
    timestampField: 'landedAt',
  },
  {
    key: 'complete',
    label: 'Completado',
    description: 'Todos los clientes recibieron sus piezas y pagaron el balance.',
    timestampField: 'completedAt',
  },
];

export const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s]));

/** The stage immediately after `stageKey`, or null if we're already at the terminal. */
export function nextStage(stageKey) {
  const idx = STAGES.findIndex((s) => s.key === stageKey);
  if (idx === -1 || idx >= STAGES.length - 1) return null;
  return STAGES[idx + 1];
}

/** Numeric index of a stage (0 = filling, 5 = complete). Useful for stepper rendering. */
export function stageIndex(stageKey) {
  const idx = STAGES.findIndex((s) => s.key === stageKey);
  return idx === -1 ? 0 : idx;
}

/** Read the current stage from a container row, defaulting to 'filling' for legacy data. */
export function currentStage(container) {
  if (!container) return 'filling';
  if (container.stage && STAGE_BY_KEY[container.stage]) return container.stage;
  // Legacy fallback: pre-pipeline rows still have status='dispatched'/'open'.
  if (container.status === 'dispatched') return 'complete';
  return 'filling';
}

/**
 * Per-quote fulfillment milestones surfaced in the container's customer
 * roll-up. Each is an independent timestamp flag on `quotes` — flipping
 * one doesn't enforce the order of the others.
 */
export const FULFILLMENT_MILESTONES = [
  { key: 'customerNotifiedAt', label: 'Notif.',    title: 'Cliente notificado' },
  { key: 'depositPaidAt',      label: 'Depósito',  title: 'Depósito recibido' },
  { key: 'specsLockedAt',      label: 'Specs',     title: 'Especificaciones confirmadas' },
  { key: 'balancePaidAt',      label: 'Balance',   title: 'Balance pagado' },
  { key: 'deliveredAt',        label: 'Entrega',   title: 'Entregado al cliente' },
];
