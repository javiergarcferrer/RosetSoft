import { Fragment, useMemo, useState } from 'react';
import { Boxes, GitFork, ChevronDown, Plus, X, Check, Sparkles, Truck, SlidersHorizontal, Eye } from 'lucide-react';
import ImageView from '../ImageView.jsx';
import ImageZoom from './ImageZoom.jsx';
import Modal from '../Modal.jsx';
import MaterialOptionsStrip from './MaterialOptionsStrip.jsx';
import MaterialColorPicker from './MaterialColorPicker.jsx';
import MaterialPickerButton from './MaterialPickerButton.jsx';
import ApplyMaterialToAllButton from './ApplyMaterialToAllButton.jsx';
import { splitSkuGrade } from '../../lib/catalog.js';
import { parseSubtype, composeFabricLabel, canPropagateMaterial, compoundFabric, groupComponentsByMaterial, fabricDisplay } from '../../lib/subtype.js';
import {
  ITBIS_PCT, isCompoundLine, componentSubtotal, compoundSubtotal, lineTotal,
  lineQty, lineBasePrice, lineListUnit, applyLineAdjustments, clampPct,
  isRangeLine, lineTotalRange,
  isRangeComponent, componentSubtotalRange, lineHasRange, componentAlternativeGroupInfo,
} from '../../lib/pricing.js';
import { isModularLine, modulesOf, moduleSubtotal } from '../../lib/modules.js';
import { resolveQuoteView } from '../../core/quote/views/quoteView.js';
import { formatMoney, formatDate } from '../../lib/format.js';
import { colorCodeFromSubtype } from '../../lib/swatchMatch.js';
import { swatchUrl } from '../../lib/swatchImage.js';

/**
 * Read-only client-facing preview of the quote. Renders the same data the
 * PDF generator does, in HTML, so the dealer can flip "Vista cliente" in
 * the header during a sales conversation without downloading a PDF first.
 *
 * Intentionally NOT styled to match the PDF pixel-for-pixel — the PDF
 * follows pdf-lib's text layout constraints; this is the *web* twin, with
 * generous typography honoring the brand and the things you can do in HTML
 * (line item images at scale, hover-cleaner totals, etc.).
 */
/**
 * A labelled section group wrapped in a native <details open> so a customer
 * on a phone can collapse a long section. Renders only when the section
 * carries a label (top-level / unlabelled groups stay flush). The summary
 * is the same terracotta eyebrow + rule the section header used, plus a
 * chevron that rotates when open.
 */
function SectionDisclosure({ label, subtotalLabel, children }) {
  return (
    <details open className="group/section">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden px-4 pt-6 pb-2 flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="eyebrow font-semibold tracking-[0.12em] text-brand-700">{label}</span>
          <span className="mt-1.5 block h-[2px] w-9 bg-brand-700 rounded-full" />
        </span>
        <span className="flex items-center gap-3 flex-shrink-0">
          {subtotalLabel && (
            <span className="text-sm font-semibold tabular-nums text-ink-800 whitespace-nowrap">{subtotalLabel}</span>
          )}
          <ChevronDown
            size={16}
            className="text-brand-700 transition-transform duration-200 group-open/section:rotate-180"
            aria-hidden
          />
        </span>
      </summary>
      {children}
    </details>
  );
}

// The Ver / Personalizar mode switch on the interactive link. A segmented
// control (NOT a floating action button — this flips a MODE, and a FAB reads as
// a primary action; a segment pair states "you are here, tap to switch"). Ver is
// the clean read-only proposal a client lands on; Personalizar reveals every
// control. The amber dot on Personalizar quietly advertises that there's more to
// do without shouting, so a client discovers they can configure their own fabric.
function ModeToggle({ mode, onChange, floating }) {
  const opts = [
    { value: 'view', label: 'Ver', Icon: Eye },
    { value: 'edit', label: 'Personalizar', Icon: SlidersHorizontal },
  ];
  // Floating: carries its own dark surface + pop shadow (it no longer sits on
  // the dark banner). Inline keeps the translucent fill it had on the banner.
  return (
    <span
      className={`inline-flex items-stretch rounded-full p-0.5 ${floating ? 'bg-ink-900 shadow-pop ring-1 ring-white/10' : 'bg-white/10'}`}
      role="group"
      aria-label="Modo de la cotización"
    >
      {opts.map(({ value, label, Icon }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            aria-pressed={active}
            className={`relative inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              active ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-50/80 hover:text-white'
            }`}
          >
            <Icon size={12} aria-hidden />
            {label}
            {/* Quiet "there's more here" hint on the inactive Personalizar tab. */}
            {value === 'edit' && !active && (
              <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />
            )}
          </button>
        );
      })}
    </span>
  );
}

// Per-line margin factor — the SAME factor the public-link bundle bakes into
// every price (quote margin × line margin; the discount is deliberately
// excluded — the link bakes margin only). The editor feeds RAW prices + the real
// margin fields, so the in-app preview applies this factor itself to show the
// picker grade prices + option-chip deltas the link already carries baked. On the
// link both margin fields are zeroed (margin already baked) so the factor is 1.
function marginFactor(quoteMarginPct, lineMarginPct) {
  return (1 + (Number(quoteMarginPct) || 0) / 100) * (1 + (Number(lineMarginPct) || 0) / 100);
}

// Module-level optional / alternative flags live on the module's components (the
// whole component-product opts in/out, or is one pick-one sibling). modulesOf
// already grouped them, so we read the flags off the first element — the twin of
// how a line carries isOptional / alternativeGroup. moduleSelected defaults true
// for an alternative member that hasn't been flagged, so a single-option group
// never reads as "not chosen".
function moduleFlags(module) {
  const c = module?.components?.[0] || {};
  const altGroup = c.moduleAlternativeGroup || null;
  return {
    optional: !!c.moduleOptional,
    altGroup,
    selected: altGroup ? !!c.moduleSelected : true,
  };
}

// "Alternativa N de M" positions for a modular's MODULE alternatives, keyed by
// moduleGroup — the module twin of componentAlternativeGroupInfo (which keys by
// component id). Counts the modules sharing each moduleAlternativeGroup and
// numbers them in first-appearance order.
function moduleAlternativeInfo(modules) {
  const counts = new Map();
  for (const m of modules) {
    const g = moduleFlags(m).altGroup;
    if (g) counts.set(g, (counts.get(g) || 0) + 1);
  }
  const seen = new Map();
  const map = new Map();
  for (const m of modules) {
    const g = moduleFlags(m).altGroup;
    if (!g || !m.moduleGroup) continue;
    const idx = (seen.get(g) || 0) + 1;
    seen.set(g, idx);
    map.set(m.moduleGroup, { index: idx, total: counts.get(g) });
  }
  return map;
}

