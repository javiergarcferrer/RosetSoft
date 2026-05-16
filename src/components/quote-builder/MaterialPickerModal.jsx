import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useLiveQuery } from '../../db/hooks.js';
import Modal from '../Modal.jsx';
import ImageView from '../ImageView.jsx';
import { db } from '../../db/database.js';

/**
 * Modal that lets the user pick a material + color for a line. Two-step UX:
 *   1. Material list (filtered by kind / grade / search).
 *   2. Once a material is selected, a color grid for that material.
 *
 * Materials in the product's `technicalImpossibilities` list are shown but
 * disabled with a "No permitida" badge, so the user understands WHY a
 * particular fabric isn't selectable rather than wondering where it went.
 */
export default function MaterialPickerModal({ open, onClose, onPick, product }) {
  const materials = useLiveQuery(() => db.materials.toArray(), [], []);
  const colors = useLiveQuery(() => db.materialColors.toArray(), [], []);
  const [q, setQ] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [gradeFilter, setGradeFilter] = useState('');
  const [activeMaterial, setActiveMaterial] = useState(null);

  useEffect(() => {
    if (!open) { setActiveMaterial(null); setQ(''); }
  }, [open]);

  const matColors = useMemo(() => {
    if (!activeMaterial) return [];
    return colors.filter((c) => c.materialId === activeMaterial.id);
  }, [activeMaterial, colors]);

  const impossibilities = useMemo(
    () => (product?.technicalImpossibilities || []).map((s) => s.toUpperCase()),
    [product],
  );

  const filteredMaterials = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return materials
      .filter((m) => (kindFilter ? m.kind === kindFilter : true))
      .filter((m) => (gradeFilter ? m.grade === gradeFilter : true))
      .filter((m) => !needle ? true : m.name.toLowerCase().includes(needle) || (m.composition || '').toLowerCase().includes(needle))
      .sort((a, b) => {
        const aBlocked = impossibilities.includes((a.name || '').toUpperCase());
        const bBlocked = impossibilities.includes((b.name || '').toUpperCase());
        if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
  }, [materials, q, kindFilter, gradeFilter, impossibilities]);

  return (
    <Modal open={open} onClose={onClose} title="Elegir material y color" size="xl">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
        <input autoFocus className="input flex-1" placeholder="Buscar materiales…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input sm:max-w-[160px]" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
          <option value="">Todos los tipos</option>
          <option value="fabric">Tela</option>
          <option value="leather">Cuero</option>
          <option value="outdoor-fabric">Outdoor</option>
        </select>
        <select className="input sm:max-w-[120px]" value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)}>
          <option value="">Todos los grados</option>
          {'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((g) => <option key={g} value={g}>Grado {g}</option>)}
          <option value="S">Grado S</option>
        </select>
      </div>

      {!activeMaterial ? (
        <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1">
          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-ink-100">
            {filteredMaterials.map((m) => {
              const blocked = impossibilities.includes(m.name.toUpperCase());
              const colorCount = colors.filter((c) => c.materialId === m.id).length;
              return (
                <button
                  key={m.id}
                  onClick={() => !blocked && setActiveMaterial(m)}
                  disabled={blocked}
                  className={`w-full text-left p-3 flex items-start justify-between gap-2 ${blocked ? 'opacity-50 cursor-not-allowed' : 'hover:bg-ink-50 active:bg-ink-100'}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">{m.name}</div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <span className="capitalize text-[10px] text-ink-700">{m.kind.replace('-', ' ')}</span>
                      <span className="badge">{m.grade || '—'}</span>
                      <span className="text-[10px] text-ink-500">{colorCount} {colorCount === 1 ? 'color' : 'colores'}</span>
                    </div>
                    {m.composition && (
                      <div className="text-[11px] text-ink-500 mt-1 truncate">{m.composition}</div>
                    )}
                  </div>
                  <div className="flex-shrink-0 text-xs text-brand-600">
                    {blocked ? <span className="text-red-600 text-[11px]">No permitida</span> : 'Elegir →'}
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
                  <th>Composición</th>
                  <th>Colores</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredMaterials.map((m) => {
                  const blocked = impossibilities.includes(m.name.toUpperCase());
                  const colorCount = colors.filter((c) => c.materialId === m.id).length;
                  return (
                    <tr key={m.id} className={blocked ? 'opacity-50' : ''}>
                      <td className="font-medium">{m.name}</td>
                      <td className="capitalize text-ink-700 text-xs">{m.kind.replace('-', ' ')}</td>
                      <td><span className="badge">{m.grade || '—'}</span></td>
                      <td className="text-xs text-ink-500 max-w-xs truncate" title={m.composition}>{m.composition || '—'}</td>
                      <td className="text-ink-500">{colorCount}</td>
                      <td className="text-right">
                        {blocked ? (
                          <span className="text-[11px] text-red-600">No permitida</span>
                        ) : (
                          <button onClick={() => setActiveMaterial(m)} className="text-xs text-brand-600 hover:underline">Elegir →</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <button onClick={() => setActiveMaterial(null)} className="btn-ghost"><ArrowLeft size={14} /> Atrás</button>
            <div className="text-sm">
              <span className="font-medium">{activeMaterial.name}</span>
              <span className="text-ink-500"> · Grado {activeMaterial.grade}</span>
            </div>
            <button onClick={() => onPick(activeMaterial, null)} className="btn-secondary text-xs">Usar sin color</button>
          </div>
          {matColors.length === 0 ? (
            <div className="text-center text-sm text-ink-500 py-10">
              Sin colores guardados para {activeMaterial.name}.
              <div className="mt-2"><button onClick={() => onPick(activeMaterial, null)} className="btn-primary">Usar de todos modos</button></div>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 max-h-[55vh] overflow-y-auto">
              {matColors.map((c) => (
                <button key={c.id} onClick={() => onPick(activeMaterial, c)} className="card hover:border-ink-300 transition text-left overflow-hidden">
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
