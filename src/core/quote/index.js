// The quote MODEL — the logic + data core, framework-agnostic (no React, no
// Supabase, no pdf-lib). It's the single place the quote's rules live; the
// per-view ViewModels and the Views derive from here and nothing re-implements
// the logic on its own.
//
// MVVM layering:
//   • Model      — this package: pricing, grouping, predicates, the exchange-
//                  rate state, and `applyAction` (the one mutation reducer).
//   • ViewModel  — `views/*`: pure projections shaped to what each view needs.
//   • View       — the renderers (ClientPreview, the editor, the PDF) that read
//                  a ViewModel and render it; they derive nothing themselves.
//
// (During the migration the pricing/grouping/rate helpers physically still live
// under src/lib and are surfaced here; new code imports them from the Model.)

// ---- derivations: pricing + grouping (totals, ranges, group runs, positions)
export * from '../../lib/pricing.js';

// ---- per-quote money rollups (the single "sum a quote" helpers for the
//      list/detail surfaces — dashboard, quotes/orders lists, customer/pro)
export { linesByQuoteId, quoteTotals, quoteGrandTotal } from './totals.js';

// ---- predicates (what counts toward the total)
export { isPricedLine, isPricedComponent } from '../../lib/constants.js';

// ---- group attributes
export { isGroupOptional, selectAlternativePatches } from '../../lib/quoteGroups.js';

// ---- exchange-rate state (live-until-accept lock; the single source of truth)
export {
  quoteRateState, displayRatesFor, effectiveRates, effectiveDopRate, readExchangeRate,
} from '../../lib/exchangeRate.js';

// ---- the one mutation reducer (optimistic client + authoritative server share it)
//      reanchorMaterial is the grade-switch re-anchor rule (subtype/swatch/options
//      re-base) the editor preview reuses to mirror the link's `materials` pick.
export { applyAction, applyClientPick, reanchorMaterial } from './actions.js';

// ---- ViewModels (per-view projections off the Model)
export { resolveQuoteView } from './views/quoteView.js';
export { resolveLineList } from './views/editor.js';
export { resolveLineItem } from './views/lineItem.js';
export { resolveDashboard } from './views/dashboard.js';
export { resolveQuotesList, resolveOrdersList, resolveProfessionalsList } from './views/lists.js';
export { resolveOrderDetail, resolveCustomerDetail, resolveProfessionalDetail } from './views/detail.js';
export { resolveOrderRegistration } from './views/registration.js';
