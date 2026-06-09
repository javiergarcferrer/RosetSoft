import { useContext, useState } from 'react';
import { Palette, Plus, X } from 'lucide-react';
import ImageView from '../ImageView.jsx';
import SwatchPicker from './SwatchPicker.jsx';
import { ProjectPaletteContext } from './ProjectPaletteContext.js';
import { composeSubtype, fabricColorName, fabricDisplay, groupPaletteByMaterial } from '../../lib/subtype.js';
import { colorCodeFromSubtype } from '../../lib/swatchMatch.js';
import { swatchUrl } from '../../lib/swatchImage.js';

/**
 * "Paleta del proyecto" — manage the quote's curated material library: the
 * fabrics pinned to this project (including ones not yet applied to any line),
 * surfaced first in every material picker so a compound's many components are
 * dressed fast and consistently. Reads + writes the library through
 * ProjectPaletteContext (the Workspace owns persistence). `showPalette={false}`
 * on the add-picker hides the quick-pick strip there — you're building it, not
 * applying from it.
 */
export default function ProjectPaletteCard() {
  const { materials, onAdd, onAddMany, onRemove } = useContext(ProjectPaletteContext);
  const [addOpen, setAddOpen] = useState(false);
  const list = Array.isArray(materials) ? materials : [];
  const groups = groupPaletteByMaterial(list);

  return (
    <div className="card p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Palette size={15} className="text-ink-500 flex-shrink-0" aria-hidden />
          <h3 className="text-sm font-semibold text-ink-800 truncate">Paleta del proyecto</h3>
        </div>
        {onAdd && (
          <button type="button" onClick={() => setAddOpen(true)} className="btn-ghost text-xs flex-shrink-0">
            <Plus size={14} /> Agregar material
          </button>
        )}
      </div>

      {list.length === 0 ? (
        <p className="mt-2 text-[11px] text-ink-500">
          Fija las telas del proyecto para aplicarlas con un toque desde cualquier componente.
        </p>
      ) : (
        <div className="mt-2 space-y-1">
          {groups.map((g) => (
            // Label INLINE with its chips (same wrapping row) so a single-colour
            // group takes one line, not two — the previous header-above-chips
            // stacking doubled the height of every group on a phone.
            <div key={g.material} className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
              <span className="text-[11px] font-medium text-ink-500 flex-shrink-0">
                {g.material}{g.grade ? <span className="text-ink-400"> · Grade {g.grade}</span> : null}
              </span>
              {g.items.map((m) => (
                <span
                  key={m.id}
                  className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-white py-0.5 pl-0.5 pr-1 min-w-0 max-w-full"
                >
                  <ImageView
                    id={m.swatchImageId || null}
                    fallbackUrl={swatchUrl(colorCodeFromSubtype(composeSubtype(m.grade, m.fabric)))}
                    className="h-5 w-5 flex-shrink-0 rounded border border-ink-100 bg-ink-50 object-cover"
                    hoverPreview
                  />
                  <span className="text-[11px] text-ink-700 truncate min-w-0">
                    {fabricColorName(m.fabric) || fabricDisplay(composeSubtype(m.grade, m.fabric)) || '—'}
                  </span>
                  {onRemove && (
                    <button
                      type="button"
                      onClick={() => onRemove(m.id)}
                      className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-red-50 hover:text-red-600 coarse:h-6 coarse:w-6"
                      title="Quitar de la paleta"
                      aria-label="Quitar de la paleta"
                    >
                      <X size={12} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      {onAdd && (
        <SwatchPicker
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onSelect={(pick) => onAdd(pick)}
          allowMultiSelect
          onSelectMany={(picks) => onAddMany?.(picks)}
          showPalette={false}
        />
      )}
    </div>
  );
}
