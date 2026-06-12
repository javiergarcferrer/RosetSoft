import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import Modal from '../Modal.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { useLiveQuery } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { formatMoney } from '../../lib/format.js';

const usd = (n) => formatMoney(Number(n) || 0, 'USD', { USD: 1 });

/**
 * Inventory picker — add a quote line from STOCK ON HAND (existencias). This is
 * the counterpart to CatalogPicker and a DIFFERENT source on purpose: it lists
 * our own `inventory_items` (units already received), each with its quantity on
 * hand and the permanent selling price set at receiving — not the supplier
 * catalog.
 *
 * The seed copies the stock item onto the line: name, reference (sku) and
 * unitPrice = sellingPrice (stored in USD, like every quote line — see the
 * "Precio de venta (USD)" field in Contabilidad › Inventario). It deliberately
 * does NOT seed unitCost: a stock item's `avgCost` is carried in DOP (the
 * books' currency) while a quote line's cost is USD, so copying it across would
 * mis-state the margin. Quoting moves no stock — the kardex only moves on a
 * real sale.
 */
export default function InventoryPicker({ open, onClose, onInsert }) {
  const { profileId } = useApp();
  // Match how Contabilidad › Inventario stores + queries stock: the shared
  // 'team' profile when no per-user profile is set. Querying a different scope
  // would show an empty picker even with stock on hand.
  const scope = profileId || 'team';
  const [q, setQ] = useState('');

  const items = useLiveQuery(
    () => db.inventoryItems.where('profileId').equals(scope).toArray(),
    [scope, open],
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
    <Modal open={open} onClose={onClose} size="lg" title="Inventario">
      <div className="relative mb-3">
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

      {rows.length === 0 ? (
        <div className="px-3 py-10 text-center text-sm text-ink-500">
          {items.length === 0 ? (
            <>Sin existencias todavía. Recíbelas en <b>Contabilidad › Inventario</b>.</>
          ) : (
            'Ningún artículo coincide con la búsqueda.'
          )}
        </div>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto -mx-1">
          {rows.map((it) => {
            const onHand = Number(it.qtyOnHand) || 0;
            const out = onHand <= 0;
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => pick(it)}
                className="w-full text-left rounded-md px-3 py-2.5 mx-1 mb-0.5 min-h-11 flex items-center justify-between gap-3 hover:bg-ink-50 active:bg-ink-100 transition-colors"
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
      )}
    </Modal>
  );
}
