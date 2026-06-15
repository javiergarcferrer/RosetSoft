import { Document, Page, View, Text, Image } from '@react-pdf/renderer';
import { resolveQuoteView } from '../../core/quote/views/quoteView.js';
import { displayRatesFor } from '../../lib/exchangeRate.js';
import { formatMoney, formatDate } from '../../lib/format.js';
import { isPricedLine } from '../../lib/constants.js';
import {
  ITBIS_PCT, lineQty, lineTotal, lineListUnit, lineHasRange, lineTotalRange,
  isCompoundLine, componentSubtotal, computeTotalsRange,
  isRangeComponent, componentSubtotalRange,
} from '../../lib/pricing.js';
import { compoundFabric, groupComponentsByMaterial, fabricDisplay } from '../../lib/subtype.js';
import { isModularLine, modulesOf, moduleSubtotal } from '../../lib/modules.js';
import type { Module } from '../../lib/modules.ts';
import type {
  Quote, QuoteLine, LineComponent, Customer, Professional, Profile, Settings, Totals,
  CurrencyCode, QuoteGroup,
} from '../../types/domain.ts';
import type { CatalogFamily } from '../../lib/catalog.ts';
import { materialCells, swatchSrcFor } from './materialCells.js';
import type { MoCell } from './materialCells.js';
import { coverKey, swatchKey } from './imageKeys.js';
import type { ImageMap } from './imageKeys.js';
import { s, C, fs } from './theme.js';

export interface QuoteDocumentProps {
  quote: Quote;
  settings: Settings | null | undefined;
  lines: QuoteLine[];
  totals: Totals;
  customer: Customer | null;
  professional?: Professional | null;
  seller?: Profile | null;
  quoteGroups?: QuoteGroup[];
  families?: Map<string, CatalogFamily> | null;
  /** Pre-resolved image data URIs (see images.ts). Empty in the Node harness. */
  images?: ImageMap;
}

type Fmt = (v: number | null | undefined) => string;
type View0 = ReturnType<typeof resolveQuoteView>;

const imgFor = (images: ImageMap | undefined, key: string | null): string | undefined =>
  (key && images ? images.get(key) : undefined);

// ---- swatch tile (uploaded id or catalog-color url, pre-resolved) ------
function Swatch({ src, images, size = 56 }: { src: { imageId?: string | null; url?: string | null }; images?: ImageMap; size?: number }) {
  const uri = imgFor(images, swatchKey(src));
  return (
    <View style={{ width: size, height: size, backgroundColor: C.bgSoft, borderWidth: 0.5, borderColor: C.inkLine2, borderRadius: 3 }}>
      {uri && <Image src={uri} style={{ width: size, height: size, objectFit: 'contain' }} />}
    </View>
  );
}

// ---- uniform-compound upholstery hero ----------------------------------
// One swatch + "Tapizado · <fabric>" shown ONCE at a compound's header when
// every piece wears the same fabric — replacing the per-component swatch
// repetition (and the old stale parent-seed swatch). The fabric code "(#…)" is
// stripped for the client. Mirrored on screen by ClientPreview.
function UpholsteryHero({ subtype, swatchImageId, images }: { subtype: string; swatchImageId: string | null; images?: ImageMap }) {
  const src = swatchSrcFor(swatchImageId, subtype);
  const label = fabricDisplay(subtype);
  // compoundFabric only reports uniform with a real bearing piece, so there's
  // always a label here; the swatch tile degrades to an empty frame when no
  // image/code resolves (never drop the fabric name).
  if (!src.imageId && !src.url && !label) return null;
  return (
    // wrap={false} keeps the swatch + its label together; minPresenceAhead makes
    // the hero defer to the next page unless a couple of its rows can follow it,
    // so a fabric header never strands alone at the bottom of a page.
    <View style={{ marginTop: 9, marginBottom: 2, flexDirection: 'row', gap: 11, alignItems: 'center' }} wrap={false} minPresenceAhead={54}>
      <Swatch src={src} images={images} size={68} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontFamily: 'Sohne', fontSize: fs(8), color: C.brand700, letterSpacing: 1.4, textTransform: 'uppercase' }}>Tapizado</Text>
        {label ? <Text style={{ fontSize: fs(12), color: C.ink, marginTop: 2, fontWeight: 'bold' }}>{label}</Text> : null}
      </View>
    </View>
  );
}

// ---- material-options grid (two columns; swatch over label + delta) ----
function MaterialGrid({ cells, images }: { cells: MoCell[]; images?: ImageMap }) {
  if (!cells.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 8 }}>
      {cells.map((cell, i) => (
        <View key={i} style={{ width: '48%', marginBottom: 8, flexDirection: 'row', gap: 7 }}>
          <Swatch src={cell.swatch} images={images} size={48} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: fs(8), color: C.inkHigh }}>{cell.label}</Text>
            {cell.note && <Text style={{ fontSize: fs(7.5), color: cell.noteColor, marginTop: 1 }}>{cell.note}</Text>}
          </View>
        </View>
      ))}
    </View>
  );
}

// ---- money cell --------------------------------------------------------
function priceShape(line: QuoteLine) {
  const qty = lineQty(line);
  const total = lineTotal(line);
  const ranged = lineHasRange(line);
  const range = ranged ? lineTotalRange(line) : null;
  const listUnit = lineListUnit(line);
  const unit = qty ? total / qty : total;
  const discount = listUnit > 0 && unit < listUnit - 0.005 ? Math.round((1 - unit / listUnit) * 100) : 0;
  return { qty, unit, listUnit, total, ranged, range, discount };
}

