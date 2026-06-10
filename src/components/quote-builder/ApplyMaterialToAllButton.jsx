import { Copy } from 'lucide-react';

// "Apply this fabric to every component" — a LABELLED secondary action shown
// directly beneath the material picker on the client link. Labelled (not the old
// bare icon) so a customer browsing on a phone can see what it does without
// hovering for a tooltip. Callers gate visibility — it shows only while copying
// this piece's material would actually change a sibling, so it self-hides once
// every component already matches.
export default function ApplyMaterialToAllButton({
  onClick,
  label = 'Aplicar a todos',
  title = 'Usar esta misma tela en todos los componentes de este producto',
  className = '',
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-md border border-ink-200 bg-white px-3 py-2 min-h-9 coarse:min-h-11 text-xs font-medium text-ink-600 transition-colors hover:bg-ink-50 hover:text-ink-900 hover:border-ink-300 active:bg-ink-100 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 ${className}`}
    >
      <Copy size={13} aria-hidden /> {label}
    </button>
  );
}
