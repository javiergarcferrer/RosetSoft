/**
 * Quote lifecycle definitions — single source of truth for the status stepper
 * and the transition CTAs. Mirrors the shape of `containerStages.js` so the
 * stepper components share visual + interaction conventions.
 *
 * The lifecycle is mostly linear (draft → sent → accepted) with two alternate
 * terminals (declined, archived) reachable as secondary actions from anywhere
 * past draft. The stepper renders the three main stages; the alternates live
 * in the "more" menu.
 */

import type { Quote, QuoteStatus } from '../types/domain.ts';

/** Quote.fields ending in `At` that are nullable timestamp slots. */
export type QuoteTimestampField =
  | 'sentAt'
  | 'acceptedAt'
  | 'declinedAt'
  | 'archivedAt';

/** One stage definition in the quote lifecycle. */
export interface QuoteStage {
  key: QuoteStatus;
  label: string;
  description: string;
  timestampField: QuoteTimestampField | null;
}

export const QUOTE_STAGES: readonly QuoteStage[] = [
  {
    key: 'draft',
    label: 'Borrador',
    description: 'Cotización en construcción.',
    timestampField: null,
  },
  {
    key: 'sent',
    label: 'Enviada',
    description: 'Compartida con el cliente; esperando respuesta.',
    timestampField: 'sentAt',
  },
  {
    key: 'accepted',
    label: 'Aceptada',
    description: 'Cliente aceptó la cotización.',
    timestampField: 'acceptedAt',
  },
];

export const QUOTE_TERMINAL_STAGES: readonly QuoteStage[] = [
  {
    key: 'declined',
    label: 'Rechazada',
    description: 'Cliente rechazó la cotización.',
    timestampField: 'declinedAt',
  },
  {
    key: 'archived',
    label: 'Archivada',
    description: 'Guardada para referencia futura.',
    timestampField: 'archivedAt',
  },
];

export const ALL_QUOTE_STAGES: readonly QuoteStage[] = [...QUOTE_STAGES, ...QUOTE_TERMINAL_STAGES];

export const QUOTE_STAGE_BY_KEY: Readonly<Partial<Record<QuoteStatus, QuoteStage>>> =
  Object.fromEntries(
    ALL_QUOTE_STAGES.map((s) => [s.key, s]),
  );

/** Numeric index in the main stepper (0..2). Terminals return -1. */
export function quoteStageIndex(key: string | null | undefined): number {
  return QUOTE_STAGES.findIndex((s) => s.key === key);
}

/** The next main-track stage, or null if at the end (or on a terminal alt). */
export function nextQuoteStage(key: string | null | undefined): QuoteStage | null {
  const idx = quoteStageIndex(key);
  if (idx === -1 || idx >= QUOTE_STAGES.length - 1) return null;
  return QUOTE_STAGES[idx + 1];
}

/** Read the current stage from a quote row, defaulting to 'draft'. */
export function currentQuoteStage(quote: Pick<Quote, 'status'> | null | undefined): QuoteStatus {
  if (!quote) return 'draft';
  const s = quote.status;
  if (s && QUOTE_STAGE_BY_KEY[s]) return s;
  return 'draft';
}

/** True if the stage is one of the terminal alternates (declined / archived). */
export function isTerminalStage(key: string | null | undefined): boolean {
  return QUOTE_TERMINAL_STAGES.some((s) => s.key === key);
}
