import { useMemo } from 'react';
import { Boxes, GitFork, ChevronDown, Plus, X, Check, Sparkles, Truck } from 'lucide-react';
import ImageView from '../ImageView.jsx';
import ImageZoom from './ImageZoom.jsx';
import MaterialOptionsStrip from './MaterialOptionsStrip.jsx';
import {
  ITBIS_PCT, isCompoundLine, componentSubtotal, compoundSubtotal, lineTotal,
  lineQty, lineBasePrice, lineListUnit, applyLineAdjustments, clampPct,
  isRangeLine, lineTotalRange,
  isRangeComponent, componentSubtotalRange, lineHasRange, componentAlternativeGroupInfo,
} from '../../lib/pricing.js';
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

export default function ClientPreview({ quote, settings, lines, quoteGroups, totals, customer, professional, seller, families, materialSelections, onSelectMaterial, onToggleOptional, onSelectAlternative }) {
  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
  const dopRate = rates.DOP || null;
  const fmt = (v) => formatMoney(v, currency, rates);
  // Interactive (the public share link wires onSelect* handlers) vs. read-only
  // (the dealer's in-editor "Vista cliente"). Drives the banner copy so the
  // recipient knows they can configure the quote right here.
  const interactive = !!(onSelectMaterial || onSelectAlternative || onToggleOptional);

  // ViewModel — the SHARED content tree (sections → group-runs with footer
  // data, savings, the grand-total range, the "Alternativa/Conjunto N de M"
  // position maps). Computed by the quote Model (core/quote/views/quoteView);
  // the PDF renders the same tree. This view derives nothing itself.
  const view = useMemo(
    () => resolveQuoteView({ quote, lines, settings, quoteGroups }),
    [quote, lines, settings, quoteGroups],
  );
  const { savings, totalsRange, hasRange, groupInfo, setInfo, sections } = view;
  // id → line, for resolving a run's `lineIds` back to its line objects.
  const byId = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);

  // overflow-clip (not -hidden) so the rounded corners still clip the
  // full-bleed banner WITHOUT establishing a scroll container — an
  // overflow:hidden ancestor would trap the sticky product image in
  // CompoundClientLine and stop it following the page scroll.
  return (
    <div className="bg-white border border-ink-100 rounded-xl shadow-soft overflow-clip">
      {/* Banner so the dealer knows this is a preview, not the live editor */}
      <div className="bg-ink-900 text-ink-50 px-5 py-2 text-[11px] flex items-center justify-between">
        <span>{interactive ? 'Personaliza tu cotización · elige opciones y telas' : 'Vista previa del cliente · de solo lectura'}</span>
        <span className="opacity-60">{formatDate(quote.updatedAt)}</span>
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
            <div className="text-xl font-semibold text-ink-900">{settings?.companyName || 'Tu empresa'}</div>
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
                        currency={currency}
                        rates={rates}
                        fmt={fmt}
                        families={families}
                        groupInfo={groupInfo.get(l.id)}
                        setInfo={undefined}
                        insideGroupCard={false}
                        materialSelections={materialSelections}
                        onSelectMaterial={onSelectMaterial}
                        onToggleOptional={onToggleOptional}
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
                      {members.map((l) => (
                        <ClientLine
                          key={l.id}
                          line={l}
                          currency={currency}
                          rates={rates}
                          fmt={fmt}
                          families={families}
                          groupInfo={groupInfo.get(l.id)}
                          setInfo={isSet ? setInfo.get(l.id) : undefined}
                          insideGroupCard
                          materialSelections={materialSelections}
                          onSelectMaterial={onSelectMaterial}
                          onToggleOptional={onToggleOptional}
                          onSelectAlternative={onSelectAlternative}
                        />
                      ))}
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
          (Descuento in brand); the savings line + FX shadow sit below the
          band. Mirrors the redesigned PDF. */}
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
          {savings > 0 && (
            <div className="mt-2 text-right text-xs font-medium text-brand-700">
              Ahorras {fmt(savings)} en esta cotización
            </div>
          )}
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
  );
}