function MoneyCell({ line, fmt }: { line: QuoteLine; fmt: Fmt }) {
  const p = priceShape(line);
  if (p.ranged && p.range) {
    return (
      <View style={s.priceCell}>
        <Text style={s.priceQty}>{p.qty} × rango</Text>
        <Text style={s.priceTotal}>{fmt(p.range.min)} – {fmt(p.range.max)}</Text>
        <Text style={s.priceNote}>sin material</Text>
      </View>
    );
  }
  return (
    <View style={s.priceCell}>
      <Text style={s.priceQty}>{p.qty} × {fmt(p.unit)}</Text>
      {p.discount > 0 && (
        <Text>
          <Text style={s.priceStrike}>{fmt(p.listUnit)}</Text>
          <Text style={s.priceDisc}>  −{p.discount}%</Text>
        </Text>
      )}
      <Text style={s.priceTotal}>{fmt(p.total)}</Text>
    </View>
  );
}

// ---- one product line --------------------------------------------------
function LineRow({
  line, view, fmt, inZone, families, currency, rates, images, hideSwatch,
}: {
  line: QuoteLine; view: View0; fmt: Fmt; inZone: boolean;
  families?: Map<string, CatalogFamily> | null; currency: CurrencyCode; rates: Record<string, number>; images?: ImageMap;
  // A set member whose run shares ONE material → its standalone swatch is
  // collapsed into the run's material header (the run names the fabric once).
  hideSwatch?: boolean;
}) {
  const optional = !!line.isOptional;
  const inGroup = !!line.alternativeGroup;
  const inSet = !!line.setGroup;
  const isSelected = !!line.isSelectedAlternative;
  const dimmed = optional || (inGroup && !isSelected);
  const altInfo = inGroup ? view.groupInfo.get(line.id) : null;
  const setI = inSet ? view.setInfo.get(line.id) : null;
  const compound = isCompoundLine(line);
  const cover = imgFor(images, coverKey(line.id));
  // A line with no photo reserves NO image column — the body takes the full
  // width, exactly as ClientPreview omits its image column when there's no
  // `imageId`. (Drawing the empty `imgBox` is the "big empty square" the dealer
  // saw.) The compound rail below aligns under the name, so its left indent
  // collapses from "past the 120pt photo + 14pt gap" to 0 when the photo is gone.
  const railIndent = cover ? 134 : 0;
  const cells = materialCells({ mo: line.materialOptions, reference: line.reference, baseSwatchImageId: line.swatchImageId, families, currency, rates });
  // Uniform compound → hoist the shared fabric to ONE hero swatch at the header
  // and drop every per-piece swatch below. A mixed compound keeps per-piece
  // swatches (they're now informative). Resolved by the Model so screen + paper
  // agree on when to collapse.
  // A MODULAR compound is grouped by MODULE (component product) — each module
  // under its own header with a per-module subtotal, one image for the whole line
  // — but a uniform fabric still hoists to the one hero above, and a module whose
  // own pieces share a fabric collapses under a per-module hero (so an identical
  // swatch is never stamped on every row). Resolved by the Model so screen + paper agree.
  const modular = compound ? isModularLine(line) : false;
  const upholstery = compound ? compoundFabric(line.components) : { uniform: false, subtype: '', swatchImageId: null };
  // Standalone swatch only for a SIMPLE line with no options grid (the grid
  // leads with the same material). A compound's parent carries a stale seed
  // subtype the editor hides — never draw it; its fabric is the hero (uniform)
  // or each piece's own swatch (mixed). Mirrors ClientPreview.
  const swatchSrc = swatchSrcFor(line.swatchImageId, line.subtype);
  const showSwatch = !hideSwatch && !compound && !cells.length && (!!swatchSrc.imageId || !!swatchSrc.url);

  const caption: { text: string; color: string } | null = (() => {
    if (optional && !inGroup && !inSet) return { text: 'Opcional · no incluido en el total', color: C.inkMid };
    if (!inZone && inGroup && altInfo) return { text: `Alternativa ${altInfo.index} de ${altInfo.total}${isSelected ? ' · seleccionada' : ''}`, color: C.brand700 };
    if (!inZone && inSet && setI) return { text: `Conjunto ${setI.index} de ${setI.total}`, color: C.inkMid };
    if (inZone && inGroup && isSelected) return { text: 'Seleccionada', color: C.emerald700 };
    return null;
  })();

  return (
    // Dim the WHOLE row (photo included) for an optional / non-selected
    // alternative — matches the pdf-lib renderer + the on-screen veil.
    //
    // wrap: a SIMPLE line is short — keep its photo + name + price together on
    // one page (wrap={false}). A COMPOUND / modular line can carry a dozen
    // components and grow taller than a whole page, so it MUST be allowed to
    // break across pages; forcing wrap={false} there made react-pdf give up
    // ("Node of type VIEW can't wrap between pages…") and overlap/cram every row
    // — the real cause of the "messed up" #1018 PDF. So compound lines paginate.
    <View
      wrap={compound}
      style={[
        // For a compound line the outer wrapper carries the row's padding +
        // bottom hairline (the identity row inside stays border-less); a simple
        // line keeps using s.line directly, so its look is unchanged.
        ...(compound ? [{ paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: C.inkLine }] : []),
        ...(dimmed ? [{ opacity: 0.45 }] : []),
      ]}
    >
      {/* Identity row — photo | family/name/ref/swatch | line total. Kept whole
          (wrap={false}) so a compound line's photo + name + total never split
          across a page; only the component list below is allowed to paginate. */}
      <View style={compound ? { flexDirection: 'row', gap: 14 } : s.line} wrap={false}>
        {cover && (
          <View style={s.imgBox}><Image src={cover} style={{ width: 120, height: 120, objectFit: 'contain' }} /></View>
        )}
        <View style={s.lineBody}>
          <View style={s.lineMain}>
            {caption && <Text style={[s.groupCaption, { color: caption.color }]}>{caption.text}</Text>}
            {line.family && <Text style={s.familyEyebrow}>{line.family}</Text>}
            <Text style={s.lineName}>{line.name || '—'}</Text>
            {/* Catalog Description 2 (read-only product identity, e.g. "W/SHORT
                UNIT") — directly under the name so it reads as part of the
                title, matching the editor + client preview. */}
            {!compound && line.productDescription && <Text style={s.lineDesc}>{line.productDescription}</Text>}
            {/* The dealer-authored Descripción — directly beneath the identity
                (name + Description 2), the same position the editor and the
                client preview use. SIMPLE lines only: a compound keeps its
                whole-composition blurb OUT of this wrap={false} identity row
                (below, in wrappable flow) so a long paragraph can't jam
                pagination. */}
            {!compound && line.description && <Text style={s.lineDesc}>{line.description}</Text>}
            {!hideSwatch && line.subtype && <Text style={s.lineSub}>{fabricDisplay(line.subtype)}</Text>}
            {(line.reference || line.dimensions) && (
              <View style={s.lineRefRow}>
                {line.reference && <Text style={s.lineRef}>REF. {line.reference}</Text>}
                {line.dimensions && <Text style={s.lineRef}>DIM. {line.dimensions}</Text>}
              </View>
            )}
            {showSwatch && <View style={{ marginTop: 6 }}><Swatch src={swatchSrc} images={images} size={40} /></View>}
            <MaterialGrid cells={cells} images={images} />
          </View>
          <MoneyCell line={line} fmt={fmt} />
        </View>
      </View>

      {/* Compound's whole-composition Descripción — beneath the identity card,
          above the component list, and in WRAPPABLE flow (outside the
          wrap={false} identity row) so a long blurb paginates instead of jamming
          the row. Indented to align under the product name, like the rail. */}
      {compound && line.description && (
        <View style={{ marginTop: 6, marginLeft: railIndent }}>
          <Text style={s.lineDesc}>{line.description}</Text>
        </View>
      )}

      {/* Component list — pulled OUT of the identity row's flex-row layout into
          normal block flow so a tall modular/compound paginates cleanly across
          pages (react-pdf can't break a tall column trapped inside a row). Each
          ComponentRow is itself wrap={false}, so breaks land between pieces. */}
      {compound && (
        // Containment rail: the components are indented to sit UNDER the product
        // name (past the 92pt photo + 14pt gap) with a hairline left rule, so the
        // whole block reads as "what this product is made of" instead of a stack
        // of rows that look like top-level line items.
        <View style={{ marginTop: 8, marginLeft: railIndent, paddingLeft: 12, borderLeftWidth: 1.5, borderLeftColor: C.inkLine2 }}>
          {(() => {
            // A modular line whose modules carry OPTIONAL / ALTERNATIVE state must
            // render per-module (each dimmed block keeps its own caption). Every
            // other compound — plain, mixed, or a plain modular composition —
            // renders ONE material-grouped list so the same fabric collapses to a
            // single big swatch across the WHOLE product (not once per module).
            const modVMs = modular ? modulesWithAltPos(line.components) : [];
            const perModule = modular && modVMs.some((m) => m.optional || m.inAlt);
            if (perModule) {
              return (
                <>
                  {upholstery.uniform && (
                    <UpholsteryHero subtype={upholstery.subtype} swatchImageId={upholstery.swatchImageId} images={images} />
                  )}
                  {modVMs.map((m, mi) => (
                    <ModuleBlock key={m.moduleGroup || mi} m={m} fmt={fmt} families={families} currency={currency} rates={rates} images={images} wholeUniform={upholstery.uniform} />
                  ))}
                </>
              );
            }
            return <ComponentList components={line.components} fmt={fmt} families={families} currency={currency} rates={rates} images={images} />;
          })()}
        </View>
      )}
    </View>
  );
}

