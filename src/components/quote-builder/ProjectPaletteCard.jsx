import { useContext, useState } from 'react';
import { Palette, Plus, X } from 'lucide-react';
import ImageView from '../ImageView.jsx';
import SwatchPicker from './SwatchPicker.jsx';
import { ProjectPaletteContext } from './ProjectPaletteContext.js';
import { composeSubtype, fabricDisplay } from '../../lib/subtype.js';
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

  return (
    <div className="card card-pad">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Palette size={16} className="text-ink-500" aria-hidden />
          <h3 className="text-sm font-semibold text-ink-800">Paleta del proyecto</h3>
        </div>
        {onAdd && (
          <button type="button" onClick={() => setAddOpen(true)} className="btn-ghost text-xs">
            <Plus size={14} /> Agregar material
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-500">
        Fija las telas de este proyecto para aplicarlas con un toque desde cualquier componente.
      </p>

      {list.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-ink-200 px-4 py-5 text-center text-xs text-ink-500">
          Aún no hay telas en la paleta. Agrega las que usarás en este proyecto.
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {list.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-2 rounded-lg border border-ink-200 bg-white py-1.5 pl-1.5 pr-2"
            >
              <ImageView
                id={m.swatchImageId || null}
                fallbackUrl={swatchUrl(colorCodeFromSubtype(composeSubtype(m.grade, m.fabric)))}
                className="h-9 w-9 flex-shrink-0 rounded border border-ink-100 bg-ink-50 object-cover"
                hoverPreview
              />
              <span className="text-xs text-ink-700">
                {fabricDisplay(composeSubtype(m.grade, m.fabric)) || '—'}
              </span>
              {onRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(m.id)}
                  className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-red-50 hover:text-red-600"
                  title="Quitar de la paleta"
                  aria-label="Quitar de la paleta"
                >
                  <X size={13} />
                </button>
              )}
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
