import { Palette, Pencil } from 'lucide-react';

// The material-picker trigger. Two faces share ONE component so the dealer's
// editor and the client link can't drift:
//   - compact (no `label`) — the dealer's line editor (QuoteLineItem): a small
//     "Catálogo" text button. It used to be a bare palette glyph, which the
//     dealer never discovered — the ONE door into the material catalog can't
//     be a mystery icon.
//   - labelled (`label` given) — the client-facing preview / share link, where
//     a customer on a phone gets a full, obviously tappable button. When a
//     `colorUrl` is passed it leads with a colour chip of the CURRENT material
//     (color-coded) + an edit pencil, so it reads as "edit this material",
//     sitting to the right of the swatch.
// A caller just hands an onClick that opens its own picker modal; the glyph,
// sizing, and hover/touch states live here.
export default function MaterialPickerButton({ onClick, label, colorUrl, className = '' }) {
  if (label) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1.5 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 min-h-9 coarse:min-h-11 text-xs font-semibold text-brand-700 transition-colors hover:bg-brand-100 hover:border-brand-300 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${className}`}
        title="Elegir del catálogo de materiales"
      >
        {colorUrl ? (
          <span
            className="h-4 w-4 rounded-full border border-brand-300 bg-cover bg-center flex-shrink-0"
            style={{ backgroundImage: `url(${colorUrl})` }}
            aria-hidden
          />
        ) : (
          <Palette size={15} aria-hidden />
        )}
        {label}
        <Pencil size={12} className="opacity-70" aria-hidden />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 min-h-7 coarse:min-h-11 text-[11px] font-medium text-brand-700 hover:bg-brand-50 active:bg-brand-100 transition-colors flex-shrink-0 whitespace-nowrap ${className}`}
      title="Elegir del catálogo de materiales"
      aria-label="Elegir tela del catálogo"
    >
      <Palette size={13} aria-hidden />
      Catálogo
    </button>
  );
}