// compound component / element row. Three weights, set by the caller so the
// hierarchy reads at a glance:
//   • lead — the module's PRIMARY piece (e.g. the loveseat the module is named
//     after). Bold name + bold price; carries the module's top divider.
//   • sub  — a secondary piece of that module (a back cushion, an armrest). Slight
//     indent + a "+" so it reads as "…and this is part of it", no divider.
//   • (default) — a plain element of a non-promoted group.
// `hideSwatch` (uniform compound) collapses the row to a clean name + price — the
// shared fabric is stated once in the header hero, so the per-piece swatch and
// its now-redundant subtype line drop out.
function ComponentRow({
  c, fmt, families, currency, rates, images, hideSwatch, lead, sub,
}: {
  c: LineComponent; fmt: Fmt; families?: Map<string, CatalogFamily> | null; currency: CurrencyCode; rates: Record<string, number>; images?: ImageMap; hideSwatch?: boolean; lead?: boolean; sub?: boolean;
}) {
  const cells = materialCells({ mo: c.materialOptions, reference: c.reference, baseSwatchImageId: c.swatchImageId, families, currency, rates });
  const swatchSrc = swatchSrcFor(c.swatchImageId, c.subtype);
  const showSwatch = !hideSwatch && !cells.length && (!!swatchSrc.imageId || !!swatchSrc.url);
  // Each piece's quantity — a module can carry several of one product (2 seats,
  // a pair of cushions). The screen shows "n × unit"; the PDF dropped it, hiding
  // how many of each product the price covers. Mirror the line-level money cell.
  const qty = Number(c.qty) || 0;
  const unit = Number(c.unitPrice) || 0;
  const ranged = isRangeComponent(c);
  const range = ranged ? componentSubtotalRange(c) : null;
  const nameStyle = lead
    ? { fontSize: fs(10), color: C.ink, fontWeight: 'bold' as const }
    : sub
      ? { fontSize: fs(9), color: C.inkMid }
      : { fontSize: fs(9), color: C.inkHigh };
  const valStyle = lead
    ? { fontSize: fs(10), color: C.inkHigh, fontWeight: 'bold' as const }
    : { fontSize: fs(9), color: C.inkMid };
  return (
    // wrap={false}: the parent compound line wraps across pages, so keep each
    // element row atomic — a page break lands BETWEEN rows, never mid-row.
    <View
      style={{
        marginTop: sub ? 3 : 5,
        ...(sub ? { marginLeft: 12 } : { paddingTop: 5, borderTopWidth: 0.5, borderTopColor: C.inkLine }),
      }}
      wrap={false}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 6, flex: 1 }}>
          {sub && <Text style={{ fontSize: fs(9), color: C.inkSoft }}>+</Text>}
          {showSwatch && <Swatch src={swatchSrc} images={images} size={40} />}
          <View style={{ flex: 1 }}>
            <Text style={nameStyle}>{c.name || c.reference || '—'}</Text>
            {!hideSwatch && c.subtype && <Text style={{ fontSize: fs(7.5), color: C.inkMid, marginTop: 1 }}>{fabricDisplay(c.subtype)}</Text>}
            {/* Secondary identifiers — REF / DIM and the per-piece description,
                so two same-named pieces (e.g. twin corner seats) read apart.
                Mirrors the line-level row and the on-screen LineContent. REF is
                suppressed when it stood in AS the name (no name set), so it's
                never repeated. */}
            {((c.name && c.reference) || c.dimensions) && (
              <View style={s.lineRefRow}>
                {c.name && c.reference && <Text style={s.lineRef}>REF. {c.reference}</Text>}
                {c.dimensions && <Text style={s.lineRef}>DIM. {c.dimensions}</Text>}
              </View>
            )}
            {c.productDescription && <Text style={s.lineDesc}>{c.productDescription}</Text>}
            {c.description && <Text style={s.lineDesc}>{c.description}</Text>}
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          {/* The "qty ×" line only earns its place when there's more than one
              unit (2 seats, a pair of cushions). At qty 1 it just repeats the
              subtotal below — so show the subtotal alone. */}
          {qty > 1 && <Text style={{ fontSize: fs(7.5), color: C.inkMid }}>{qty} × {ranged ? 'rango' : fmt(unit)}</Text>}
          <Text style={[valStyle, { marginTop: qty > 1 ? 1 : 0 }]}>
            {ranged && range ? `${fmt(range.min)} – ${fmt(range.max)}` : fmt(componentSubtotal(c))}
          </Text>
        </View>
      </View>
      {!hideSwatch && <MaterialGrid cells={cells} images={images} />}
    </View>
  );
}

