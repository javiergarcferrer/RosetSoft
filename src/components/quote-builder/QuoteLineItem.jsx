import { useEffect, useRef, useState } from 'react';
import { Trash2, ChevronDown, GripVertical, Copy, MoreHorizontal, Tag, Layers, Plus, X, Palette, Check, Sparkles, GitFork } from 'lucide-react';
import Thumbnail from '../primitives/Thumbnail.jsx';
import HeroInput from '../primitives/HeroInput.jsx';
import InlineEditor from '../primitives/InlineEditor.jsx';
import MoneyInput from '../primitives/MoneyInput.jsx';
import Select from '../primitives/Select.jsx';
import { FieldGroup, Field } from '../primitives/FieldGroup.jsx';
import { DebouncedInput, DebouncedTextarea } from '../DebouncedInput.jsx';
import LineBreakdownPopover from './LineBreakdownPopover.jsx';
import FamilyPicker from './FamilyPicker.jsx';
import SwatchPicker from './SwatchPicker.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { rememberSwatchInCatalog } from '../../lib/swatchCatalog.js';
import {
  applyLineAdjustments, clampPct,
  isCompoundLine, componentSubtotal, compoundSubtotal, lineTotal,
} from '../../lib/pricing.js';
import { formatMoney } from '../../lib/format.js';
import { parseSubtype, composeSubtype, GRADE_GROUPS, SPECIAL_GRADES, LEGACY_NAMED_GRADES } from '../../lib/subtype.js';
import { newId } from '../../db/database.js';

/**
 * One quote line — designed as a product card with three vertical bands:
 *
 *   1. Top strip      family chip + drag handle + expand / overflow actions
 *   2. Identity band  thumbnail + name + grade/fabric chooser + spec strip
 *   3. Calculator     qty × unit = total, on a tinted inset surface
 *
 *   + (expanded)      a grouped details panel for fields not surfaced above
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
 * Yardage and line-level margin are intentionally absent from the editor.
 * Old quotes that have `lineMarginPct` set in the DB still calculate
 * correctly (pricing.js respects the value), but new lines never set it
 * and the UI never lets you toggle it.
 *
 * autoFocus targets the REF input — the dealer's primary entry point when
 * reading from a paper price list.
 */
export default function QuoteLineItem({
  line, quote, onChange, onRemove, onDuplicate,
  onToggleOptional, onAddAlternative, onSelectAlternative,
  groupInfo,
  autoFocus, dragHandleProps,
}) {
  const [expanded, setExpanded] = useState(false);
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
        line.alternativeGroup ? 'border-l-2 border-solid border-brand-300' : ''
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
        groupInfo={groupInfo}
        expanded={expanded}
        onToggleExpand={() => setExpanded((v) => !v)}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        onConvertToCompound={convertToCompound}
        onDissolveCompound={dissolveCompound}
        onToggleOptional={onToggleOptional}
        onAddAlternative={onAddAlternative}
        onSelectAlternative={onSelectAlternative}
        dragHandleProps={dragHandleProps}
      />

      <div className="qli-body mt-1.5">
        <IdentityBand
          line={line}
          compound={compound}
          onChange={onChange}
          refInputRef={refInput}
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

      {expanded && <DetailsPanel line={line} compound={compound} onChange={onChange} />}
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
// Top strip — family chip + row actions. The chip is a direct button that
// opens FamilyPicker; previously the only path to set a family was to
// expand the row, scroll to the Catálogo group, and type the string by
// hand (the dealer's words: "I don't like that I have to write family
// name there for it to show up above. That's stupid."). One tap now.
// The action cluster stays pinned to the right edge regardless of fill
// state.
// ---------------------------------------------------------------------------
function TopStrip({
  family, onPickFamily, compound,
  isOptional, alternativeGroup, isSelectedAlternative, groupInfo,
  expanded, onToggleExpand, onDuplicate, onRemove,
  onConvertToCompound, onDissolveCompound,
  onToggleOptional, onAddAlternative, onSelectAlternative,
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
          className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-700 bg-brand-50 border border-brand-100 hover:bg-brand-100 hover:border-brand-200 transition-colors px-2 py-0.5 rounded-full"
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
          className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-500 hover:text-ink-900 border border-dashed border-ink-300 hover:border-ink-500 transition-colors px-2 py-0.5 rounded-full"
          aria-label="Asignar familia"
        >
          <Tag size={10} className="opacity-70" aria-hidden />
          Asignar familia
        </button>
      )}

      {/* Status chips. Order: Compuesto → Opcional → Alternativa.
          Multiple can show concurrently when a compound is in an
          alternative group; isOptional+alternative is forbidden by
          the DB so those two are visually mutually exclusive too. */}
      {compound ? (
        <span
          className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-600 bg-ink-100 border border-ink-200 px-2 py-0.5 rounded-full"
          title="Artículo compuesto"
        >
          <Layers size={10} className="opacity-80" aria-hidden />
          Compuesto
        </span>
      ) : (
        <button
          type="button"
          onClick={onConvertToCompound}
          className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-500 hover:text-ink-900 border border-dashed border-ink-300 hover:border-ink-500 transition-colors px-2 py-0.5 rounded-full"
          title="Agrupar varias referencias bajo una misma familia y foto"
          aria-label="Convertir en artículo compuesto"
        >
          <Layers size={10} className="opacity-70" aria-hidden />
          Compuesto
        </button>
      )}

      {isOptional && (
        <span
          className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-600 bg-ink-50 border border-dashed border-ink-300 px-2 py-0.5 rounded-full"
          title="No se incluye en el total hasta aceptación"
        >
          Opcional
        </span>
      )}

      {alternativeGroup && groupInfo && (
        <span
          className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-700 bg-brand-50 border border-brand-100 px-2 py-0.5 rounded-full"
          title="Esta línea es parte de un grupo de alternativas; solo la seleccionada cuenta en el total"
        >
          Alternativa {groupInfo.index}/{groupInfo.total}
        </span>
      )}

      <div className="flex-1" />
      <button
        type="button"
        onClick={onToggleExpand}
        className="inline-flex items-center justify-center w-8 h-8 coarse:w-10 coarse:h-10 rounded-md text-ink-500 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200 transition-colors"
        aria-label={expanded ? 'Contraer detalles' : 'Más detalles'}
        aria-expanded={expanded}
      >
        <ChevronDown size={16} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      <OverflowMenu
        compound={compound}
        isOptional={isOptional}
        alternativeGroup={alternativeGroup}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        onConvertToCompound={onConvertToCompound}
        onDissolveCompound={onDissolveCompound}
        onToggleOptional={onToggleOptional}
        onAddAlternative={onAddAlternative}
      />

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
function IdentityBand({ line, compound, onChange, refInputRef }) {
  // Layout: product photo + name on top; the swatch + material
  // (grade/fabric) and the ref/dimensions strip stack BELOW them, full
  // width — not squeezed into a narrow column beside the photo.
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
      {!compound && <GradeFabricRow line={line} onChange={onChange} />}
      {!compound && (
        <SpecStrip
          reference={line.reference}
          dimensions={line.dimensions}
          onChangeReference={(v) => onChange({ reference: v })}
          onChangeDimensions={(v) => onChange({ dimensions: v })}
          refInputRef={refInputRef}
        />
      )}
    </div>
  );
}

