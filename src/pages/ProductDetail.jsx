import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from '../db/hooks.js';
import { ArrowLeft, Plus, Trash2, Save, ExternalLink } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import ImageDrop from '../components/ImageDrop.jsx';
import ImageView from '../components/ImageView.jsx';
import Modal from '../components/Modal.jsx';
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

  if (!product) return <div className="text-sm text-ink-500">Loading product…</div>;

  async function update(patch) {
    await db.products.put({ ...product, ...patch });
  }

  async function newVariant() {
    const id = newId();
    await db.productVariants.put({
      id,
      productId,
      name: 'NEW VARIANT',
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
    if (!confirm(`Delete product ${product.name} and all its variants?`)) return;
    for (const v of variants) await db.productVariants.delete(v.id);
    await db.products.delete(productId);
    navigate('/catalog');
  }

  const impossibilitiesText = (product.technicalImpossibilities || []).join(', ');

  return (
    <>
      <Link to="/catalog" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 mb-3">
        <ArrowLeft size={12} /> Back to catalog
      </Link>
      <PageHeader
        title={product.name}
        subtitle={[product.designer, product.year, categories.find((c) => c.id === product.categoryId)?.name]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            <button onClick={removeProduct} className="btn-ghost text-red-600 hover:bg-red-50"><Trash2 size={14} /> Delete</button>
            <Link to={`/quotes/new?product=${product.id}`} className="btn-primary">Add to quote</Link>
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
            label="Vector image — shown in catalog and quote builder"
            imgClassName="w-full aspect-[4/3] object-cover rounded-md"
          />
          <div className="mt-4">
            <ImageDrop
              imageId={product.heroImageId}
              onChange={(id) => update({ heroImageId: id })}
              kind="product-hero"
              ownerId={product.id}
              label="Hero image — customer-facing photo, used only in exported PDFs"
              imgClassName="w-full aspect-[4/3] object-cover rounded-md"
            />
          </div>
          <div className="card card-pad mt-4 space-y-3">
            <div>
              <div className="label">Name</div>
              <input className="input" value={product.name} onChange={(e) => update({ name: e.target.value })} />
            </div>
            <div>
              <div className="label">Designer</div>
              <input className="input" value={product.designer || ''} onChange={(e) => update({ designer: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="label">Year</div>
                <input className="input" type="number" value={product.year || ''} onChange={(e) => update({ year: e.target.value ? Number(e.target.value) : null })} />
              </div>
              <div>
                <div className="label">Category</div>
                <select className="input" value={product.categoryId || ''} onChange={(e) => update({ categoryId: e.target.value || null })}>
                  <option value="">(uncategorized)</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <div className="label">Technical impossibilities (fabric names, comma-separated)</div>
              <textarea
                className="input min-h-[60px]"
                value={impossibilitiesText}
                onChange={(e) => update({
                  technicalImpossibilities: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                })}
              />
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {product.description && (
            <div className="card card-pad">
              <div className="label">Description</div>
              <textarea
                className="input min-h-[100px]"
                value={product.description}
                onChange={(e) => update({ description: e.target.value })}
              />
            </div>
          )}

          <div className="card">
            <div className="px-5 py-3 border-b border-ink-100 flex items-center justify-between">
              <h2 className="font-semibold">Variants ({variants.length})</h2>
              <button onClick={newVariant} className="btn-secondary"><Plus size={14} /> Add variant</button>
            </div>
            {variants.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-ink-500">No variants yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="table min-w-[760px]">
                  <thead>
                    <tr>
                      <th>Image</th>
                      <th>Name</th>
                      <th>Reference</th>
                      <th>Yardage</th>
                      <th>Dimensions</th>
                      <th className="text-right">Grades</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {variants.map((v) => (
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
                          {Object.keys(v.priceByGrade || {}).length} grade{Object.keys(v.priceByGrade || {}).length === 1 ? '' : 's'}
                        </td>
                        <td className="text-right w-20">
                          <button onClick={() => setEditingVariantId(v.id)} className="text-xs text-ink-600 hover:text-ink-900 inline-flex items-center gap-1">
                            Edit <ExternalLink size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
    return <Modal open={open} onClose={onClose} title="Variant" />;
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
    if (!confirm(`Delete variant "${variant.name}"?`)) return;
    await db.productVariants.delete(variant.id);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Edit variant — ${variant.name}`}
      size="lg"
      footer={
        <>
          <button onClick={remove} className="btn-ghost text-red-600 hover:bg-red-50"><Trash2 size={14} /> Delete</button>
          <div className="flex-1" />
          <button onClick={onClose} className="btn-primary"><Save size={14} /> Done</button>
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
        <ImageDrop
          imageId={variant.imageId}
          onChange={(id) => update({ imageId: id })}
          kind="variant"
          ownerId={variant.id}
          label="Variant image"
          imgClassName="w-full aspect-square object-cover rounded-md"
        />
        <div className="sm:col-span-2 space-y-3">
          <div>
            <div className="label">Name</div>
            <input className="input" value={variant.name} onChange={(e) => update({ name: e.target.value })} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="label">Reference code</div>
              <input className="input font-mono" value={variant.reference || ''} onChange={(e) => update({ reference: e.target.value })} />
            </div>
            <div>
              <div className="label">Yardage</div>
              <input className="input" value={variant.yardage || ''} onChange={(e) => update({ yardage: e.target.value })} placeholder="e.g. 6.60yd" />
            </div>
          </div>
          <div>
            <div className="label">Dimensions</div>
            <input className="input" value={variant.dimensions || ''} onChange={(e) => update({ dimensions: e.target.value })} placeholder='e.g. H 28" W 32" D 32" S 16"' />
          </div>
        </div>
      </div>

      <div className="label">Pricing by grade (USD)</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {GRADES.map((g) => (
          <div key={g}>
            <div className="text-[10px] font-semibold text-ink-500 uppercase">Grade {g}</div>
            <input
              type="number"
              className="input mt-1"
              value={(variant.priceByGrade || {})[g] ?? ''}
              onChange={(e) => updateGrade(g, e.target.value)}
              placeholder="—"
            />
          </div>
        ))}
      </div>
    </Modal>
  );
}
