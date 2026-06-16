import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import Modal from '../Modal.jsx';
import { PickerSearch, PickerBrowse } from './ModelBrowser.jsx';
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
 * the Catálogo picker (the full Ligne Roset catalog to ORDER): this one shows
 * only what's actually in the warehouse, across our two stock catalogues, each
 * with its own browse tab:
 *   • Ligne Roset     — our on-hand `inventory_items` (units that entered from
 *     Importaciones (expediente) or Compras, each with its quantity on hand and
 *     the permanent selling price set at receiving). The seed copies name,
 *     reference (sku) and unitPrice = sellingPrice (USD, like every quote line).
 *     It deliberately does NOT seed unitCost — a stock item's avgCost is carried
 *     in DOP (the books' currency) while a quote line's cost is USD, so copying
 *     it across would mis-state the margin. Quoting moves no stock — the kardex
 *     only moves on a real sale.
 *   • LifestyleGarden — the stock synced from the team's LSG Shopify store
 *     (products with brand `lifestylegarden`, each carrying live `stock_qty`).
 *     It's the EXCEPTION: not import-fed, mirrored from Shopify. Picking inserts
 *     the line through the SHARED productLineSeed so an LSG line lands
 *     identically wherever it's added (incl. its CDN photo pointers).
 *
 * ONE search bar spans BOTH catalogues: typing surfaces matching Ligne Roset
 * stock AND LifestyleGarden models together (the active tab's catalogue leads).
 * The tabs only drive BROWSE (empty query) — pick a catalogue to scroll it.
 */
export default function InventoryPicker({ open, onClose, onInsert }) {
  const { profileId } = useApp();
  // Match how the Existencias page stores + queries stock: the shared 'team'
  // profile when no per-user profile is set. Querying a different scope would
  // show an empty picker even with stock on hand.
  const scope = profileId || 'team';
  const [tab, setTab] = useState('stock'); // 'stock' (Ligne Roset) | 'lsg'
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');        // debounced query (the LSG side hits Postgres)
  const inputRef = useRef(null);

  // Reset to the Ligne Roset tab + an empty search each time the modal (re)opens.
  useEffect(() => { if (open) { setTab('stock'); setQ(''); setDq(''); } }, [open]);

  // Focus the shared search on open (mirrors ModelBrowser's deferred focus so it
  // wins over the modal's mount focus).
  useEffect(() => {
    if (!open) return undefined;
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open]);

  // Debounce the query so each keystroke isn't its own request.
  useEffect(() => {
    const id = setTimeout(() => setDq(q.trim()), 200);
    return () => clearTimeout(id);
  }, [q]);

  // Add an LSG model to the quote. LSG products are never fabric-graded, so the
  // pick inserts the single product directly — the same seed (incl. the CDN
  // photo pointers) the Catálogo picker built when LSG lived under it.
  function pickLsg(model) {
    const product = productForGrade(model, '');
    if (!product || isOutOfStock(product)) return;
    onInsert(productLineSeed(model, product, ''));
    onClose();
  }

  const searching = dq.length > 0;

  // Combined-search sections. The active tab's catalogue leads, so a dealer
  // mid-browse on LifestyleGarden sees LSG hits first (and vice-versa).
  const lrSection = (
    <div key="lr">
      <SectionLabel>Ligne Roset</SectionLabel>
      <StockList scope={scope} q={dq} onInsert={onInsert} onClose={onClose} />
    </div>
  );
  const lsgSection = (
    <div key="lsg">
      <SectionLabel>LifestyleGarden</SectionLabel>
      <PickerSearch profileId={profileId} brand={BRAND_LIFESTYLEGARDEN} term={dq} onPick={pickLsg} />
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Inventario" flushBody>
      <div className="flex flex-col flex-1 min-h-0">
        {/* Pinned header — catalogue tabs over the single cross-catalogue search
            box. Both stay put as the list grows and with the iOS keyboard up. */}
        <div className="flex-shrink-0 px-4 sm:px-6 pt-4 pb-3 space-y-3 border-b border-ink-100">
          <SourceTabs tab={tab} onChange={setTab} />
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className={q ? 'input search-clean pl-9 pr-9 coarse:pr-11' : 'input search-clean pl-9'}
              placeholder="Buscar en todos los catálogos…"
              aria-label="Buscar en el inventario"
              // See ModelBrowser: a real type="search" with no contact words in
              // the placeholder keeps iOS from raising the AutoFill-Contact bar;
              // .search-clean hides the native ✕ (we render our own).
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {q && (
              // btn-icon matches the input's 36/44 height exactly, so the clear
              // affordance fills the input's right end as a full-size touch target.
              <button type="button" onClick={() => { setQ(''); inputRef.current?.focus(); }} className="btn-icon absolute right-0 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700" aria-label="Limpiar">
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Single scroll region — combined cross-catalogue results when
            searching, else the active catalogue's browse. */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-6 pb-4 pt-3">
          {searching ? (
            <div className="space-y-4">
              {tab === 'lsg' ? [lsgSection, lrSection] : [lrSection, lsgSection]}
            </div>
          ) : tab === 'stock' ? (
            <StockList scope={scope} q="" onInsert={onInsert} onClose={onClose} />
          ) : (
            <PickerBrowse profileId={profileId} brand={BRAND_LIFESTYLEGARDEN} onPick={pickLsg} />
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Segmented catalogue switcher — our on-hand Ligne Roset stock vs the LSG
 *  Shopify stock. Drives BROWSE only; searching spans both regardless. */
function SourceTabs({ tab, onChange }) {
  const cls = (active) =>
    active
      ? 'px-3 py-1.5 min-h-8 coarse:min-h-11 bg-ink-900 text-ink-50'
      : 'px-3 py-1.5 min-h-8 coarse:min-h-11 text-ink-600 hover:bg-ink-100 active:bg-ink-200 transition-colors';
  return (
    <div className="inline-flex rounded-md border border-ink-200 overflow-hidden text-xs font-medium select-none">
      <button type="button" onClick={() => onChange('stock')} aria-pressed={tab === 'stock'} className={cls(tab === 'stock')}>
        Ligne Roset
      </button>
      <button type="button" onClick={() => onChange('lsg')} aria-pressed={tab === 'lsg'} className={cls(tab === 'lsg')}>
        LifestyleGarden
      </button>
    </div>
  );
}

/** Source divider in the combined search view — names which catalogue the rows
 *  below belong to (Ligne Roset stock vs the LifestyleGarden Shopify models). */
function SectionLabel({ children }) {
  return <div className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{children}</div>;
}

/** Our on-hand stock (`inventory_items`) — the Ligne Roset catalogue of the
 *  Inventario picker. Renders the matched rows for the SHARED search box (`q`
 *  empty = browse all, in-stock first); it owns no search field of its own. */
function StockList({ scope, q, onInsert, onClose }) {
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

  if (rows.length === 0) {
    // Searching → a quiet one-liner (the other catalogue sits right below);
    // browsing an empty catalogue → the fuller "where the stock comes from" hint.
    if (q.trim()) return <div className="px-3 py-2 text-sm text-ink-500">Sin coincidencias en Ligne Roset.</div>;
    return (
      <div className="px-3 py-10 text-center text-sm text-ink-500">
        Sin existencias todavía. La mercancía Ligne Roset entra desde <b>Importaciones</b> o <b>Compras</b>.
      </div>
    );
  }

  return (
    <div>
      {rows.map((it) => {
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
      })}
    </div>
  );
}
