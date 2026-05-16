import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from '../db/hooks.js';
import { ArrowLeft, Plus, Trash2, Save, ExternalLink } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import ImageDrop from '../components/ImageDrop.jsx';
import ImageView from '../components/ImageView.jsx';
import Modal from '../components/Modal.jsx';
import { DebouncedInput, DebouncedTextarea } from '../components/DebouncedInput.jsx';
import { db, newId } from '../db/database.js';
import { GRADES } from '../lib/pricing.js';

export default function ProductDetail() {
  const { productId } = useParams();
  const navigate = useNavigate();
  const product = useLiveQuery(() => db.products.get(productId), [productId], null);
  const variants = useLiveQuery(
    () => db.productVariants.where('productId').equals(productId).toArray(),
    [productId],
    []
  );
  const categories = useLiveQuery(() => db.categories.toArray(), [], []);

  const [editingVariantId, setEditingVariantId] = useState(null);

  if (!product) return <div className="text-sm text-ink-500">Cargando producto…</div>;

  async function update(patch) {
    await db.products.put({ ...product, ...patch });
  }

  async function newVariant() {
    const id = newId();
    await db.productVariants.put({
      id,
      productId,
      name: 'NUEVA VARIANTE',
      reference: '',
      yardage: '',
      dimensions: '',
      priceByGrade: {},
      sortOrder: variants.length,
      imageId: null,
    });
    setEditingVariantId(id);
  }

  async function removeProduct() {
    if (!confirm(`¿Eliminar el producto ${product.name} y todas sus variantes?`)) return;
    for (const v of variants) await db.productVariants.delete(v.id);
    await db.products.delete(productId);
    navigate('/catalog');
  }

  const impossibilitiesText = (product.technicalImpossibilities || []).join(', ');

  return (
    <>
      <Link to="/catalog" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 mb-3">
        <ArrowLeft size={12} /> Volver al catálogo
      </Link>
      <PageHeader
        title={product.name}
        subtitle={[product.designer, product.year, categories.find((c) => c.id === product.categoryId)?.name]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            <button onClick={removeProduct} className="btn-ghost text-red-600 hover:bg-red-50"><Trash2 size={14} /> Eliminar</button>
            <Link to={`/quotes/new?product=${product.id}`} className="btn-primary">Agregar a cotización</Link>
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <ImageDrop
            imageId={product.vectorImageId}
            onChange={(id) => update({ vectorImageId: id })}
            kind="product-vector"
            ownerId={product.id}
            label="Imagen vector — se muestra en el catálogo y al cotizar"
            imgClassName="w-full aspect-[4/3] object-cover rounded-md"
          />
          <div className="mt-4">
            <ImageDrop
              imageId={product.heroImageId}
              onChange={(id) => update({ heroImageId: id })}
              kind="product-hero"
              ownerId={product.id}
              label="Foto principal — imagen para el cliente, solo en el PDF exportado"
              imgClassName="w-full aspect-[4/3] object-cover rounded-md"
            />
          </div>
          <div className="card card-pad mt-4 space-y-3">
            <div>
              <div className="label">Nombre</div>
              <DebouncedInput className="input" value={product.name} onCommit={(v) => update({ name: v })} />
            </div>
            <div>
              <div className="label">Diseñador</div>
              <DebouncedInput className="input" value={product.designer || ''} onCommit={(v) => update({ designer: v })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="label">Año</div>
                <DebouncedInput className="input" type="number" value={product.year || ''} onCommit={(v) => update({ year: v ? Number(v) : null })} />
              </div>
              <div>
                <div className="label">Categoría</div>
                <select className="input" value={product.categoryId || ''} onChange={(e) => update({ categoryId: e.target.value || null })}>
                  <option value="">(sin categoría)</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <div className="label">Telas no permitidas (separadas por coma)</div>
              <DebouncedTextarea
                className="input min-h-[60px]"
                value={impossibilitiesText}
                onCommit={(v) => update({
                  technicalImpossibilities: v.split(',').map((s) => s.trim()).filter(Boolean),
                })}
              />
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {product.description && (
            <div className="card card-pad">
              <div className="label">Descripción</div>
              <DebouncedTextarea
                className="input min-h-[100px]"
                value={product.description}
                onCommit={(v) => update({ description: v })}
              />
            </div>
          )}

          <div className="card">
            <div className="px-5 py-3 border-b border-ink-100 flex items-center justify-between">
              <h2 className="font-semibold">Variantes ({variants.length})</h2>
              <button onClick={newVariant} className="btn-secondary"><Plus size={14} /> Agregar variante</button>
            </div>
            {variants.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-ink-500">Sin variantes.</div>
            ) : (
              <>
                {/* Mobile cards */}
                <div className="md:hidden divide-y divide-ink-100">
                  {variants.map((v) => {
                    const gradeCount = Object.keys(v.priceByGrade || {}).length;
                    return (
                      <button
                        key={v.id}
                        onClick={() => setEditingVariantId(v.id)}
                        className="w-full text-left p-3 flex items-center gap-3 hover:bg-ink-50 active:bg-ink-100"
                      >
                        <div className="w-14 h-14 rounded bg-ink-100 overflow-hidden flex-shrink-0">
                          <ImageView id={v.imageId} className="w-full h-full object-cover" placeholderClassName="w-full h-full" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold truncate">{v.name}</div>
                          {v.reference && <div className="font-mono text-[11px] text-ink-500 truncate">{v.reference}</div>}
                          <div className="text-[11px] text-ink-500 mt-0.5 truncate">
                            {[v.yardage, v.dimensions].filter(Boolean).join(' · ') || '—'}
                          </div>
                          <div className="text-[11px] text-ink-500 mt-0.5">
                            {gradeCount} {gradeCount === 1 ? 'grado' : 'grados'}
                          </div>
                        </div>
                        <ExternalLink size={14} className="text-ink-400 flex-shrink-0" />
                      </button>
                    );
                  })}
                </div>

                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="table min-w-[760px]">
                    <thead>
                      <tr>
                        <th>Imagen</th>
                        <th>Nombre</th>
                        <th>Referencia</th>
                        <th>Metraje</th>
                        <th>Dimensiones</th>
                        <th className="text-right">Grados</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {variants.map((v) => {
                        const gradeCount = Object.keys(v.priceByGrade || {}).length;
                        return (
                          <tr key={v.id}>
                            <td className="w-14">
                              <div className="w-12 h-12 rounded bg-ink-100 overflow-hidden">
                                <ImageView id={v.imageId} className="w-full h-full object-cover" placeholderClassName="w-full h-full" />
                              </div>
                            </td>
                            <td className="font-medium">{v.name}</td>
                            <td className="font-mono text-xs text-ink-600">{v.reference || '—'}</td>
                            <td className="text-ink-600">{v.yardage || '—'}</td>
                            <td className="text-ink-600 max-w-xs truncate" title={v.dimensions}>{v.dimensions || '—'}</td>
                            <td className="text-right text-xs text-ink-500">
                              {gradeCount} {gradeCount === 1 ? 'grado' : 'grados'}
                            </td>
                            <td className="text-right w-20">
                              <button onClick={() => setEditingVariantId(v.id)} className="text-xs text-ink-600 hover:text-ink-900 inline-flex items-center gap-1">
                                Editar <ExternalLink size={12} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <VariantEditor
        variantId={editingVariantId}
        onClose={() => setEditingVariantId(null)}
      />
    </>
  );
}

function VariantEditor({ variantId, onClose }) {
  const variant = useLiveQuery(() => (variantId ? db.productVariants.get(variantId) : null), [variantId], null);
  const open = !!variantId;
  if (!variant) {
    return <Modal open={open} onClose={onClose} title="Variante" />;
  }

  async function update(patch) {
    await db.productVariants.put({ ...variant, ...patch });
  }

  async function updateGrade(letter, value) {
    const next = { ...(variant.priceByGrade || {}) };
    if (value === '' || value == null) delete next[letter];
    else next[letter] = Number(value);
    await db.productVariants.put({ ...variant, priceByGrade: next });
  }

  async function remove() {
    if (!confirm(`¿Eliminar la variante "${variant.name}"?`)) return;
    await db.productVariants.delete(variant.id);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Editar variante — ${variant.name}`}
      size="lg"
      footer={
        <>
          <button onClick={remove} className="btn-ghost text-red-600 hover:bg-red-50"><Trash2 size={14} /> Eliminar</button>
          <div className="flex-1" />
          <button onClick={onClose} className="btn-primary"><Save size={14} /> Listo</button>
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
        <ImageDrop
          imageId={variant.imageId}
          onChange={(id) => update({ imageId: id })}
          kind="variant"
          ownerId={variant.id}
          label="Imagen de variante"
          imgClassName="w-full aspect-square object-cover rounded-md"
        />
        <div className="sm:col-span-2 space-y-3">
          <div>
            <div className="label">Nombre</div>
            <DebouncedInput className="input" value={variant.name} onCommit={(v) => update({ name: v })} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="label">Código de referencia</div>
              <DebouncedInput className="input font-mono" value={variant.reference || ''} onCommit={(v) => update({ reference: v })} />
            </div>
            <div>
              <div className="label">Metraje</div>
              <DebouncedInput className="input" value={variant.yardage || ''} onCommit={(v) => update({ yardage: v })} placeholder="p. ej. 6.60yd" />
            </div>
          </div>
          <div>
            <div className="label">Dimensiones</div>
            <DebouncedInput className="input" value={variant.dimensions || ''} onCommit={(v) => update({ dimensions: v })} placeholder='p. ej. H 28" W 32" D 32" S 16"' />
          </div>
        </div>
      </div>

      <div className="label">Precios por grado (USD)</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {GRADES.map((g) => (
          <div key={g}>
            <div className="text-[10px] font-semibold text-ink-500 uppercase">Grado {g}</div>
            <DebouncedInput
              type="number"
              className="input mt-1"
              value={(variant.priceByGrade || {})[g] ?? ''}
              onCommit={(v) => updateGrade(g, v)}
              placeholder="—"
            />
          </div>
        ))}
      </div>
    </Modal>
  );
}
