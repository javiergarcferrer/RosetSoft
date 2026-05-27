/**
 * Promotion helpers — activation-window logic and the "which lines qualify"
 * suggestion used by the quote builder's Apply-promotion flow.
 *
 * The quote data is free-text (no normalized catalog), so eligibility is
 * ASSISTED, not decided: we suggest lines whose family / reference / name
 * mentions one of the promo's keywords (or matches an excluded-model code),
 * and the dealer confirms per line before applying.
 */

import { isPricedLine } from './constants.js';
import type { Promotion, QuoteLine } from '../types/domain.ts';

/**
 * Is the promo live right now? Enabled, and within its [startsAt, endsAt]
 * window (each bound is optional; a missing bound means "open-ended on that
 * side"). Bounds are inclusive — the modal stores endsAt at end-of-day so a
 * promo is still active on its last calendar day.
 */
export function isPromoActive(promo: Promotion | null | undefined, now: number = Date.now()): boolean {
  if (!promo || promo.isEnabled === false) return false;
  if (promo.startsAt != null && now < promo.startsAt) return false;
  if (promo.endsAt != null && now > promo.endsAt) return false;
  return true;
}

/** True once the promo's window has fully passed (for a "vencida" badge). */
export function isPromoExpired(promo: Promotion | null | undefined, now: number = Date.now()): boolean {
  return !!promo && promo.endsAt != null && now > promo.endsAt;
}

function norm(s: unknown): string {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * Does this line look eligible for the promo? A line matches when any of its
 * identity fields (family / reference / name) contains one of the promo's
 * eligible keywords, OR its reference/family equals one of the excluded-model
 * codes (those are still discounted — the dealer just funds them fully).
 *
 * When the promo declares NEITHER keywords NOR excluded refs, every priced
 * line is considered eligible (a blanket promo).
 */
export function lineMatchesPromo(line: QuoteLine | null | undefined, promo: Promotion | null | undefined): boolean {
  if (!line || !promo) return false;
  if (!isPricedLine(line)) return false;

  const keywords = (promo.eligibleKeywords || []).map(norm).filter(Boolean);
  const fullRefs = (promo.dealerFullRefs || []).map(norm).filter(Boolean);
  if (keywords.length === 0 && fullRefs.length === 0) return true;

  const hay = [line.family, line.reference, line.name].map(norm);
  const ref = norm(line.reference);
  const fam = norm(line.family);

  const keywordHit = keywords.some((k) => hay.some((h) => h && h.includes(k)));
  const refHit = fullRefs.some((r) => r && (ref === r || fam === r || ref.includes(r) || fam.includes(r)));
  return keywordHit || refHit;
}

/** True when the line's model code is in the dealer-funds-fully list. */
export function lineIsDealerFunded(line: QuoteLine | null | undefined, promo: Promotion | null | undefined): boolean {
  if (!line || !promo) return false;
  const fullRefs = (promo.dealerFullRefs || []).map(norm).filter(Boolean);
  if (fullRefs.length === 0) return false;
  const ref = norm(line.reference);
  const fam = norm(line.family);
  return fullRefs.some((r) => r && (ref === r || fam === r || ref.includes(r) || fam.includes(r)));
}

/** Line ids the promo suggests applying to, in list order. */
export function suggestEligibleLineIds(
  lines: readonly QuoteLine[] | null | undefined,
  promo: Promotion | null | undefined,
): string[] {
  return (lines || []).filter((l) => lineMatchesPromo(l, promo)).map((l) => l.id);
}

/** Active promos first, then by start date; disabled/expired sink to the bottom. */
export function sortPromotions(promos: readonly Promotion[] | null | undefined): Promotion[] {
  const now = Date.now();
  return [...(promos || [])].sort((a, b) => {
    const aActive = isPromoActive(a, now) ? 0 : 1;
    const bActive = isPromoActive(b, now) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return (b.startsAt || 0) - (a.startsAt || 0);
  });
}
