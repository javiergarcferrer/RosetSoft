import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Trash2, ChevronDown, GripVertical, Copy, Tag, Layers, Plus, X, Palette, Check, Sparkles, GitFork, Boxes, MessageSquarePlus } from 'lucide-react';
import Thumbnail from '../primitives/Thumbnail.jsx';
import HeroInput from '../primitives/HeroInput.jsx';
import InlineEditor from '../primitives/InlineEditor.jsx';
import MoneyInput from '../primitives/MoneyInput.jsx';
import Select from '../primitives/Select.jsx';
import { DebouncedInput, DebouncedTextarea } from '../DebouncedInput.jsx';
import LineBreakdownPopover from './LineBreakdownPopover.jsx';
import FamilyPicker from './FamilyPicker.jsx';
import SwatchPicker from './SwatchPicker.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { rememberSwatchInCatalog } from '../../lib/swatchCatalog.js';
import { colorCodeFromSubtype } from '../../lib/swatchMatch.js';
import { swatchUrl } from '../../lib/swatchImage.js';
import {
  applyLineAdjustments, materialOptionDeltas,
  isCompoundLine, componentSubtotal, compoundSubtotal, lineTotal,
} from '../../lib/pricing.js';
import { splitSkuGrade } from '../../lib/catalog.js';
import { formatMoney } from '../../lib/format.js';
import { parseSubtype, composeSubtype, GRADE_GROUPS, SPECIAL_GRADES, LEGACY_NAMED_GRADES } from '../../lib/subtype.js';
import { newId } from '../../db/database.js';

/**
 * Catalog families keyed by SKU root, provided by QuoteBuilder. Used to
 * resolve a line's family (via splitSkuGrade(reference).root) for the
 * material-options price deltas. Passed via context because the intermediate
 * LineItemList doesn't forward per-line catalog data. Defaults to an empty
 * Map so the component renders fine outside a provider (tests, previews).
 */
export const FamiliesContext = createContext(new Map());

/**
 * One quote line — a product card read top→bottom:
 *
 *   1. Top strip      drag handle + family chip + READ-ONLY status badges
 *                     (Compuesto / Opcional / Conjunto N/M / Alternativa N/M)
 *   2. Identity band  thumbnail + name + grade/fabric chooser + spec strip
 *                     + an always-visible "Descripción" (visible in the PDF)
 *                     + an optional "Nota interna" (collapsed when empty)
 *   3. Calculator     qty × unit = total, on a tinted inset surface
 *   4. Footer         the per-line ACTION row — Compuesto, + Alternativa,
 *                     Opcional, Duplicar, Separar, Eliminar. The old "⋯"
 *                     overflow menu + "más detalles" disclosure are gone;
 *                     every action lives in the open on the card.
 *
 * Same anatomy on every viewport. On phones the bands stack vertically;
 * from sm up the identity and calculator bands sit side-by-side with the
 * calculator right-aligned. Layout is explicit at every breakpoint — no
 * flex-wrap fallback that drifts the money tower below the name.
 *
 * The grade + fabric pair is promoted from the legacy "Subtype" free-text
 * field via lib/subtype.js (parse on read, compose on write — no DB
 * migration). Grade is a native <Select> so iOS / Android use their built-
 * in picker UI; fabric is an inline editor next to it.
 *
 * Yardage, line-level margin AND the per-line discount input are
 * intentionally absent from the editor. Old quotes that carry
 * `lineMarginPct` / `lineDiscountPct` in the DB still calculate correctly
 * (pricing.js respects the value, and the read-only AdjustmentChip surfaces
 * it on the total), but new lines never set them and the UI never lets you
 * edit them.
 *
 * autoFocus targets the REF input — the dealer's primary entry point when
 * reading from a paper price list.
 */
