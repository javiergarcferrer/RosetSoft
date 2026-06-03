import ImageView from '../ImageView.jsx';
import { composeSubtype, fabricDisplay } from '../../lib/subtype.js';
import { colorCodeFromSubtype } from '../../lib/swatchMatch.js';
import { swatchUrl } from '../../lib/swatchImage.js';

/**
 * The quote's curated material library ("Paleta del proyecto") as a row of
 * quick-pick chips, shown FIRST inside a material picker so a project's fabrics
 * apply in one tap. Shared by the editor's SwatchPicker and the client link's
 * FabricPicker so both surfaces stay identical.
 *
 * Presentational + pure: `palette` is the QuoteMaterial[] snapshot
 * ({ id, grade, fabric, swatchImageId }); `onApply(pick)` receives the
 * { grade, fabric, swatchImageId } shape the picker commits (the caller decides
 * whether that replaces a line, applies to all, etc.). Renders nothing when the
 * palette is empty.
 */
export default function ProjectPalettePicks({ palette, onApply }) {
  const list = Array.isArray(palette) ? palette : [];
  if (!list.length) return null;
  return (
    <div className="mb-3 border-b border-ink-100 pb-3">
      <div className="eyebrow-xs tracking-widest text-ink-500 mb-1.5">Paleta del proyecto</div>
      <div className="flex flex-wrap gap-1.5">
        {list.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onApply({ grade: m.grade, fabric: m.fabric, swatchImageId: m.swatchImageId ?? null })}
            className="flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white py-1 pl-1 pr-2.5 text-left transition-colors hover:border-brand-300 hover:bg-brand-50"
            title="Aplicar esta tela"
          >
            <ImageView
              id={m.swatchImageId || null}
              fallbackUrl={swatchUrl(colorCodeFromSubtype(composeSubtype(m.grade, m.fabric)))}
              className="h-8 w-8 flex-shrink-0 rounded border border-ink-100 bg-ink-50 object-cover"
            />
            <span className="text-xs text-ink-700">{fabricDisplay(composeSubtype(m.grade, m.fabric)) || '—'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
