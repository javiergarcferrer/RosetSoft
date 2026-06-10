import { BookOpen, Boxes } from 'lucide-react';

/**
 * The two product-source buttons for the editor — icon only, no label. They are
 * deliberately SEPARATE because the two sources are fundamentally different:
 *   • Catálogo  → the Ligne Roset supplier catalog (CatalogPicker): a SKU/model
 *                 priced by grade + fabric, ordered from the manufacturer.
 *   • Inventario → our own stock on hand (InventoryPicker): a physical unit
 *                 already received into the warehouse, at its selling price.
 *
 * `variant`: 'toolbar' (compact, sits in a card header/footer row) | 'cta'
 * (larger bordered buttons — the empty-state call to action).
 */
export default function AddSourceButtons({ onOpenCatalog, onOpenInventory, variant = 'toolbar' }) {
  const cls = variant === 'cta'
    ? 'inline-flex items-center justify-center w-11 h-11 coarse:w-12 coarse:h-12 rounded-md border border-ink-200 bg-white text-ink-600 hover:bg-ink-50 hover:border-ink-300 hover:text-ink-900 active:bg-ink-100 active:scale-[0.97] transition-all shadow-xs ring-1 ring-inset ring-black/5'
    : 'inline-flex items-center justify-center w-9 h-9 coarse:w-11 coarse:h-11 rounded-md text-ink-500 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200 active:scale-[0.96] transition-all';
  const size = variant === 'cta' ? 20 : 17;
  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onOpenCatalog}
        className={cls}
        title="Catálogo Ligne Roset"
        aria-label="Agregar desde el catálogo Ligne Roset"
      >
        <BookOpen size={size} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onOpenInventory}
        className={cls}
        title="Inventario (existencias)"
        aria-label="Agregar desde el inventario"
      >
        <Boxes size={size} aria-hidden />
      </button>
    </div>
  );
}
