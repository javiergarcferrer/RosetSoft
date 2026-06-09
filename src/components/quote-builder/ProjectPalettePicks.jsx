import ImageView from '../ImageView.jsx';
import { composeSubtype, fabricColorName, fabricDisplay, groupPaletteByMaterial } from '../../lib/subtype.js';
import { colorCodeFromSubtype } from '../../lib/swatchMatch.js';
import { swatchUrl } from '../../lib/swatchImage.js';

/**
 * The quote's curated material library ("Paleta del proyecto") as quick-pick
 * chips, GROUPED BY MATERIAL (ERPI → its colours, VIDAR → its colours), shown
 * FIRST inside a material picker so a project's fabrics apply in one tap. Shared
 * by the editor's SwatchPicker and the client link's FabricPicker so both
 * surfaces stay identical.
 *
 * Presentational + pure: `palette` is the QuoteMaterial[] snapshot
 * ({ id, grade, fabric, swatchImageId }); `onApply(pick)` receives the
 * { grade, fabric, swatchImageId } shape the picker commits. Renders nothing
 * when the palette is empty.
 */
export default function ProjectPalettePicks({ palette, onApply }) {
  const groups = groupPaletteByMaterial(palette);
  if (!groups.length) return null;
  return (
    <div className="mb-2.5 border-b border-ink-100 pb-2.5">
      <div className="eyebrow-xs tracking-widest text-ink-500 mb-1.5">Paleta del proyecto</div>
      <div className="space-y-1">
        {groups.map((g) => (
          // Label INLINE with its chips (same wrapping row) so a single-colour
          // group is one line, not two — keeps the palette compact in the sheet.
          <div key={g.material} className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            <span className="text-[11px] font-medium text-ink-500 flex-shrink-0">
              {g.material}{g.grade ? <span className="text-ink-400"> · Grade {g.grade}</span> : null}
            </span>
            {g.items.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onApply({ grade: m.grade, fabric: m.fabric, swatchImageId: m.swatchImageId ?? null })}
                className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-white py-0.5 pl-0.5 pr-1.5 text-left transition-colors hover:border-brand-300 hover:bg-brand-50 max-w-full min-w-0"
                title="Aplicar esta tela"
              >
                <ImageView
                  id={m.swatchImageId || null}
                  fallbackUrl={swatchUrl(colorCodeFromSubtype(composeSubtype(m.grade, m.fabric)))}
                  className="h-5 w-5 flex-shrink-0 rounded border border-ink-100 bg-ink-50 object-cover"
                />
                <span className="text-[11px] text-ink-700 truncate min-w-0">
                  {fabricColorName(m.fabric) || fabricDisplay(composeSubtype(m.grade, m.fabric)) || '—'}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
