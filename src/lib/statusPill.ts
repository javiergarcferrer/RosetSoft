/**
 * Status colorization — the single source of truth that maps a domain status
 * to its `.status-pill-*` variant + Spanish label. Centralized here so a
 * status re-skin is one edit instead of a hunt across every page (Quotes,
 * Orders, CustomerDetail, ProfessionalDetail, …), which each used to carry
 * their own copy of these maps.
 *
 * The `.status-pill-*` classes themselves live in src/index.css.
 */

import { ORDER_STAGE_BY_KEY } from './orderStages.js';

export interface PillSpec { cls: string; label: string }

/* ------------------------------ quote stages ------------------------------ */

export const QUOTE_STAGE_PILL: Record<string, string> = {
  draft: 'status-pill-draft',
  sent: 'status-pill-sent',
  accepted: 'status-pill-accepted',
  deposito_recibido: 'status-pill-deposito',
  declined: 'status-pill-declined',
  archived: 'status-pill-archived',
};

export const QUOTE_STAGE_LABEL: Record<string, string> = {
  draft: 'Borrador',
  sent: 'Enviada',
  accepted: 'Aceptada',
  deposito_recibido: 'Depósito recibido',
  declined: 'Rechazada',
  archived: 'Archivada',
};

/** Resolve a quote stage to its pill class + Spanish label. */
export function quoteStagePill(stage: string | null | undefined): PillSpec {
  const key = stage || 'draft';
  return {
    cls: QUOTE_STAGE_PILL[key] || QUOTE_STAGE_PILL.draft,
    label: QUOTE_STAGE_LABEL[key] || QUOTE_STAGE_LABEL.draft,
  };
}

/* ------------------------------ order statuses ------------------------------ */

// Map the 6-stage order lifecycle onto the pill palette: confirmed reads as
// committed (accepted-tone), received as active, cancelled as declined, the
// two in-flight stages share the sent-blue / pending-amber. Labels come from
// the order-stage definitions so they stay in one place.
export const ORDER_STATUS_PILL: Record<string, string> = {
  draft: 'status-pill-draft',
  placed: 'status-pill-sent',
  confirmed: 'status-pill-accepted',
  in_transit: 'status-pill-sent',
  in_customs: 'status-pill-pending',
  received: 'status-pill-active',
  cancelled: 'status-pill-declined',
};

/** Resolve an order status to its pill class + Spanish label. */
export function orderStatusPill(status: string | null | undefined): PillSpec {
  const key = status || 'draft';
  return {
    cls: ORDER_STATUS_PILL[key] || ORDER_STATUS_PILL.draft,
    label: (ORDER_STAGE_BY_KEY as Record<string, { label?: string }>)[key]?.label || 'Borrador',
  };
}
