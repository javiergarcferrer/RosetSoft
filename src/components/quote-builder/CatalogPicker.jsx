import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, PackageSearch, ChevronLeft, Loader2 } from 'lucide-react';
import Modal from '../Modal.jsx';
import ImageView from '../ImageView.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { useLiveQuery, useLiveQueryStatus } from '../../db/hooks.js';
import { db, searchProducts } from '../../db/database.js';
import { groupFamilies, productForGrade } from '../../lib/catalog.js';
import { composeSubtype } from '../../lib/subtype.js';
import { formatMoney } from '../../lib/format.js';

/**
 * Catalog picker — the model → fabric(grade)→ price quote flow.
 *
 *   Step 1: search and pick a MODEL (a family of SKUs sharing the 8-digit
 *           root, e.g. "Togo Fireside Chair").
 *   Step 2: ONE combined step — a list of fabrics available for that model's
 *           grades, each row showing the fabric, its grade, and the model's
 *           PRICE in that grade. Picking one fills the quote line (reference =
 *           that grade's SKU, name, dimensions, "Grade X — Fabric", price, and
 *           the real cost frozen onto the line for the margin view).
 *
 * Non-graded models (tables, lamps, wood chairs) skip step 2 — picking the
 * model inserts its single priced row directly.
 *
 * The catalog is tens of thousands of SKUs, so step 1 searches Postgres
 * server-side (debounced) and only ever pulls a bounded result set —
 * `searchProducts` — never the whole table. Materials (a small table) load on
 * open as before.
 */
const usd = (n) => formatMoney(Number(n) || 0, 'USD', { USD: 1 });
const heroImageId = (m) => m?.colors?.find((c) => c.imageId)?.imageId || null;

