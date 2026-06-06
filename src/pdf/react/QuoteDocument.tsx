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
function Swatch({ src, images, size = 40 }: { src: { imageId?: string | null; url?: string | null }; images?: ImageMap; size?: number }) {
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
    <View style={{ marginTop: 7, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
      <Swatch src={src} images={images} size={40} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: 'Sohne', fontSize: fs(7.5), color: C.inkMid, letterSpacing: 1, textTransform: 'uppercase' }}>Tapizado</Text>
        {label ? <Text style={{ fontSize: fs(9.5), color: C.inkHigh, marginTop: 1.5 }}>{label}</Text> : null}
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
        <View key={i} style={{ width: '48%', marginBottom: 8, flexDirection: 'row', gap: 6 }}>
          <Swatch src={cell.swatch} images={images} size={36} />
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
  // Mixed (non-modular) compound → group pieces into contiguous same-material
  // runs, each under one fabric header (frame, then cushions); uniform stays the
  // single hero above. Same Model rule as the on-screen preview.
  const grouping = compound && !modular ? groupComponentsByMaterial(line.components) : { grouped: false as const, runs: [] };
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
    <View style={[s.line, dimmed ? { opacity: 0.45 } : {}]} wrap={false}>
      <View style={s.imgBox}>{cover && <Image src={cover} style={{ width: 92, height: 92, objectFit: 'contain' }} />}</View>
      <View style={s.lineBody}>
        <View style={s.lineMain}>
          {caption && <Text style={[s.groupCaption, { color: caption.color }]}>{caption.text}</Text>}
          {line.family && <Text style={s.familyEyebrow}>{line.family}</Text>}
          <Text style={s.lineName}>{line.name || '—'}</Text>
          {!hideSwatch && line.subtype && <Text style={s.lineSub}>{fabricDisplay(line.subtype)}</Text>}
          {(line.reference || line.dimensions) && (
            <View style={s.lineRefRow}>
              {line.reference && <Text style={s.lineRef}>REF. {line.reference}</Text>}
              {line.dimensions && <Text style={s.lineRef}>DIM. {line.dimensions}</Text>}
            </View>
          )}
          {showSwatch && <View style={{ marginTop: 6 }}><Swatch src={swatchSrc} images={images} size={40} /></View>}
          <MaterialGrid cells={cells} images={images} />
          {compound && upholstery.uniform && (
            <UpholsteryHero subtype={upholstery.subtype} swatchImageId={upholstery.swatchImageId} images={images} />
          )}
          {modular ? (
            // Group by module: each component product under its own header with
            // a per-module subtotal; the whole modular keeps one image above. A
            // module may itself be a client-OPTIONAL add-on (excluded from the
            // total) or a pick-one ALTERNATIVE — rendered read-only, dimmed with
            // a caption, mirroring the line-level optional/alternative treatment
            // and the on-screen client link.
            modulesWithAltPos(line.components).map((m, mi) => (
              <ModuleBlock key={m.moduleGroup || mi} m={m} fmt={fmt} families={families} currency={currency} rates={rates} images={images} wholeUniform={upholstery.uniform} />
            ))
          ) : compound && grouping.grouped ? (
            // A fabric header per contiguous run, its rows collapsed to clean
            // name+price (the run header states the fabric). Non-bearing runs
            // (metal base, glass) render header-less.
            grouping.runs.map((run, ri) => (
              <View key={run.key + ri}>
                {run.bearing && (
                  <UpholsteryHero subtype={run.subtype} swatchImageId={run.swatchImageId} images={images} />
                )}
                {run.components.map((c, i) => (
                  <ComponentRow key={c.id || i} c={c} fmt={fmt} families={families} currency={currency} rates={rates} images={images} hideSwatch={run.bearing} />
                ))}
              </View>
            ))
          ) : (
            compound && Array.isArray(line.components) && line.components.map((c, i) => (
              <ComponentRow key={c.id || i} c={c} fmt={fmt} families={families} currency={currency} rates={rates} images={images} hideSwatch={upholstery.uniform} />
            ))
          )}
          {line.description && <Text style={s.lineDesc}>{line.description}</Text>}
        </View>
        <MoneyCell line={line} fmt={fmt} />
      </View>
    </View>
  );
}

