import { Palette } from 'lucide-react';

// The single material-picker icon button. Every surface that opens a
// fabric/material picker renders THIS — the dealer's line editor
// (QuoteLineItem) and the client-facing preview / share link (ClientPreview's
// FabricPicker). Keeping the trigger in one place is why it looks identical
// everywhere and can't drift: a caller just hands an onClick that opens its own
// picker modal; the glyph, sizing, and hover/touch states live here.
export default function MaterialPickerButton({ onClick, className = '' }) {
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
