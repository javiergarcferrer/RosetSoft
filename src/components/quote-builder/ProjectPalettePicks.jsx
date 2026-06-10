import ImageView from '../ImageView.jsx';
import { composeSubtype, fabricColorName, fabricDisplay, groupPaletteByMaterial } from '../../lib/subtype.js';
import { colorCodeFromSubtype } from '../../lib/swatchMatch.js';
import { swatchUrl } from '../../lib/swatchImage.js';

/**
 * The quote's curated material library ("Paleta del proyecto") as a GRID of
 * swatch cards, shown FIRST inside a material picker so a project's fabrics
 * apply in one tap. Shared by the editor's SwatchPicker and the client link's
 * FabricPicker so both surfaces stay identical.
 *
 * UX: a fabric swatch is a VISUAL choice, so each colour is a card with a large
 * image (you can actually read the weave/colour) over a caption — colour name on
 * top, material · grade beneath. A responsive 2-up grid (3-up from sm:) keeps the
 * swatches big without a long single-column scroll. Tapping a card applies it.
 *
 * Presentational + pure: `palette` is the QuoteMaterial[] snapshot
 * ({ id, grade, fabric, swatchImageId }); `onApply(pick)` receives the
 * { grade, fabric, swatchImageId } shape the picker commits. Renders nothing
 * when the palette is empty.
 */
export default function ProjectPalettePicks({ palette, onApply }) {
  const groups = groupPaletteByMaterial(palette);
  if (!groups.length) return null;
  // Flatten to the pickable unit — one card per colour — carrying its material
  // + grade for the caption.
  const tiles = groups.flatMap((g) =>
    g.items.map((m) => ({ id: m.id, grade: m.grade, fabric: m.fabric, swatchImageId: m.swatchImageId, material: g.material, groupGrade: g.grade })),
  );
  return (
    <div className="mb-3 border-b border-ink-100 pb-3">
      <div className="eyebrow-xs mb-2">Paleta del proyecto</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {tiles.map((m) => {
          const color = fabricColorName(m.fabric) || fabricDisplay(composeSubtype(m.grade, m.fabric)) || '—';
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => onApply({ grade: m.grade, fabric: m.fabric, swatchImageId: m.swatchImageId ?? null })}
              className="group overflow-hidden rounded-xl border border-ink-200 bg-white text-left transition-all hover:border-brand-400 hover:shadow-soft active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              title={`Aplicar ${m.material}${m.groupGrade ? ` · Grade ${m.groupGrade}` : ''} · ${color}`}
            >
              <div className="aspect-[4/3] w-full overflow-hidden bg-ink-50">
                <ImageView
                  id={m.swatchImageId || null}
                  fallbackUrl={swatchUrl(colorCodeFromSubtype(composeSubtype(m.grade, m.fabric)))}
                  className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                />
              </div>
              {/* Captions WRAP rather than truncate — fabric/color names are data
                  the dealer picks by, so they must stay fully readable. */}
              <div className="min-w-0 px-2 py-1.5">
                <div className="break-words text-xs font-semibold text-ink-900">{color}</div>
                <div className="break-words text-[10px] text-ink-500">
                  {m.material}{m.groupGrade ? <span className="text-ink-400"> · Grade {m.groupGrade}</span> : null}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