function ClientLine({ line, currency, rates, fmt, families, groupInfo, setInfo, insideGroupCard, materialSelections, onSelectMaterial, onToggleOptional, onSelectAlternative }) {
  // A set member may itself be a Compuesto — the group card just nests the
  // compound row cleanly. When the row lives inside a group card the card
  // owns the accent + eyebrow + footer, so the row suppresses its own group
  // border / eyebrow (insideGroupCard) to avoid doubling.
  if (isCompoundLine(line)) {
    return (
      <CompoundClientLine
        line={line}
        currency={currency}
        rates={rates}
        fmt={fmt}
        families={families}
        groupInfo={groupInfo}
        setInfo={setInfo}
        insideGroupCard={insideGroupCard}
        materialSelections={materialSelections}
        onSelectMaterial={onSelectMaterial}
        onToggleOptional={onToggleOptional}
        onSelectAlternative={onSelectAlternative}
      />
    );
  }
  // All line math routes through lib/pricing so the customer preview can
  // never diverge from the editor / PDF / totals — and so the line-discount
  // clamp (0–100) is applied here too (a stray out-of-range pct can't invert
  // or balloon the unit price). listUnit = post-margin, pre-discount: the
  // catalogue price the customer would have paid without the discount, so the
  // strike-through reflects what they're saving against, not the cost basis.
  const qty = lineQty(line);
  const listUnit = lineListUnit(line);
  const unit = applyLineAdjustments(lineBasePrice(line), line.lineMarginPct, line.lineDiscountPct);
  const listTotal = listUnit * qty;
  const total = lineTotal(line);
  const discount = clampPct(line.lineDiscountPct);
  const discounted = discount > 0;
  // Material-less line — show its price RANGE instead of a single total.
  const ranged = isRangeLine(line);
  const totalR = ranged ? lineTotalRange(line) : null;
  // Extra product photos beyond the cover — a small zoomable strip under it.
  const extras = Array.isArray(line.extraImageIds) ? line.extraImageIds : [];
  // Layout shape, mobile-first:
  //
  //   row 1   image + text side-by-side
  //   row 2   compact label/value strip at the card bottom — three
  //           pairs (CANTIDAD / UNITARIO / TOTAL) rendered as a
  //           horizontal flex with a top hairline so it reads as a
  //           summary footer, not a leftover wrapped column.
  //
  // On sm+ the strip promotes back to a vertical column in a third
  // grid column to the right of the text — same vocabulary, denser.
  //
  // The previous full-width col-span-2 wrap was technically right-
  // aligned but left a tall dead zone next to it on mobile because
  // each label/value pair sat on its own row. A horizontal strip
  // uses the width that's already there instead of stacking
  // vertically into the void.
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
        <div className="flex-1 min-w-0 sm:flex sm:items-start sm:gap-6">
          <div className="min-w-0 sm:flex-1">
            {line.family && (
              <div className="eyebrow-xs tracking-widest text-ink-500 mb-0.5">
                {line.family}
              </div>
            )}
            <div className="text-base font-semibold text-ink-900 sm:text-sm">{line.name || '—'}</div>
            {(line.subtype || line.reference || line.dimensions) && (
              <div className="min-w-0 mt-1">
                {line.subtype && <div className="text-xs text-ink-500 sm:text-[11px]">{line.subtype}</div>}
                {(line.reference || line.dimensions) && (
                  <div className="text-[11px] text-ink-500 sm:text-[10px] mt-0.5 flex flex-wrap gap-x-2">
                    {line.reference && <span className="font-mono">REF. {line.reference}</span>}
                    {line.dimensions && <span>DIM. {line.dimensions}</span>}
                  </div>
                )}
              </div>
            )}
            {/* Fabric swatch — shown only when there are NO material options.
                When the options grid renders it already leads with this same
                (selected) material as its "incluido" cell, so a separate hero
                swatch would just repeat it. */}
            {!line.materialOptions?.options?.length && (line.swatchImageId || swatchUrl(colorCodeFromSubtype(line.subtype))) && (
              <div className="mt-2">
                <ImageZoom
                  id={line.swatchImageId}
                  fallbackUrl={swatchUrl(colorCodeFromSubtype(line.subtype))}
                  alt="Muestra de tela"
                  className="relative z-[2] w-16 h-16 object-cover rounded border border-ink-200 bg-white"
                />
              </div>
            )}
            <MaterialOptionsStrip
              materialOptions={line.materialOptions}
              reference={line.reference}
              families={families}
              currency={currency}
              rates={rates}
              baseSwatchImageId={line.swatchImageId}
              selectedGrade={materialSelections?.[line.id] ?? line.materialOptions?.baseGrade}
              onSelect={onSelectMaterial ? (g) => onSelectMaterial(line.id, g) : undefined}
            />
            {line.description && (
              <div className="text-[11px] text-ink-600 mt-1.5 max-w-xl whitespace-pre-line">
                {line.description}
              </div>
            )}
          </div>

          {/* Price strip — on mobile it anchors the full card width
              (flex items-end justify-between: "n × $unit" on the left, the
              bold TOTAL on the right under a hairline); on sm+ it promotes
              to a right rail (sm:block sm:text-right). The struck list /
              −Y% discount pair + per-line savings ride along when present. */}
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
                    {fmt(totalR.min)} <span className="text-ink-300" aria-hidden>–</span> {fmt(totalR.max)}
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
                  <div className="text-lg font-semibold text-ink-900 whitespace-nowrap">
                    {fmt(total)}
                  </div>
                  {discounted && qty > 1 && (
                    <div className="text-[10px] text-ink-500 mt-0.5 whitespace-nowrap">
                      ahorras {fmt(listTotal - total)}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
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
function CompoundClientLine({ line, currency, rates, fmt, families, groupInfo, setInfo, insideGroupCard, materialSelections, onSelectMaterial, onToggleOptional, onSelectAlternative }) {
  const subtotal = compoundSubtotal(line);
  const grandTotal = lineTotal(line);
  // Material-less components make the whole compound a RANGE — "min – max"
  // instead of a single total, just like a standalone range line.
  const ranged = lineHasRange(line);
  const tr = ranged ? lineTotalRange(line) : null;
  // "Opción N de M" positions for any component-level alternatives.
  const compAltInfo = componentAlternativeGroupInfo(line.components);
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
          {line.family && (
            <div className="eyebrow-xs tracking-widest text-brand-700 mb-0.5">
              {line.family}
            </div>
          )}
          {line.name && (
            <div className="text-base font-semibold text-ink-900 sm:text-sm">{line.name}</div>
          )}
          <ul className="mt-2 divide-y divide-ink-100 border-t border-ink-100">
            {(line.components || []).map((c, i) => (
              <CompoundComponentRow
                key={c.id || i}
                component={c}
                currency={currency}
                rates={rates}
                fmt={fmt}
                families={families}
                groupInfo={compAltInfo.get(c.id)}
                materialSelections={materialSelections}
                onSelectMaterial={onSelectMaterial}
                onToggleOptional={onToggleOptional}
                onSelectAlternative={onSelectAlternative}
              />
            ))}
          </ul>
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

function CompoundComponentRow({ component, currency, rates, fmt, families, groupInfo, materialSelections, onSelectMaterial, onToggleOptional, onSelectAlternative }) {
  const qty = Number(component.qty) || 0;
  const unit = Number(component.unitPrice) || 0;
  const subtotal = componentSubtotal(component);
  const optional = !!component.isOptional;
  // Material-less sub-piece — show its price RANGE instead of qty × unit,
  // mirroring a standalone range line.
  const ranged = isRangeComponent(component);
  const cr = ranged ? componentSubtotalRange(component) : null;
  // Component-level alternative (pick-one). The interactive link gives each
  // option a radio; read-only surfaces flag the chosen one and dim the rest.
  const inGroup = !!component.alternativeGroup;
  const isSelected = !!component.isSelectedAlternative;
  const selectable = inGroup && !!onSelectAlternative;
  const dimmed = inGroup && !isSelected;
  // A dealer-offered optional sub-piece the client can fold in / out right
  // here — the SAME add/remove affordance as a standalone optional line, one
  // level down. Only on the interactive link (onToggleOptional present).
  const offered = !!onToggleOptional && !!component.optionalOffered;
  const included = !optional;
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
      <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-x-4">
        <div className="min-w-0 sm:flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-medium text-ink-900">{component.name || '—'}</span>
            {/* Read-only surfaces keep the static caption; the interactive link
                shows the on-row add/remove action below instead (offered). */}
            {optional && !offered && (
              <span className="eyebrow-xs font-normal tracking-widest">
                Opcional · no incluido
              </span>
            )}
            {/* Read-only alternative flag + position. */}
            {inGroup && !selectable && (
              <span className="eyebrow-xs font-semibold tracking-widest text-brand-700">
                Alternativa {groupInfo?.index ?? '?'} de {groupInfo?.total ?? '?'}
                {isSelected && <span className="ml-1.5 text-emerald-700 normal-case font-medium">· elegida</span>}
              </span>
            )}
          </div>
          {(component.subtype || component.reference || component.dimensions) && (
            <div className="min-w-0 mt-0.5">
              {component.subtype && <div className="text-[11px] text-ink-500">{component.subtype}</div>}
              {(component.reference || component.dimensions) && (
                <div className="text-[10px] text-ink-500 mt-0.5 flex flex-wrap gap-x-2">
                  {component.reference && <span className="font-mono">REF. {component.reference}</span>}
                  {component.dimensions && <span>DIM. {component.dimensions}</span>}
                </div>
              )}
            </div>
          )}
          {/* Fabric swatch — suppressed when the material-options grid renders
              (it already leads with this same material), mirroring the
              standalone line. */}
          {!component.materialOptions?.options?.length && (component.swatchImageId || swatchUrl(colorCodeFromSubtype(component.subtype))) && (
            <div className="mt-2">
              <ImageZoom
                id={component.swatchImageId}
                fallbackUrl={swatchUrl(colorCodeFromSubtype(component.subtype))}
                alt="Muestra de tela"
                className="relative z-[2] w-16 h-16 object-cover rounded border border-ink-200 bg-white"
              />
            </div>
          )}
          <MaterialOptionsStrip
            materialOptions={component.materialOptions}
            reference={component.reference}
            families={families}
            currency={currency}
            rates={rates}
            baseSwatchImageId={component.swatchImageId}
            selectedGrade={materialSelections?.[component.id] ?? component.materialOptions?.baseGrade}
            onSelect={onSelectMaterial ? (g) => onSelectMaterial(component.id, g) : undefined}
          />
          {component.description && (
            <div className="text-[11px] text-ink-600 mt-1 max-w-xl whitespace-pre-line">
              {component.description}
            </div>
          )}
        </div>
        <div className={`text-right tabular-nums whitespace-nowrap text-xs sm:text-sm ${
          optional ? 'text-ink-500' : ''
        }`}>
          {ranged ? (
            <>
              <span className={optional ? 'text-ink-500 font-medium' : 'text-ink-900 font-semibold'}>
                {fmt(cr.min)} <span className="text-ink-300" aria-hidden>–</span> {fmt(cr.max)}
              </span>
              <span className="block text-[10px] text-ink-500 mt-0.5">sin material</span>
            </>
          ) : (
            <>
              <span className="text-ink-700">{qty}</span>
              <span className="text-ink-400 mx-1.5" aria-hidden>×</span>
              <span className="text-ink-700">{fmt(unit)}</span>
              <span className="text-ink-400 mx-1.5" aria-hidden>=</span>
              <span className={optional ? 'text-ink-500 font-medium' : 'text-ink-900 font-semibold'}>
                {optional ? `+ ${fmt(subtotal)}` : fmt(subtotal)}
              </span>
            </>
          )}
        </div>
      </div>
      {offered && <OptionalAction included={included} onToggle={(on) => onToggleOptional(component.id, on)} />}
    </li>
  );
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