// compound component: swatch + name/ref over its subtotal, plus its own grid.
// `hideSwatch` (uniform compound) collapses the row to a clean name + price —
// the shared fabric is stated once in the header hero, so the per-piece swatch
// and its now-redundant subtype line drop out.
function ComponentRow({
  c, fmt, families, currency, rates, images, hideSwatch,
}: {
  c: LineComponent; fmt: Fmt; families?: Map<string, CatalogFamily> | null; currency: CurrencyCode; rates: Record<string, number>; images?: ImageMap; hideSwatch?: boolean;
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
  return (
    <View style={{ marginTop: 5, paddingTop: 5, borderTopWidth: 0.5, borderTopColor: C.inkLine }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 6, flex: 1 }}>
          {showSwatch && <Swatch src={swatchSrc} images={images} size={26} />}
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: fs(9), color: C.inkHigh }}>{c.name || c.reference || '—'}</Text>
            {!hideSwatch && c.subtype && <Text style={{ fontSize: fs(7.5), color: C.inkMid, marginTop: 1 }}>{fabricDisplay(c.subtype)}</Text>}
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          {/* The "qty ×" line only earns its place when there's more than one
              unit (2 seats, a pair of cushions). At qty 1 it just repeats the
              subtotal below — so show the subtotal alone. */}
          {qty > 1 && <Text style={{ fontSize: fs(7.5), color: C.inkMid }}>{qty} × {ranged ? 'rango' : fmt(unit)}</Text>}
          <Text style={{ fontSize: fs(9), color: C.inkMid, marginTop: qty > 1 ? 1 : 0 }}>
            {ranged && range ? `${fmt(range.min)} – ${fmt(range.max)}` : fmt(componentSubtotal(c))}
          </Text>
        </View>
      </View>
      {!hideSwatch && <MaterialGrid cells={cells} images={images} />}
    </View>
  );
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
  // Group the module's pieces by material — one "Tapizado" hero for a uniform
  // module, a header per contiguous same-fabric run for a mixed one (ERPI seat
  // pieces, then a CLOUD accent cushion) — so an identical swatch isn't stamped
  // on every row. Read-only; mirrors ClientPreview's module block.
  const renderBody = () => {
    if (wholeUniform) {
      return <>{m.components.map((c, i) => (
        <ComponentRow key={c.id || i} c={c} fmt={fmt} families={families} currency={currency} rates={rates} images={images} hideSwatch />
      ))}</>;
    }
    const modFabric = compoundFabric(m.components);
    if (modFabric.uniform) {
      return <>
        <UpholsteryHero subtype={modFabric.subtype} swatchImageId={modFabric.swatchImageId} images={images} />
        {m.components.map((c, i) => (
          <ComponentRow key={c.id || i} c={c} fmt={fmt} families={families} currency={currency} rates={rates} images={images} hideSwatch />
        ))}
      </>;
    }
    const grouping = groupComponentsByMaterial(m.components);
    if (grouping.grouped) {
      return <>{grouping.runs.map((run, ri) => (
        <View key={run.key + ri}>
          {run.bearing && <UpholsteryHero subtype={run.subtype} swatchImageId={run.swatchImageId} images={images} />}
          {run.components.map((c, i) => (
            <ComponentRow key={c.id || i} c={c} fmt={fmt} families={families} currency={currency} rates={rates} images={images} hideSwatch={run.bearing} />
          ))}
        </View>
      ))}</>;
    }
    return <>{m.components.map((c, i) => (
      <ComponentRow key={c.id || i} c={c} fmt={fmt} families={families} currency={currency} rates={rates} images={images} />
    ))}</>;
  };
  const caption: { text: string; color: string } | null = m.optional
    ? { text: 'Opcional · no incluido', color: C.inkMid }
    : m.inAlt
      ? { text: `Alternativa ${m.altPos?.index ?? '?'} de ${m.altPos?.total ?? '?'}${m.selected ? ' · seleccionada' : ''}`, color: C.brand700 }
      : null;
  return (
    <View style={dimmed ? { opacity: 0.45 } : {}}>
      {caption && <Text style={[s.groupCaption, { color: caption.color, marginTop: 5 }]}>{caption.text}</Text>}
      {/* A module header labels a GROUP of elements. With a single element the
          element's own row already names and prices it, so a header here just
          repeats the name + price (the modular "EXCLUSIF COMPOSITION" clutter) —
          show it only for a real 2+-element grouping. */}
      {m.moduleGroup && m.components.length > 1 && (
        <View style={s.moduleHead}>
          <Text style={s.moduleName}>{m.name || '—'}</Text>
          {!dimmed && <Text style={s.moduleAmount}>{fmt(moduleSubtotal(m.components))}</Text>}
        </View>
      )}
      {renderBody()}
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
              {customer.address && <Text style={s.custMeta}>{customer.address}</Text>}
              {meta && <Text style={s.custMeta}>{meta}</Text>}
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
  subRows.push([`ITBIS (${ITBIS_PCT}%)`, totals.taxAmt, C.inkMid, false]);
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
