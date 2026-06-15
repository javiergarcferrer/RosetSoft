/**
 * Quote terms presets — the dealer's small library of named terms templates
 * (Configuración → Predeterminados de cotización), applied to a quote with one
 * tap. The picker in the quote editor (NotesAndTermsCard) writes a preset's
 * `body` straight into `quote.terms`; every downstream surface (the client
 * preview, the public link, the PDF) already renders `quote.terms`, so nothing
 * else has to change.
 *
 * Two presets ship by default, keyed to the quote's orderType: a PISO
 * (stock/floor) sale ships from inventory now; a SPECIAL order ships in a
 * container weeks out — different validity, lead time and payment language.
 *
 * Pure Model — no React, no Supabase. Surfaced through core/quote.
 */
import type { OrderType, Quote, QuoteTermsPreset, Settings } from '../types/domain';

/**
 * Fallback presets, mirroring the seed in migration
 * 20260724000000_quote_terms_presets.sql. Used when a settings row predates the
 * column (empty array) so the picker + the new-draft default still have sane
 * terms to offer.
 */
export const DEFAULT_QUOTE_TERMS_PRESETS: QuoteTermsPreset[] = [
  {
    id: 'preset-piso',
    label: 'Pedido de piso',
    orderType: 'floor',
    body: 'Cotización válida por 15 días. Precios en pesos dominicanos. Entrega inmediata sujeta a disponibilidad en almacén. Se requiere el pago total para apartar y retirar la mercancía.',
  },
  {
    id: 'preset-especial',
    label: 'Pedido especial',
    orderType: 'special',
    body: 'Cotización válida por 30 días. Precios en pesos dominicanos. Tiempo de entrega aproximado: 12–16 semanas. Se requiere un depósito del 50% para iniciar el pedido; el balance se paga antes de la entrega. Sujeto a disponibilidad del fabricante.',
  },
];

/** The orderType normalized to the two valid values (default 'floor'). */
function normOrderType(orderType?: OrderType | string | null): OrderType {
  return orderType === 'special' ? 'special' : 'floor';
}

/**
 * The configured presets for a settings row, defensively normalized (drops any
 * entry missing an id/body). Falls back to DEFAULT_QUOTE_TERMS_PRESETS when
 * nothing valid is stored, so callers never face an empty picker.
 */
export function resolveTermsPresets(
  settings?: Pick<Settings, 'quoteTermsPresets'> | null,
): QuoteTermsPreset[] {
  const raw = settings?.quoteTermsPresets;
  const list = Array.isArray(raw)
    ? raw.filter(
        (p): p is QuoteTermsPreset =>
          !!p && typeof p.id === 'string' && typeof p.body === 'string',
      )
    : [];
  return list.length ? list : DEFAULT_QUOTE_TERMS_PRESETS;
}

/** One picker chip: a preset plus its state for the current quote. */
export interface TermsPresetChoice extends QuoteTermsPreset {
  /** Matches the quote's current orderType — the recommended pick. */
  suggested: boolean;
  /** This preset's body is exactly the quote's current terms text. */
  applied: boolean;
}

/**
 * The terms-preset picker model for one quote: every configured preset, each
 * flagged `suggested` when its orderType matches the quote's (a piso quote
 * suggests the piso preset, etc.) and `applied` when its body already equals the
 * quote's terms text. The View renders these as one-tap chips above the terms
 * box.
 */
export function resolveTermsPresetPicker(
  settings?: Pick<Settings, 'quoteTermsPresets'> | null,
  quote?: Pick<Quote, 'orderType' | 'terms'> | null,
): TermsPresetChoice[] {
  const orderType = normOrderType(quote?.orderType);
  const current = (quote?.terms || '').trim();
  return resolveTermsPresets(settings).map((p) => ({
    ...p,
    // Only a preset explicitly tagged with an orderType is "suggested" — an
    // untagged (generic) preset never claims the match.
    suggested: p.orderType != null && normOrderType(p.orderType) === orderType,
    applied: current.length > 0 && p.body.trim() === current,
  }));
}

/**
 * The terms text a NEW draft starts with: the preset matching the draft's
 * orderType, else the legacy single `quoteTerms`, else the first preset, else
 * empty. Keeps the long-standing behavior (new quotes prefill terms) while
 * making the prefill order-type aware.
 */
export function initialQuoteTerms(
  settings?: Pick<Settings, 'quoteTermsPresets' | 'quoteTerms'> | null,
  orderType: OrderType = 'floor',
): string {
  const ot = normOrderType(orderType);
  const presets = resolveTermsPresets(settings);
  const match = presets.find((p) => p.orderType === ot);
  if (match) return match.body;
  if (typeof settings?.quoteTerms === 'string' && settings.quoteTerms) {
    return settings.quoteTerms;
  }
  return presets[0]?.body || '';
}
