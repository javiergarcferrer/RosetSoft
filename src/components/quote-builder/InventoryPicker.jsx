import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import Modal from '../Modal.jsx';
import ModelBrowser from './ModelBrowser.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { useLiveQuery } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { formatMoney } from '../../lib/format.js';
import { productForGrade, isOutOfStock } from '../../lib/catalog.js';
import { BRAND_LIFESTYLEGARDEN } from '../../lib/constants.js';
import { productLineSeed } from './catalogSeed.js';

const usd = (n) => formatMoney(Number(n) || 0, 'USD', { USD: 1 });

/**
 * Inventory picker — add a quote line from STOCK ON HAND. The counterpart to
 * the (Ligne Roset) CatalogPicker, with TWO sources of our own stock, each its
 * own tab:
 *   • Existencias     — the manual `inventory_items` list (units received, each
 *     with its quantity on hand and the permanent selling price set at
 *     receiving). The seed copies the item onto the line: name, reference (sku)
 *     and unitPrice = sellingPrice (USD, like every quote line). It deliberately
 *     does NOT seed unitCost — a stock item's avgCost is carried in DOP (the
 *     books' currency) while a quote line's cost is USD, so copying it across
 *     would mis-state the margin. Quoting moves no stock — the kardex only moves
 *     on a real sale.
 *   • LifestyleGarden — the stock synced from the team's LSG Shopify store
 *     (products with brand `lifestylegarden`, each carrying live `stock_qty`).
 *     It moved here from the Catálogo picker: it's our own warehouse stock, not
 *     the supplier catalog. Picking inserts the line through the SHARED
 *     productLineSeed so an LSG line lands identically wherever it's added.
 */
export default function InventoryPicker({ open, onClose, onInsert }) {
  const { profileId } = useApp();
  // Match how the Existencias page stores + queries stock: the shared 'team'
  // profile when no per-user profile is set. Querying a different scope would
  // show an empty picker even with stock on hand.
  const scope = profileId || 'team';
  const [tab, setTab] = useState('stock'); // 'stock' | 'lsg'

  // Reset to the manual-stock tab each time the modal (re)opens.
  useEffect(() => { if (open) setTab('stock'); }, [open]);

  // Add an LSG model to the quote. LSG products are never fabric-graded, so the
  // pick inserts the single product directly — the same seed (incl. the CDN
  // photo pointers) the Catálogo picker built when LSG lived under it.
  function pickLsg(model) {
    const product = productForGrade(model, '');
    if (!product || isOutOfStock(product)) return;
    onInsert(productLineSeed(model, product, ''));
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Inventario" flushBody>
      <div className="flex flex-col flex-1 min-h-0">
        <div className="flex-shrink-0 px-4 sm:px-6 pt-4 pb-3 border-b border-ink-100">
          <SourceTabs tab={tab} onChange={setTab} />
        </div>
        {tab === 'stock'
          ? <StockBody scope={scope} onInsert={onInsert} onClose={onClose} />
          : <ModelBrowser profileId={profileId} brand={BRAND_LIFESTYLEGARDEN} onPick={pickLsg} />}
      </div>
    </Modal>
  );
}

/** Segmented source switcher — our manual stock vs the LSG Shopify stock.
 *  Mirrors the brand switch the Catálogo picker used to carry (now Roset-only). */
function SourceTabs({ tab, onChange }) {
  const cls = (active) =>
    active
      ? 'px-3 py-1.5 min-h-8 coarse:min-h-11 bg-ink-900 text-ink-50'
      : 'px-3 py-1.5 min-h-8 coarse:min-h-11 text-ink-600 hover:bg-ink-100 active:bg-ink-200 transition-colors';
  return (
    <div className="inline-flex rounded-md border border-ink-200 overflow-hidden text-xs font-medium select-none">
      <button type="button" onClick={() => onChange('stock')} aria-pressed={tab === 'stock'} className={cls(tab === 'stock')}>
        Existencias
      </button>
      <button type="button" onClick={() => onChange('lsg')} aria-pressed={tab === 'lsg'} className={cls(tab === 'lsg')}>
        LifestyleGarden
      </button>
    </div>
  );
}

/** Manual stock-on-hand list (inventory_items) — search + pick. Owns its own
 *  pinned search band over a single scrolling list, matching ModelBrowser. */
function StockBody({ scope, onInsert, onClose }) {
  const [q, setQ] = useState('');
  const items = useLiveQuery(
    () => db.inventoryItems.where('profileId').equals(scope).toArray(),
    [scope],
    [],
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = needle
      ? items.filter((it) => `${it.name} ${it.sku || ''}`.toLowerCase().includes(needle))
      : items;
    // In-stock first, then alphabetical — the dealer usually reaches for what's
    // actually on hand.
    return [...matched].sort((a, b) => {
      const ao = (Number(a.qtyOnHand) || 0) > 0 ? 0 : 1;
      const bo = (Number(b.qtyOnHand) || 0) > 0 ? 0 : 1;
      return ao - bo || String(a.name || '').localeCompare(String(b.name || ''));
    });
  }, [items, q]);

  function pick(item) {
    onInsert({
      name: item.name,
      reference: item.sku || '',
      unitPrice: Number(item.sellingPrice) || 0,
      qty: 1,
      // Keep the link to the kardex item — quoting still moves no stock, but
      // invoicing can now offer the salida prefilled instead of forgetting
      // which item was sold.
      inventoryItemId: item.id,
    });
    onClose();
  }

  return (
    <>
      <div className="flex-shrink-0 px-4 sm:px-6 pt-3 pb-3">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar en existencias por nombre o SKU…"
            className="input pl-9"
            autoFocus
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6 pb-4">
        {rows.length === 0 ? (
          <div className="px-3 py-10 text-center text-sm text-ink-500">
            {items.length === 0 ? (
              <>Sin existencias todavía. Agrégalas en <b>Inventario › Existencias</b>.</>
            ) : (
              'Ningún artículo coincide con la búsqueda.'
            )}
          </div>
        ) : (
          rows.map((it) => {
            const onHand = Number(it.qtyOnHand) || 0;
            const out = onHand <= 0;
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => pick(it)}
                className="w-full text-left rounded-md px-3 py-2.5 mb-0.5 min-h-11 flex items-center justify-between gap-3 hover:bg-ink-50 active:bg-ink-100 transition-colors"
              >
                {/* Stock names are user-entered — wrap, never truncate. */}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink-900 break-words">{it.name}</span>
                  <span className="block text-[11px] text-ink-500 break-words">
                    {it.sku ? `${it.sku} · ` : ''}
                    <span className={out ? 'text-amber-600' : 'text-emerald-600'}>
                      {onHand} {it.unit || 'u.'} {out ? '· sin stock' : 'en stock'}
                    </span>
                  </span>
                </span>
                <span className="text-xs tabular-nums text-ink-900 whitespace-nowrap flex-shrink-0">{usd(it.sellingPrice)}</span>
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