export default function QuoteLineItem({
  line, quote, onChange, onRemove, onDuplicate,
  onToggleOptional, onAddAlternative, onSelectAlternative,
  onSeparateFromSet, onUngroup, insideGroupCard,
  groupInfo, setInfo,
  autoFocus, dragHandleProps,
}) {
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const refInput = useRef(null);

  useEffect(() => {
    if (autoFocus && refInput.current) {
      refInput.current.focus();
      refInput.current.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
  }, [autoFocus]);

  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
  const compound = isCompoundLine(line);
  const unit = applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
  const rowTotal = compound ? lineTotal(line) : unit * (line.qty || 0);
  const fmt = (v) => formatMoney(v, currency, rates);
  // Only render the adjustment chip when there's a live discount or a
  // legacy margin to explain (new lines never set margin, but old quotes
  // may have it). Without this gate the c/u line shows on every adjusted
  // row even when the chip itself is empty.
  const discount = Number(line.lineDiscountPct) || 0;
  const margin = Number(line.lineMarginPct) || 0;
  const hasAdjustment = discount !== 0 || margin !== 0;

  // ----- compound mutations -----
  function addComponent() {
    const components = Array.isArray(line.components) ? [...line.components] : [];
    components.push(makeBlankComponent());
    onChange({ components });
  }
  function updateComponent(id, patch) {
    const components = (line.components || []).map((c) =>
      c.id === id ? { ...c, ...patch } : c,
    );
    onChange({ components });
  }
  function removeComponent(id) {
    const components = (line.components || []).filter((c) => c.id !== id);
    onChange({ components });
  }
  function reorderComponents(orderedIds) {
    const byId = new Map((line.components || []).map((c) => [c.id, c]));
    const components = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    onChange({ components });
  }
  function convertToCompound() {
    // Promote the current line's own ref/subtype/dimensions/description/
    // qty/unitPrice into the first component, then clear those columns
    // on the parent — keeps the dealer's work intact through the
    // toggle. Family + image + name stay on the parent because they're
    // the shared identity of the compound.
    const seed = makeBlankComponent({
      name: '',
      reference: line.reference || '',
      subtype: line.subtype || '',
      dimensions: line.dimensions || '',
      description: line.description || '',
      qty: line.qty ?? 1,
      unitPrice: line.unitPrice ?? 0,
    });
    onChange({
      components: [seed],
      reference: '',
      subtype: '',
      dimensions: '',
      description: '',
      qty: 1,
      unitPrice: 0,
    });
  }
  function dissolveCompound() {
    // Promote the first component back onto the parent line and drop
    // the rest. The dealer can re-add them as separate lines if they
    // want — silently discarding multi-component work would be worse.
    const first = (line.components || [])[0];
    onChange({
      components: [],
      reference: first?.reference || line.reference || '',
      subtype: first?.subtype || line.subtype || '',
      dimensions: first?.dimensions || line.dimensions || '',
      description: first?.description || line.description || '',
      qty: first?.qty ?? line.qty ?? 1,
      unitPrice: first?.unitPrice ?? line.unitPrice ?? 0,
    });
  }

  // Deactivated (optional) or non-selected alternative: the row reads as
  // "off". We fade it with a white veil overlay (not row opacity) so the
  // fabric swatch — lifted to z-[2] in GradeFabricRow — stays full-colour
  // while the product photo, text and prices dim. Same treatment the
  // client preview and the PDF export use.
  const dimmed = !!line.isOptional || (!!line.alternativeGroup && !line.isSelectedAlternative);

  return (
    // qli-row turns each row into its own container-query root, so the
    // body below reflows based on this row's width — not the viewport's.
    // That's how the line item reads correctly whether it lives in the
    // full-width builder, in a narrowed editor when the PDF panel is
    // open, or in some future drawer / inspector pane. CSS in
    // src/index.css owns the breakpoints.
    // Visual cues for the option flags:
    //   • optional lines     dashed left accent + faint background tint
    //                        + white veil (deactivated).
    //   • alternative groups solid brand-color left accent unifying
    //                        the contiguous siblings.
    //   • non-selected sibs  white veil on top of the accent so the
    //                        selected one wins the eye.
    <li
      className={`qli-row group relative transition-colors duration-150 hover:bg-ink-50/40 ${
        line.isOptional ? 'border-l-2 border-dashed border-ink-300 bg-ink-50/30' : ''
      } ${
        // Per-line group accents are drawn by the wrapping GroupCard when
        // this line lives inside one (insideGroupCard) — don't double them.
        // A standalone alternative line (mid-edit, before the card forms)
        // keeps its own accent as a fallback.
        !insideGroupCard && line.alternativeGroup ? 'border-l-2 border-solid border-brand-300' : ''
      }`}
    >
      {dimmed && (
        <div className="pointer-events-none absolute inset-0 z-[1] bg-white/55" aria-hidden />
      )}
      <TopStrip
        family={line.family}
        onPickFamily={(value) => onChange({ family: value || '' })}
        compound={compound}
        isOptional={!!line.isOptional}
        alternativeGroup={line.alternativeGroup}
        isSelectedAlternative={!!line.isSelectedAlternative}
        setGroup={line.setGroup}
        groupInfo={groupInfo}
        setInfo={setInfo}
        insideGroupCard={insideGroupCard}
        onSelectAlternative={onSelectAlternative}
        dragHandleProps={dragHandleProps}
      />

      <div className="qli-body mt-1.5">
        <IdentityBand
          line={line}
          compound={compound}
          onChange={onChange}
          refInputRef={refInput}
          currency={currency}
          rates={rates}
        />
        {compound ? (
          <CompoundCalculatorBand
            line={line}
            rowTotal={rowTotal}
            fmt={fmt}
            hasAdjustment={hasAdjustment}
            breakdownOpen={breakdownOpen}
            onToggleBreakdown={() => setBreakdownOpen((v) => !v)}
            onCloseBreakdown={() => setBreakdownOpen(false)}
            currency={currency}
            rates={rates}
          />
        ) : (
          <CalculatorBand
            line={line}
            unit={unit}
            lineTotal={rowTotal}
            fmt={fmt}
            hasAdjustment={hasAdjustment}
            breakdownOpen={breakdownOpen}
            onChange={onChange}
            onToggleBreakdown={() => setBreakdownOpen((v) => !v)}
            onCloseBreakdown={() => setBreakdownOpen(false)}
            currency={currency}
            rates={rates}
          />
        )}
      </div>

      {compound && (
        <ComponentsPanel
          line={line}
          currency={currency}
          rates={rates}
          fmt={fmt}
          onAdd={addComponent}
          onUpdate={updateComponent}
          onRemove={removeComponent}
          onReorder={reorderComponents}
        />
      )}

      <LineFooter
        compound={compound}
        isOptional={!!line.isOptional}
        alternativeGroup={line.alternativeGroup}
        setGroup={line.setGroup}
        onConvertToCompound={convertToCompound}
        onDissolveCompound={dissolveCompound}
        onAddAlternative={onAddAlternative}
        onToggleOptional={onToggleOptional}
        onDuplicate={onDuplicate}
        onSeparateFromSet={onSeparateFromSet}
        onUngroup={onUngroup}
        onRemove={onRemove}
      />
    </li>
  );
}

// New compound components start with their own id so React keys stay
// stable across reorders / edits. Pass overrides to seed values from
// an existing line being converted to compound.
function makeBlankComponent(overrides = {}) {
  return {
    id: newId(),
    name: '',
    reference: '',
    subtype: '',
    dimensions: '',
    description: '',
    qty: 1,
    unitPrice: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Top strip — drag handle + family chip + READ-ONLY status badges. The chip
// is a direct button that opens FamilyPicker; previously the only path to
// set a family was to expand the row, scroll to the Catálogo group, and type
// the string by hand (the dealer's words: "I don't like that I have to write
// family name there for it to show up above. That's stupid."). One tap now.
//
// The TopStrip carries IDENTITY + STATE only: family + the Compuesto /
// Opcional / Conjunto N/M / Alternativa N/M badges. All row ACTIONS
// (convert, alternativa, opcional, duplicar, separar, eliminar) moved to
// the per-line LineFooter at the bottom of the card, so there's no longer
// an action cluster pinned to the right edge here.
// ---------------------------------------------------------------------------
function TopStrip({
  family, onPickFamily, compound,
  isOptional, alternativeGroup, isSelectedAlternative, groupInfo,
  setGroup, setInfo, insideGroupCard,
  onSelectAlternative,
  dragHandleProps,
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="flex items-center gap-2 mb-2.5 -ml-1">
      <span
        {...(dragHandleProps || {})}
        className="hidden sm:inline-flex items-center cursor-grab text-ink-300 hover:text-ink-700 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
        title="Arrastra para reordenar"
        aria-label="Arrastrar para reordenar"
      >
        <GripVertical size={14} />
      </span>

      {/* Alternative-radio at the leftmost position when this line is
          in an alternative group. Clicking flips the group's selection
          to this line. Reading order: radio → family → status pills
          → actions. The radio sits BEFORE family because it's the
          primary affordance for an alternative-group member. */}
      {alternativeGroup && (
        <button
          type="button"
          onClick={onSelectAlternative}
          className={`inline-flex items-center justify-center w-5 h-5 rounded-full border-2 transition-colors flex-shrink-0 ${
            isSelectedAlternative
              ? 'border-brand-500 bg-brand-500 text-white'
              : 'border-ink-300 bg-white hover:border-brand-400'
          }`}
          title={isSelectedAlternative ? 'Alternativa seleccionada' : 'Seleccionar esta alternativa'}
          aria-pressed={isSelectedAlternative}
          aria-label="Seleccionar alternativa"
        >
          {isSelectedAlternative && <Check size={11} strokeWidth={3} />}
        </button>
      )}

      {family ? (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="chip text-brand-700 bg-brand-50 border border-brand-100 hover:bg-brand-100 hover:border-brand-200"
          title="Cambiar familia"
          aria-label={`Familia ${family}. Cambiar`}
        >
          {family}
          <ChevronDown size={10} className="-mr-0.5 opacity-70" aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="chip font-medium text-ink-500 hover:text-ink-900 border border-dashed border-ink-300 hover:border-ink-500"
          aria-label="Asignar familia"
        >
          <Tag size={10} className="opacity-70" aria-hidden />
          Asignar familia
        </button>
      )}

      {/* Read-only status badges. Order: Compuesto → Opcional → Alternativa
          → Conjunto. Multiple can show concurrently when a compound is in an
          alternative group; isOptional+alternative is forbidden by the DB so
          those two are visually mutually exclusive too. These are NON-
          interactive labels — the matching toggles (convert to compound,
          mark optional) live in the per-line LineFooter. */}
      {compound && (
        <span
          className="chip text-ink-600 bg-ink-100 border border-ink-200"
          title="Artículo compuesto"
        >
          <Layers size={10} className="opacity-80" aria-hidden />
          Compuesto
        </span>
      )}

      {/* Opcional badge — read-only. Shown only when the line IS optional;
          the on/off toggle (and its "Hacer opcional" affordance) lives in
          the footer. Hidden for grouped lines, where optional is forbidden. */}
      {isOptional && (
        <span
          className="chip text-ink-600 bg-ink-50 border border-dashed border-ink-300"
          title="Línea opcional — se muestra pero no suma al total"
        >
          <Sparkles size={10} className="opacity-80" aria-hidden />
          Opcional
        </span>
      )}

      {/* Group position chips. When the line is wrapped in a GroupCard the
          card's header/footer already carries the "Conjunto" / "Alternativas"
          identity, so we render only a quiet "N/M" position pill inside the
          card to avoid doubling the label. Outside a card (a momentary
          mid-edit single line) the full labelled chip still shows. */}
      {alternativeGroup && groupInfo && (
        <span
          className="chip text-brand-700 bg-brand-50 border border-brand-100"
          title="Esta línea es parte de un grupo de alternativas; solo la seleccionada cuenta en el total"
        >
          {insideGroupCard ? `${groupInfo.index}/${groupInfo.total}` : `Alternativa ${groupInfo.index}/${groupInfo.total}`}
        </span>
      )}

      {setGroup && (
        <span
          className="chip text-ink-600 bg-ink-100 border border-ink-200"
          title="Esta línea forma parte de un conjunto; todas las piezas se cotizan y suman al total"
        >
          <Boxes size={10} className="opacity-80" aria-hidden />
          {insideGroupCard
            ? (setInfo ? `${setInfo.index}/${setInfo.total}` : 'Conjunto')
            : `Conjunto${setInfo ? ` ${setInfo.index}/${setInfo.total}` : ''}`}
        </span>
      )}

      <div className="flex-1" />

      <FamilyPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(value) => onPickFamily(value)}
        currentFamily={family || ''}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identity band — thumbnail · name · grade/fabric · spec strip.
//
// Grade + fabric are promoted from the legacy DetailsPanel to the always-
// visible band because fabric grade is what drives price; hiding it behind
// a disclosure made the dealer hunt for the most-used control.
// ---------------------------------------------------------------------------
function IdentityBand({ line, compound, onChange, refInputRef, currency, rates }) {
  // Layout: product photo + name on top; the ref/dimensions strip and
  // the swatch + material (grade/fabric) stack BELOW them, full width —
  // not squeezed into a narrow column beside the photo. Material sits
  // under the spec to match the PDF and client preview.
  //
  // In compound mode the parent only carries the *shared* identity —
  // family (a chip in the TopStrip), photo, and the composition name.
  // The per-product grade/fabric + spec strip live inside each component.
  return (
    <div className="flex-1 min-w-0 space-y-2.5">
      <div className="flex items-start gap-3">
        <Thumbnail
          imageId={line.imageId}
          onChange={(id) => onChange({ imageId: id })}
          kind="quote-line"
          ownerId={line.id}
          hoverPreview
        />
        <div className="flex-1 min-w-0">
          <HeroInput
            placeholder={compound ? 'Nombre de la composición' : 'Nombre del artículo'}
            value={line.name || ''}
            onCommit={(v) => onChange({ name: v })}
            autoCapitalize="words"
            enterKeyHint="next"
          />
        </div>
      </div>
      {!compound && (
        <SpecStrip
          reference={line.reference}
          dimensions={line.dimensions}
          onChangeReference={(v) => onChange({ reference: v })}
          onChangeDimensions={(v) => onChange({ dimensions: v })}
          refInputRef={refInputRef}
        />
      )}
      {!compound && <GradeFabricRow line={line} onChange={onChange} currency={currency} rates={rates} />}
      {/* Descripción — promoted out of the old DetailsPanel disclosure to an
          always-visible, auto-growing field under the spec + material rows.
          It's the PDF-facing copy the dealer writes for the client, so it
          earns a permanent slot. Compound lines don't carry a line-level
          description (the per-component rows do), so it's gated to simple
          lines — same rule the old panel used. */}
      {!compound && (
        <AutoGrowTextarea
          value={line.description || ''}
          onCommit={(v) => onChange({ description: v })}
          label="Descripción · visible en el PDF"
          placeholder="Descripción · visible en el PDF"
          autoCapitalize="sentences"
        />
      )}
      {/* Notas internas — a quiet "+ Nota interna" toggle that reveals an
          auto-growing field. Collapsed by default when empty; auto-shown
          when the line already carries a note so existing copy isn't
          hidden behind a click. */}
      <InternalNote
        value={line.notes || ''}
        onCommit={(v) => onChange({ notes: v })}
      />
    </div>
  );
}

// Auto-growing multi-line text field for the always-visible Descripción and
// the internal-note reveal. Wraps the shared <DebouncedTextarea> (debounced
// commit on type/blur) and drives the same scrollHeight auto-resize HeroInput
// uses, so long copy wraps and the field grows instead of scrolling. Unlike
// HeroInput it ALLOWS Enter (these are paragraphs, not one-line titles) and
// reads with the muted body weight of an inline note, not a heading.
function AutoGrowTextarea({ value, onCommit, label, placeholder, ...rest }) {
  const ref = useRef(null);
  useEffect(() => { autoSize(ref.current); }, [value]);
  return (
    <DebouncedTextarea
      ref={ref}
      value={value}
      onCommit={onCommit}
      rows={1}
      placeholder={placeholder}
      aria-label={label || placeholder}
      onInput={(e) => autoSize(e.currentTarget)}
      className="block w-full bg-transparent border-0 px-1 -mx-1 py-1 rounded resize-none overflow-hidden text-[13px] coarse:text-sm leading-snug text-ink-700 placeholder:text-ink-300 hover:bg-ink-50 focus:bg-white focus:shadow-[inset_0_0_0_1px_theme('colors.ink.200')] focus:outline-none transition-colors"
      {...rest}
    />
  );
}

function autoSize(el) {
  if (!el) return;
  // Reset to auto first so deleting content shrinks the field back down —
  // otherwise the height latches at the previous scrollHeight.
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// Internal-note reveal. Collapsed to a quiet "+ Nota interna" link when the
// line has no note; clicking opens the field. When the line ALREADY has a
// note it opens automatically so existing copy is never hidden. These notes
// never print — the placeholder says so.
function InternalNote({ value, onCommit }) {
  const [open, setOpen] = useState(!!value);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-400 hover:text-ink-700 transition-colors px-1 -mx-1 py-1 rounded"
        title="Agregar una nota interna — no se imprime en el PDF"
      >
        <MessageSquarePlus size={13} className="opacity-80" aria-hidden />
        Nota interna
      </button>
    );
  }
  return (
    <AutoGrowTextarea
      value={value}
      onCommit={onCommit}
      label="Notas internas · no se imprimen"
      placeholder="Notas internas · no se imprimen"
      autoCapitalize="sentences"
    />
  );
}

// Grade + fabric editor. The grade dropdown displays just the short label
// (a letter, "Cuir", "COM") so the row reads tightly even when the device
// is narrow; the full "Grade X" name lives in the option list, grouped
// via <optgroup> so the menu still telegraphs the convention. Both
// controls write into the single `subtype` column on every commit via
// composeSubtype, so on-disk format is identical to what dealers have
// always typed — no migration, no PDF / autocomplete churn.
function GradeFabricRow({ line, onChange, currency = 'USD', rates }) {
  const { profileId } = useApp();
  const families = useContext(FamiliesContext);
  const { grade, fabric } = parseSubtype(line.subtype);
  // Resolve this line's catalog family from its reference root so the
  // material-option chips can show a list-price delta. A line with no (or a
  // non-graded) reference simply yields no family → deltas read as 0.
  const family = families?.get(splitSkuGrade(line.reference).root) || null;
  const materialOptions = line.materialOptions || null;
  // When a swatch is attached inline, also remember it in the catalog so
  // the next quote that picks the same material/color is pre-filled. Only
  // bites when the subtype came from the picker (carries a "(#code)") and
  // the catalog color has no photo yet; hand-typed fabrics are skipped.
  // Fire-and-forget — never blocks or fails the line edit.
  const setSwatch = (id) => {
    onChange({ swatchImageId: id });
    if (id && profileId) {
      rememberSwatchInCatalog({ profileId, subtype: line.subtype, imageId: id });
    }
  };
  // commit() always writes the composed subtype. When the picker hands
  // back a swatchImageId we persist it too; manual grade/fabric edits
  // (which don't carry the key) leave any existing swatch untouched.
  const commit = (next) => {
    const patch = { subtype: composeSubtype(next.grade, next.fabric) };
    if ('swatchImageId' in next) patch.swatchImageId = next.swatchImageId;
    onChange(patch);
  };
  const swatchImageId = line.swatchImageId || null;
  const [swatchOpen, setSwatchOpen] = useState(false);
  const [optionOpen, setOptionOpen] = useState(false);

  // Append one or more alternative materials (informational — never touches the
  // line's price/subtype). On the FIRST option we snapshot the line's current
  // grade + material name as the delta base, so every option's "+RD$X" reads
  // relative to what the line is actually quoted at. The catalog picker hands
  // back a batch (multi-select), so this takes an array.
  function addOptions(picks) {
    if (!picks?.length) return;
    const toOption = (picked) => ({
      grade: picked.grade || '',
      label: picked.fabric || '',
      code: colorCodeFromSubtype(composeSubtype(picked.grade, picked.fabric)) || undefined,
      swatchImageId: picked.swatchImageId || undefined,
    });
    const additions = picks.map(toOption);
    const prev = materialOptions;
    const next = prev
      ? { ...prev, options: [...(prev.options || []), ...additions] }
      : { baseGrade: grade || '', baseLabel: fabric || '', options: additions };
    onChange({ materialOptions: next });
  }

  function removeOption(idx) {
    if (!materialOptions) return;
    const options = (materialOptions.options || []).filter((_, i) => i !== idx);
    // Drop the whole structure when the last option goes — keeps the row clean
    // and avoids a dangling base with no alternatives.
    onChange({ materialOptions: options.length ? { ...materialOptions, options } : null });
  }

  // Swap an option into the base slot: the picked option becomes the delta
  // reference and the old base is pushed back as an option. INFORMATIONAL
  // only — the line's own grade/price/subtype are untouched (deltas just
  // recompute against the new base).
  function makeBase(idx) {
    if (!materialOptions) return;
    const opts = materialOptions.options || [];
    const target = opts[idx];
    if (!target) return;
    const oldBase = {
      grade: materialOptions.baseGrade || '',
      label: materialOptions.baseLabel || '',
    };
    const options = opts.map((o, i) => (i === idx ? oldBase : o));
    onChange({
      materialOptions: {
        ...materialOptions,
        baseGrade: target.grade || '',
        baseLabel: target.label || '',
        options,
      },
    });
  }

  // Single row: swatch · grade · fabric · picker. The fabric input sizes
  // to its content (field-sizing) so it's only as wide as the material
  // name; the picker button sits right after it, not across the row.
  return (
    <div className="space-y-1.5 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        {/* Swatch pinned to the LEFT so the material reads the same on every
            line/component no matter how long the fabric name is — mirrors
            the client preview, which always puts the swatch left of the
            subtype. The catalog picker pre-fills it; the empty state is an
            explicit "add photo" tile and the corner × clears just the
            swatch. */}
        {/* z-[2] keeps the swatch above any deactivated/non-selected veil
            (z-[1]) so the fabric colour is never dimmed — in any state. */}
        <span className="relative z-[2] inline-flex shrink-0">
          <Thumbnail
            imageId={swatchImageId}
            fallbackUrl={swatchUrl(colorCodeFromSubtype(line.subtype))}
            onChange={setSwatch}
            kind="quote-line-swatch"
            ownerId={line.id}
            sizeClass="w-10 h-10"
            hoverPreview
          />
        </span>
        <div className="flex items-baseline gap-x-1 min-w-0 flex-1">
          <Select
            variant="ghost"
            value={grade}
            onChange={(v) => commit({ grade: v, fabric })}
            aria-label="Grade"
            title="Fabric grade"
          >
            {/* Option text carries the "Grade " prefix on alpha values so the
                collapsed select reads as "Grade C" rather than just "C" —
                a bare letter is unambiguous to a Ligne Roset dealer in
                isolation but jarring on a card that contains other letters
                (refs, page numbers, dimensions).

                Groups (Telas / Microfibras / Pieles) and the A..R, S, U..X
                letter set come from the Ligne Roset price list verbatim;
                the in-between letters (T, Y, Z) are reserved and never
                offered. Source of truth: src/lib/subtype.js GRADE_GROUPS. */}
            <option value="">Grade —</option>
            {GRADE_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.grades.map((g) => (
                  <option key={g} value={g}>Grade {g}</option>
                ))}
              </optgroup>
            ))}
            <optgroup label="Otros">
              {SPECIAL_GRADES.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
              {/* Legacy values that may still live in older quotes — render
                  the matching option ONLY when the current value is one of
                  them, so a native <select> can display it back to the user.
                  Without this, the browser would silently fall back to the
                  first option and we'd lose what the dealer typed. */}
              {LEGACY_NAMED_GRADES.includes(grade) && (
                <option value={grade}>{grade} (anterior)</option>
              )}
            </optgroup>
          </Select>
          {(grade || fabric) ? (
            <span className="text-ink-300 select-none px-0.5" aria-hidden>·</span>
          ) : null}
          <DebouncedInput
            value={fabric}
            onCommit={(v) => commit({ grade, fabric: v })}
            placeholder="Tela o acabado"
            autoCapitalize="words"
            // Sizes to its content (field-sizing via .qli-grow): only as wide
            // as the material name (or the placeholder when empty), never
            // stretched across the row. Capped at 100% so a very long name
            // still wraps/scrolls within the row instead of overflowing.
            className="qli-grow bg-transparent border-0 border-b border-transparent hover:border-ink-200 focus:!border-ink-900 px-1 py-1 coarse:min-h-10 text-[13px] coarse:text-sm text-ink-700 placeholder:text-ink-300 focus:outline-none focus:ring-0 transition-colors"
          />
          {/* Catalog picker — opens the swatch modal so the dealer can pick a
              material + color instead of typing the name and guessing the
              code. Selecting writes back grade + fabric (and the swatch) in
              one shot; the input above still works for freeform overrides. */}
          <button
            type="button"
            onClick={() => setSwatchOpen(true)}
            className="inline-flex items-center justify-center w-7 h-7 coarse:w-9 coarse:h-9 rounded-md text-ink-400 hover:text-brand-700 hover:bg-brand-50 transition-colors flex-shrink-0"
            title="Elegir del catálogo de materiales"
            aria-label="Elegir tela del catálogo"
          >
            <Palette size={14} />
          </button>
          {/* Quiet "+ Opción" affordance — adds an ALTERNATIVE material the
              customer could choose instead. Purely informational: it records
              the option + a list-price delta, never changing this line's own
              price or total. */}
          <button
            type="button"
            onClick={() => setOptionOpen(true)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-400 hover:text-brand-700 rounded-md px-1.5 py-1 coarse:min-h-9 hover:bg-brand-50 transition-colors flex-shrink-0"
            title="Agregar un material alternativo (solo informativo, no cambia el total)"
            aria-label="Agregar material alternativo"
          >
            <Plus size={12} className="opacity-80" aria-hidden />
            Opción
          </button>
        </div>
      </div>

      <MaterialOptionChips
        materialOptions={materialOptions}
        family={family}
        currency={currency}
        rates={rates}
        onRemove={removeOption}
        onMakeBase={makeBase}
      />

      <SwatchPicker
        open={swatchOpen}
        onClose={() => setSwatchOpen(false)}
        onSelect={(next) => commit(next)}
        currentGrade={grade}
        currentFabric={fabric}
        family={family}
      />
      {/* Second picker instance dedicated to adding alternative materials;
          multi-select so the dealer can tick several fabrics at once. Each
          selection is appended to materialOptions instead of replacing the
          line's own grade/fabric. */}
      <SwatchPicker
        open={optionOpen}
        onClose={() => setOptionOpen(false)}
        multiSelect
        onSelectMany={(picks) => addOptions(picks)}
        currentGrade=""
        currentFabric=""
        family={family}
      />
    </div>
  );
}

// Compact, removable chips for a line/component's alternative materials. Each
// reads "LABEL +RD$X · ×"; the delta comes from materialOptionDeltas (resolved
// against the line's catalog family) and is formatted in the quote's currency.
// "Hacer base" swaps a chip with the current delta base — informational only.
function MaterialOptionChips({ materialOptions, family, currency, rates, onRemove, onMakeBase }) {
  if (!materialOptions || !(materialOptions.options || []).length) return null;
  const deltas = materialOptionDeltas(materialOptions, family);
  const fmtDelta = (d) => {
    const v = Number(d) || 0;
    const sign = v > 0 ? '+' : v < 0 ? '−' : '';
    return `${sign}${formatMoney(Math.abs(v), currency, rates)}`;
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-12">
      {materialOptions.baseLabel && (
        <span
          className="chip text-ink-500 bg-ink-50 border border-ink-200"
          title="Material base — referencia para los deltas"
        >
          {composeSubtype(materialOptions.baseGrade, materialOptions.baseLabel) || materialOptions.baseLabel}
          <span className="ml-1 text-ink-400 normal-case font-normal">base</span>
        </span>
      )}
      {deltas.map((o, i) => (
        <span
          key={`${o.code || o.label || 'opt'}-${i}`}
          className="inline-flex items-center gap-1 chip text-brand-700 bg-brand-50 border border-brand-100"
        >
          <span className="truncate max-w-[14rem]">{o.label || `Grade ${o.grade}`}</span>
          <span className="tabular-nums font-medium">{fmtDelta(o.delta)}</span>
          <button
            type="button"
            onClick={() => onMakeBase(i)}
            className="text-[10px] text-brand-600 hover:text-brand-900 underline decoration-dotted"
            title="Usar este material como base de los deltas"
          >
            Hacer base
          </button>
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="text-brand-500 hover:text-red-600"
            aria-label={`Quitar ${o.label || 'opción'}`}
            title="Quitar opción"
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

// Compact inline strip of identifying meta — REF. + DIM. The uppercase
// micro-labels match the compound component rows (and the PDF / client
// preview), so the spec reads consistently across all three surfaces.
//
// Shared by the article line AND the compound ComponentRow (passing
// `value`/`onCommit` for `reference` + `dimensions`) so the two have an
// identical spec layout. The inputs auto-grow via field-sizing:content;
// `widthClass` is the MIN width (REF. is short, DIM. holds a full
// "H 28 × L 89 × P 43" string), and the .qli-grow 2.5rem floor keeps an
// empty placeholder-only field from collapsing. The strip flex-wraps so a
// long value drops the second field to its own line instead of forcing
// horizontal scroll. (Previously the article passed widthClass="min-w-0",
// which re-zeroed the floor and let the placeholder clip to nothing.)
function SpecStrip({
  reference, dimensions, onChangeReference, onChangeDimensions, refInputRef,
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 min-w-0">
      <InlineEditor
        ref={refInputRef}
        label="Ref."
        value={reference || ''}
        onCommit={onChangeReference}
        placeholder="—"
        mono
        widthClass="min-w-[5rem]"
        autoCapitalize="characters"
        autoComplete="off"
      />
      {/* Catalog page input ("Pág.") intentionally hidden — the field
          remains in the data model (line.pageRef) and is still surfaced
          by autocomplete, QuickActions, and PDF rendering; only the
          edit control has been removed at the dealer's request. */}
      <InlineEditor
        label="Dim."
        value={dimensions || ''}
        onCommit={onChangeDimensions}
        placeholder="H × W × D"
        mono
        widthClass="min-w-[7rem]"
        autoComplete="off"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pricing row — the ONE primitive that renders `Cant. × Unitario = Total`
// for both the standalone article line and every compound component. It
// owns the grid (.qli-pricing-grid in src/index.css) so the equation reads
// as a single right-aligned cluster on wide cards and reflows to a labelled
// stack on narrow ones. Article and component differ only in the size of
// the Total and whether the Total opens a breakdown popover — passed as
// props so the structure, spacing, operators, and min-widths stay identical
// across the two surfaces. (Fixes the prior split where the article used a
// flex calc-grid with a stranded total cell and the component used a
// hand-rolled justify-between row with no operators.)
function PricingRow({
  qty, unitPrice, total, fmt, currency,
  onQtyChange, onUnitChange,
  // Total presentation: 'lg' on the article line, 'md' inside a component.
  totalSize = 'lg',
  totalLabel = 'Total',
  // When provided, the Total is a button that toggles the breakdown popover
  // and renders the c/u adjustment caption. Components pass none of these
  // (their total is a plain read-out; the parent line owns the breakdown).
  onToggleBreakdown, breakdownOpen, breakdown, adjustmentLine, unitForCaption, hasAdjustment,
  qtyAriaLabel = 'Cantidad', unitAriaLabel = 'Precio unitario',
}) {
  const totalValCls = totalSize === 'lg'
    ? 'qli-total-val text-lg font-semibold tabular-nums text-ink-900 leading-tight'
    : 'qli-total-val text-[15px] font-semibold tabular-nums text-ink-900 leading-tight';
  const totalEl = (
    <div className={totalValCls}>{fmt(total)}</div>
  );
  return (
    <div className="qli-pricing-grid">
      <CalcCell label="Cant.">
        <DebouncedInput
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          className="qli-grow min-w-[3.25rem] max-w-[7rem] text-right tabular-nums input min-h-9 coarse:min-h-10 py-1.5 px-2"
          value={qty ?? 1}
          onCommit={(v) => onQtyChange(Math.max(0, Number(v) || 0))}
          aria-label={qtyAriaLabel}
        />
      </CalcCell>

      <span className="qli-pricing-op text-base" aria-hidden>×</span>

      <CalcCell label="Unitario">
        <MoneyInput
          currency={currency}
          value={unitPrice}
          onCommit={onUnitChange}
          widthClass="min-w-[6rem]"
          aria-label={unitAriaLabel}
        />
      </CalcCell>

      <span className="qli-pricing-op text-base" aria-hidden>=</span>

      <div className="qli-pricing-cell qli-pricing-total relative">
        <div className="eyebrow-xs tracking-wide">
          {totalLabel}
        </div>
        {onToggleBreakdown ? (
          <>
            <button
              type="button"
              onClick={onToggleBreakdown}
              className="block w-full text-right px-1 py-1 -mx-1 -my-1 rounded hover:bg-white active:bg-ink-100 transition-colors"
              title="Ver desglose"
              aria-expanded={breakdownOpen}
            >
              {totalEl}
              {hasAdjustment ? (
                <div className="text-[10px] text-ink-500 tabular-nums leading-tight mt-0.5">
                  {unitForCaption != null && (
                    <span className="whitespace-nowrap">{fmt(unitForCaption)} c/u</span>
                  )}
                  {adjustmentLine && <AdjustmentChip line={adjustmentLine} />}
                </div>
              ) : null}
            </button>
            {breakdownOpen && breakdown}
          </>
        ) : (
          totalEl
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calculator band — the article line's pricing. Reads as the card's last
// row (faint top divider via .qli-pricing), right-aligned equation. The
// Total is a button — clicking it toggles the per-line breakdown popover.
function CalculatorBand({
  line, unit, lineTotal, fmt, hasAdjustment, breakdownOpen,
  onChange, onToggleBreakdown, onCloseBreakdown, currency, rates,
}) {
  return (
    <div className="qli-pricing">
      <PricingRow
        qty={line.qty}
        unitPrice={line.unitPrice}
        total={lineTotal}
        fmt={fmt}
        currency={currency}
        onQtyChange={(q) => onChange({ qty: q })}
        onUnitChange={(v) => onChange({ unitPrice: v })}
        totalSize="lg"
        totalLabel="Total"
        onToggleBreakdown={onToggleBreakdown}
        breakdownOpen={breakdownOpen}
        hasAdjustment={hasAdjustment}
        unitForCaption={unit}
        adjustmentLine={line}
        breakdown={(
          <LineBreakdownPopover
            line={line}
            currency={currency}
            rates={rates}
            onClose={onCloseBreakdown}
          />
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compound calculator band — replaces the qty × unit = total equation
// with a single read-only "Compound total" because the math now lives
// per-component below. Still a button so clicking opens the breakdown
// popover with the same explanation (subtotal of all components, then
// line-level discount).
// ---------------------------------------------------------------------------
function CompoundCalculatorBand({
  line, rowTotal, fmt, hasAdjustment, breakdownOpen,
  onToggleBreakdown, onCloseBreakdown, currency, rates,
}) {
  const count = (line.components || []).length;
  return (
    <div className="qli-pricing">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[11px] text-ink-500 tabular-nums leading-tight">
          {count} componente{count === 1 ? '' : 's'}
        </div>
        <div className="relative text-right ml-auto">
          <div className="eyebrow-xs tracking-wide mb-0.5">
            Total compuesto
          </div>
          <button
            type="button"
            onClick={onToggleBreakdown}
            className="block w-full text-right px-1 py-1 -mx-1 -my-1 rounded hover:bg-white active:bg-ink-100 transition-colors"
            title="Ver desglose"
            aria-expanded={breakdownOpen}
          >
            <div className="qli-total-val text-lg font-semibold tabular-nums text-ink-900 leading-tight">
              {fmt(rowTotal)}
            </div>
            {hasAdjustment ? (
              <div className="text-[10px] text-ink-500 tabular-nums leading-tight mt-0.5">
                <AdjustmentChip line={line} />
              </div>
            ) : null}
          </button>
          {breakdownOpen && (
            <LineBreakdownPopover
              line={line}
              currency={currency}
              rates={rates}
              onClose={onCloseBreakdown}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Components panel — the per-component editor that sits below the
// parent identity in compound mode. Each component is a compact row
// with its own name, ref, dim, grade/fabric, qty, unit, and total.
//
// Layout intent: dense but readable. A component is the same data
// shape as a line item but rendered as a single horizontal-wrapping
// strip rather than the full-card vocabulary — three vertical bands
// nested inside another three vertical bands would be visual noise.
// ---------------------------------------------------------------------------
// Components reorder with the SAME HTML5 drag-and-drop as the line items
// (see LineItemList) — a grip handle per row, a brand drop-indicator bar,
// and a renormalised order on drop. Kept deliberately identical so the
// interaction is consistent across the two nesting levels.
function ComponentsPanel({ line, currency, rates, fmt, onAdd, onUpdate, onRemove, onReorder }) {
  const components = line.components || [];
  const [draggingId, setDraggingId] = useState(null);
  const [dropTargetId, setDropTargetId] = useState(null);

  function onDragStart(e, id) {
    setDraggingId(id);
    e.stopPropagation();   // don't let the parent line's drag pick this up
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); } catch { /* noop */ }
  }
  function onDragEnd() { setDraggingId(null); setDropTargetId(null); }
  function onDragOver(e, id) {
    if (!draggingId || draggingId === id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetId(id);
  }
  function onDrop(e, id) {
    e.preventDefault();
    e.stopPropagation();
    const srcId = draggingId;
    setDraggingId(null);
    setDropTargetId(null);
    if (!srcId || srcId === id) return;
    const srcIdx = components.findIndex((c) => c.id === srcId);
    const dstIdx = components.findIndex((c) => c.id === id);
    if (srcIdx === -1 || dstIdx === -1) return;
    const next = [...components];
    const [moved] = next.splice(srcIdx, 1);
    const insertAt = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
    next.splice(insertAt, 0, moved);
    onReorder(next.map((c) => c.id));
  }

  return (
    <div className="mt-3 rounded-lg border border-ink-100 bg-ink-50/40 divide-y divide-ink-100 overflow-hidden">
      {components.length === 0 ? (
        <div className="px-4 py-5 text-center text-xs text-ink-500">
          Sin componentes todavía. Agrega el primero para empezar.
        </div>
      ) : (
        components.map((c, i) => {
          const isDragging = draggingId === c.id;
          const isDropTarget = dropTargetId === c.id && draggingId !== c.id;
          const dragHandleProps = {
            draggable: true,
            onDragStart: (e) => onDragStart(e, c.id),
            onDragEnd,
          };
          return (
            <div
              key={c.id || i}
              onDragOver={(e) => onDragOver(e, c.id)}
              onDrop={(e) => onDrop(e, c.id)}
              className={`relative ${isDragging ? 'opacity-40' : ''}`}
            >
              {isDropTarget && (
                <div className="absolute left-0 right-0 -top-px h-0.5 bg-brand-500 z-10 pointer-events-none" />
              )}
              <ComponentRow
                index={i}
                component={c}
                currency={currency}
                rates={rates}
                fmt={fmt}
                onChange={(patch) => onUpdate(c.id, patch)}
                onRemove={() => onRemove(c.id)}
                dragHandleProps={dragHandleProps}
              />
            </div>
          );
        })
      )}
      <div className="px-3 py-2 bg-white flex items-center justify-end">
        <button
          type="button"
          onClick={onAdd}
          className="btn-ghost text-xs"
          title="Agregar componente"
        >
          <Plus size={12} /> Agregar componente
        </button>
      </div>
    </div>
  );
}

function ComponentRow({ index, component, currency, rates, fmt, onChange, onRemove, dragHandleProps }) {
  const total = componentSubtotal(component);
  const optional = !!component.isOptional;
  // ComponentRow used to be a two-column grid (specs on the left, calc
  // cells on the right via `sm:grid-cols-[minmax(0,1fr)_auto]`). The
  // auto-sized right column happily grabbed ~300px for its CANT × UNIT
  // = TOTAL strip and squeezed a long component name ("RIGHT-ARM SOFA
  // WITH SHORT UNIT KOBOLD CLASSIC") into a narrow 3-line tower —
  // visible even on the mid-width screenshots the dealer was sending
  // in. This row is already inside a sub-card inside a line-item card;
  // stacking vertically reads cleaner and gives the name the full
  // row width unconditionally.
  return (
    <div className={`group/comprow relative px-3 sm:px-4 py-3 bg-white space-y-2 ${
      optional ? 'border-l-2 border-dashed border-ink-300' : ''
    }`}>
      {/* Deactivated (optional) component: white veil fades the block;
          the swatch (z-[2] in GradeFabricRow) stays full-colour. */}
      {optional && (
        <div className="pointer-events-none absolute inset-0 z-[1] bg-white/55" aria-hidden />
      )}
      <div className="flex items-center gap-2">
        <span
          {...(dragHandleProps || {})}
          className="hidden sm:inline-flex items-center cursor-grab text-ink-300 hover:text-ink-700 opacity-0 group-hover/comprow:opacity-60 hover:!opacity-100 transition-opacity"
          title="Arrastra para reordenar"
          aria-label="Arrastrar para reordenar componente"
        >
          <GripVertical size={13} />
        </span>
        <span className="eyebrow-xs tracking-wide text-ink-400 select-none">
          Componente {index + 1}
        </span>
        {/* Per-component optional toggle. Mirrors the line-level
            "Marcar como opcional" but at the inner-compound layer
            so a single sub-piece (e.g. an ottoman in a sectional)
            can be offered as an add-on without changing the rest of
            the composition. Pricing math (compoundSubtotal) skips
            optional components when summing. */}
        <button
          type="button"
          onClick={() => onChange({ isOptional: !optional })}
          className={`chip font-medium ${
            optional
              ? 'text-ink-600 bg-ink-50 border border-dashed border-ink-300 hover:border-ink-500'
              : 'text-ink-400 hover:text-ink-700 border border-dashed border-ink-200 hover:border-ink-400'
          }`}
          title={optional
            ? 'Quitar el marcador opcional — el componente vuelve a sumar al total compuesto'
            : 'Marcar este componente como opcional — se muestra pero no suma al total'}
          aria-pressed={optional}
        >
          <Sparkles size={10} className="opacity-70" aria-hidden />
          {optional ? 'Opcional' : 'Hacer opcional'}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center justify-center w-7 h-7 coarse:w-9 coarse:h-9 rounded text-ink-400 hover:text-red-600 hover:bg-red-50 transition-colors"
          aria-label="Quitar componente"
          title="Quitar componente"
        >
          <X size={13} />
        </button>
      </div>

      <HeroInput
        placeholder="Nombre del componente"
        value={component.name || ''}
        onCommit={(v) => onChange({ name: v })}
        autoCapitalize="words"
      />

      <SpecStrip
        reference={component.reference}
        dimensions={component.dimensions}
        onChangeReference={(v) => onChange({ reference: v })}
        onChangeDimensions={(v) => onChange({ dimensions: v })}
      />

      <div className="pt-0.5">
        <GradeFabricRow
          line={{
            subtype: component.subtype,
            swatchImageId: component.swatchImageId,
            reference: component.reference,
            materialOptions: component.materialOptions,
          }}
          onChange={(patch) => onChange(patch)}
          currency={currency}
          rates={rates}
        />
      </div>

      {/* Pricing row — the SAME <PricingRow> primitive the article line
          uses, so the equation reads identically (right-aligned cluster
          on wide widths, labelled stack when narrow). The component total
          is a plain read-out (no breakdown button — the parent line owns
          the compound breakdown) and rendered one size down ('md'). */}
      <div className="qli-pricing">
        <PricingRow
          qty={component.qty}
          unitPrice={component.unitPrice}
          total={total}
          fmt={fmt}
          currency={currency}
          onQtyChange={(q) => onChange({ qty: q })}
          onUnitChange={(v) => onChange({ unitPrice: v })}
          totalSize="md"
          totalLabel="Total"
          qtyAriaLabel="Cantidad del componente"
          unitAriaLabel="Precio unitario del componente"
        />
      </div>
    </div>
  );
}

// Labelled input cell for the pricing grid: an uppercase micro-label
// (CANT. / UNITARIO) stacked over its input. Uses .qli-pricing-cell so it
// shares the grid's stacking + min-width contract with the Total cell.
function CalcCell({ label, children }) {
  return (
    <div className="qli-pricing-cell">
      <div className="eyebrow-xs tracking-wide">
        {label}
      </div>
      {children}
    </div>
  );
}

// Renders the live adjustments on a line. New lines can carry NEITHER a
// discount nor a margin from the editor anymore (the per-line discount input
// was removed); this read-only chip only surfaces a value that a legacy quote
// already stored, so an old discount/margin still explains the adjusted total.
function AdjustmentChip({ line }) {
  const margin = Number(line.lineMarginPct) || 0;
  const discount = Number(line.lineDiscountPct) || 0;
  const parts = [];
  if (margin) parts.push(`${margin > 0 ? '+' : ''}${margin}%`);
  if (discount) parts.push(`–${discount}%`);
  if (parts.length === 0) return null;
  return <span className="ml-1 text-brand-700 font-medium">{parts.join(' ')}</span>;
}

// ---------------------------------------------------------------------------
// Per-line footer — the ACTION row, the home for everything the old "⋯"
// overflow menu carried. A quiet hairline-topped strip at the bottom of the
// card, read left→right: Compuesto · + Alternativa · Opcional · Duplicar ·
// Separar … Eliminar (pushed to the far right, red).
//
// Visibility / touch contract: the row is ALWAYS reachable on touch (no
// hover-to-reveal), so phone/tablet dealers can always act on a line. On
// fine pointers it sits subtle (muted, faint top border) and strengthens on
// row hover + on focus-within, so a dense desktop list stays calm but the
// actions are one hover/Tab away. (Judgment call flagged in the report.)
//
// The conditional buttons mirror the exact rules the overflow menu used:
//   • Compuesto    — convert / dissolve, mirroring the old chip+menu labels.
//   • + Alternativa — hidden when optional or in a set; label changes to
//                     "Agregar otra alternativa" once already in a group.
//   • Opcional     — moved here from the TopStrip; hidden when grouped.
//   • Duplicar     — always.
//   • Separar      — "del conjunto" (set) or "de las alternativas" (alt).
//   • Eliminar     — always, red, far right.
// "Unir al conjunto de arriba" is gone — joining a set now happens via the
// between-lines connector chip in LineItemList.
// ---------------------------------------------------------------------------
function LineFooter({
  compound, isOptional, alternativeGroup, setGroup,
  onConvertToCompound, onDissolveCompound,
  onAddAlternative, onToggleOptional,
  onDuplicate, onSeparateFromSet, onUngroup, onRemove,
}) {
  const canToggleOptional = !alternativeGroup && !setGroup;
  const canAddAlternative = !isOptional && !setGroup;
  return (
    <div className="qli-footer relative z-[2] mt-2.5 pt-2 border-t border-ink-100 flex flex-wrap items-center gap-x-1 gap-y-1">
      {compound ? (
        <FooterButton
          onClick={onDissolveCompound}
          icon={Layers}
          title="Convertir el compuesto en un artículo simple"
        >
          Disolver compuesto
        </FooterButton>
      ) : (
        <FooterButton
          onClick={onConvertToCompound}
          icon={Layers}
          title="Agrupar varias referencias bajo una misma familia y foto"
        >
          Convertir a compuesto
        </FooterButton>
      )}

      {canAddAlternative && onAddAlternative && (
        <FooterButton
          onClick={onAddAlternative}
          icon={GitFork}
          title={alternativeGroup
            ? 'Agregar otra alternativa al grupo existente'
            : 'Crear un grupo de alternativas con esta línea como la seleccionada por defecto'}
        >
          {alternativeGroup ? 'Agregar otra alternativa' : 'Agregar alternativa'}
        </FooterButton>
      )}

      {canToggleOptional && onToggleOptional && (
        <FooterButton
          onClick={onToggleOptional}
          icon={Sparkles}
          active={isOptional}
          aria-pressed={isOptional}
          title={isOptional
            ? 'Quitar el marcador opcional — la línea vuelve a sumar al total'
            : 'Marcar como opcional — la línea se muestra pero no suma al total'}
        >
          {isOptional ? 'Opcional' : 'Hacer opcional'}
        </FooterButton>
      )}

      {onDuplicate && (
        <FooterButton onClick={onDuplicate} icon={Copy} title="Duplicar esta línea">
          Duplicar
        </FooterButton>
      )}

      {setGroup && onSeparateFromSet && (
        <FooterButton
          onClick={onSeparateFromSet}
          icon={Boxes}
          title="Sacar esta línea del conjunto; vuelve a ser una línea independiente"
        >
          Separar del conjunto
        </FooterButton>
      )}
      {alternativeGroup && onUngroup && (
        <FooterButton
          onClick={onUngroup}
          icon={GitFork}
          title="Sacar esta línea del grupo de alternativas; vuelve a ser una línea independiente"
        >
          Separar de las alternativas
        </FooterButton>
      )}

      <div className="flex-1" />

      <button
        type="button"
        onClick={onRemove}
        className="inline-flex items-center justify-center w-8 h-8 coarse:w-10 coarse:h-10 rounded-md text-ink-400 hover:text-red-600 hover:bg-red-50 active:bg-red-100 transition-colors"
        aria-label="Eliminar línea"
        title="Eliminar línea"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

// A single footer action — quiet text+icon button reusing the project's
// ghost-button feel. `active` paints the pressed state for the Opcional
// toggle (the only stateful action in the row); everything else is a plain
// command. On touch the min-height bumps to 40px so it's a comfortable tap
// target without making the desktop row tall.
function FooterButton({ onClick, icon: Icon, children, active, title, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium rounded-md px-2 py-1 coarse:min-h-10 transition-colors ${
        active
          ? 'text-ink-700 bg-ink-100 hover:bg-ink-200'
          : 'text-ink-500 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200'
      }`}
      {...rest}
    >
      <Icon size={13} className="opacity-80" aria-hidden />
      {children}
    </button>
  );
}
