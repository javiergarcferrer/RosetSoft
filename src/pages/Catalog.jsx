import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from '../db/hooks.js';
import {
  Plus, Search, Sofa, ChevronDown, ChevronRight, ExternalLink, Image as ImageIcon,
} from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ImageView from '../components/ImageView.jsx';
import Modal from '../components/Modal.jsx';
import { db, newId } from '../db/database.js';
import { useApp } from '../context/AppContext.jsx';
import { useCart } from '../context/CartContext.jsx';
import { formatMoney } from '../lib/format.js';
import { isMaterialAllowed, variantPriceForGrade } from '../lib/pricing.js';

/**
 * Catalog page — grouped table view.
 *
 * Each product is a header row (image, name, designer, category, # variants).
 * Click to expand and see all variants as sub-rows, each with reference,
 * yardage, price range, and a "+ Agregar" button that opens a material picker.
 *
 * Right sidebar (QuoteCart) shows the running quote and lets the user keep
 * stacking items without leaving this page.
 */

export default function Catalog() {
  const { settings } = useApp();
  const products = useLiveQuery(() => db.products.toArray(), [], []);
  const variants = useLiveQuery(() => db.productVariants.toArray(), [], []);
  const categories = useLiveQuery(() => db.categories.orderBy('sortOrder').toArray(), [], []);

  const [q, setQ] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [pickerState, setPickerState] = useState({ open: false, variant: null, product: null });
  const [newOpen, setNewOpen] = useState(false);

  const rates = settings?.currencyRates || { USD: 1, DOP: 60.0 };
  const currency = settings?.defaultCurrency || 'DOP';

  const productsWithVariants = useMemo(() => {
    const byProduct = new Map();
    for (const v of variants) {
      const arr = byProduct.get(v.productId) || [];
      arr.push(v);
      byProduct.set(v.productId, arr);
    }
    return products.map((p) => {
      const vs = (byProduct.get(p.id) || []).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      const allPrices = [];
      let hasFixed = false;
      for (const v of vs) {
        const grades = Object.values(v.priceByGrade || {});
        if (grades.length) allPrices.push(...grades);
        if (v.priceFixed != null) { allPrices.push(v.priceFixed); hasFixed = true; }
      }
      return {
        ...p,
        variants: vs,
        minPrice: allPrices.length ? Math.min(...allPrices) : null,
        maxPrice: allPrices.length ? Math.max(...allPrices) : null,
        hasFixedPrice: hasFixed,
      };
    });
  }, [products, variants]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return productsWithVariants
      .filter((p) => (catFilter ? p.categoryId === catFilter : true))
      .filter((p) => {
        if (!needle) return true;
        return (
          p.name.toLowerCase().includes(needle) ||
          (p.designer || '').toLowerCase().includes(needle) ||
          p.variants.some((v) => v.name.toLowerCase().includes(needle) || (v.reference || '').toLowerCase().includes(needle))
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [productsWithVariants, q, catFilter]);

  if (!products.length) {
    return (
      <>
        <PageHeader title="Catálogo" subtitle="Productos y variantes" />
        <EmptyState
          icon={Sofa}
          title="Sin productos"
          description="Importa un PDF de Ligne Roset para poblar el catálogo automáticamente, o agrega un producto manualmente."
          action={
            <div className="flex items-center justify-center gap-2">
              <Link to="/import" className="btn-primary">Importar PDF</Link>
              <button onClick={() => setNewOpen(true)} className="btn-secondary">Agregar manual</button>
            </div>
          }
        />
        <NewProductModal open={newOpen} onClose={() => setNewOpen(false)} categories={categories} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Catálogo"
        subtitle={`${products.length} productos · ${variants.length} variantes`}
        actions={<button onClick={() => setNewOpen(true)} className="btn-primary"><Plus size={14} /> Agregar producto</button>}
      />

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar producto, diseñador o referencia…"
            className="input pl-9"
          />
        </div>
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} className="input max-w-xs">
          <option value="">Todas las categorías</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* Mobile: stacked cards */}
      <div className="md:hidden space-y-3">
        {filtered.map((p) => (
          <ProductCard
            key={p.id}
            product={p}
            isExpanded={expandedId === p.id}
            onToggle={() => setExpandedId(expandedId === p.id ? null : p.id)}
            onAdd={(variant) => setPickerState({ open: true, variant, product: p })}
            category={categories.find((c) => c.id === p.categoryId)}
            rates={rates}
            currency={currency}
          />
        ))}
        {filtered.length === 0 && (
          <div className="card card-pad text-center text-sm text-ink-500">Sin coincidencias.</div>
        )}
      </div>

      {/* Desktop: table */}
      <div className="hidden md:block card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table min-w-[860px]">
            <thead>
              <tr>
                <th className="w-10"></th>
                <th className="w-28">Foto</th>
                <th>Producto</th>
                <th>Diseñador</th>
                <th>Categoría</th>
                <th className="text-right">Variantes</th>
                <th className="text-right">Desde</th>
                <th className="w-20"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <ProductRows
                  key={p.id}
                  product={p}
                  isExpanded={expandedId === p.id}
                  onToggle={() => setExpandedId(expandedId === p.id ? null : p.id)}
                  onAdd={(variant) => setPickerState({ open: true, variant, product: p })}
                  category={categories.find((c) => c.id === p.categoryId)}
                  rates={rates}
                  currency={currency}
                />
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && <div className="px-5 py-10 text-center text-sm text-ink-500">Sin coincidencias.</div>}
      </div>

      <FabricPickerModal
        open={pickerState.open}
        product={pickerState.product}
        variant={pickerState.variant}
        onClose={() => setPickerState({ open: false, variant: null, product: null })}
      />
      <NewProductModal open={newOpen} onClose={() => setNewOpen(false)} categories={categories} />
    </>
  );
}

function ProductRows({ product, isExpanded, onToggle, onAdd, category, rates, currency }) {
  const variants = product.variants;
  const variantCount = variants.length;

  return (
    <>
      <tr className="cursor-pointer align-middle" onClick={onToggle}>
        <td className="text-ink-400">
          {variantCount > 0 ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}
        </td>
        <td>
          <div className="w-24 h-20 rounded bg-ink-50 border border-ink-100 overflow-hidden">
            <ImageView id={product.vectorImageId || product.heroImageId} className="w-full h-full object-contain" placeholderClassName="w-full h-full" />
          </div>
        </td>
        <td>
          <div className="font-semibold text-sm">{product.name}</div>
          {product.year && <div className="text-[10px] text-ink-500">{product.year}</div>}
        </td>
        <td className="text-ink-700">{product.designer || '—'}</td>
        <td className="text-ink-500 text-xs">{category?.name || '—'}</td>
        <td className="text-right text-ink-500">{variantCount}</td>
        <td className="text-right">
          {product.minPrice != null ? (
            <div className="text-sm font-medium">{formatMoney(product.minPrice, currency, rates)}</div>
          ) : (
            <span className="text-xs text-ink-400">—</span>
          )}
        </td>
        <td className="text-right">
          <Link
            to={`/catalog/${product.id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1"
          >
            Editar <ExternalLink size={11} />
          </Link>
        </td>
      </tr>

      {isExpanded && variants.length > 0 && (
        <tr>
          <td colSpan={8} className="!p-0 bg-ink-50/50">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="text-[10px] text-ink-500 uppercase tracking-wider">
                    <th className="text-left pl-12 py-2 w-24"></th>
                    <th className="text-left py-2 w-2/5">Variante</th>
                    <th className="text-left py-2">Referencia</th>
                    <th className="text-left py-2">Telas</th>
                    <th className="text-right py-2">Precio</th>
                    <th className="text-right py-2 pr-5 w-32"></th>
                  </tr>
                </thead>
                <tbody>
                  {variants.map((v) => (
                    <VariantRow
                      key={v.id}
                      product={product}
                      variant={v}
                      onAdd={() => onAdd(v)}
                      rates={rates}
                      currency={currency}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ProductCard({ product, isExpanded, onToggle, onAdd, category, rates, currency }) {
  const variantCount = product.variants.length;
  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left flex items-start gap-3 p-3 hover:bg-ink-50"
      >
        <div className="w-20 h-16 rounded bg-ink-50 border border-ink-100 overflow-hidden flex-shrink-0">
          <ImageView id={product.vectorImageId || product.heroImageId} className="w-full h-full object-contain" placeholderClassName="w-full h-full" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="font-semibold text-sm truncate">{product.name}</div>
              <div className="text-xs text-ink-500 truncate">
                {product.designer || '—'}{category?.name ? ` · ${category.name}` : ''}
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              {product.minPrice != null ? (
                <div className="text-sm font-medium">{formatMoney(product.minPrice, currency, rates)}</div>
              ) : (
                <div className="text-xs text-ink-400">—</div>
              )}
              <div className="text-[10px] text-ink-500">{variantCount} {variantCount === 1 ? 'variante' : 'variantes'}</div>
            </div>
          </div>
        </div>
      </button>

      <div className="px-3 pb-2 flex items-center justify-between">
        <Link
          to={`/catalog/${product.id}`}
          className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 px-2 py-1 -ml-2"
        >
          Editar <ExternalLink size={11} />
        </Link>
        {variantCount > 0 && (
          <button
            type="button"
            onClick={onToggle}
            className="text-xs text-ink-600 inline-flex items-center gap-1 px-2 py-1 -mr-2"
          >
            {isExpanded ? <>Ocultar <ChevronDown size={12} /></> : <>Ver variantes <ChevronRight size={12} /></>}
          </button>
        )}
      </div>

      {isExpanded && variantCount > 0 && (
        <ul className="border-t border-ink-100 divide-y divide-ink-100 bg-ink-50/50">
          {product.variants.map((v) => (
            <VariantCard
              key={v.id}
              product={product}
              variant={v}
              onAdd={() => onAdd(v)}
              rates={rates}
              currency={currency}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function VariantCard({ product, variant, onAdd, rates, currency }) {
  const grades = Object.entries(variant.priceByGrade || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const minPrice = grades.length
    ? Math.min(...grades.map(([, v]) => v))
    : variant.priceFixed ?? null;
  const maxPrice = grades.length
    ? Math.max(...grades.map(([, v]) => v))
    : variant.priceFixed ?? null;
  const differentiator = variant.dimensions || variant.yardage || product.description || '';
  return (
    <li className="px-3 py-2.5 flex items-start gap-3">
      <div className="w-16 h-12 rounded bg-white border border-ink-100 overflow-hidden flex-shrink-0">
        <ImageView id={variant.imageId || product.vectorImageId || product.heroImageId} className="w-full h-full object-contain" placeholderClassName="w-full h-full" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{variant.name}</div>
        {differentiator && (
          <div
            className="text-[11px] text-ink-600 truncate tabular-nums"
            title={differentiator}
          >
            {differentiator}
          </div>
        )}
        {variant.reference && <div className="font-mono text-[10px] text-ink-500">{variant.reference}</div>}
        {minPrice != null && (
          <div className="text-xs text-ink-700 mt-0.5">
            {minPrice === maxPrice
              ? formatMoney(minPrice, currency, rates)
              : `${formatMoney(minPrice, currency, rates)} – ${formatMoney(maxPrice, currency, rates)}`}
          </div>
        )}
      </div>
      <button
        onClick={onAdd}
        className="btn-brand text-xs flex-shrink-0"
        title="Agregar a la cotización"
      >
        <Plus size={12} /> Agregar
      </button>
    </li>
  );
}

function VariantRow({ product, variant, onAdd, rates, currency }) {
  const grades = Object.entries(variant.priceByGrade || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const minPrice = grades.length
    ? Math.min(...grades.map(([, v]) => v))
    : variant.priceFixed ?? null;
  const maxPrice = grades.length
    ? Math.max(...grades.map(([, v]) => v))
    : variant.priceFixed ?? null;

  return (
    <tr className="border-t border-ink-100 align-middle">
      <td className="pl-12 py-2 w-24">
        <div className="w-20 h-16 rounded bg-white border border-ink-100 overflow-hidden">
          <ImageView id={variant.imageId || product.vectorImageId || product.heroImageId} className="w-full h-full object-contain" placeholderClassName="w-full h-full" />
        </div>
      </td>
      <td className="py-2">
        <div className="font-medium text-sm">{variant.name}</div>
        {(() => {
          const diff = variant.dimensions || variant.yardage || product.description || '';
          return diff ? (
            <div
              className="text-[11px] text-ink-600 truncate tabular-nums max-w-xs"
              title={diff}
            >
              {diff}
            </div>
          ) : null;
        })()}
      </td>
      <td className="py-2 font-mono text-xs text-ink-600">{variant.reference || '—'}</td>
      <td className="py-2 text-xs text-ink-500">
        {grades.length > 0 ? `${grades.length} grados (${grades[0][0]}–${grades[grades.length - 1][0]})` : variant.priceFixed != null ? 'Precio fijo' : '—'}
      </td>
      <td className="py-2 text-right">
        {minPrice != null ? (
          minPrice === maxPrice ? (
            <div className="text-sm font-medium">{formatMoney(minPrice, currency, rates)}</div>
          ) : (
            <div>
              <div className="text-sm font-medium">{formatMoney(minPrice, currency, rates)}</div>
              <div className="text-[10px] text-ink-500">hasta {formatMoney(maxPrice, currency, rates)}</div>
            </div>
          )
        ) : (
          <span className="text-xs text-ink-400">—</span>
        )}
      </td>
      <td className="py-2 pr-5 text-right">
        <button
          onClick={(e) => { e.stopPropagation(); onAdd(); }}
          className="btn-brand text-xs"
          title="Agregar a la cotización"
        >
          <Plus size={12} /> Agregar
        </button>
      </td>
    </tr>
  );
}

/**
 * Quick fabric + color picker shown when the user clicks "Agregar".
 * Pre-filters fabrics disallowed by the product's technicalImpossibilities.
 * The selection determines which grade price applies to this line.
 */
function FabricPickerModal({ open, onClose, product, variant }) {
  const { addLine } = useCart();
  const materials = useLiveQuery(() => db.materials.toArray(), [], []);
  const colors = useLiveQuery(() => db.materialColors.toArray(), [], []);

  const [q, setQ] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [activeMaterial, setActiveMaterial] = useState(null);
  const [qty, setQty] = useState(1);

  useEffect(() => {
    if (!open) {
      setActiveMaterial(null);
      setQ('');
      setQty(1);
      setKindFilter('');
    }
  }, [open]);

  const hasGrades = variant && Object.keys(variant.priceByGrade || {}).length > 0;
  const hasFixed = variant?.priceFixed != null;

  const allowed = useMemo(() => {
    return materials.filter((m) => isMaterialAllowed(product, m));
  }, [materials, product]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return allowed
      .filter((m) => (kindFilter ? m.kind === kindFilter : true))
      .filter((m) => {
        if (!hasGrades) return true; // for fixed-price products, any material allowed
        return variantPriceForGrade(variant, m.grade) != null;
      })
      .filter((m) => {
        if (!needle) return true;
        return m.name.toLowerCase().includes(needle) || (m.composition || '').toLowerCase().includes(needle);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allowed, q, kindFilter, variant, hasGrades]);

  const matColors = useMemo(() => {
    if (!activeMaterial) return [];
    return colors.filter((c) => c.materialId === activeMaterial.id);
  }, [activeMaterial, colors]);

  async function pickColor(color) {
    await addLine({
      variant,
      materialId: activeMaterial?.id || null,
      colorId: color?.id || null,
      qty: Math.max(1, qty),
    });
    onClose();
  }

  async function skipColorAndAdd() {
    await addLine({
      variant,
      materialId: activeMaterial?.id || null,
      colorId: null,
      qty: Math.max(1, qty),
    });
    onClose();
  }

  async function addFixedPriced() {
    await addLine({
      variant,
      materialId: null,
      colorId: null,
      qty: Math.max(1, qty),
    });
    onClose();
  }

  if (!variant) return <Modal open={open} onClose={onClose} title="" />;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${product?.name || ''} — ${variant.name}`}
      size="xl"
    >
      <div className="flex flex-wrap items-center gap-3 mb-4 pb-3 border-b border-ink-100">
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-500">Cantidad</span>
          <input
            type="number"
            min="1"
            value={qty}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
            className="input w-20 py-1 text-center"
          />
        </div>
        {hasFixed && !hasGrades && (
          <button onClick={addFixedPriced} className="btn-primary ml-auto">
            <Plus size={14} /> Agregar (precio fijo)
          </button>
        )}
      </div>

      {!hasGrades && hasFixed ? (
        <div className="text-sm text-ink-500 py-6">
          Este artículo tiene precio fijo (no requiere selección de tela). Ajusta la cantidad arriba y agrega.
        </div>
      ) : !activeMaterial ? (
        <>
          <div className="flex flex-col sm:flex-row gap-2 mb-3">
            <input
              autoFocus
              className="input flex-1"
              placeholder="Buscar tela o cuero…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className="input">
              <option value="">Todos</option>
              <option value="fabric">Tela</option>
              <option value="leather">Cuero</option>
              <option value="outdoor-fabric">Outdoor</option>
            </select>
          </div>
          <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1">
            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-ink-100">
              {filtered.map((m) => {
                const price = variantPriceForGrade(variant, m.grade);
                const colorCount = colors.filter((c) => c.materialId === m.id).length;
                return (
                  <button
                    key={m.id}
                    onClick={() => setActiveMaterial(m)}
                    className="w-full text-left p-3 flex items-start justify-between gap-2 hover:bg-ink-50 active:bg-ink-100"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold truncate">{m.name}</div>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <span className="capitalize text-[10px] text-ink-700">{m.kind.replace('-', ' ')}</span>
                        <span className="badge">{m.grade || '—'}</span>
                        <span className="text-[10px] text-ink-500">{colorCount} {colorCount === 1 ? 'color' : 'colores'}</span>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-sm font-medium"><PriceCell amount={price} /></div>
                      <div className="text-[11px] text-brand-600 mt-0.5">Elegir →</div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="table min-w-[640px]">
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Tipo</th>
                    <th>Grado</th>
                    <th className="text-right">Precio</th>
                    <th>Colores</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m) => {
                    const price = variantPriceForGrade(variant, m.grade);
                    const colorCount = colors.filter((c) => c.materialId === m.id).length;
                    return (
                      <tr key={m.id}>
                        <td className="font-medium">{m.name}</td>
                        <td className="capitalize text-xs">{m.kind.replace('-', ' ')}</td>
                        <td><span className="badge">{m.grade || '—'}</span></td>
                        <td className="text-right font-medium">
                          <PriceCell amount={price} />
                        </td>
                        <td className="text-ink-500">{colorCount}</td>
                        <td className="text-right">
                          <button onClick={() => setActiveMaterial(m)} className="text-xs text-brand-600 hover:underline">
                            Elegir →
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filtered.length === 0 && (
              <div className="text-center text-sm text-ink-500 py-10">
                No hay telas disponibles para este producto/grado.
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3">
            <button onClick={() => setActiveMaterial(null)} className="btn-ghost">← Cambiar tela</button>
            <div className="text-sm">
              <span className="font-medium">{activeMaterial.name}</span>
              <span className="text-ink-500"> · Grado {activeMaterial.grade}</span>
            </div>
            <button onClick={skipColorAndAdd} className="btn-primary text-xs">
              <Plus size={12} /> Sin color
            </button>
          </div>
          {matColors.length === 0 ? (
            <div className="text-center text-sm text-ink-500 py-10">
              No hay colores guardados para {activeMaterial.name}.
              <div className="mt-3"><button onClick={skipColorAndAdd} className="btn-primary">Agregar sin color</button></div>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 max-h-[55vh] overflow-y-auto">
              {matColors.map((c) => (
                <button
                  key={c.id}
                  onClick={() => pickColor(c)}
                  className="card hover:border-brand-400 hover:shadow-md transition text-left overflow-hidden"
                >
                  <div className="aspect-square bg-ink-100">
                    <ImageView id={c.swatchImageId} className="w-full h-full object-cover" placeholderClassName="w-full h-full" />
                  </div>
                  <div className="px-2.5 py-1.5">
                    <div className="text-xs font-medium truncate">{c.name}</div>
                    <div className="text-[10px] text-ink-500 font-mono">{c.code || '—'}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function PriceCell({ amount }) {
  const { settings } = useApp();
  if (amount == null) return <span className="text-ink-400">—</span>;
  return <span>{formatMoney(amount, settings?.defaultCurrency || 'DOP', settings?.currencyRates || { USD: 1, DOP: 60 })}</span>;
}

function NewProductModal({ open, onClose, categories }) {
  const [name, setName] = useState('');
  const [designer, setDesigner] = useState('');
  const [categoryId, setCategoryId] = useState('');

  async function save() {
    if (!name.trim()) return;
    const id = newId();
    await db.products.put({
      id,
      name: name.trim().toUpperCase(),
      designer: designer.trim(),
      categoryId: categoryId || null,
      description: '',
      technicalImpossibilities: [],
      heroImageId: null,
      vectorImageId: null,
    });
    onClose();
    window.location.hash = `#/catalog/${id}`;
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Agregar producto"
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">Cancelar</button>
          <button onClick={save} className="btn-primary">Crear</button>
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="label">Nombre *</div>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. ANDY" />
        </div>
        <div>
          <div className="label">Diseñador</div>
          <input className="input" value={designer} onChange={(e) => setDesigner(e.target.value)} placeholder="p. ej. Pierre Paulin" />
        </div>
        <div className="sm:col-span-2">
          <div className="label">Categoría</div>
          <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">(sin categoría)</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}
