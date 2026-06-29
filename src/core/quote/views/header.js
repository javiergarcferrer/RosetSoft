// ViewModel for the quote-builder header (components/quote-builder/QuoteHeader.jsx).
//
// MVVM: QuoteHeader is the View — it owns the inline-edit UI state, the pickers
// and the modals. This module owns the pure DERIVATION the header reads: the
// assigned customer / professional / creator rows resolved out of the profile
// lists, plus the list of sellers an admin may assign (active team members, with
// the current attribution kept visible even when inactive so the row labels
// itself honestly).
//
// Pure: no React, no db, no I/O — a function of the raw quote + the profile
// lists the page already has in hand.

/** Display name for a seller/creator profile, with a graceful e-mail/id fallback. */
export function sellerName(p) {
  return p?.name?.trim() || p?.email?.split('@')[0] || p?.id || '';
}

/**
 * Resolve the header's related entities + the assignable-seller list.
 *
 * @param {object} quote          the current quote (may be null while loading).
 * @param {Array}  customers      profile customers (resolve quote.customerId).
 * @param {Array}  professionals  profile professionals (resolve quote.professionalId).
 * @param {Array}  profiles       team profiles (resolve the creator/seller).
 * @returns {{
 *   customer: object|null,
 *   professional: object|null,
 *   creator: object|null,
 *   creatorLabel: string,        // creator display name, '' when unset
 *   assignableSellers: Array,    // active team members eligible as the seller
 * }}
 */
export function resolveQuoteHeader({ quote, customers, professionals, profiles }) {
  const cust = Array.isArray(customers) ? customers : [];
  const pros = Array.isArray(professionals) ? professionals : [];
  const profs = Array.isArray(profiles) ? profiles : [];

  const customer = quote?.customerId
    ? cust.find((c) => c.id === quote.customerId) || null
    : null;
  const professional = quote?.professionalId
    ? pros.find((p) => p.id === quote.professionalId) || null
    : null;
  // The user who clicked "Nueva cotización" has their auth.uid() stamped on the
  // row at materialize time. Falls back silently to '' when unset.
  const creator = quote?.createdByUserId
    ? profs.find((p) => p.id === quote.createdByUserId) || null
    : null;
  const creatorLabel = creator ? sellerName(creator) : '';

  // Only real, active team members are eligible to be a seller. Tombstoned /
  // pending profiles would attribute commissions to ineligible accounts; surface
  // them only when they're the CURRENT creator so the admin can see who's there
  // and change them.
  const assignableSellers = profs.filter(
    (p) =>
      p.id !== 'team' &&
      (p.role === 'admin' || p.role === 'employee') &&
      (p.active || p.id === quote?.createdByUserId),
  );

  return { customer, professional, creator, creatorLabel, assignableSellers };
}