// A list of elements rendered with material grouping, shared by a non-modular
// compound and by a module's body so the rule is identical everywhere:
//   • whole list one fabric → ONE "Tapizado" hero, every row swatch-less.
//   • mixed → a hero per same-fabric run of 2+ pieces; a lone piece (or a
//     non-upholstered run: metal base, glass) just shows its own inline swatch
//     instead of an oversized one-item hero.
// `forceHideSwatch` is set when an ancestor already showed the single shared
// fabric (a uniform whole line), so the whole list collapses to clean rows.
function ComponentList({
  components, fmt, families, currency, rates, images, forceHideSwatch,
}: {
  components: LineComponent[]; fmt: Fmt; families?: Map<string, CatalogFamily> | null; currency: CurrencyCode; rates: Record<string, number>; images?: ImageMap; forceHideSwatch?: boolean;
}) {
  const row = (c: LineComponent, hideSwatch: boolean, key: React.Key) => (
    <ComponentRow key={key} c={c} fmt={fmt} families={families} currency={currency} rates={rates} images={images} hideSwatch={hideSwatch} />
  );
  if (forceHideSwatch) return <>{components.map((c, i) => row(c, true, c.id || i))}</>;
  const fab = compoundFabric(components);
  if (fab.uniform) {
    return (
      <>
        <UpholsteryHero subtype={fab.subtype} swatchImageId={fab.swatchImageId} images={images} />
        {components.map((c, i) => row(c, true, c.id || i))}
      </>
    );
  }
  const g = groupComponentsByMaterial(components);
  if (g.grouped) {
    return (
      <>
        {g.runs.map((run, ri) =>
          run.bearing ? (
            // No wrap={false} on the group: a tall material group must be allowed
            // to FILL the current page and continue on the next, instead of being
            // pushed whole to page 2 and stranding a near-empty page 1. Each row
            // stays atomic (ComponentRow wrap={false}); the hero carries
            // minPresenceAhead so the swatch never lands alone at a page bottom.
            <View key={run.key + ri}>
              <UpholsteryHero subtype={run.subtype} swatchImageId={run.swatchImageId} images={images} />
              {run.components.map((c, i) => row(c, true, c.id || i))}
            </View>
          ) : (
            <View key={run.key + ri}>{run.components.map((c, i) => row(c, false, c.id || i))}</View>
          ),
        )}
      </>
    );
  }
  return <>{components.map((c, i) => row(c, false, c.id || i))}</>;
}

