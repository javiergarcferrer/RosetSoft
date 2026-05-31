import { Document, Page, View, Text, Image } from '@react-pdf/renderer';
import { resolveQuoteView } from '../../core/quote/views/quoteView.js';
import { displayRatesFor } from '../../lib/exchangeRate.js';
import { formatMoney, formatDate } from '../../lib/format.js';
import { isPricedLine } from '../../lib/constants.js';
import {
  ITBIS_PCT, lineQty, lineTotal, lineListUnit, lineHasRange, lineTotalRange,
  isCompoundLine, componentSubtotal, computeTotalsRange, quoteSavings,
} from '../../lib/pricing.js';
import type {
  Quote, QuoteLine, LineComponent, Customer, Professional, Profile, Settings, Totals,
  CurrencyCode, QuoteGroup,
} from '../../types/domain.ts';
import type { CatalogFamily } from '../../lib/catalog.ts';
import { materialCells } from './materialCells.js';
import type { MoCell } from './materialCells.js';
import { coverKey, swatchKey } from './imageKeys.js';
import type { ImageMap } from './imageKeys.js';
import { s, C } from './theme.js';

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

// ---- material-options grid (two columns; swatch over label + delta) ----
function MaterialGrid({ cells, images }: { cells: MoCell[]; images?: ImageMap }) {
  if (!cells.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 8 }}>
      {cells.map((cell, i) => (
        <View key={i} style={{ width: '48%', marginBottom: 8, flexDirection: 'row', gap: 6 }}>
          <Swatch src={cell.swatch} images={images} size={36} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 8, color: C.inkHigh }}>{cell.label}</Text>
            {cell.note && <Text style={{ fontSize: 7.5, color: cell.noteColor, marginTop: 1 }}>{cell.note}</Text>}
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
  line, view, fmt, inZone, families, currency, rates, images,
}: {
  line: QuoteLine; view: View0; fmt: Fmt; inZone: boolean;
  families?: Map<string, CatalogFamily> | null; currency: CurrencyCode; rates: Record<string, number>; images?: ImageMap;
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
  // Standalone swatch only when there's no options grid (the grid leads with
  // the same material) — mirrors ClientPreview / the pdf-lib renderer.
  const showSwatch = !cells.length && !!line.swatchImageId;

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
          {line.subtype && <Text style={s.lineSub}>{line.subtype}</Text>}
          {(line.reference || line.dimensions) && (
            <View style={s.lineRefRow}>
              {line.reference && <Text style={s.lineRef}>REF. {line.reference}</Text>}
              {line.dimensions && <Text style={s.lineRef}>DIM. {line.dimensions}</Text>}
            </View>
          )}
          {showSwatch && <View style={{ marginTop: 6 }}><Swatch src={{ imageId: line.swatchImageId }} images={images} size={40} /></View>}
          <MaterialGrid cells={cells} images={images} />
          {compound && Array.isArray(line.components) && line.components.map((c, i) => (
            <ComponentRow key={c.id || i} c={c} fmt={fmt} families={families} currency={currency} rates={rates} images={images} />
          ))}
          {line.description && <Text style={s.lineDesc}>{line.description}</Text>}
        </View>
        <MoneyCell line={line} fmt={fmt} />
      </View>
    </View>
  );
}

// compound component: swatch + name/ref over its subtotal, plus its own grid
function ComponentRow({
  c, fmt, families, currency, rates, images,
}: {
  c: LineComponent; fmt: Fmt; families?: Map<string, CatalogFamily> | null; currency: CurrencyCode; rates: Record<string, number>; images?: ImageMap;
}) {
  const cells = materialCells({ mo: c.materialOptions, reference: c.reference, baseSwatchImageId: c.swatchImageId, families, currency, rates });
  const showSwatch = !cells.length && !!c.swatchImageId;
  return (
    <View style={{ marginTop: 5, paddingTop: 5, borderTopWidth: 0.5, borderTopColor: C.inkLine }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 6, flex: 1 }}>
          {showSwatch && <Swatch src={{ imageId: c.swatchImageId }} images={images} size={26} />}
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 9, color: C.inkHigh }}>{c.name || c.reference || '—'}</Text>
            {c.subtype && <Text style={{ fontSize: 7.5, color: C.inkMid, marginTop: 1 }}>{c.subtype}</Text>}
          </View>
        </View>
        <Text style={{ fontSize: 9, color: C.inkMid }}>{fmt(componentSubtotal(c))}</Text>
      </View>
      <MaterialGrid cells={cells} images={images} />
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

  const Member = ({ m }: { m: QuoteLine }) => (
    <View style={[s.zoneMember, { backgroundColor: memberBg, borderLeftColor: railColor }]}>
      <LineRow line={m} view={view} fmt={fmt} inZone families={families} currency={currency} rates={rates} images={images} />
    </View>
  );

  return (
    <View style={{ marginVertical: 4 }}>
      {/* Bind the header band to its first member so the band never orphans
          at a page bottom (minPresenceAhead is unreliable nested this deep). */}
      <View wrap={false}>
        <View style={[s.zoneBand, { backgroundColor: bandBg }]}>
          <Text style={[s.zoneBandLabel, { color: labelColor }]}>{title}</Text>
          <Text style={{ fontSize: 7.5, color: C.inkMid, textTransform: 'uppercase', letterSpacing: 1 }}>{sub}</Text>
        </View>
        {members[0] && <Member m={members[0]} />}
      </View>
      {members.slice(1).map((m) => <Member key={m.id} m={m} />)}
      {footer && (
        <View style={[s.zoneBand, { backgroundColor: bandBg }]} wrap={false}>
          <Text style={[s.zoneBandLabel, { color: labelColor }]}>{footerLabel}</Text>
          <Text style={{ fontSize: 11, fontWeight: 'bold', color: C.ink }}>
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
  const range = computeTotalsRange(lines, quote as { marginPct?: number; discountPct?: number; shipping?: number });
  const hasRange = range.max > range.min;
  const savings = quoteSavings(lines, totals);
  const dopRate = Number(rates?.DOP) || 0;
  const rateLogo = imgFor(images, 'rateLogo');
  const plain = (v: number) => `RD$ ${Math.round(v).toLocaleString('en-US')}`;

  const subRows: Array<[string, number, string, boolean]> = [['Subtotal', totals.subtotal, C.inkHigh, false]];
  if (quote.discountPct) subRows.push([`Descuento (${quote.discountPct}%)`, -totals.discountAmt, C.brand700, true]);
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
      {savings > 0 && <Text style={s.savings}>Ahorras {fmt(savings)} en esta cotización</Text>}
      {dopRate > 0 && currency === 'USD' && (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 4, marginTop: 6 }}>
          {rateLogo && <Image src={rateLogo} style={{ height: 10, width: 10, objectFit: 'contain' }} />}
          <Text style={{ fontSize: 8.5, color: C.inkMid }}>
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
          <Text style={{ fontSize: 11, color: C.inkSoft, fontStyle: 'italic', marginTop: 20 }}>
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