export default function ClientPreview({ quote, settings, lines, quoteGroups, totals, customer, professional, seller, families, materials, modelFabrics, gradePricesFor, materialSelections, onSelectMaterial, onPickMaterial, onPickMaterialMany, onToggleOptional, onSelectAlternative }) {
  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
  const dopRate = rates.DOP || null;
  const fmt = (v) => formatMoney(v, currency, rates);
  // Interactive (the public share link wires onSelect* handlers) vs. read-only
  // (the dealer's in-editor "Vista cliente"). Drives the banner copy so the
  // recipient knows they can configure the quote right here.
  const interactive = !!(onSelectMaterial || onPickMaterial || onSelectAlternative || onToggleOptional);
  // Two modes on the interactive link: a clean read-only PROPOSAL (default) and
  // a PERSONALIZAR mode that reveals every control (radios, fabric pickers,
  // optional toggles, per-piece swatches). The default sells; the toggle invites
  // configuration without cluttering the first impression. Read-only surfaces
  // (the dealer's preview, the PDF) have no toggle — they're always 'view'.
  // `editable` is THE single gate threaded down: in view mode the interactive
  // surface renders byte-identical to the read-only one.
  const [mode, setMode] = useState('view'); // 'view' | 'edit'
  const editable = interactive && mode === 'edit';
  // The full fabric picker is available only when its catalog + commit handler
  // are both wired. The per-line price source differs by surface but the picker
  // is identical: the share link carries baked `gradePrices` on each line; the
  // in-app editor preview derives them live from the catalog via `gradePricesFor`.
  // `onPickMany` powers the "apply this fabric to every component" shortcut: one
  // action carrying the chosen fabric for every sibling id, replayed by the same
  // reducer (materialPick is a map) so the optimistic + server paths stay in
  // parity. Absent ⇒ the shortcut button simply never renders.
  // Every interactive affordance flows through ONE gate: in view mode the
  // handlers are withheld (undefined), so the same `!!handler` checks the
  // renderers already make collapse them to read-only — no parallel "is this
  // editable?" plumbing. The PDF and the dealer's read-only preview hit the same
  // path because `editable` is false there too.
  const pickMaterialIf = editable ? onPickMaterial : undefined;
  const selectMaterialIf = editable ? onSelectMaterial : undefined;
  const toggleOptionalIf = editable ? onToggleOptional : undefined;
  const selectAlternativeIf = editable ? onSelectAlternative : undefined;
  const picker = pickMaterialIf && materials?.length
    ? { materials, modelFabrics: modelFabrics || {}, gradePricesFor, onPick: pickMaterialIf, onPickMany: editable ? onPickMaterialMany : undefined }
    : null;

  // ViewModel — the SHARED content tree (sections → group-runs with footer
  // data, the grand-total range, the "Alternativa/Conjunto N de M"
  // position maps). Computed by the quote Model (core/quote/views/quoteView);
  // the PDF renders the same tree. This view derives nothing itself.
  const view = useMemo(
    () => resolveQuoteView({ quote, lines, settings, quoteGroups }),
    [quote, lines, settings, quoteGroups],
  );
  const { totalsRange, hasRange, groupInfo, setInfo, sections } = view;
  // id → line, for resolving a run's `lineIds` back to its line objects.
  const byId = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);

  // overflow-clip (not -hidden) so the rounded corners still clip the
  // full-bleed banner WITHOUT establishing a scroll container — an
  // overflow:hidden ancestor would trap the sticky product image in
  // CompoundClientLine and stop it following the page scroll.
  return (
    <>
    <div className="bg-white border border-ink-100 rounded-xl shadow-soft overflow-clip">
      {/* Banner. On the interactive link the Ver / Personalizar mode toggle is
          a floating pill pinned to the screen (rendered after this card) so it
          never scrolls away — the banner just states the mode + date here. */}
      <div className="bg-ink-900 text-ink-50 px-5 py-2 text-[11px] flex items-center justify-between gap-3">
        <span>
          {interactive
            ? (mode === 'edit' ? 'Personaliza tu cotización · elige opciones y telas' : 'Tu propuesta · pulsa Personalizar para configurar')
            : 'Vista previa del cliente · de solo lectura'}
        </span>
        <span className="opacity-60 flex-shrink-0">{formatDate(quote.updatedAt)}</span>
      </div>

      {/* Header — stacks on mobile (logo block, then quote#) and promotes
          to a side-by-side row on sm+. The quote# column reads left-aligned
          on mobile so it shares the page gutter instead of orphaning to the
          right edge. */}
      <div className="px-6 sm:px-10 pt-8 pb-6 border-b border-ink-100 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="min-w-0">
          {settings?.logoImageId ? (
            <ImageView
              id={settings.logoImageId}
              className="h-12 max-w-[200px] object-contain object-left mb-3"
            />
          ) : (
            <div className="font-wordmark text-2xl text-ink-900">{settings?.companyName || 'Tu empresa'}</div>
          )}
          <div className="text-[11px] text-ink-500 leading-relaxed whitespace-pre-line max-w-xs">
            {[settings?.companyAddress, settings?.companyPhone, settings?.companyEmail].filter(Boolean).join('\n')}
          </div>
        </div>
        <div className="text-left sm:text-right">
          <div className="eyebrow">Cotización</div>
          {/* Quieter quote number — it shouldn't out-shout the company
              wordmark or (on the totals) the grand total. */}
          <div className="text-xl font-semibold tracking-tight">#{quote.number || '—'}</div>
          <div className="text-[11px] text-ink-500 mt-2">{formatDate(quote.updatedAt)}</div>
        </div>
      </div>

      {/* Customer block — client at the start; the vendedor + referring
          professional sit together at the end. On sm+ the row does NOT wrap:
          the client column flexes (its long address wraps INSIDE that column)
          and the vendor/pro stack stays pinned at the end, so the two blocks
          stay justified instead of the second wrapping below. The inner pair
          runs INLINE on mobile (side by side) and stacks on sm+. */}
      {(customer || seller || professional) && (
        <div className="px-6 sm:px-10 py-5 border-b border-ink-100 flex flex-col gap-4 sm:flex-row sm:flex-nowrap sm:items-start sm:justify-between sm:gap-x-6">
          <div className="min-w-0 sm:flex-1">
            <div className="eyebrow mb-1.5">Cliente</div>
            {customer ? (
              <>
                {/* Up-weighted recipient — the second-most prominent
                    identity after the company, matching the PDF. */}
                <div className="text-lg font-semibold text-ink-900">{customer.name}</div>
                {customer.company && <div className="text-xs text-ink-700">{customer.company}</div>}
                {/* Stacked details, one line each: contact (email · phone),
                    then street, then city/state/zip. Country is omitted. */}
                <div className="text-[11px] text-ink-500 leading-relaxed mt-1 space-y-0.5">
                  {(customer.email || customer.phone) && (
                    <div>{[customer.email, customer.phone].filter(Boolean).join(' · ')}</div>
                  )}
                  {customer.address && <div>{customer.address}</div>}
                  {(customer.city || customer.state || customer.zip) && (
                    <div>{[customer.city, customer.state, customer.zip].filter(Boolean).join(', ')}</div>
                  )}
                </div>
              </>
            ) : (
              <div className="text-sm text-ink-400">Sin cliente asignado</div>
            )}
          </div>
          {(seller || professional) && (
            <div className="flex flex-wrap items-start gap-x-8 gap-y-3 text-left shrink-0 sm:block sm:space-y-3 sm:text-right">
              {seller && (
                <div>
                  <div className="eyebrow mb-0.5">Vendedor</div>
                  <div className="text-sm font-medium text-ink-900">{seller.name}</div>
                </div>
              )}
              {professional && (
                <div>
                  <div className="eyebrow mb-0.5">Profesional</div>
                  <div className="text-sm font-medium text-ink-900">{professional.name}</div>
                  {professional.company && <div className="text-[11px] text-ink-500">{professional.company}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Line items — unified left gutter (px-4 sm:px-6) so every left
          edge inside (rows, group cards, section headers) aligns with the
          header/customer blocks above. */}
      <div className="px-4 sm:px-6 py-2">
        {lines.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-ink-500">
            Aún no hay artículos en esta cotización.
          </div>
        ) : (
          sections.map((section, gi) => {
            // The ViewModel already resolved the card boundaries (runs) + each
            // group's footer DATA; the view just renders them. 'single' → a flat
            // row; 'set' / 'alternative' → a bordered card (header + member rows
            // + one footer total), formatting the footer numbers for currency.
            const list = (
              <ul>
                {section.runs.map((run) => {
                  if (run.type === 'single') {
                    const l = byId.get(run.lineIds[0]);
                    if (!l) return null;
                    return (
                      <ClientLine
                        key={l.id}
                        line={l}
                        quoteMarginPct={quote.marginPct}
                        currency={currency}
                        rates={rates}
                        fmt={fmt}
                        families={families}
                        groupInfo={groupInfo.get(l.id)}
                        setInfo={undefined}
                        insideGroupCard={false}
                        materialSelections={materialSelections}
                        picker={picker}
                        onSelectMaterial={selectMaterialIf}
                        onToggleOptional={toggleOptionalIf}
                      />
                    );
                  }

                  // Group run → a container card wrapping the member rows.
                  const members = run.lineIds.map((id) => byId.get(id)).filter(Boolean);
                  const isSet = run.type === 'set';
                  const { footer } = run;
                  const footerValueLabel = footer.amountRange
                    ? `${fmt(footer.amountRange.min)} – ${fmt(footer.amountRange.max)}`
                    : fmt(footer.amount);
                  return (
                    <ClientGroupCard
                      key={`grp-${run.groupId}-${run.start}`}
                      type={run.type}
                      memberCount={members.length}
                      optional={footer.optional}
                      footerLabel={isSet ? 'Total del conjunto' : 'Total'}
                      footerValue={footerValueLabel}
                    >
                      {isSet ? (
                        // Conjunto members are full product lines that often
                        // share a fabric — collapse repeated swatches under one
                        // shared material header (read-only). Alternatives keep
                        // their own per-row swatch (each option is distinct).
                        <SetMemberList
                          members={members}
                          quoteMarginPct={quote.marginPct}
                          currency={currency}
                          rates={rates}
                          fmt={fmt}
                          families={families}
                          groupInfo={groupInfo}
                          setInfo={setInfo}
                          materialSelections={materialSelections}
                          picker={picker}
                          onSelectMaterial={selectMaterialIf}
                          onToggleOptional={toggleOptionalIf}
                          onSelectAlternative={selectAlternativeIf}
                        />
                      ) : (
                        members.map((l) => (
                          <ClientLine
                            key={l.id}
                            line={l}
                            quoteMarginPct={quote.marginPct}
                            currency={currency}
                            rates={rates}
                            fmt={fmt}
                            families={families}
                            groupInfo={groupInfo.get(l.id)}
                            setInfo={undefined}
                            insideGroupCard
                            materialSelections={materialSelections}
                            picker={picker}
                            onSelectMaterial={selectMaterialIf}
                            onToggleOptional={toggleOptionalIf}
                            onSelectAlternative={selectAlternativeIf}
                          />
                        ))
                      )}
                    </ClientGroupCard>
                  );
                })}
              </ul>
            );
            const secSub = section.subtotal;
            return (
              <div key={gi} className="mb-2">
                {section.label ? (
                  // Labelled section → collapsible <details> landmark with the
                  // section subtotal; open by default.
                  <SectionDisclosure label={section.label} subtotalLabel={secSub > 0 ? fmt(secSub) : null}>{list}</SectionDisclosure>
                ) : (
                  // Top-level / unlabelled group — flush, no disclosure.
                  list
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Totals — the grand total is anchored in a solid ink-900 band,
          the visual climax. Sub-rows above stay right-aligned body text
          (Descuento in brand); the FX shadow sits below the band.
          Mirrors the redesigned PDF. */}
      <div className="px-6 sm:px-10 py-7 border-t border-ink-100">
        <div className="w-full sm:ml-auto sm:max-w-sm tabular-nums">
          <div className="space-y-1.5">
            <TotalRow label="Subtotal" value={fmt(totals.subtotal)} />
            {quote.discountPct ? (
              // Discount row reads in brand colour — muted styling made
              // it look incidental next to the (muted) ITBIS / Envío
              // lines, which buried the concession the customer was
              // supposed to perceive.
              <TotalRow
                label={`Descuento (${quote.discountPct}%)`}
                value={`–${fmt(totals.discountAmt)}`}
                accent
              />
            ) : null}
            {quote.courtesyDiscountPct ? (
              <TotalRow
                label={`Cortesía amigos y familia (${quote.courtesyDiscountPct}%)`}
                value={`–${fmt(totals.courtesyDiscountAmt)}`}
                accent
              />
            ) : null}
            <TotalRow label={`ITBIS (${ITBIS_PCT}%)`} value={fmt(totals.taxAmt)} muted />
            {quote.shipping ? <TotalRow label="Envío" value={fmt(totals.shipping)} muted /> : null}
          </div>
          {/* The anchored grand-total band. */}
          <div className="mt-3 flex items-center justify-between gap-4 bg-ink-900 px-5 py-3.5">
            <span className="eyebrow-xs tracking-[0.18em] text-ink-200 flex-shrink-0">Total</span>
            <span className="text-xl sm:text-2xl font-semibold text-white text-right whitespace-nowrap">
              {hasRange ? `${fmt(totalsRange.min)} – ${fmt(totalsRange.max)}` : fmt(totals.grandTotal)}
            </span>
          </div>
          {/* Standing inclusion note — the quoted price already covers freight
              + customs brokerage. Sits right under the total so it reads as a
              qualifier of the number. */}
          <div className="mt-2 flex items-center justify-end gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
            <Truck size={13} className="flex-shrink-0" aria-hidden />
            Flete y agenciamiento incluido
          </div>
          {dopRate && currency === 'USD' && (
            <div className="flex items-center justify-end gap-1.5 text-[11px] text-ink-500 pt-0.5">
              {settings?.rateLogoImageId && (
                <ImageView
                  id={settings.rateLogoImageId}
                  alt="Banco Popular Dominicano"
                  className="h-4 w-4 flex-shrink-0 object-contain"
                />
              )}
              <span>
                ≈ {hasRange
                  ? `${formatMoney(totalsRange.min, 'DOP', rates)} – ${formatMoney(totalsRange.max, 'DOP', rates)}`
                  : formatMoney(totals.grandTotal, 'DOP', rates)} a {dopRate.toFixed(2)} DOP/USD
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Terms */}
      {quote.terms && (
        <div className="px-6 sm:px-10 py-6 border-t border-ink-100">
          <div className="eyebrow mb-2">Términos</div>
          <div className="text-xs text-ink-700 leading-relaxed whitespace-pre-line">{quote.terms}</div>
        </div>
      )}

      {/* Footer */}
      {settings?.quoteFooter && (
        <div className="px-6 sm:px-10 py-3 border-t border-ink-100 text-[10px] text-ink-500 text-center">
          {settings.quoteFooter}
        </div>
      )}
    </div>

    {/* Floating Ver / Personalizar toggle — interactive link only. Pinned to
        the screen so a client scrolling a long quote can always switch into
        Personalizar (or back) without hunting for the top. Bottom-centred (the
        thumb zone on a phone) and lifted above the home indicator; z-40 sits
        under the transient SaveToast (z-50) so a "Guardando…" confirmation
        still reads over it. */}
    {interactive && (
      <div className={`fixed z-40 flex justify-center px-4 print:hidden pointer-events-none ${gradePricesFor ? 'left-0 right-0 md:left-[var(--rs-sidebar-offset,15rem)] bottom-[calc(3.5rem+max(1rem,env(safe-area-inset-bottom)))]' : 'inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))]'}`}>
        <div className="pointer-events-auto">
          <ModeToggle mode={mode} onChange={setMode} floating />
        </div>
      </div>
    )}
    </>
  );
}

// ── Shared line content ────────────────────────────────────────────────────
// ONE renderer for the actual CONTENT of a priced line. A standalone product, a
// set member, and a component inside a compound ALL go through it, so the name,
// family, specs, swatch, material picker, description and price look identical
// everywhere and change in exactly one place. The product photo and the row
// chrome (group accents, the optional veil, the alternative radio, the "N de M"
// eyebrow, group/compound footers) belong to the wrappers — this owns only the
// inner [text column | price cell] block.

// Family eyebrow + name — the line's identity, rendered the same for a simple
// product, a compound's header, and a sub-component.
function LineIdentity({ family, name }) {
  return (
    <>
      {family && (
        <div className="eyebrow-xs tracking-widest text-ink-500 mb-0.5">{family}</div>
      )}
      <div className="text-base font-semibold text-ink-900 sm:text-sm">{name || '—'}</div>
    </>
  );
}

// The money cell: "n × $unit" (+ struck list price / −Y% when discounted) on the
// left, the bold total — or a "min – max" range — on the right. Mobile: a full
// width footer under a hairline; sm+: a right rail. `priced` is assembled from
// the pricing Model (linePriced / componentPriced) so the numbers can't drift.
function LinePriceCell({ priced, fmt }) {
  const { qty, unit, listUnit, total, listTotal, discount, ranged, range } = priced;
  const discounted = discount > 0;
  return (
    <div className="mt-3 pt-3 border-t border-ink-100 sm:mt-0 sm:pt-0 sm:border-t-0 flex items-end justify-between gap-3 sm:block sm:text-right tabular-nums sm:min-w-[120px] sm:flex-shrink-0">
      {ranged ? (
        <>
          <div className="min-w-0">
            <div className="text-[13px] text-ink-500 whitespace-nowrap">
              {qty} <span className="text-ink-400" aria-hidden>×</span> <span className="text-brand-700">rango</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold text-ink-900 whitespace-nowrap">
              {fmt(range.min)} <span className="text-ink-300" aria-hidden>–</span> {fmt(range.max)}
            </div>
            <div className="text-[10px] text-ink-500 mt-0.5 whitespace-nowrap">sin material</div>
          </div>
        </>
      ) : (
        <>
          <div className="min-w-0">
            <div className="text-[13px] text-ink-500 whitespace-nowrap">
              {qty} <span className="text-ink-400" aria-hidden>×</span> {fmt(unit)}
            </div>
            {discounted && (
              <div className="mt-0.5 whitespace-nowrap">
                <span className="text-[13px] text-ink-400 line-through">{fmt(listUnit)}</span>
                <span className="ml-2 text-[11px] font-semibold text-brand-700">−{discount}%</span>
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold text-ink-900 whitespace-nowrap">{fmt(total)}</div>
            {discounted && qty > 1 && (
              <div className="text-[10px] text-ink-500 mt-0.5 whitespace-nowrap">
                ahorras {fmt(listTotal - total)}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Assemble the price numbers — a standalone/set-member line and a compound's
// component use different pricing primitives but render through one shape.
function linePriced(line) {
  const qty = lineQty(line);
  const listUnit = lineListUnit(line);
  const ranged = isRangeLine(line);
  return {
    qty,
    unit: applyLineAdjustments(lineBasePrice(line), line.lineMarginPct, line.lineDiscountPct),
    listUnit,
    total: lineTotal(line),
    listTotal: listUnit * qty,
    discount: clampPct(line.lineDiscountPct),
    ranged,
    range: ranged ? lineTotalRange(line) : null,
  };
}
function componentPriced(component) {
  const qty = Number(component.qty) || 0;
  const unit = Number(component.unitPrice) || 0;
  const ranged = isRangeComponent(component);
  return {
    qty,
    unit,
    listUnit: unit, // components carry no per-line discount
    total: componentSubtotal(component),
    listTotal: unit * qty,
    discount: 0,
    ranged,
    range: ranged ? componentSubtotalRange(component) : null,
  };
}

// The shared content block: identity + specs + swatch/picker + options + price.
// `mf` is the per-line margin factor the picker grade prices + option-chip
// deltas bake; `canApplyToAll`/`onApplyToAll` are only passed for compound
// components (a standalone line has no siblings to copy a material to).
function LineContent({ entity, mf, priced, families, currency, rates, fmt, hideSwatch, materialSelections, picker, onSelectMaterial, canApplyToAll, onApplyToAll, modelKey }) {
  const gp = picker && (entity.gradePrices || picker.gradePricesFor?.(entity.reference, mf));
  // A standalone swatch shows only when there's NO material-options grid (the
  // grid already leads with this same material) AND we're not collapsing it into
  // a compound's shared "Tapizado" hero (`hideSwatch`) — a uniform compound
  // states the fabric once up top, so the per-piece tile would just repeat it.
  const showSwatch = !hideSwatch
    && !entity.materialOptions?.options?.length
    && !!(entity.swatchImageId || swatchUrl(colorCodeFromSubtype(entity.subtype)));
  // FabricPicker (+ the "apply to all" twin for compound components). z-[2] keeps
  // both controls above any dimming veil so the material stays pickable in every
  // state (an excluded optional, a non-selected alternative).
  const pickerStack = gp ? (
    <div className="relative z-[2] flex flex-col items-start gap-1.5">
      <FabricPicker id={entity.id} subtype={entity.subtype} reference={entity.reference} gradePrices={gp} picker={picker} modelKey={modelKey} className="" />
      {canApplyToAll && onApplyToAll && <ApplyMaterialToAllButton onClick={onApplyToAll} />}
    </div>
  ) : null;
  return (
    <div className="flex-1 min-w-0 sm:flex sm:items-start sm:gap-6">
      <div className="min-w-0 sm:flex-1">
        <LineIdentity family={entity.family} name={entity.name} />
        {((entity.subtype && !hideSwatch) || entity.reference || entity.dimensions) && (
          <div className="min-w-0 mt-1">
            {/* Fabric line — suppressed when the compound hero already names it. */}
            {entity.subtype && !hideSwatch && <div className="text-xs text-ink-500 sm:text-[11px]">{fabricDisplay(entity.subtype)}</div>}
            {(entity.reference || entity.dimensions) && (
              <div className="text-[11px] text-ink-500 sm:text-[10px] mt-0.5 flex flex-wrap gap-x-2">
                {entity.reference && <span className="font-mono">REF. {entity.reference}</span>}
                {entity.dimensions && <span>DIM. {entity.dimensions}</span>}
              </div>
            )}
          </div>
        )}
        {/* Chosen-fabric swatch (with a clear ×) + picker controls, side by side.
            Suppressed when the material-options grid renders — it leads with the
            same material. */}
        {showSwatch && (
          <div className="mt-2 flex items-start gap-3">
            <ClearSwatch id={entity.id} subtype={entity.subtype} swatchImageId={entity.swatchImageId} gradePrices={gp} picker={picker} />
            {pickerStack}
          </div>
        )}
        <MaterialOptionsStrip
          materialOptions={entity.materialOptions}
          reference={entity.reference}
          families={families}
          marginFactor={mf}
          currency={currency}
          rates={rates}
          baseSwatchImageId={entity.swatchImageId}
          selectedGrade={materialSelections?.[entity.id] ?? entity.materialOptions?.baseGrade}
          onSelect={onSelectMaterial ? (g) => onSelectMaterial(entity.id, g) : undefined}
        />
        {/* No standalone swatch (a grid showed instead) → controls render here. */}
        {!showSwatch && pickerStack && <div className="mt-2.5">{pickerStack}</div>}
        {entity.description && (
          <div className="text-[11px] text-ink-600 mt-1.5 max-w-xl whitespace-pre-line">
            {entity.description}
          </div>
        )}
      </div>
      <LinePriceCell priced={priced} fmt={fmt} />
    </div>
  );
}

function ClientLine({ line, quoteMarginPct, currency, rates, fmt, families, groupInfo, setInfo, insideGroupCard, hideSwatch, materialSelections, picker, onSelectMaterial, onToggleOptional, onSelectAlternative }) {
  // A set member may itself be a Compuesto — the group card just nests the
  // compound row cleanly. When the row lives inside a group card the card
  // owns the accent + eyebrow + footer, so the row suppresses its own group
  // border / eyebrow (insideGroupCard) to avoid doubling.
  if (isCompoundLine(line)) {
    return (
      <CompoundClientLine
        line={line}
        quoteMarginPct={quoteMarginPct}
        currency={currency}
        rates={rates}
        fmt={fmt}
        families={families}
        groupInfo={groupInfo}
        setInfo={setInfo}
        insideGroupCard={insideGroupCard}
        materialSelections={materialSelections}
        picker={picker}
        onSelectMaterial={onSelectMaterial}
        onToggleOptional={onToggleOptional}
        onSelectAlternative={onSelectAlternative}
      />
    );
  }
  // The per-line margin factor the picker grade prices + option-chip deltas bake
  // (so the editor preview matches the margin-baked public link; factor 1 on the
  // link, where the margin fields are already zeroed).
  const mf = marginFactor(quoteMarginPct, line.lineMarginPct);
  // Extra product photos beyond the cover — a small zoomable strip under it.
  const extras = Array.isArray(line.extraImageIds) ? line.extraImageIds : [];
  const optional = !!line.isOptional;
  const inGroup = !!line.alternativeGroup;
  const inSet = !!line.setGroup;
  const isSelected = !!line.isSelectedAlternative;
  const dimmed = optional || (inGroup && !isSelected);
  // A dealer-offered optional the client can fold in / out right here with a
  // toggle. Only when interactive (onToggleOptional) and standalone — group
  // members are priced take-all / pick-one, never individually optional.
  const offered = !!onToggleOptional && !!line.optionalOffered && !inGroup && !inSet;
  const included = !optional; // an offered optional currently in the total
  // Inside a group card the card owns the left accent + the full group
  // eyebrow + the footer, so the row drops its own per-row group border /
  // tint / standalone eyebrow to avoid doubling. The optional treatment
  // and the alternative dimming (so the customer sees which option is
  // selected) are preserved either way.
  const showRowGroupChrome = !insideGroupCard;
  // Interactive on the public share link: when onSelectAlternative is provided,
  // each option gets a radio IN PLACE (no selector panel at the top of the
  // page), mirroring the editor's pick-pane. The static flags are suppressed
  // then — the radio already shows which option is the client's choice.
  const selectable = inGroup && !!onSelectAlternative;
  const showSelectedFlag = insideGroupCard && inGroup && isSelected && !selectable;
  return (
    <li className={`px-4 sm:px-5 py-4 border-b border-ink-100 last:border-b-0 ${
      optional ? 'bg-ink-50/30 border-l-2 border-dashed border-ink-300' : ''
    } ${
      showRowGroupChrome && inGroup ? 'border-l-2 border-solid border-brand-300' : ''
    } ${
      // Conjunto member: shared violet left accent + tint, distinct from
      // the alternative's brand accent. Members are NEVER dimmed (every
      // piece is priced / take-all), so no veil here. Suppressed inside a
      // group card (the card draws the violet accent itself).
      showRowGroupChrome && inSet ? 'border-l-2 border-solid border-ink-300 bg-ink-50/30' : ''
    } ${
      dimmed ? 'relative' : ''
    }`}>
      {/* Deactivated (optional) or non-selected alternative: fade the row
          with a white veil. Only the swatch is lifted above it (z-[2]); the
          product photo dims with the rest, matching the editor + PDF. */}
      {dimmed && (
        <div className="pointer-events-none absolute inset-0 z-[1] bg-white/45" aria-hidden />
      )}
      {selectable && (
        <AlternativeRadio line={line} groupInfo={groupInfo} isSelected={isSelected} onSelect={onSelectAlternative} />
      )}
      {((optional && !offered) || (showRowGroupChrome && (inGroup || inSet)) || showSelectedFlag) && (
        <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-widest">
          {/* Read-only surfaces (editor preview / PDF twin) keep the static
              optional caption. The interactive link instead gets the on-card
              action footer below, so this line stays quiet there (offered). */}
          {optional && !offered && (
            <span className="text-ink-500">
              Opcional · no incluido en el total
            </span>
          )}
          {showRowGroupChrome && inGroup && groupInfo && !selectable && (
            <span className="text-brand-700 font-semibold">
              Alternativa {groupInfo.index} de {groupInfo.total}
              {isSelected && <span className="ml-1.5 text-emerald-700 normal-case font-medium">· seleccionada</span>}
            </span>
          )}
          {showRowGroupChrome && inSet && setInfo && (
            <span className="inline-flex items-center gap-1 text-ink-600 font-semibold">
              <Boxes size={11} className="opacity-80" aria-hidden />
              Conjunto {setInfo.index} de {setInfo.total}
            </span>
          )}
          {showSelectedFlag && (
            <span className="text-emerald-700 font-semibold normal-case">
              Seleccionada
            </span>
          )}
        </div>
      )}
      {/* Mobile-first: the photo is a near-full-bleed hero stacked above
          the text (the gesture customers expect on a phone); sm+ promotes
          to a side-by-side card with the photo at a fixed "quarter page"
          scale (w-44 / lg:w-52) so the on-screen preview reads at the same
          physical size as the printed PDF. */}
      <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-5">
        <div className="flex-shrink-0">
          {line.imageId ? (
            <ImageZoom
              id={line.imageId}
              alt={line.name || ''}
              className="w-full h-auto aspect-square max-h-72 sm:w-44 sm:h-44 sm:aspect-auto lg:w-52 lg:h-52 object-contain bg-ink-50 rounded-lg border border-ink-100"
            />
          ) : (
            <div className="w-full h-auto aspect-square max-h-72 sm:w-44 sm:h-44 sm:aspect-auto lg:w-52 lg:h-52 bg-ink-50 rounded-lg border border-ink-100" />
          )}
          {extras.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5 sm:w-44 lg:w-52">
              {extras.map((id) => (
                <ImageZoom
                  key={id}
                  id={id}
                  alt={line.name || ''}
                  className="w-12 h-12 object-cover rounded-md border border-ink-100 bg-ink-50"
                />
              ))}
            </div>
          )}
        </div>
        <LineContent
          entity={line}
          mf={mf}
          priced={linePriced(line)}
          families={families}
          currency={currency}
          rates={rates}
          fmt={fmt}
          hideSwatch={hideSwatch}
          materialSelections={materialSelections}
          picker={picker}
          onSelectMaterial={onSelectMaterial}
        />
      </div>
      {offered && <OptionalAction included={included} onToggle={(on) => onToggleOptional(line.id, on)} />}
    </li>
  );
}

// Inline "pick one" radio for an alternative option on the interactive public
// link — the SAME affordance the editor's pick-pane uses, placed ON the option
// (not in a selector panel at the top of the page). Sits above the dimming veil
// (z-[2]) so a non-selected option stays tappable; selecting re-prices the
// quote optimistically (PublicQuoteView.applyPick).
function AlternativeRadio({ line, groupInfo, isSelected, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(line.alternativeGroup, line.id)}
      aria-pressed={isSelected}
      title={isSelected ? 'Esta es tu elección' : 'Elegir esta opción'}
      className="group/alt relative z-[2] mb-2.5 flex w-full items-center gap-2.5 text-left"
    >
      <span className={`inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
        isSelected ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-300 bg-white group-hover/alt:border-brand-400'
      }`}>
        {isSelected && <Check size={11} strokeWidth={3} aria-hidden />}
      </span>
      <span className="text-[10px] font-semibold uppercase tracking-widest">
        {isSelected
          ? <span className="text-brand-700">Tu elección</span>
          : <span className="text-ink-500 transition-colors group-hover/alt:text-brand-700">Elegir esta opción</span>}
        {groupInfo && <span className="ml-1.5 font-normal normal-case text-ink-400">Opción {groupInfo.index} de {groupInfo.total}</span>}
      </span>
    </button>
  );
}

// Full catalog fabric picker for an upholstered line/component on the
// interactive client link. Renders the shared <MaterialPickerButton> (the same
// icon-only trigger the editor uses) which opens the SAME two-step
// <MaterialColorPicker> the editor uses (fabric → color), so the client link
// and the dealer's in-app preview show one identical picker. The
// catalog + the commit handler arrive via `picker` (the share bundle); the
// per-line `gradePrices` drive both the in-grade restriction and the price each
// fabric shows. On pick we hand back the SAME { grade, fabric, swatchImageId }
// shape the dealer's SwatchPicker produces — the optimistic reducer + the Edge
// Function reprice from it. `z-[2]` lifts the trigger above any dimming veil.
function FabricPicker({ id, subtype, reference, gradePrices, picker, modelKey, className = 'mt-2.5' }) {
  const [open, setOpen] = useState(false);
  // A CatalogFamily-shaped shim so MaterialColorPicker shows the MODEL price (the
  // margin-baked `gradePrices`) per grade — never the material's own per-yard
  // price, which the bundle deliberately withholds.
  const family = useMemo(() => {
    if (!gradePrices) return null;
    const byGrade = new Map();
    for (const [g, price] of Object.entries(gradePrices)) byGrade.set(String(g).toUpperCase(), { priceUsd: price });
    return { root: splitSkuGrade(reference || '').root, name: '', family: '', graded: byGrade.size >= 2, byGrade, grades: [...byGrade.keys()] };
  }, [gradePrices, reference]);
  const gradeFilter = useMemo(() => Object.keys(gradePrices || {}), [gradePrices]);
  // The model-link allowlist key: a COMPOUND governs its components by one link
  // keyed on the parent line id (`modelKey`); a simple line keys on its
  // reference's family root. Mirrors the editor's `modelKey` and the bundle's
  // keying in quote-share — the bundle ships the allowlist under that same key.
  const nameFilter = useMemo(() => {
    const key = modelKey ?? splitSkuGrade(reference || '').root;
    const allow = key ? picker.modelFabrics?.[key] : null;
    return allow?.length ? new Set(allow) : undefined;
  }, [modelKey, reference, picker.modelFabrics]);
  const { grade, fabric } = parseSubtype(subtype);
  return (
    <div className={`relative z-[2] ${className}`}>
      <MaterialPickerButton onClick={() => setOpen(true)} label="Elegir tela" />
      <Modal open={open} onClose={() => setOpen(false)} title="Elegir tela" size="lg">
        {open && (
          <MaterialColorPicker
            materials={picker.materials}
            family={family}
            gradeFilter={gradeFilter}
            nameFilter={nameFilter}
            currentGrade={grade}
            currentFabric={fabric}
            autoDrill
            onPick={(m, c) => {
              picker.onPick(id, {
                grade: m.grade || '',
                fabric: composeFabricLabel(m, c),
                swatchImageId: (c && c.imageId) || null,
              });
              setOpen(false);
            }}
          />
        )}
      </Modal>
    </div>
  );
}

// Can this model collapse back to a price RANGE? Only when it spans ≥2 distinct
// grade prices — otherwise there's no "min–max" to revert to, so the clear ×
// isn't offered. Mirrors the reducers' own range guard.
function rangeable(gradePrices) {
  const vals = Object.values(gradePrices || {}).map(Number).filter((n) => Number.isFinite(n));
  return vals.length >= 2 && Math.max(...vals) > Math.min(...vals);
}

// The chosen-fabric swatch with a hover red × at its top-right corner that
// returns the line/component to "no material" — the model's price range. The ×
// rides the materialPick channel with an EMPTY grade; `applyAction` + the
// quote-share Edge Function both read that as "drop the fabric, restore the
// range". Only offered when the picker is wired AND the model can span a range.
// Chosen-fabric swatch with a hover × to clear it back to "no material" (a price
// range). A single piece clears via picker.onPick; pass `onClear` to clear a
// whole zone at once (the grouped header clears every piece in its run). The
// swatch size is overridable so the compact group header can shrink it.
function ClearSwatch({ id, subtype, swatchImageId, gradePrices, picker, onClear, swatchClassName = 'w-16 h-16' }) {
  const canClear = !!(picker && gradePrices && rangeable(gradePrices) && (onClear || picker.onPick));
  const clear = onClear || (() => picker.onPick(id, { grade: '', fabric: '', swatchImageId: null }));
  return (
    <span className="group/swatch relative z-[2] inline-flex flex-shrink-0">
      <ImageZoom
        id={swatchImageId}
        fallbackUrl={swatchUrl(colorCodeFromSubtype(subtype))}
        alt="Muestra de tela"
        className={`${swatchClassName} object-cover rounded border border-ink-200 bg-white`}
      />
      {canClear && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); clear(); }}
          title="Quitar la tela — volver a cotizar sin material (rango de precio)"
          aria-label="Quitar la tela seleccionada"
          className="absolute -top-2 -right-2 z-10 inline-flex h-5 w-5 items-center justify-center rounded-full border border-red-200 bg-white text-red-500 shadow-sm opacity-0 transition-all hover:scale-110 hover:border-red-300 hover:bg-red-50 hover:text-red-600 group-hover/swatch:opacity-100 focus:opacity-100 coarse:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
        >
          <X size={11} strokeWidth={2.5} aria-hidden />
        </button>
      )}
    </span>
  );
}

// Upholstery hero — ONE swatch + "Tapizado · <fabric>" hoisted above a set of
// pieces that share a fabric, so the swatch isn't stamped on every row below.
// Serves BOTH the uniform compound (every piece, one header) and a single
// material run (the frame pieces, or the cushions) when a compound mixes
// fabrics. Because the rows collapse under it, this header CARRIES the per-row
// edit controls for the whole zone — the clear-× (remove the fabric → range),
// the FabricPicker (re-dress the zone in a new fabric), and "apply to all"
// (push this zone's fabric onto every piece in the compound). All run over
// onPickMany so one action redraws the zone / piece; read-only surfaces (picker
// is null) show a plain swatch + label. `siblings` is the FULL compound for the
// apply-to-all reach; `modelKey` filters the picker's fabrics to the parent
// model. Mirrors the PDF's UpholsteryHero (which is read-only).
function UpholsteryHero({ subtype, swatchImageId, components, siblings, mf, picker, modelKey }) {
  const label = fabricDisplay(subtype);
  // A pick uses the FIRST bearing piece's model for grade prices and dresses
  // every piece in the zone at once (onPickMany).
  const list = components || [];
  const all = siblings || list;
  const lead = list.find((c) => {
    const { grade, fabric } = parseSubtype(c.subtype);
    return !!(grade || fabric);
  }) || list[0];
  const gp = picker && lead && (lead.gradePrices || picker.gradePricesFor?.(lead.reference, mf));
  const canPick = !!(picker?.onPickMany && gp && lead);
  // Clear the WHOLE zone's fabric in one action (every piece in the run → range).
  const clearZone = picker?.onPickMany
    ? () => {
        const map = {};
        for (const c of list) map[c.id] = { grade: '', fabric: '', swatchImageId: null };
        picker.onPickMany(map);
      }
    : undefined;
  // "Apply this zone's fabric to the entire piece" — only when a sibling OUTSIDE
  // the zone still wears a different material (i.e. a mixed compound).
  const canApplyAll = !!(picker?.onPickMany && lead && canPropagateMaterial(lead, all));
  return (
    <div className="mt-2 mb-1 flex items-start gap-3 rounded-lg border border-ink-100 bg-ink-50/50 p-2.5">
      <ClearSwatch
        subtype={subtype}
        swatchImageId={swatchImageId}
        gradePrices={gp}
        picker={picker}
        onClear={clearZone}
        swatchClassName="w-14 h-14"
      />
      <div className="min-w-0 flex-1">
        <div className="eyebrow-xs tracking-widest text-ink-500">Tapizado</div>
        {label && <div className="text-sm font-medium text-ink-800 mt-0.5">{label}</div>}
        {canPick && (
          <div className="mt-1.5">
            <FabricPicker
              id={lead.id}
              subtype={lead.subtype}
              reference={lead.reference}
              gradePrices={gp}
              // The hero shares the compound's single link (keyed on the parent
              // line id), threaded down as `modelKey` — the same key every row in
              // the zone uses.
              modelKey={modelKey}
              // Wrap onPick so a hero pick dresses every piece in the zone at once.
              picker={{ ...picker, onPick: (_id, sel) => {
                const map = {};
                for (const c of list) map[c.id] = sel;
                picker.onPickMany(map);
              } }}
              className=""
            />
          </div>
        )}
        {canApplyAll && (
          <div className="mt-1.5">
            <ApplyMaterialToAllButton onClick={() => applyMaterialToSiblings(lead, all, picker)} />
          </div>
        )}
      </div>
    </div>
  );
}

// Dress every OTHER component in the compound in `source`'s fabric, in ONE
// action. We build a materialPick map (sibling id → the source's chosen
// { grade, fabric, swatchImageId }) and hand it to picker.onPickMany; the
// reducer (and its server twin) iterate the map and reprice each sibling at the
// shared grade from its OWN model's gradePrices — and silently skip any piece
// whose model doesn't offer that grade, so a mixed compound stays safe.
function applyMaterialToSiblings(source, components, picker) {
  if (!picker?.onPickMany || !source) return;
  const { grade, fabric } = parseSubtype(source.subtype);
  const sel = { grade, fabric, swatchImageId: source.swatchImageId ?? null };
  const map = {};
  for (const c of components || []) if (c && c.id !== source.id) map[c.id] = sel;
  if (Object.keys(map).length) picker.onPickMany(map);
}

// Compound line — one family + one image header, then a stacked list of
// component rows underneath. Each row has its own name / ref / dim /
// subtype + its own qty × unit = subtotal. The whole block resolves into
// a single "Total compuesto" amount.
//
// The footer mirrors the article line's compact money cell (struck list
// price + −Y% caption + bold total anchor) so a customer comparing a
// single-item discount to a bundle discount reads the same vocabulary in
// the same position — the shared compact-cell shape is the design system,
// not a one-off composition.
function CompoundClientLine({ line, quoteMarginPct, currency, rates, fmt, families, groupInfo, setInfo, insideGroupCard, materialSelections, picker, onSelectMaterial, onToggleOptional, onSelectAlternative }) {
  // Components inherit the PARENT line's margin factor (the bundle bakes ONE
  // per-line factor into the line AND its components — there is no component-level
  // margin), so resolve it once here and pass it down to every component row.
  const mf = marginFactor(quoteMarginPct, line.lineMarginPct);
  const subtotal = compoundSubtotal(line);
  const grandTotal = lineTotal(line);
  // Material-less components make the whole compound a RANGE — "min – max"
  // instead of a single total, just like a standalone range line.
  const ranged = lineHasRange(line);
  const tr = ranged ? lineTotalRange(line) : null;
  // "Opción N de M" positions for any component-level alternatives.
  const compAltInfo = componentAlternativeGroupInfo(line.components);
  // Uniform upholstery → hoist the shared fabric to ONE "Tapizado" hero at the
  // header and drop every per-piece swatch (they'd just repeat it). Resolved by
  // the Model so screen + PDF agree on when to collapse. This is INDEPENDENT of
  // edit/view mode and of whether pieces are alternatives — a sectional of
  // same-fabric alternative seats still shows one hero, with its radios intact.
  // A MODULAR compound is grouped by MODULE (component product); a uniform fabric
  // is still hoisted to the one "Tapizado" hero above (a sectional all in one
  // fabric), and a module whose own pieces share a fabric collapses under a
  // per-module hero below — so an identical swatch is never stamped on every row.
  // Resolved by the Model (lib/modules + subtype) so screen + paper agree.
  const modular = isModularLine(line);
  const upholstery = compoundFabric(line.components);
  const hideSwatch = upholstery.uniform;
  // Mixed upholstery → group the pieces into contiguous same-material runs and
  // give each a header (frame fabric, then cushion fabric), instead of stamping
  // a swatch on every row. Only fires with 2+ materials; uniform stays the one
  // hero above. Same Model rule the PDF uses, so screen + paper agree.
  const grouping = modular ? { grouped: false, runs: [] } : groupComponentsByMaterial(line.components);
  // Editing (the interactive link / the dealer's edit-mode preview) wires
  // onPickMany. It gates whether a grouped run COLLAPSES: read-only surfaces
  // drop the repeated per-piece swatch under the zone header (clean), but in
  // edit mode the rows stay expanded so each piece keeps its OWN picker + × —
  // the only way to make one piece differ from its zone-mates. The header still
  // carries the zone-level bulk controls (clear zone, re-dress zone, apply-to-all).
  const editing = !!picker?.onPickMany;
  // Extra product photos beyond the cover — a small zoomable strip under it.
  const extras = Array.isArray(line.extraImageIds) ? line.extraImageIds : [];
  // Clamp the displayed discount % the same way the lib does (0–100) so the
  // "−Y%" caption can't show an out-of-range value; the money above already
  // routes through compoundSubtotal / lineTotal.
  const discount = clampPct(line.lineDiscountPct);
  const discounted = discount > 0;
  const optional = !!line.isOptional;
  const inGroup = !!line.alternativeGroup;
  const inSet = !!line.setGroup;
  const isSelected = !!line.isSelectedAlternative;
  const dimmed = optional || (inGroup && !isSelected);
  // Same client-toggleable optional affordance as the simple line.
  const offered = !!onToggleOptional && !!line.optionalOffered && !inGroup && !inSet;
  const included = !optional;
  // Inside a group card the card owns the accent + eyebrow + footer, so a
  // compound member suppresses its own per-row group border / tint /
  // standalone eyebrow to avoid doubling. Optional treatment + alternative
  // dimming are preserved.
  const showRowGroupChrome = !insideGroupCard;
  // Interactive radio on the public link (same as the simple line).
  const selectable = inGroup && !!onSelectAlternative;
  const showSelectedFlag = insideGroupCard && inGroup && isSelected && !selectable;
  // One row, rendered the same whether the compound is flat or grouped — only
  // `hide` (collapse the redundant swatch under a header) and `allowApplyAll`
  // (offer per-row "apply to every sibling") differ between the two layouts.
  const renderComponentRow = (c, i, hide, allowApplyAll) => (
    <CompoundComponentRow
      key={c.id || i}
      component={c}
      marginFactor={mf}
      currency={currency}
      rates={rates}
      fmt={fmt}
      families={families}
      groupInfo={compAltInfo.get(c.id)}
      materialSelections={materialSelections}
      picker={picker}
      hideSwatch={hide}
      onSelectMaterial={onSelectMaterial}
      onToggleOptional={onToggleOptional}
      onSelectAlternative={onSelectAlternative}
      canApplyToAll={allowApplyAll && !!picker?.onPickMany && canPropagateMaterial(c, line.components)}
      onApplyToAll={() => applyMaterialToSiblings(c, line.components, picker)}
      modelKey={line.id}
    />
  );
  return (
    <li className={`px-4 sm:px-5 py-4 border-b border-ink-100 last:border-b-0 ${
      optional ? 'bg-ink-50/30 border-l-2 border-dashed border-ink-300' : ''
    } ${
      showRowGroupChrome && inGroup ? 'border-l-2 border-solid border-brand-300' : ''
    } ${
      // Conjunto member (a set member may itself be a compound article):
      // shared violet left accent + tint, never dimmed. Suppressed inside a
      // group card (the card draws the violet accent itself).
      showRowGroupChrome && inSet ? 'border-l-2 border-solid border-ink-300 bg-ink-50/30' : ''
    } ${
      dimmed ? 'relative' : ''
    }`}>
      {/* Deactivated (optional) or non-selected alternative: fade the row
          with a white veil. Only the swatch is lifted above it (z-[2]); the
          product photo dims with the rest, matching the editor + PDF. */}
      {dimmed && (
        <div className="pointer-events-none absolute inset-0 z-[1] bg-white/45" aria-hidden />
      )}
      {selectable && (
        <AlternativeRadio line={line} groupInfo={groupInfo} isSelected={isSelected} onSelect={onSelectAlternative} />
      )}
      {((optional && !offered) || (showRowGroupChrome && (inGroup || inSet)) || showSelectedFlag) && (
        <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-widest">
          {optional && !offered && (
            <span className="text-ink-500">Opcional · no incluido en el total</span>
          )}
          {showRowGroupChrome && inGroup && groupInfo && !selectable && (
            <span className="text-brand-700 font-semibold">
              Alternativa {groupInfo.index} de {groupInfo.total}
              {isSelected && <span className="ml-1.5 text-emerald-700 normal-case font-medium">· seleccionada</span>}
            </span>
          )}
          {showRowGroupChrome && inSet && setInfo && (
            <span className="inline-flex items-center gap-1 text-ink-600 font-semibold">
              <Boxes size={11} className="opacity-80" aria-hidden />
              Conjunto {setInfo.index} de {setInfo.total}
            </span>
          )}
          {showSelectedFlag && (
            <span className="text-emerald-700 font-semibold normal-case">
              Seleccionada
            </span>
          )}
        </div>
      )}
      <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-5">
        {/* Image column. On mobile it's a near-full-bleed hero stacked
            above the component list — NOT sticky (a pinned hero would
            cover the list as you scroll on a phone). On sm+ it pins to the
            top of the viewport (offset clears the z-30 topbar) and stays
            visible while the customer scrolls a long component list beside
            it; `self-start` confines the sticky box to this row so a short
            list simply sits put — graceful degradation. */}
        <div className="flex-shrink-0 self-start sm:sticky sm:top-20 w-full sm:w-auto">
          {line.imageId ? (
            <ImageZoom
              id={line.imageId}
              alt={line.name || ''}
              className="w-full h-auto aspect-square max-h-72 sm:w-44 sm:h-44 sm:aspect-auto lg:w-52 lg:h-52 object-contain bg-ink-50 rounded-lg border border-ink-100"
            />
          ) : (
            <div className="w-full h-auto aspect-square max-h-72 sm:w-44 sm:h-44 sm:aspect-auto lg:w-52 lg:h-52 bg-ink-50 rounded-lg border border-ink-100" />
          )}
          {extras.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5 sm:w-44 lg:w-52">
              {extras.map((id) => (
                <ImageZoom key={id} id={id} alt={line.name || ''} className="w-12 h-12 object-cover rounded-md border border-ink-100 bg-ink-50" />
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          {/* Mobile sticky identity bar — pins a slim thumbnail + name as the
              client scrolls a LONG component list, so the product they're
              configuring stays on screen without scrolling back up to the hero
              (a full-bleed sticky hero would instead cover the list). sm+ keeps
              the sticky image column + the full LineIdentity below. `top-2` sits
              just under the public link's scroll-container top (that surface has
              no app topbar); it tucks beneath the editor's mobile topbar, which
              is the rarely-used preview-on-phone case. */}
          <div className="sm:hidden sticky top-2 z-[3] -mx-4 mb-2 flex items-center gap-2.5 border-b border-ink-100 bg-white/95 px-4 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-white/80">
            {line.imageId && (
              <ImageView id={line.imageId} alt="" className="h-9 w-9 flex-shrink-0 rounded border border-ink-100 bg-ink-50 object-contain" />
            )}
            <div className="min-w-0">
              {line.family && <div className="eyebrow-xs tracking-widest text-ink-500 leading-none">{line.family}</div>}
              <div className="truncate text-sm font-semibold text-ink-900 leading-tight">{line.name || '—'}</div>
            </div>
          </div>
          <div className="hidden sm:block"><LineIdentity family={line.family} name={line.name} /></div>
          {/* Uniform compound → state the shared fabric ONCE here (swatch +
              "Tapizado · …"), instead of repeating it on every row below. In
              edit mode the hero swatch is itself a whole-compound picker. */}
          {upholstery.uniform && (
            <UpholsteryHero
              subtype={upholstery.subtype}
              swatchImageId={upholstery.swatchImageId}
              components={line.components}
              siblings={line.components}
              mf={mf}
              picker={picker}
              modelKey={line.id}
            />
          )}
          {modular ? (
            // Modular → group by module (component product): each module under
            // its own header with a per-module subtotal; ungrouped elements
            // stand alone. One image for the whole modular, above. A module may
            // itself be OPTIONAL (an opt-in add-on, excluded from the total) or
            // one of a pick-one ALTERNATIVE set — rendered with the SAME dim +
            // caption language a line-level optional / alternative uses, so the
            // whole-module treatment reads consistently with the per-line one.
            // Read-only: the modules show which alternative is chosen; the actual
            // pick happens in the editor / via the share function, not here.
            (() => {
              const modules = modulesOf(line.components);
              const modAltInfo = moduleAlternativeInfo(modules);
              return (
                <div className="mt-2 border-t border-ink-100">
                  {modules.map((m, mi) => {
                    const { optional: modOptional, altGroup, selected } = moduleFlags(m);
                    const inModAlt = !!altGroup;
                    const modDimmed = modOptional || (inModAlt && !selected);
                    const altPos = inModAlt ? modAltInfo.get(m.moduleGroup) : null;
                    // Collapse a module's repeated identical swatch under one
                    // per-module hero — unless the whole compound is already
                    // uniform (the single hero above covers every module). Edit
                    // mode keeps per-row pickers (the hero carries zone controls).
                    const modFabric = upholstery.uniform ? null : compoundFabric(m.components);
                    const hideRow = upholstery.uniform || (!!modFabric?.uniform && !editing);
                    return (
                      <div
                        key={m.moduleGroup || mi}
                        className={`${modDimmed ? 'relative' : ''} ${
                          // Mirror the row accents: dashed-ink for an optional
                          // module, solid-brand for an alternative one.
                          modOptional
                            ? 'border-l-2 border-dashed border-ink-300 pl-2'
                            : inModAlt
                            ? 'border-l-2 border-solid border-brand-300 pl-2'
                            : ''
                        }`}
                      >
                        {/* Same white veil a dimmed row uses — the module reads
                            as present-but-excluded. Captions/headers sit above it. */}
                        {modDimmed && (
                          <div className="pointer-events-none absolute inset-0 z-[1] bg-white/45" aria-hidden />
                        )}
                        {(modOptional || inModAlt) && (
                          <div className="mt-1 flex items-center gap-2 text-[10px] uppercase tracking-widest">
                            {modOptional && (
                              <span className="text-ink-500">Opcional · no incluido</span>
                            )}
                            {inModAlt && (
                              <span className="text-brand-700 font-semibold">
                                Alternativa {altPos?.index ?? '?'} de {altPos?.total ?? '?'}
                                {selected && <span className="ml-1.5 text-emerald-700 normal-case font-medium">· seleccionada</span>}
                              </span>
                            )}
                          </div>
                        )}
                        {m.moduleGroup && (
                          <div className="flex items-baseline justify-between gap-2 pt-2 pb-1">
                            <span className="text-xs font-semibold uppercase tracking-wide text-ink-600">{m.name || '—'}</span>
                            {/* An excluded module (optional / non-selected) adds
                                nothing to the total, so it asserts no price — the
                                same reason an optional line is struck from the sum. */}
                            {!modDimmed && (
                              <span className="text-xs tabular-nums text-ink-500">{fmt(moduleSubtotal(m.components) * mf)}</span>
                            )}
                          </div>
                        )}
                        {modFabric?.uniform && (
                          <UpholsteryHero
                            subtype={modFabric.subtype}
                            swatchImageId={modFabric.swatchImageId}
                            components={m.components}
                            siblings={line.components}
                            mf={mf}
                            picker={picker}
                            modelKey={line.id}
                          />
                        )}
                        <ul className={`divide-y divide-ink-100 ${m.moduleGroup ? 'border-l-2 border-ink-100 pl-2' : ''}`}>
                          {m.components.map((c, i) => renderComponentRow(c, i, hideRow, false))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              );
            })()
          ) : grouping.grouped ? (
            // Mixed compound → a material header per contiguous run. The header
            // carries the zone's bulk controls (clear / re-dress / apply-to-all).
            // Read-only: rows collapse to clean name+price under it. Editing:
            // rows stay expanded with their own swatch + picker + × so a single
            // piece can be re-dressed independently of its zone-mates. Per-row
            // apply-to-all stays off (the header owns that bulk gesture).
            <div className="mt-2 border-t border-ink-100">
              {grouping.runs.map((run, ri) => (
                <div key={run.key + ri}>
                  {run.bearing && (
                    <UpholsteryHero
                      subtype={run.subtype}
                      swatchImageId={run.swatchImageId}
                      components={run.components}
                      siblings={line.components}
                      mf={mf}
                      picker={picker}
                      modelKey={line.id}
                    />
                  )}
                  <ul className="divide-y divide-ink-100">
                    {run.components.map((c, i) => renderComponentRow(c, i, run.bearing && !editing, false))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <ul className="mt-2 divide-y divide-ink-100 border-t border-ink-100">
              {(line.components || []).map((c, i) => renderComponentRow(c, i, hideSwatch, !hideSwatch))}
            </ul>
          )}
          {/* Compound roll-up — a neutral "Total compuesto" caption +
              bold total anchor, matching the redesigned PDF footer. The
              optional struck list price / −Y% sit above when discounted. */}
          <div className="mt-3 pt-2 border-t border-ink-100 tabular-nums">
            <div className="ml-auto w-fit text-right">
              {discounted && !ranged && (
                <div className="whitespace-nowrap">
                  <span className="text-[13px] text-ink-400 line-through">{fmt(subtotal)}</span>
                  <span className="ml-2 text-[11px] font-semibold text-brand-700">−{discount}%</span>
                </div>
              )}
              <div className="eyebrow-xs tracking-wide text-ink-500 whitespace-nowrap mt-0.5">
                Total compuesto
              </div>
              <div className="text-lg font-semibold text-ink-900 whitespace-nowrap">
                {ranged
                  ? <>{fmt(tr.min)} <span className="text-ink-300" aria-hidden>–</span> {fmt(tr.max)}</>
                  : fmt(grandTotal)}
              </div>
              {ranged ? (
                <div className="text-[10px] text-ink-500 mt-0.5 whitespace-nowrap">sin material</div>
              ) : discounted && (
                <div className="text-[10px] text-ink-500 mt-0.5 whitespace-nowrap">
                  ahorras {fmt(subtotal - grandTotal)}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {offered && <OptionalAction included={included} onToggle={(on) => onToggleOptional(line.id, on)} />}
    </li>
  );
}

function CompoundComponentRow({ component, marginFactor: mf, currency, rates, fmt, families, groupInfo, materialSelections, picker, hideSwatch, onSelectMaterial, onToggleOptional, onSelectAlternative, canApplyToAll, onApplyToAll, modelKey }) {
  const optional = !!component.isOptional;
  // Component-level alternative (pick-one). The interactive link gives each
  // option a radio; read-only surfaces flag the chosen one and dim the rest.
  const inGroup = !!component.alternativeGroup;
  const isSelected = !!component.isSelectedAlternative;
  const selectable = inGroup && !!onSelectAlternative;
  const dimmed = inGroup && !isSelected;
  // A dealer-offered optional sub-piece the client can fold in / out right here
  // — the SAME add/remove affordance as a standalone optional line, one level
  // down. Only on the interactive link (onToggleOptional present).
  const offered = !!onToggleOptional && !!component.optionalOffered;
  const included = !optional;
  // Static optional / alternative caption — suppressed when the inline radio
  // (selectable) or the on-row add/remove action (offered) already conveys it.
  const showCaption = (optional && !offered) || (inGroup && !selectable);
  return (
    <li className={`py-2 ${
      optional ? 'relative pl-3 border-l-2 border-dashed border-ink-300' : ''
    } ${
      inGroup ? 'relative pl-3 border-l-2 border-solid border-brand-300' : ''
    }`}>
      {/* Optional OR non-selected alternative: dim with a white veil; the radio
          + swatch carry their own z-[2] so they stay clickable / vivid. */}
      {(optional || dimmed) && (
        <div className="pointer-events-none absolute inset-0 z-[1] bg-white/45" aria-hidden />
      )}
      {selectable && (
        <AlternativeRadio line={component} groupInfo={groupInfo} isSelected={isSelected} onSelect={onSelectAlternative} />
      )}
      {showCaption && (
        <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-widest">
          {optional && !offered && (
            <span className="text-ink-500">Opcional · no incluido</span>
          )}
          {inGroup && !selectable && (
            <span className="text-brand-700 font-semibold">
              Alternativa {groupInfo?.index ?? '?'} de {groupInfo?.total ?? '?'}
              {isSelected && <span className="ml-1.5 text-emerald-700 normal-case font-medium">· elegida</span>}
            </span>
          )}
        </div>
      )}
      <LineContent
        entity={component}
        mf={mf}
        priced={componentPriced(component)}
        families={families}
        currency={currency}
        rates={rates}
        fmt={fmt}
        hideSwatch={hideSwatch}
        materialSelections={materialSelections}
        picker={picker}
        onSelectMaterial={onSelectMaterial}
        canApplyToAll={canApplyToAll}
        onApplyToAll={onApplyToAll}
        modelKey={modelKey}
      />
      {offered && <OptionalAction included={included} onToggle={(on) => onToggleOptional(component.id, on)} />}
    </li>
  );
}

// Conjunto member list — the rows inside a set's group card. A Conjunto often
// gathers several full PRODUCT lines that wear the SAME fabric (e.g. a sofa +
// loveseat + armchair all in one CRAQUELIN), which would otherwise stamp the
// identical swatch on every member's row. So this collapses a contiguous run of
// 2+ same-material members the way a compound collapses its pieces: ONE shared
// "Tapizado · <fabric>" header (the read-only UpholsteryHero — picker withheld,
// since set members are independent lines, not components in one onPickMany
// map) above a clean name/price list, with each member's own swatch hidden.
//
// The partition reuses groupComponentsByMaterial (members carry subtype +
// swatchImageId, so the helper works on them as-is) for the mixed case, plus
// compoundFabric for the all-uniform case — exactly the two Model rules a mixed
// vs. uniform compound uses, so a set and a compound collapse identically. Any
// run of a single member, a non-bearing member (a glass top), or a member that
// is itself a Compuesto (its fabric lives on its own components) renders exactly
// as before — only redundant 2+ runs collapse. Selection/optional dimming + the
// "Conjunto N de M" eyebrow stay on each member row regardless.
function SetMemberList({ members, quoteMarginPct, currency, rates, fmt, families, groupInfo, setInfo, materialSelections, picker, onSelectMaterial, onToggleOptional, onSelectAlternative }) {
  // One member row, rendered identically whether or not its run collapsed —
  // only `hideSwatch` (drop the per-row swatch the shared header now carries)
  // differs. The member keeps its own setInfo eyebrow, alternative radio, etc.
  const row = (l, hideSwatch) => (
    <ClientLine
      key={l.id}
      line={l}
      quoteMarginPct={quoteMarginPct}
      currency={currency}
      rates={rates}
      fmt={fmt}
      families={families}
      groupInfo={groupInfo.get(l.id)}
      setInfo={setInfo.get(l.id)}
      insideGroupCard
      hideSwatch={hideSwatch}
      materialSelections={materialSelections}
      picker={picker}
      onSelectMaterial={onSelectMaterial}
      onToggleOptional={onToggleOptional}
      onSelectAlternative={onSelectAlternative}
    />
  );
  // ONE shared, read-only material header for a collapsed run — wrapped in an
  // <li> so it sits naturally in the card's member <ul> alongside the rows.
  const header = (subtype, swatchImageId, key) => (
    <li key={`tap-${key}`} className="px-4 sm:px-5 pt-3 list-none">
      <UpholsteryHero subtype={subtype} swatchImageId={swatchImageId} picker={null} />
    </li>
  );

  // Uniform run (every bearing member shares one fabric) → a single hero, the
  // compound's uniform case. compoundFabric ignores non-bearing members, so a
  // set mixing upholstered seats with a glass side table still collapses.
  const uniform = compoundFabric(members);
  if (uniform.uniform && members.length >= 2) {
    return (
      <>
        {header(uniform.subtype, uniform.swatchImageId, 'all')}
        {members.map((l) => row(l, true))}
      </>
    );
  }

  // Mixed → per-run headers. groupComponentsByMaterial only reports grouped
  // when 2+ DISTINCT materials are present; otherwise we fall straight through
  // to the flat list (rendered exactly as before).
  const grouping = groupComponentsByMaterial(members);
  if (grouping.grouped) {
    return (
      <>
        {grouping.runs.map((run, ri) => {
          // Collapse only a run of 2+ matching, fabric-bearing members; a lone
          // member (or a non-bearing run) renders with its own swatch as today.
          const collapse = run.bearing && run.components.length >= 2;
          return (
            <Fragment key={run.key + ri}>
              {collapse && header(run.subtype, run.swatchImageId, run.key + ri)}
              {run.components.map((l) => row(l, collapse))}
            </Fragment>
          );
        })}
      </>
    );
  }

  // Single material (or none) and/or fewer than 2 members → render as today.
  return <>{members.map((l) => row(l, false))}</>;
}

// Container card wrapping a contiguous group run (Conjunto or Alternativa)
// on the customer-facing preview. Mirrors the editor's LineItemList
// GroupCard visual language — a bordered card with a header eyebrow on
// top, the member rows inside, and one footer total at the bottom — with
// the read-only customer treatment (no radios; the selected alternative is
// flagged inside its own row, non-selected members stay dimmed by their
// own row markup). The accent color distinguishes a set (violet) from an
// alternative (brand). The card owns the border + footer so the member
// rows inside don't re-draw their own group accent/eyebrow.
//
//   - Conjunto: violet accent, header "Conjunto", footer
//     "Total del conjunto" = setSubtotal (sum of ALL members — take-all).
//   - Alternativa: brand accent, header "Alternativas — elige una", footer
//     "Total" = alternativeSubtotal (only the SELECTED option is billed).
//
// The footers are presentational roll-ups: set members are each already
// priced into the grand total, and only the selected alternative is — the
// card footer never re-feeds those numbers.
function ClientGroupCard({ type, memberCount, optional, footerLabel, footerValue, children }) {
  const isSet = type === 'set';
  // Tailwind needs literal class names — branch rather than interpolate.
  const ring = isSet ? 'border-ink-300' : 'border-brand-300';
  const headBg = isSet ? 'bg-ink-50' : 'bg-brand-50/50';
  const footBg = isSet ? 'bg-ink-50/70' : 'bg-brand-50/40';
  const eyebrowColor = isSet ? 'text-ink-600' : 'text-brand-700';
  const Icon = isSet ? Boxes : GitFork;
  const eyebrow = isSet
    ? (optional ? 'Conjunto opcional' : 'Conjunto')
    : 'Alternativas — elige una';
  return (
    // Inset card so the surrounding list rows don't bleed into it. Rendered
    // as a list item so it sits naturally in the <ul> alongside flat rows.
    <li className="px-3 sm:px-2 py-3 list-none">
      <div className={`rounded-xl border-2 ${ring} overflow-hidden bg-white ${optional ? 'border-dashed' : ''}`}>
        <div className={`${headBg} px-4 py-2 flex items-center justify-between gap-2`}>
          <span className={`inline-flex items-center gap-1.5 eyebrow font-semibold tracking-[0.06em] ${eyebrowColor}`}>
            <Icon size={13} className="opacity-80" aria-hidden />
            {eyebrow}
          </span>
          <span className="eyebrow-xs font-medium tracking-wide text-ink-400 tabular-nums">
            {memberCount} {isSet ? 'piezas' : 'opciones'}
          </span>
        </div>
        <ul>{children}</ul>
        <div className={`${footBg} border-t-2 ${ring} px-4 py-2.5 flex items-center justify-between gap-2`}>
          <span className={`inline-flex items-center gap-1.5 eyebrow font-semibold tracking-[0.06em] ${eyebrowColor}`}>
            <Icon size={12} className="opacity-80" aria-hidden />
            {footerLabel}
            {optional && <span className="normal-case font-normal text-ink-400">· no incluido en el total</span>}
          </span>
          <span className="text-sm font-semibold text-ink-900 tabular-nums">
            {footerValue}
          </span>
        </div>
      </div>
    </li>
  );
}

// On-card action row for a dealer-offered optional the client can fold in or
// out. It sits at the FOOT of the product card — beside the product it acts
// on, not in a panel divorced at the top — and speaks the app's own button
// vocabulary (a brand CTA to add, a quiet bordered button to remove) rather
// than a foreign switch. The dashed top hairline rhymes with the dashed left
// border the excluded-optional card already wears.
//
// `relative z-[2]` lifts it above the card's dimming veil, so the "Agregar"
// CTA stays lit and tappable even while the rest of the (excluded) card is
// washed out — the one clear next step on an otherwise quiet card.
function OptionalAction({ included, onToggle }) {
  return (
    <div className="relative z-[2] mt-3 pt-3 border-t border-dashed border-ink-200 flex items-center justify-between gap-3">
      {included ? (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
          <Check size={14} className="flex-shrink-0" aria-hidden />
          Incluido en tu cotización
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-xs text-ink-500">
          <Sparkles size={13} className="flex-shrink-0 opacity-80" aria-hidden />
          Complemento opcional
        </span>
      )}
      {included ? (
        <button
          type="button"
          onClick={() => onToggle(false)}
          className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 bg-white px-2.5 py-1.5 min-h-8 coarse:min-h-10 text-xs font-medium text-ink-600 transition-colors hover:bg-ink-50 hover:text-ink-900 hover:border-ink-300 active:bg-ink-100 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
        >
          <X size={13} aria-hidden /> Quitar
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onToggle(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 px-3 py-1.5 min-h-8 coarse:min-h-10 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-brand-600 active:bg-brand-700 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
        >
          <Plus size={14} aria-hidden /> Agregar
        </button>
      )}
    </div>
  );
}

// Supporting sub-total row above the grand-total band. The grand total
// itself lives in the dark band, so this only renders the muted / accent
// (Descuento) supporting cast — no bold variant any more.
function TotalRow({ label, value, muted, accent }) {
  const tone = accent
    ? 'text-brand-700 font-medium'
    : muted
    ? 'text-ink-500'
    : '';
  return (
    <div className={`flex justify-between text-sm ${tone}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

