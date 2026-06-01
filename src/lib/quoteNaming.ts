// The ONE place a quote's human label is defined — "client name + quote
// number" — so the PDF filename/title and the public share link read
// identically. The PDF side (deliver.ts) sanitises this for the filesystem;
// the link side (quoteShare.shareLinkUrl) slugs it into the URL path. Pure
// string logic, no React/db, so it loads on the always-available path the
// share button uses (not gated behind the lazy PDF bundle).
import type { Quote, Customer } from '../types/domain.ts';

type QuoteLike = Pick<Quote, 'number'> | null | undefined;
type CustomerLike = Pick<Customer, 'name' | 'company'> | null | undefined;

/**
 * The canonical label for a quote:
 *   "Eduardo García - Cotizacion 1042"   (with a client)
 *   "Cotizacion 1042"                    (no client assigned yet)
 *   "Cotizacion (borrador)"              (unsaved draft, no number yet)
 * The client falls back to the company when there's no personal name.
 */
export function quoteDisplayName(quote: QuoteLike, customer: CustomerLike): string {
  const num = quote?.number != null ? `Cotizacion ${quote.number}` : 'Cotizacion (borrador)';
  const client = (customer?.name || customer?.company || '').trim();
  return client ? `${client} - ${num}` : num;
}

/**
 * A URL-safe slug of the same label, for the public link path — so the link a
 * dealer sends reads "eduardo-garcia-cotizacion-1042/<token>" instead of an
 * opaque token alone. Diacritics are folded (García → garcia), every run of
 * non-alphanumerics collapses to a single hyphen, and the result is capped so
 * a long company name can't bloat the URL. An empty label (a draft with no
 * client AND no number is impossible — there's always "cotizacion …") still
 * yields a non-empty slug, but the caller treats "" defensively and omits the
 * segment if it ever is.
 */
export function quoteSlug(quote: QuoteLike, customer: CustomerLike): string {
  const slug = quoteDisplayName(quote, customer)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')                       // non-alnum → hyphen
    .replace(/^-+|-+$/g, '');                          // trim leading/trailing
  // Keep URLs tidy — cap length and drop any hyphen the cut left dangling.
  return slug.length > 80 ? slug.slice(0, 80).replace(/-+$/, '') : slug;
}