export default function CatalogPicker({ open, onClose, onInsert }) {
  const { profileId } = useApp();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [sel, setSel] = useState(null);   // selected graded family → step 2
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setDq('');
    setSel(null);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // Debounce the query so each keystroke isn't its own request.
  useEffect(() => {
    const id = setTimeout(() => setDq(q.trim()), 200);
    return () => clearTimeout(id);
  }, [q]);

  // Server-side search — the catalog is tens of thousands of SKUs, never pulled
  // whole. A focused model search returns all that model's grade variants so
  // family grouping stays complete; an empty term shows a bounded browse set.
  // While closed the query is inert (a never-resolving promise) so reopening
  // shows the last results instantly instead of an "empty catalog" flash.
  const { data: products, loaded } = useLiveQueryStatus(
    () => (open && profileId ? searchProducts(profileId, dq, 500) : new Promise(() => {})),
    [open, profileId, dq],
    [],
  );
  const materials = useLiveQuery(
    () => (profileId ? db.materials.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId, open],
    [],
  );

  const families = useMemo(() => groupFamilies(products), [products]);
  const matches = useMemo(
    () => [...families].sort((a, b) => (a.name || '').localeCompare(b.name || '')).slice(0, 60),
    [families],
  );

  function familyPriceLabel(fam) {
    if (!fam.graded) {
      const p = productForGrade(fam, '');
      return p ? usd(p.priceUsd) : '—';
    }
    const prices = fam.grades.map((g) => Number(productForGrade(fam, g)?.priceUsd) || 0).filter(Boolean);
    return prices.length ? `desde ${usd(Math.min(...prices))}` : '—';
  }

  function insertProduct(fam, product, grade, material) {
    if (!product) return;
    onInsert({
      family: product.family || fam.family,
      reference: product.reference,
      name: product.name,
      dimensions: product.dimensions,
      // Graded pick → "Grade X — Fabric"; a plain (non-upholstered) product
      // keeps its own catalog subtype (the wood finish / variant text).
      subtype: (grade || material) ? composeSubtype(grade, material?.name) : (product.subtype || ''),
      unitPrice: product.priceUsd,
      unitCost: product.cost,
      swatchImageId: material ? heroImageId(material) : null,
    });
    onClose();
  }

  function pickFamily(fam) {
    if (!fam.graded) {
      insertProduct(fam, productForGrade(fam, ''), '');
      return;
    }
    setSel(fam);
  }

  // Step 2 — fabrics whose grade the selected model offers, each carrying the
  // model's price at that grade.
  const fabricRows = useMemo(() => {
    if (!sel) return [];
    const grades = new Set(sel.grades);
    return materials
      .filter((m) => m.grade && grades.has(String(m.grade).toUpperCase()))
      .map((m) => {
        const grade = String(m.grade).toUpperCase();
        return { material: m, grade, product: productForGrade(sel, grade) };
      })
      .filter((r) => r.product)
      .sort((a, b) => (Number(a.product.priceUsd) || 0) - (Number(b.product.priceUsd) || 0));
  }, [sel, materials]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={sel ? `${sel.name} · elige la tela` : 'Catálogo'}
    >
      {!sel ? (
        <>
          <div className="relative mb-3">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400 pointer-events-none" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="input pl-9"
              placeholder="Buscar modelo por nombre, referencia o familia…"
            />
            {q && (
              <button type="button" onClick={() => { setQ(''); inputRef.current?.focus(); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700 p-1" aria-label="Limpiar">
                <X size={14} />
              </button>
            )}
          </div>

          {!loaded ? (
            <div className="px-3 py-10 text-center text-sm text-ink-500 flex items-center justify-center gap-2">
              <Loader2 size={15} className="animate-spin" /> Buscando…
            </div>
          ) : matches.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-ink-500">
              {dq ? 'Sin coincidencias.' : <>Catálogo vacío. Impórtalo en <b>Administración › Catálogo</b>.</>}
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto -mx-1">
              {matches.map((fam) => (
                <button
                  key={fam.root}
                  type="button"
                  onClick={() => pickFamily(fam)}
                  className="w-full text-left rounded-md px-3 py-2.5 mx-1 mb-0.5 flex items-center gap-3 hover:bg-ink-50 transition-colors"
                >
                  <span className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-ink-100 text-ink-500 flex-shrink-0">
                    <PackageSearch size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink-900 truncate">{fam.name || fam.root}</span>
                    <span className="block text-[11px] text-ink-500">
                      {[fam.family, fam.graded ? `${fam.grades.length} grados` : null].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="text-sm tabular-nums text-ink-700 whitespace-nowrap">{familyPriceLabel(fam)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <button type="button" onClick={() => setSel(null)} className="back-link"><ChevronLeft size={12} /> Volver a modelos</button>
          {fabricRows.length === 0 ? (
            // No fabric in the catalog for this model's grades — let the dealer
            // pick the price tier (grade) directly so the flow still works.
            <div className="max-h-[60vh] overflow-y-auto -mx-1">
              <div className="px-3 pb-2 text-[11px] text-ink-500">Sin telas del catálogo para estos grados — elige el grado por precio:</div>
              {sel.grades.map((g) => {
                const p = productForGrade(sel, g);
                return (
                  <button key={g} type="button" onClick={() => insertProduct(sel, p, g)} className="w-full text-left rounded-md px-3 py-2.5 mx-1 mb-0.5 flex items-center justify-between gap-3 hover:bg-ink-50 transition-colors">
                    <span className="chip bg-ink-100 text-ink-700 border border-ink-200">Grado {g}</span>
                    <span className="text-sm tabular-nums text-ink-900 whitespace-nowrap">{usd(p?.priceUsd)}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto -mx-1">
              {fabricRows.map(({ material, grade, product }) => (
                <button
                  key={material.id}
                  type="button"
                  onClick={() => insertProduct(sel, product, grade, material)}
                  className="w-full text-left rounded-md px-3 py-2.5 mx-1 mb-0.5 flex items-center gap-3 hover:bg-ink-50 transition-colors"
                >
                  {heroImageId(material) ? (
                    <ImageView id={heroImageId(material)} hoverPreview className="w-9 h-9 object-cover rounded border border-ink-100 bg-white flex-shrink-0" />
                  ) : (
                    <span className="w-9 h-9 rounded border border-dashed border-ink-200 bg-ink-50 flex-shrink-0" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink-900 truncate">{material.name}</span>
                    <span className="block text-[11px] text-ink-500">Grado {grade}{material.category ? ` · ${material.category}` : ''}</span>
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-ink-900 whitespace-nowrap">{usd(product.priceUsd)}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
