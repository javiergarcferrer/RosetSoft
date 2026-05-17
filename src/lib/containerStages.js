/**
 * Container pipeline definitions — single source of truth for the 6-stage
 * journey a physical shipment moves through. The 'filling' entry stage is
 * where a freshly created container sits until the dispatch threshold is
 * reached; from there it walks the linear path to 'received' (the photo
 * has been off-loaded in DR — what used to be 'complete', renamed because
 * 'received' is also the terminal at the order level when every
 * container has arrived, and using the same word at both levels keeps
 * the dealer's vocabulary unified).
 *
 * Pages render from this map, so adding a stage or relabeling one is a
 * one-line change. The transition timestamps are nullable columns on the
 * containers table so a stage's actual happened-at can be displayed.
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
    key: 'received',
    label: 'Recibido',
    description: 'Contenedor descargado en RD; piezas disponibles para entrega al cliente.',
    timestampField: 'completedAt',  // legacy column name kept to avoid a second migration
  },
];

export const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s]));

/** The stage immediately after `stageKey`, or null if we're already at the terminal. */
export function nextStage(stageKey) {
  const idx = STAGES.findIndex((s) => s.key === stageKey);
  if (idx === -1 || idx >= STAGES.length - 1) return null;
  return STAGES[idx + 1];
}

/** Numeric index of a stage (0 = filling, 5 = received). Useful for stepper rendering. */
export function stageIndex(stageKey) {
  const idx = STAGES.findIndex((s) => s.key === stageKey);
  return idx === -1 ? 0 : idx;
}

/** Read the current stage from a container row, defaulting to 'filling' for legacy data. */
export function currentStage(container) {
  if (!container) return 'filling';
  if (container.stage && STAGE_BY_KEY[container.stage]) return container.stage;
  // Legacy fallback: pre-pipeline rows still have status='dispatched'/'open'.
  // The 20260516120200 migration backfills these but a partially-migrated
  // row could still slip through; coercing here is cheap defence.
  if (container.status === 'dispatched') return 'received';
  if (container.stage === 'complete') return 'received';
  return 'filling';
}
