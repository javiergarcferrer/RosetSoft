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

/**
 * Stepper keys = the real statuses PLUS the deposit milestone. "Depósito
 * recibido" is surfaced as a lifecycle step but is NOT a quote.status value —
 * it's backed by the `depositReceivedAt` timestamp, which is the single source
 * of truth shared with the order's deposit milestone. So marking it from the
 * quote or from the order is the same write, and they can never desync.
 */
export type QuoteStageKey = QuoteStatus | 'deposito_recibido';

/** Quote fields ending in `At` that a stage stamps. */
export type QuoteTimestampField =
  | 'sentAt'
  | 'acceptedAt'
  | 'depositReceivedAt'
  | 'declinedAt'
  | 'archivedAt';

/** One stage definition in the quote lifecycle. */
export interface QuoteStage {
  key: QuoteStageKey;
  label: string;
  description: string;
  timestampField: QuoteTimestampField | null;
  /**
   * True when the stage is backed ONLY by its timestamp (not a quote.status
   * value). Advancing stamps the timestamp and leaves `status` as-is; the
   * stage is then derived from that timestamp. Used for `deposito_recibido`.
   */
  milestone?: boolean;
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
  {
    key: 'deposito_recibido',
    label: 'Depósito recibido',
    description: 'Cliente pagó el depósito; la venta queda confirmada y entra a comisión.',
    timestampField: 'depositReceivedAt',
    milestone: true,
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

export const QUOTE_STAGE_BY_KEY: Readonly<Partial<Record<QuoteStageKey, QuoteStage>>> =
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

/**
 * Read the current stage from a quote row, defaulting to 'draft'.
 * Terminal states win; otherwise a recorded `depositReceivedAt` surfaces the
 * derived 'deposito_recibido' step — the same field the order page writes, so
 * the quote and the order always show the same thing.
 */
export function currentQuoteStage(
  quote: Pick<Quote, 'status' | 'depositReceivedAt'> | null | undefined,
): QuoteStageKey {
  if (!quote) return 'draft';
  const s = quote.status;
  if (s === 'declined' || s === 'archived') return s;
  if (quote.depositReceivedAt) return 'deposito_recibido';
  if (s && QUOTE_STAGE_BY_KEY[s]) return s;
  return 'draft';
}

/** True if the stage is one of the terminal alternates (declined / archived). */
export function isTerminalStage(key: string | null | undefined): boolean {
  return QUOTE_TERMINAL_STAGES.some((s) => s.key === key);
}

/** Days a SENT quote may wait for client acceptance before it auto-archives. */
export const QUOTE_AUTO_ARCHIVE_DAYS = 15;

/**
 * Quotes that should AUTO-ARCHIVE: sent to a client but neither accepted nor
 * moved on within QUOTE_AUTO_ARCHIVE_DAYS. Measured from `sentAt` — the
 * "waiting on the client" clock, not creation — so a quote drafted weeks ago but
 * only just sent isn't swept. Drafts (still being built) and already-terminal
 * quotes (accepted/declined/archived) are deliberately left alone. Pure: the
 * caller stamps each exactly like the manual stepper (status:'archived' +
 * archivedAt), so an auto-archive and a hand-archive are indistinguishable — and
 * "Volver" un-archives it just the same.
 */
export function quotesToAutoArchive<T extends Pick<Quote, 'id' | 'status' | 'sentAt'>>(
  quotes: ReadonlyArray<T> | null | undefined,
  now: number,
  days: number = QUOTE_AUTO_ARCHIVE_DAYS,
): T[] {
  const cutoff = now - days * 86_400_000;
  return (quotes || []).filter(
    (q) => q.status === 'sent' && q.sentAt != null && q.sentAt < cutoff,
  );
}
