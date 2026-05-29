/**
 * Shared string-enum constants. Co-locates the discriminator values
 * that several files compare against directly (`l.kind === 'item'`,
 * `q.status === 'sent'`) so a future rename is one-place and a
 * mis-typed comparison is a compile error instead of a silent never-
 * true expression.
 *
 * Order-side state lives in src/lib/orderStages.js (ORDER_STAGES,
 * ORDER_STAGE_BY_KEY, ALL_ORDER_STAGES); this file covers the bits
 * that weren't already namespaced there.
 */

import type {
  LineKind,
  QuoteStatus,
  QuoteLine,
} from '../types/domain.ts';

/* ---------------------------------- quote lines --------------------------------- */

/**
 * `quote_lines.kind` discriminator. A quote line is either a priced
 * item or a section header. Compound articles are NOT a separate kind
 * — they're regular items whose `components` array is non-empty (see
 * `isCompoundLine` in lib/pricing).
 */
export const LINE_KIND_ITEM:    LineKind = 'item';
export const LINE_KIND_SECTION: LineKind = 'section';

/* ---------------------------------- feature flags --------------------------------- */

/**
 * DAILY auto-pull of the Banco Popular Dominicano exchange rate (once per day
 * on the first login at/after 08:00 AST, via the `bpd-rate` edge function →
 * apipublico.bpd.com.do).
 *
 * This gates ONLY the automatic daily pull. The manual on-demand refresh
 * (Settings' "Actualizar ahora" and the quote workspace's "Actualizar tasa")
 * is ALWAYS available regardless of this flag.
 *
 * ENABLED: the production subscription is approved and the rate pulls
 * successfully end-to-end. The pull fires once per day on the first app load
 * at/after 08:00 AST (see `shouldPullDailyRate` in lib/exchangeRate +
 * AppContext) — gated on 08:00 because BPD publishes a single daily rate in
 * the morning, and not hourly thereafter.
 */
export const EXCHANGE_RATE_PULL_ENABLED = true;

/**
 * Predicate every total-bearing surface (Quotes / Orders / Dashboard /
 * CustomerDetail / ProfessionalDetail / admin/Commissions / all
 * accounting/* / ClientPreview / PDF totals) filters by before
 * computing money. Returns true when this line should contribute to
 * the quote total — i.e. NOT a section divider, NOT a parked
 * optional add-on, NOT a non-selected alternative.
 *
 * Three exclusions composed in one place so a new exclusion rule in
 * the future lands once instead of in ~10 call sites:
 *
 *   kind = 'section'              visual divider, no math
 *   isOptional                    add-on the customer hasn't taken
 *   alternativeGroup && !isSelected  sibling alternative the
 *                                    customer didn't pick
 *
 * Lines that fail this predicate still RENDER in the editor and the
 * client preview — they're visible options the customer is meant to
 * see. They're just excluded from the running total.
 *
 * NOTE on Conjuntos (sets, `setGroup`): set members are ALWAYS priced —
 * a Conjunto is "take ALL", so every member counts toward the total
 * exactly like a standalone line. This predicate therefore needs NO
 * `setGroup` case; it's intentionally absent. (A set member can't be
 * optional or an alternative — that's forbidden by the type's
 * exclusivity rule and a DB CHECK — so the existing branches never
 * spuriously exclude one.)
 */
export function isPricedLine(
  line:
    | Pick<QuoteLine, 'kind' | 'isOptional' | 'alternativeGroup' | 'isSelectedAlternative'>
    | null
    | undefined,
): boolean {
  if (!line) return true;
  if (line.kind === LINE_KIND_SECTION) return false;
  if (line.isOptional) return false;
  if (line.alternativeGroup && !line.isSelectedAlternative) return false;
  return true;
}

/* ----------------------------------- quote status ----------------------------------- */

/**
 * `quotes.status` lifecycle. draft → sent → accepted ↔ declined →
 * archived. The lifecycle stepper (QuoteStatusStepper.jsx) enforces
 * the legal transitions; this file just names the values.
 */
export const QUOTE_STATUS_DRAFT:    QuoteStatus = 'draft';
export const QUOTE_STATUS_SENT:     QuoteStatus = 'sent';
export const QUOTE_STATUS_ACCEPTED: QuoteStatus = 'accepted';
export const QUOTE_STATUS_DECLINED: QuoteStatus = 'declined';
export const QUOTE_STATUS_ARCHIVED: QuoteStatus = 'archived';
