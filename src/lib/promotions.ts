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

/* ------------------------------ email import ------------------------------ */

/** What the parser can pull out of a pasted Roset marketing email. */
export type ParsedPromotion = Partial<
  Pick<
    Promotion,
    'name' | 'code' | 'discountPct' | 'startsAt' | 'endsAt' | 'dealerFullRefs' | 'eligibleKeywords' | 'terms'
  >
>;

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

const KEYWORD_STOPWORDS = new Set(['promo', 'promotion', 'and', 'the', 'of', 'our', 'sale']);

/**
 * Turn pasted email content (rich-text/HTML or plain text) into normalized
 * plain text: block tags → newlines, common entities decoded, tags stripped,
 * runs of spaces collapsed (newlines preserved so the model list stays
 * line-per-code).
 */
function emailToText(raw: string): string {
  return String(raw || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&(?:#8211|#8212|ndash|mdash);/gi, '-')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Parse a Ligne Roset promo email into a draft Promotion. Best-effort — every
 * field is independent, so a missed pattern just leaves that field unset for
 * the dealer to fill. Pairs with the "Importar pegando el correo" box in
 * PromotionModal, which pre-fills the form from the result.
 *
 * Handles the standard Roset shape, e.g.:
 *   "...materials for our Cabinetry & Bedroom Promo, June 11-23, 2026."
 *   "Registration Code: BED26"
 *   "...offer a 20% discount..."
 *   "...the dealer takes the full 20%:\n152 - TOGO\n14 J - MINI TOGO\n..."
 *   "This promotion cannot be combined ... not included."
 */
export function parsePromotionEmail(raw: string): ParsedPromotion {
  const text = emailToText(raw);
  const out: ParsedPromotion = {};

  // Name + date window: "for our <name>, <Month> <d>-<d>, <year>"
  const nameDate = text.match(
    /for our\s+(.+?),\s+([A-Za-z]+)\.?\s+(\d{1,2})\s*[-–]\s*([A-Za-z]+\.?\s+)?(\d{1,2}),?\s+(\d{4})/i,
  );
  if (nameDate) {
    out.name = nameDate[1].replace(/\s+/g, ' ').trim();
    const startMonth = MONTHS[nameDate[2].toLowerCase().replace('.', '')];
    const endMonth = nameDate[4] ? MONTHS[nameDate[4].toLowerCase().replace('.', '').trim()] : startMonth;
    const startDay = Number(nameDate[3]);
    const endDay = Number(nameDate[5]);
    const year = Number(nameDate[6]);
    if (startMonth != null && Number.isFinite(startDay)) {
      out.startsAt = new Date(year, startMonth, startDay, 0, 0, 0, 0).getTime();
    }
    if (endMonth != null && Number.isFinite(endDay)) {
      out.endsAt = new Date(year, endMonth, endDay, 23, 59, 59, 999).getTime();
    }
  }

  // Registration / promo code.
  const code = text.match(/Registration Code:\s*([A-Za-z0-9-]+)/i) || text.match(/\bcode\s+([A-Z][A-Z0-9]{2,})\b/);
  if (code) out.code = code[1].trim();

  // Headline discount — prefer the explicit "offer a NN% discount" sentence.
  const disc = text.match(/offer(?:s|ing)?\s+a\s+(\d{1,3})\s*%/i) || text.match(/(\d{1,3})\s*%\s*(?:off|discount)/i);
  if (disc) out.discountPct = Number(disc[1]);

  // Dealer-funds-fully model list: the block after "full NN%:" up to the next
  // blank line or the "This promotion..." sentence. Each line's leading token
  // (before " - <name>") is the model code.
  const block = text.match(/full\s+\d{1,3}%:\s*([\s\S]*?)(?:\n\s*\n|This promotion|$)/i);
  if (block) {
    const refs = block[1]
      .split('\n')
      .map((line) => line.split(/\s[-–]\s/)[0].trim())
      .filter((tok) => tok && /[A-Za-z0-9]/.test(tok) && tok.length <= 12);
    if (refs.length) out.dealerFullRefs = refs;
  }

  // Terms — the standard fine-print. Prefer capturing through the trailing
  // "...not included." sentence; fall back to the first sentence boundary so
  // a shorter variant still yields something.
  const terms =
    text.match(/This promotion cannot be combined[\s\S]*?not included\./i) ||
    text.match(/This promotion cannot be combined[\s\S]*?(?:included|orders)\./i);
  if (terms) out.terms = terms[0].replace(/\s+/g, ' ').trim();

  // Eligible keywords — seed from the promo name's content words so the line
  // suggestion has something to match; the dealer can refine.
  if (out.name) {
    const kws = out.name
      .toLowerCase()
      .split(/[^a-záéíóúñ]+/i)
      .map((w) => w.trim())
      .filter((w) => w.length > 2 && !KEYWORD_STOPWORDS.has(w));
    if (kws.length) out.eligibleKeywords = [...new Set(kws)];
  }

  return out;
}

