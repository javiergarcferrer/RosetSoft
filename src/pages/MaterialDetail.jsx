import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from '../db/hooks.js';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import ImageDrop from '../components/ImageDrop.jsx';
import ImageView from '../components/ImageView.jsx';
import Modal from '../components/Modal.jsx';
import { DebouncedInput, DebouncedTextarea } from '../components/DebouncedInput.jsx';
import { db, newId, deleteImage } from '../db/database.js';

export default function MaterialDetail() {
  const { materialId } = useParams();
  const navigate = useNavigate();
  const material = useLiveQuery(() => db.materials.get(materialId), [materialId], null);
  const colors = useLiveQuery(
    () => db.materialColors.where('materialId').equals(materialId).toArray(),
    [materialId],
    []
  );
  const [colorModal, setColorModal] = useState({ open: false, colorId: null });

  if (!material) return <div className="text-sm text-ink-500">Loading material…</div>;

  async function update(patch) {
    await db.materials.put({ ...material, ...patch });
  }

  async function addColor() {
    const id = newId();
    await db.materialColors.put({ id, materialId, name: 'NEW COLOR', code: '', swatchImageId: null });
    setColorModal({ open: true, colorId: id });
  }

  async function removeMaterial() {
    if (!confirm(`Delete ${material.name} and all its colors?`)) return;
    for (const c of colors) {
      if (c.swatchImageId) await deleteImage(c.swatchImageId).catch(() => {});
      await db.materialColors.delete(c.id);
    }
    await db.materials.delete(materialId);
    navigate('/materials');
  }

  return (
    <>
      <Link to="/materials" className="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 mb-3">
        <ArrowLeft size={12} /> Back to materials
      </Link>
      <PageHeader
        title={material.name}
        subtitle={`${material.kind.replace('-', ' ')} · Grade ${material.grade || '—'} · ${colors.length} color${colors.length === 1 ? '' : 's'}`}
        actions={
          <>
            <button onClick={removeMaterial} className="btn-ghost text-red-600 hover:bg-red-50"><Trash2 size={14} /> Delete</button>
            <button onClick={addColor} className="btn-primary"><Plus size={14} /> Add color</button>
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card card-pad lg:col-span-1 space-y-3">
          <div>
            <div className="label">Name</div>
            <DebouncedInput className="input" value={material.name} onCommit={(v) => update({ name: v })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="label">Type</div>
              <select className="input" value={material.kind} onChange={(e) => update({ kind: e.target.value })}>
                <option value="fabric">Fabric</option>
                <option value="leather">Leather</option>
                <option value="outdoor-fabric">Outdoor Fabric</option>
              </select>
            </div>
            <div>
              <div className="label">Grade</div>
              <select className="input" value={material.grade || ''} onChange={(e) => update({ grade: e.target.value })}>
                <option value="">—</option>
                {'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((g) => <option key={g} value={g}>{g}</option>)}
                <option value="S">S</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="label">Width</div>
              <DebouncedInput className="input" value={material.width || ''} onCommit={(v) => update({ width: v })} placeholder='e.g. 55"' />
            </div>
            <div>
              <div className="label">Price / unit (USD)</div>
              <DebouncedInput className="input" type="number" value={material.pricePerUnit ?? ''} onCommit={(v) => update({ pricePerUnit: v ? Number(v) : null })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="label">Wear (AFNOR)</div>
              <DebouncedInput className="input" value={material.wear || ''} onCommit={(v) => update({ wear: v })} placeholder="e.g. 3C" />
            </div>
            <div>
              <div className="label">Martindale</div>
              <DebouncedInput className="input" type="number" value={material.martindale ?? ''} onCommit={(v) => update({ martindale: v ? Number(v) : null })} />
            </div>
          </div>
          <div>
            <div className="label">Composition</div>
            <DebouncedTextarea className="input min-h-[80px]" value={material.composition || ''} onCommit={(v) => update({ composition: v })} />
          </div>
          <div>
            <div className="label">Restricted to products (optional, comma-separated)</div>
            <DebouncedInput
              className="input"
              value={(material.restrictedToProductNames || []).join(', ')}
              onCommit={(v) => update({ restrictedToProductNames: v.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="e.g. EXCLUSIF, EXCLUSIF 2"
            />
          </div>
        </div>

        <div className="lg:col-span-2">
          {colors.length === 0 ? (
            <div className="card card-pad text-center text-sm text-ink-500 py-16">
              No colors yet. Add a color and upload a swatch image to make it easy to select on quotes.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {colors.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setColorModal({ open: true, colorId: c.id })}
                  className="card overflow-hidden text-left hover:border-ink-300 transition group"
                >
                  <div className="aspect-square bg-ink-100">
                    <ImageView id={c.swatchImageId} className="w-full h-full object-cover" placeholderClassName="w-full h-full" />
                  </div>
                  <div className="px-3 py-2">
                    <div className="text-sm font-medium truncate">{c.name}</div>
                    <div className="text-[10px] text-ink-500 font-mono">{c.code || '—'}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <ColorEditor
        open={colorModal.open}
        colorId={colorModal.colorId}
        onClose={() => setColorModal({ open: false, colorId: null })}
      />
    </>
  );
}

function ColorEditor({ open, colorId, onClose }) {
  const color = useLiveQuery(() => (colorId ? db.materialColors.get(colorId) : null), [colorId], null);
  if (!open) return <Modal open={open} onClose={onClose} title="" />;
  if (!color) return <Modal open={open} onClose={onClose} title="Loading…" />;

  async function update(patch) {
    await db.materialColors.put({ ...color, ...patch });
  }

  async function remove() {
    if (!confirm(`Delete color "${color.name}"?`)) return;
    if (color.swatchImageId) await deleteImage(color.swatchImageId).catch(() => {});
    await db.materialColors.delete(color.id);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={`Color — ${color.name}`} footer={
      <>
        <button onClick={remove} className="btn-ghost text-red-600 hover:bg-red-50"><Trash2 size={14} /> Delete</button>
        <div className="flex-1" />
        <button onClick={onClose} className="btn-primary">Done</button>
      </>
    }>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <ImageDrop
          imageId={color.swatchImageId}
          onChange={(id) => update({ swatchImageId: id })}
          kind="swatch"
          ownerId={color.id}
          label="Swatch image"
          imgClassName="w-full aspect-square object-cover rounded-md"
        />
        <div className="space-y-3">
          <div>
            <div className="label">Name</div>
            <DebouncedInput className="input" value={color.name} onCommit={(v) => update({ name: v })} />
          </div>
          <div>
            <div className="label">Color code</div>
            <DebouncedInput className="input font-mono" value={color.code || ''} onCommit={(v) => update({ code: v })} />
          </div>
          <div className="text-xs text-ink-500">
            Tip: drag the swatch image from <code className="kbd">ligne-roset.com</code> directly onto the upload area, or paste it from your clipboard.
          </div>
        </div>
      </div>
    </Modal>
  );
}