// ---- modular modules (component products) ------------------------------
// Module-level optional / alternative flags live on the module's components (the
// whole component-product opts in / out, or is one pick-one sibling). modulesOf
// already grouped them, so we read the flags off the first element — the twin of
// how a line carries isOptional / alternativeGroup, and identical to
// ClientPreview's `moduleFlags` so screen + paper agree. moduleSelected defaults
// true for an alternative member that hasn't been flagged, so a single-option
// group never reads as "not chosen".
function moduleFlags(module: Module): { optional: boolean; altGroup: string | null; selected: boolean } {
  const c = (module?.components?.[0] || {}) as LineComponent;
  const altGroup = c.moduleAlternativeGroup || null;
  return { optional: !!c.moduleOptional, altGroup, selected: altGroup ? !!c.moduleSelected : true };
}

// "Alternativa N de M" positions for a modular's MODULE alternatives, keyed by
// moduleGroup (the module twin of the line groupInfo map). Counts the modules
// sharing each moduleAlternativeGroup and numbers them in first-appearance order.
// Mirrors ClientPreview.moduleAlternativeInfo.
function moduleAlternativeInfo(modules: Module[]): Map<string, { index: number; total: number }> {
  const counts = new Map<string, number>();
  for (const m of modules) {
    const g = moduleFlags(m).altGroup;
    if (g) counts.set(g, (counts.get(g) || 0) + 1);
  }
  const seen = new Map<string, number>();
  const map = new Map<string, { index: number; total: number }>();
  for (const m of modules) {
    const g = moduleFlags(m).altGroup;
    if (!g || !m.moduleGroup) continue;
    const idx = (seen.get(g) || 0) + 1;
    seen.set(g, idx);
    map.set(m.moduleGroup, { index: idx, total: counts.get(g) as number });
  }
  return map;
}

/** One module enriched with its optional/alternative flags + alt position. */
type ModuleVM = Module & {
  optional: boolean;
  inAlt: boolean;
  selected: boolean;
  altPos: { index: number; total: number } | null;
};

// Partition a compound's components into modules and annotate each with its
// optional / alternative state — the single shape ModuleBlock renders from.
function modulesWithAltPos(components: LineComponent[] | null | undefined): ModuleVM[] {
  const modules = modulesOf(components);
  const altInfo = moduleAlternativeInfo(modules);
  return modules.map((m) => {
    const { optional, altGroup, selected } = moduleFlags(m);
    const inAlt = !!altGroup;
    return { ...m, optional, inAlt, selected, altPos: inAlt && m.moduleGroup ? altInfo.get(m.moduleGroup) ?? null : null };
  });
}

// One module of a modular line: its header (name + per-module subtotal) over its
// element rows. A module may itself be a client-OPTIONAL add-on (excluded from
// the total) or one of a pick-one ALTERNATIVE set — rendered read-only, dimmed
// with the SAME caption language a line-level optional / alternative uses, so
// the whole-module treatment reads consistently with the per-line one and with
// ClientPreview's module block. An excluded module (optional / non-selected)
// asserts NO price — same reason an optional line is struck from the sum.
function ModuleBlock({
  m, fmt, families, currency, rates, images, wholeUniform,
}: {
  m: ModuleVM; fmt: Fmt; families?: Map<string, CatalogFamily> | null; currency: CurrencyCode; rates: Record<string, number>; images?: ImageMap;
  // True when the whole compound is uniform → one hero already sits above, so
  // every module hides its per-row swatch and shows no per-module hero.
  wholeUniform?: boolean;
}) {
  const dimmed = m.optional || (m.inAlt && !m.selected);
  // When the dealer named the module after one of its own pieces (the common
  // case: a "RIGHT ARM LOVESEAT" module whose seat element is also "RIGHT ARM
  // LOVESEAT"), the module header prints that exact name + a roll-up price right
  // above the element row that repeats it — the duplicated "EXCLUSIF
  // COMPOSITION" wall. Suppress the header then; the element rows already name
  // and price the pieces.
  const headerDuplicatesElement = (m.components || []).some(
    (c) => (c?.name || '').trim().toLowerCase() === (m.name || '').trim().toLowerCase(),
  );
  const isMulti = (m.components?.length || 0) > 1;
  // Show the module header (name + per-module subtotal) only for a GENUINE
  // grouping — a real 2+-element module whose name is NOT just one of its own
  // pieces. When the dealer named the module after its main piece, the header
  // would duplicate that element's row, so we suppress it and let the material-
  // grouped body (big swatch + pieces) carry the module on its own.
  const showHeader = !!m.moduleGroup && isMulti && !headerDuplicatesElement;
  const caption: { text: string; color: string } | null = m.optional
    ? { text: 'Opcional · no incluido', color: C.inkMid }
    : m.inAlt
      ? { text: `Alternativa ${m.altPos?.index ?? '?'} de ${m.altPos?.total ?? '?'}${m.selected ? ' · seleccionada' : ''}`, color: C.brand700 }
      : null;
  return (
    // wrap={false}: keep a whole module (its header + material groups) together
    // so a page break lands BETWEEN modules — a module that doesn't fit in the
    // space left on a page moves to the next one, never spilling over the footer.
    <View style={dimmed ? { opacity: 0.45 } : {}} wrap={false}>
      {caption && <Text style={[s.groupCaption, { color: caption.color, marginTop: 5 }]}>{caption.text}</Text>}
      {showHeader && (
        <View style={s.moduleHead}>
          <Text style={s.moduleName}>{m.name || '—'}</Text>
          {!dimmed && <Text style={s.moduleAmount}>{fmt(moduleSubtotal(m.components))}</Text>}
        </View>
      )}
      {/* Body grouped BY MATERIAL: same-fabric pieces collapse under one big
          swatch (ComponentList). No per-piece swatch repetition. */}
      <ComponentList components={m.components} forceHideSwatch={wholeUniform} fmt={fmt} families={families} currency={currency} rates={rates} images={images} />
    </View>
  );
}