// Grade + fabric editor. The grade dropdown displays just the short label
// (a letter, "Cuir", "COM") so the row reads tightly even when the device
// is narrow; the full "Grade X" name lives in the option list, grouped
// via <optgroup> so the menu still telegraphs the convention. Both
// controls write into the single `subtype` column on every commit via
// composeSubtype, so on-disk format is identical to what dealers have
// always typed — no migration, no PDF / autocomplete churn.
function GradeFabricRow({ line, onChange }) {
  const { profileId } = useApp();
  const { grade, fabric } = parseSubtype(line.subtype);
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
  // Single row: swatch · grade · fabric · picker. The fabric input sizes
  // to its content (field-sizing) so it's only as wide as the material
  // name; the picker button sits right after it, not across the row.
  return (
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
          onChange={setSwatch}
          kind="quote-line-swatch"
          ownerId={line.id}
          sizeClass="w-10 h-10"
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
          className="qli-grow bg-transparent border-0 border-b border-transparent hover:border-ink-200 focus:!border-ink-900 px-1 py-1 coarse:min-h-10 text-[13px] coarse:text-[14px] text-ink-700 placeholder:text-ink-300 focus:outline-none focus:ring-0 transition-colors"
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
      </div>
      <SwatchPicker
        open={swatchOpen}
        onClose={() => setSwatchOpen(false)}
        onSelect={(next) => commit(next)}
        currentGrade={grade}
        currentFabric={fabric}
      />
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
    ? 'qli-total-val text-[18px] font-semibold tabular-nums text-ink-900 leading-tight'
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
        <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
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
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-500 mb-0.5">
            Total compuesto
          </div>
          <button
            type="button"
            onClick={onToggleBreakdown}
            className="block w-full text-right px-1 py-1 -mx-1 -my-1 rounded hover:bg-white active:bg-ink-100 transition-colors"
            title="Ver desglose"
            aria-expanded={breakdownOpen}
          >
            <div className="qli-total-val text-[18px] font-semibold tabular-nums text-ink-900 leading-tight">
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
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-400 select-none">
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
          className={`inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.08em] px-2 py-0.5 rounded-full transition-colors ${
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

      <GradeFabricRow
        line={{ subtype: component.subtype, swatchImageId: component.swatchImageId }}
        onChange={(patch) => onChange(patch)}
      />

      <div className="pt-0.5">
        <SpecStrip
          reference={component.reference}
          dimensions={component.dimensions}
          onChangeReference={(v) => onChange({ reference: v })}
          onChangeDimensions={(v) => onChange({ dimensions: v })}
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
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
        {label}
      </div>
      {children}
    </div>
  );
}

// Renders the live adjustments on a line. Discount is the only adjustment
// new lines can carry; margin is shown only when a legacy line has one
// set (the editor has no way to ADD margin anymore — see DetailsPanel).
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
// Overflow menu — Duplicate / Eliminar. Closes on outside click and Escape.
// ---------------------------------------------------------------------------
function OverflowMenu({
  onDuplicate, onRemove, compound,
  isOptional, alternativeGroup,
  onConvertToCompound, onDissolveCompound,
  onToggleOptional, onAddAlternative,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center w-8 h-8 coarse:w-10 coarse:h-10 rounded-md text-ink-500 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200 transition-colors"
        aria-label="Más acciones"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1.5 w-52 rounded-md border border-ink-200 bg-white shadow-pop py-1 z-30">
          {onDuplicate && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { onDuplicate(); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-ink-50 inline-flex items-center gap-2"
            >
              <Copy size={14} className="text-ink-500" />
              Duplicar línea
            </button>
          )}
          {compound ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => { onDissolveCompound(); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-ink-50 inline-flex items-center gap-2"
              title="Convertir el compuesto en un artículo simple"
            >
              <Layers size={14} className="text-ink-500" />
              Disolver compuesto
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => { onConvertToCompound(); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-ink-50 inline-flex items-center gap-2"
              title="Agrupar varias referencias bajo una misma familia y foto"
            >
              <Layers size={14} className="text-ink-500" />
              Convertir a compuesto
            </button>
          )}

          {/* Optional add-on toggle. Hidden when the line is in an
              alternative group — DB CHECK forbids optional+alternative
              and the UI shouldn't tempt the dealer to construct it. */}
          {!alternativeGroup && onToggleOptional && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { onToggleOptional(); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-ink-50 inline-flex items-center gap-2"
              title={isOptional
                ? 'Quitar el marcador opcional — la línea volverá al total'
                : 'Marcar como opcional — la línea se muestra pero no suma al total'}
            >
              <Sparkles size={14} className="text-ink-500" />
              {isOptional ? 'Quitar opcional' : 'Marcar como opcional'}
            </button>
          )}

          {/* Add alternative. Hidden when the line is optional (same
              mutual-exclusion rule). When the line is already in a
              group, the action label clarifies it's adding ANOTHER
              alternative to the existing group. */}
          {!isOptional && onAddAlternative && (
            <button
              type="button"
              role="menuitem"
              onClick={() => { onAddAlternative(); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-ink-50 inline-flex items-center gap-2"
              title={alternativeGroup
                ? 'Agregar otra alternativa al grupo existente'
                : 'Crear un grupo de alternativas con esta línea como la seleccionada por defecto'}
            >
              <GitFork size={14} className="text-ink-500" />
              {alternativeGroup ? 'Agregar otra alternativa' : 'Agregar alternativa'}
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => { onRemove(); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-red-50 text-red-600 inline-flex items-center gap-2"
          >
            <Trash2 size={14} />
            Eliminar línea
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details panel — fields that aren't part of the always-visible bands:
// per-line discount + the text fields. Family used to live here too, as a
// free-text input the dealer had to scroll to and type. It's now editable
// directly from its chip in the TopStrip via FamilyPicker, so we don't
// duplicate the entry point here. Yardage and line-level margin are
// intentionally absent — the line model doesn't surface them anymore.
// ---------------------------------------------------------------------------
function DetailsPanel({ line, compound, onChange }) {
  return (
    <div className="mt-4 pt-4 border-t border-ink-100 space-y-5">
      <FieldGroup title="Ajuste" columns={2}>
        <Field
          label="Descuento %"
          hint={compound
            ? 'Aplicado al subtotal de todos los componentes.'
            : 'Aplicado al precio unitario de esta línea.'}
        >
          <DebouncedInput
            type="number"
            inputMode="decimal"
            min="0"
            max="100"
            step="any"
            className="input"
            value={line.lineDiscountPct ?? 0}
            onCommit={(v) => onChange({ lineDiscountPct: clampPct(v) })}
          />
        </Field>
      </FieldGroup>

      <FieldGroup title="Texto" columns={2}>
        {!compound && (
          <Field label="Descripción (visible en el PDF)" widthClass="col-span-2">
            <DebouncedTextarea
              className="input min-h-[60px]"
              placeholder="Descripción del PDF de tarifa…"
              value={line.description || ''}
              onCommit={(v) => onChange({ description: v })}
              autoCapitalize="sentences"
            />
          </Field>
        )}
        <Field label="Notas internas (no se imprimen)" widthClass="col-span-2">
          <DebouncedTextarea
            className="input min-h-[60px]"
            placeholder="p. ej. cojín extra, COM"
            value={line.notes || ''}
            onCommit={(v) => onChange({ notes: v })}
            autoCapitalize="sentences"
          />
        </Field>
      </FieldGroup>
    </div>
  );
}
