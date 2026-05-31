import { Palette } from 'lucide-react';

// The material-picker trigger. Two faces share ONE component so the dealer's
// editor and the client link can't drift:
//   - icon-only (no `label`) — the dealer's dense line editor (QuoteLineItem),
//     where a labelled button would crowd the row's other controls.
//   - labelled (`label` given) — the client-facing preview / share link, where
//     a bare glyph went unnoticed; a customer on a phone gets a full, obviously
//     tappable button instead.
// A caller just hands an onClick that opens its own picker modal; the glyph,
// sizing, and hover/touch states live here.
export default function MaterialPickerButton({ onClick, label, className = '' }) {
  if (label) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 min-h-9 coarse:min-h-11 text-xs font-semibold text-brand-700 transition-colors hover:bg-brand-100 hover:border-brand-300 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${className}`}
        title="Elegir del catálogo de materiales"
      >
        <Palette size={15} aria-hidden />
        {label}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center justify-center w-7 h-7 coarse:w-9 coarse:h-9 rounded-md text-ink-400 hover:text-brand-700 hover:bg-brand-50 transition-colors flex-shrink-0 ${className}`}
      title="Elegir del catálogo de materiales"
      aria-label="Elegir tela del catálogo"
    >
      <Palette size={14} />
    </button>
  );
}