// ---- set / alternative grouped zone ------------------------------------
function GroupZone({
  type, members, footer, view, fmt, families, currency, rates, images,
}: {
  type: 'set' | 'alternative';
  members: QuoteLine[];
  footer: { kind: string; amount: number; amountRange: { min: number; max: number } | null; optional: boolean } | null;
  view: View0; fmt: Fmt; families?: Map<string, CatalogFamily> | null; currency: CurrencyCode; rates: Record<string, number>; images?: ImageMap;
}) {
  const isSet = type === 'set';
  const bandBg = isSet ? C.bandGroupSet : C.bandGroupAlt;
  const memberBg = isSet ? C.bgGroupSet : C.brand50;
  const railColor = isSet ? C.inkLine2 : C.brand300;
  const labelColor = isSet ? C.inkHigh : C.brand700;
  const title = isSet ? 'Conjunto' : 'Alternativa';
  const sub = isSet ? `${members.length} piezas · todas incluidas` : 'elige una';
  const footerLabel = footer?.kind === 'set'
    ? (footer.optional ? 'Total del conjunto · no incluido' : 'Total del conjunto')
    : 'Total';

  // Set members that share ONE fabric → collapse the repeated per-member swatch
  // into a single material header per run (the same groupComponentsByMaterial
  // rule a mixed compound uses on its components, here over the member LINES).
  // Only earns a header on a bearing run of 2+ members; a lone member or a
  // non-bearing run renders as today. Alternatives never collapse (each option
  // is meant to be compared swatch-and-all). Mirrors the client treatment.
  const grouping = isSet ? groupComponentsByMaterial(members) : { grouped: false as const, runs: [] };
  // Collapse a run only when it earns a header: a bearing run of 2+ SIMPLE
  // members. A compound member carries a stale parent `subtype` we never render,
  // so it must not anchor or hide under a fabric header — leave such a run as is.
  const collapseRun = (run: { bearing: boolean; components: QuoteLine[] }): boolean =>
    run.bearing && run.components.length >= 2 && run.components.every((m) => !isCompoundLine(m));

  const Member = ({ m, hideSwatch }: { m: QuoteLine; hideSwatch?: boolean }) => (
    <View style={[s.zoneMember, { backgroundColor: memberBg, borderLeftColor: railColor }]}>
      <LineRow line={m} view={view} fmt={fmt} inZone families={families} currency={currency} rates={rates} images={images} hideSwatch={hideSwatch} />
    </View>
  );

  // A run's material header — one swatch + "Tapizado · <fabric>" hoisted above a
  // run of same-fabric members (read-only, like UpholsteryHero everywhere else).
  // Inset to the member rail so it reads as belonging to the members below it.
  const RunHeader = ({ subtype, swatchImageId }: { subtype: string; swatchImageId: string | null }) => (
    <View style={[s.zoneMember, { backgroundColor: memberBg, borderLeftColor: railColor }]}>
      <UpholsteryHero subtype={subtype} swatchImageId={swatchImageId} images={images} />
    </View>
  );

  // Flatten the grouped set into an ordered list of header / member nodes so the
  // zone band can stay bound to the FIRST node (page-break safety) regardless of
  // whether that node is a run header or a member.
  type Node = { kind: 'header'; key: string; subtype: string; swatchImageId: string | null }
            | { kind: 'member'; key: string; m: QuoteLine; hideSwatch: boolean };
  const nodes: Node[] = [];
  if (isSet && grouping.grouped) {
    grouping.runs.forEach((run, ri) => {
      const collapse = collapseRun(run);
      if (collapse) nodes.push({ kind: 'header', key: `h-${run.key}-${ri}`, subtype: run.subtype, swatchImageId: run.swatchImageId });
      run.components.forEach((m) => nodes.push({ kind: 'member', key: m.id, m, hideSwatch: collapse }));
    });
  } else {
    members.forEach((m) => nodes.push({ kind: 'member', key: m.id, m, hideSwatch: false }));
  }
  const renderNode = (n: Node) =>
    n.kind === 'header'
      ? <RunHeader key={n.key} subtype={n.subtype} swatchImageId={n.swatchImageId} />
      : <Member key={n.key} m={n.m} hideSwatch={n.hideSwatch} />;

  return (
    <View style={{ marginVertical: 4 }}>
      {/* Bind the header band to its first node so the band never orphans
          at a page bottom (minPresenceAhead is unreliable nested this deep). */}
      <View wrap={false}>
        <View style={[s.zoneBand, { backgroundColor: bandBg }]}>
          <Text style={[s.zoneBandLabel, { color: labelColor }]}>{title}</Text>
          <Text style={{ fontFamily: 'Sohne', fontSize: fs(7.5), color: C.inkMid, textTransform: 'uppercase', letterSpacing: 1 }}>{sub}</Text>
        </View>
        {nodes[0] && renderNode(nodes[0])}
      </View>
      {nodes.slice(1).map(renderNode)}
      {footer && (
        <View style={[s.zoneBand, { backgroundColor: bandBg }]} wrap={false}>
          <Text style={[s.zoneBandLabel, { color: labelColor }]}>{footerLabel}</Text>
          <Text style={{ fontSize: fs(11), fontWeight: 'bold', color: C.ink }}>
            {footer.amountRange ? `${fmt(footer.amountRange.min)} – ${fmt(footer.amountRange.max)}` : fmt(footer.amount)}
          </Text>
        </View>
      )}
    </View>
  );
}

