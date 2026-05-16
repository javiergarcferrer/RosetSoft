import { useMemo, useState } from 'react';
import { useLiveQuery } from '../../db/hooks.js';
import Modal from '../Modal.jsx';
import ImageView from '../ImageView.jsx';
import { db } from '../../db/database.js';

/**
 * Modal that lets the user pick a product variant to add as a quote line.
 * Each product surfaces as a card whose variants are inline buttons. The
 * substring search matches against product name and designer; the result set
 * is capped at 60 to keep the modal scannable on large catalogs.
 */
export default function ProductPickerModal({ open, onClose, onPick }) {
  const products = useLiveQuery(() => db.products.toArray(), [], []);
  const variants = useLiveQuery(() => db.productVariants.toArray(), [], []);
  const [q, setQ] = useState('');

  const variantsByProduct = useMemo(() => {
    const m = new Map();
    for (const v of variants) {
      const arr = m.get(v.productId) || [];
      arr.push(v);
      m.set(v.productId, arr);
    }
    return m;
  }, [variants]);

  const filteredProducts = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return products.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, 60);
    return products
      .filter((p) => p.name.toLowerCase().includes(needle) || (p.designer || '').toLowerCase().includes(needle))
      .slice(0, 60);
  }, [products, q]);

  return (
    <Modal open={open} onClose={onClose} title="Agregar producto" size="lg">
      <div className="mb-3">
        <input autoFocus className="input" placeholder="Buscar productos…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2 max-h-[60vh] overflow-y-auto">
        {filteredProducts.map((p) => {
          const pv = variantsByProduct.get(p.id) || [];
          return (
            <div key={p.id} className="border border-ink-100 rounded-md hover:border-ink-300 transition">
              <div className="flex items-center gap-3 px-3 py-2 border-b border-ink-100">
                <div className="w-16 h-12 rounded bg-white border border-ink-100 overflow-hidden flex-shrink-0">
                  <ImageView id={p.vectorImageId || p.heroImageId} className="w-full h-full object-contain" placeholderClassName="w-full h-full" />
                </div>
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{p.name}</div>
                  <div className="text-[10px] text-ink-500 truncate">{p.designer || ''}</div>
                </div>
              </div>
              <div className="px-2 py-1.5 space-y-0.5">
                {pv.length === 0 ? (
                  <div className="text-[11px] text-ink-400 px-2 py-1">Sin variantes</div>
                ) : pv.map((v) => {
                  const diff = v.dimensions || v.yardage || p.description || '';
                  return (
                    <button
                      key={v.id}
                      onClick={() => onPick(v)}
                      className="w-full flex items-center justify-between text-left text-xs px-2 py-1.5 rounded hover:bg-ink-100"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        <span className="truncate">{v.name}</span>
                        {diff && (
                          <span
                            className="block text-[10px] text-ink-500 truncate tabular-nums"
                            title={diff}
                          >
                            {diff}
                          </span>
                        )}
                      </span>
                      <span className="text-[10px] text-ink-400 font-mono ml-2 flex-shrink-0">{v.reference || ''}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {filteredProducts.length === 0 && (
          <div className="col-span-2 text-center text-sm text-ink-500 py-10">Sin productos.</div>
        )}
      </div>
    </Modal>
  );
}
