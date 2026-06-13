import { BookOpen, Boxes } from 'lucide-react';

/**
 * The two product-source buttons for the editor — LABELED. They are
 * deliberately SEPARATE because the two sources are fundamentally different:
 *   • Catálogo  → the brand catalogs (CatalogPicker), spanning every brand:
 *                 a Ligne Roset SKU/model priced by grade + fabric, or a
 *                 LifestyleGarden piece — ordered from the manufacturer.
 *   • Inventario → our own stock on hand (InventoryPicker): a physical unit
 *                 already received into the warehouse, at its selling price.
 *
 * They used to be icon-only (a book and boxes) — the PRIMARY way to add a
 * product hidden behind two mystery glyphs. The labels are the point: the
 * dealer should never have to hover to learn how to add an article.
 *
 * `variant`: 'toolbar' (compact ghost text buttons, sit in a card header/footer
 * row next to "Sección") | 'cta' (larger bordered buttons — the empty-state
 * call to action).
 */
export default function AddSourceButtons({ onOpenCatalog, onOpenInventory, variant = 'toolbar' }) {
  const cls = variant === 'cta'
    ? 'inline-flex items-center gap-2 rounded-md border border-ink-200 bg-surface px-4 h-11 coarse:h-12 text-sm font-medium text-ink-700 hover:bg-ink-50 hover:border-ink-300 hover:text-ink-900 active:bg-ink-100 active:scale-[0.97] transition-all shadow-xs ring-1 ring-inset ring-black/5'
    : 'btn-ghost text-xs';
  const size = variant === 'cta' ? 17 : 14;
  return (
    <div className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={onOpenCatalog}
        className={cls}
        title="Agregar desde los catálogos de marca (Ligne Roset, LifestyleGarden)"
      >
        <BookOpen size={size} aria-hidden /> Catálogo
      </button>
      <button
        type="button"
        onClick={onOpenInventory}
        className={cls}
        title="Agregar desde el inventario (existencias)"
      >
        <Boxes size={size} aria-hidden /> Inventario
      </button>
    </div>
  );
}