// ---- section -----------------------------------------------------------
function SectionBlock({
  section, view, fmt, families, currency, rates, images,
}: {
  section: View0['sections'][number]; view: View0; fmt: Fmt;
  families?: Map<string, CatalogFamily> | null; currency: CurrencyCode; rates: Record<string, number>; images?: ImageMap;
}) {
  const byId = new Map(section.items.map((l) => [l.id, l]));
  return (
    <View style={s.section}>
      {section.label && (
        // minPresenceAhead keeps the eyebrow from orphaning at a page bottom
        // away from its first product block (react-pdf owns the page break).
        <View style={s.sectionHead} minPresenceAhead={150}>
          <View>
            <Text style={s.sectionLabel}>{section.label}</Text>
            <View style={s.sectionTick} />
          </View>
          <Text style={s.sectionSubtotal}>{fmt(section.subtotal)}</Text>
        </View>
      )}
      {section.runs.map((run, i) => {
        const members = run.lineIds.map((id) => byId.get(id)).filter(Boolean) as QuoteLine[];
        if (run.type === 'single') {
          return members[0]
            ? <LineRow key={members[0].id} line={members[0]} view={view} fmt={fmt} inZone={false} families={families} currency={currency} rates={rates} images={images} />
            : null;
        }
        return (
          <GroupZone key={run.groupId || i} type={run.type as 'set' | 'alternative'} members={members} footer={run.footer} view={view} fmt={fmt} families={families} currency={currency} rates={rates} images={images} />
        );
      })}
    </View>
  );
}

// ---- header + customer -------------------------------------------------
function Header({ settings, quote, images }: { settings: Settings | null | undefined; quote: Quote; images?: ImageMap }) {
  const date = formatDate(quote.updatedAt || quote.createdAt || Date.now());
  const logo = imgFor(images, 'logo');
  return (
    <>
      <View style={s.headerRow}>
        <View>
          {logo
            ? <Image src={logo} style={{ height: 36, maxWidth: 200, objectFit: 'contain' }} />
            : <Text style={s.company}>{settings?.companyName || 'Tu empresa'}</Text>}
          {settings?.companyAddress && <Text style={s.companyMeta}>{settings.companyAddress}</Text>}
          {settings?.companyPhone && <Text style={s.companyMeta}>{settings.companyPhone}</Text>}
          {settings?.companyEmail && <Text style={s.companyMeta}>{settings.companyEmail}</Text>}
        </View>
        <View style={s.headerRight}>
          <Text style={s.eyebrow}>Cotización</Text>
          <Text style={s.quoteNumber}>{quote.number != null ? `#${quote.number}` : 'BORRADOR'}</Text>
          <Text style={s.quoteDate}>{date}</Text>
        </View>
      </View>
      <View style={s.rule} />
    </>
  );
}

function CustomerBlock({ customer, professional, seller }: { customer: Customer | null; professional?: Professional | null; seller?: Profile | null }) {
  const meta = customer ? [
    [customer.city, customer.state, customer.zip].filter(Boolean).join(', '),
    customer.country, customer.email, customer.phone,
  ].filter(Boolean).join(' · ') : '';
  return (
    <>
      <View style={s.blockRow}>
        <View>
          <Text style={s.eyebrow}>Cliente</Text>
          {customer ? (
            <>
              <Text style={s.custName}>{customer.name || '—'}</Text>
              {customer.company && <Text style={s.custCompany}>{customer.company}</Text>}
              {customer.address ? <Text style={s.custMeta}>{customer.address}</Text> : null}
              {meta ? <Text style={s.custMeta}>{meta}</Text> : null}
            </>
          ) : (
            <Text style={[s.custName, { fontStyle: 'italic', color: C.inkSoft, fontWeight: 'normal' }]}>Sin cliente asignado</Text>
          )}
        </View>
        <View>
          {seller?.name && (
            <View style={s.rightEntry}>
              <Text style={s.eyebrow}>Vendedor</Text>
              <Text style={s.rightName}>{seller.name}</Text>
            </View>
          )}
          {professional?.name && (
            <View style={s.rightEntry}>
              <Text style={s.eyebrow}>Profesional</Text>
              <Text style={s.rightName}>{professional.name}</Text>
              {professional.company && <Text style={s.rightSub}>{professional.company}</Text>}
            </View>
          )}
        </View>
      </View>
      <View style={s.rule} />
    </>
  );
}

