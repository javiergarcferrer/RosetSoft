/**
 * Shared string-enum constants. Co-locates the discriminator values
 * that several files compare against directly (`l.kind === 'item'`,
 * `q.status === 'sent'`) so a future rename is one-place and a
 * mis-typed comparison is a missing import instead of a silent
 * never-true expression.
 *
 * Order-side state lives in src/lib/orderStages.js (ORDER_STAGES,
 * ORDER_STAGE_BY_KEY, ALL_ORDER_STAGES); this file covers the bits
 * that weren't already namespaced there.
 */

/* ---------------------------------- quote lines --------------------------------- */

/**
 * `quote_lines.kind` discriminator. A quote line is either a priced
 * item or a section header. Compound articles are NOT a separate kind
 * — they're regular items whose `components` array is non-empty
 * (see `isCompoundLine` in lib/pricing.js).
 */
export const LINE_KIND_ITEM    = 'item';
export const LINE_KIND_SECTION = 'section';
export const LINE_KINDS = [LINE_KIND_ITEM, LINE_KIND_SECTION];

/** Convenience predicate — filters section rows out of a totals pass. */
export function isPricedLine(line) {
  return line?.kind !== LINE_KIND_SECTION;
}

/* ----------------------------------- quote status ----------------------------------- */

/**
 * `quotes.status` lifecycle. draft → sent → accepted ↔ declined →
 * archived. The lifecycle stepper (QuoteStatusStepper.jsx) enforces
 * the legal transitions; this file just names the values.
 */
export const QUOTE_STATUS_DRAFT    = 'draft';
export const QUOTE_STATUS_SENT     = 'sent';
export const QUOTE_STATUS_ACCEPTED = 'accepted';
export const QUOTE_STATUS_DECLINED = 'declined';
export const QUOTE_STATUS_ARCHIVED = 'archived';

export const QUOTE_STATUSES = [
  QUOTE_STATUS_DRAFT,
  QUOTE_STATUS_SENT,
  QUOTE_STATUS_ACCEPTED,
  QUOTE_STATUS_DECLINED,
  QUOTE_STATUS_ARCHIVED,
];

/**
 * Statuses where the quote is still being negotiated with the
 * customer — the editor / list views overlay live exchange rates
 * for these, instead of the snapshot. Once a quote is accepted or
 * beyond, the rate the customer agreed to is the historical record.
 */
export const QUOTE_STATUS_ACTIVE = new Set([
  QUOTE_STATUS_DRAFT,
  QUOTE_STATUS_SENT,
]);

export function isActiveQuoteStatus(status) {
  return QUOTE_STATUS_ACTIVE.has(status);
}