// ---- totals ------------------------------------------------------------
function TotalsBlock({
  quote, totals, lines, fmt, currency, rates, images,
}: {
  quote: Quote; totals: Totals; lines: QuoteLine[]; fmt: Fmt; currency: CurrencyCode; rates: Record<string, number>; images?: ImageMap;
}) {
  const range = computeTotalsRange(lines, quote as { marginPct?: number; discountPct?: number; courtesyDiscountPct?: number; shipping?: number });
  const hasRange = range.max > range.min;
  const dopRate = Number(rates?.DOP) || 0;
  const rateLogo = imgFor(images, 'rateLogo');
  const plain = (v: number) => `RD$ ${Math.round(v).toLocaleString('en-US')}`;

  const subRows: Array<[string, number, string, boolean]> = [['Subtotal', totals.subtotal, C.inkHigh, false]];
  if (quote.discountPct) subRows.push([`Descuento (${quote.discountPct}%)`, -totals.discountAmt, C.brand700, true]);
  if (quote.courtesyDiscountPct) subRows.push([`Cortesía amigos y familia (${quote.courtesyDiscountPct}%)`, -totals.courtesyDiscountAmt, C.brand700, true]);
  if (totals.taxPct) subRows.push([`ITBIS (${ITBIS_PCT}%)`, totals.taxAmt, C.inkMid, false]);
  if (quote.shipping) subRows.push(['Envío', totals.shipping, C.inkMid, false]);

  return (
    <View style={s.totalsWrap} wrap={false}>
      {subRows.map(([label, value, color, bold]) => (
        <View key={label} style={s.subRow}>
          <Text style={[s.subLabel, { color, fontWeight: bold ? 'bold' : 'normal' }]}>{label}</Text>
          <Text style={[s.subLabel, { color, fontWeight: bold ? 'bold' : 'normal' }]}>{fmt(value)}</Text>
        </View>
      ))}
      <View style={s.band}>
        <Text style={s.bandLabel}>TOTAL</Text>
        {hasRange
          ? <Text style={s.bandValueRange}>{fmt(range.min)} – {fmt(range.max)}</Text>
          : <Text style={s.bandValue}>{fmt(totals.grandTotal)}</Text>}
      </View>
      <Text style={s.flete}>Flete y agenciamiento incluido</Text>
      {dopRate > 0 && currency === 'USD' && (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 4, marginTop: 6 }}>
          {rateLogo && <Image src={rateLogo} style={{ height: 10, width: 10, objectFit: 'contain' }} />}
          <Text style={{ fontSize: fs(8.5), color: C.inkMid }}>
            {hasRange
              ? `≈ ${plain(range.min * dopRate)} – ${plain(range.max * dopRate)} a ${dopRate.toFixed(2)} DOP/USD`
              : `≈ ${plain(totals.grandTotal * dopRate)} a ${dopRate.toFixed(2)} DOP/USD`}
          </Text>
        </View>
      )}
    </View>
  );
}

// ---- document ----------------------------------------------------------
export function QuoteDocument({
  quote, settings, lines, totals, customer, professional = null, seller = null,
  quoteGroups = [], families = null, images,
}: QuoteDocumentProps) {
  const view = resolveQuoteView({ quote, lines, settings, quoteGroups });
  // Match ClientPreview's rate source so screen and paper agree: the quote's
  // own rate map wins (the public share bundle and an accepted quote both
  // carry it), falling back to displayRatesFor (live settings rate) only for
  // an editor draft that has none.
  const quoteRates = quote.rates as Record<string, number> | null | undefined;
  const rates = (quoteRates && quoteRates.DOP
    ? quoteRates
    : displayRatesFor(quote, settings || ({} as Settings))) as Record<string, number>;
  const currency = (quote.currencyCode || 'USD') as CurrencyCode;
  const fmt: Fmt = (v) => formatMoney(v, currency, rates);
  const priced = lines.filter(isPricedLine);
  const footerLeft = settings?.quoteFooter
    || (settings?.companyEmail?.includes('@') ? settings.companyEmail.split('@')[1].toLowerCase() : '')
    || settings?.companyName || '';

  return (
    <Document title={`Cotizacion ${quote.number ?? '(borrador)'}`}>
      <Page size="LETTER" style={s.page}>
        <Header settings={settings} quote={quote} images={images} />
        <CustomerBlock customer={customer} professional={professional} seller={seller} />
        {priced.length === 0 && view.sections.length === 0 ? (
          <Text style={{ fontSize: fs(11), color: C.inkSoft, fontStyle: 'italic', marginTop: 20 }}>
            Esta cotización aún no tiene líneas.
          </Text>
        ) : (
          view.sections.map((section, i) => (
            <SectionBlock key={section.label || i} section={section} view={view} fmt={fmt} families={families} currency={currency} rates={rates} images={images} />
          ))
        )}
        <TotalsBlock quote={quote} totals={totals} lines={lines} fmt={fmt} currency={currency} rates={rates} images={images} />
        {quote.terms && (
          <View wrap={false}>
            <Text style={s.termsHead}>Términos y condiciones</Text>
            <Text style={s.termsBody}>{quote.terms}</Text>
          </View>
        )}
        <View style={s.footer} fixed>
          <Text style={s.footerText}>{footerLeft}</Text>
          <Text style={s.footerText} render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
