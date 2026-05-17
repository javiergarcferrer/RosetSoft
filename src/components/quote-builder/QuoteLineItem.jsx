import { useEffect, useRef, useState } from 'react';
import { Trash2, ChevronDown, GripVertical, Copy, MoreHorizontal } from 'lucide-react';
import Thumbnail from '../primitives/Thumbnail.jsx';
import HeroInput from '../primitives/HeroInput.jsx';
import InlineEditor from '../primitives/InlineEditor.jsx';
import MoneyInput from '../primitives/MoneyInput.jsx';
import Operator from '../primitives/Operator.jsx';
import Select from '../primitives/Select.jsx';
import { FieldGroup, Field } from '../primitives/FieldGroup.jsx';
import { DebouncedInput, DebouncedTextarea } from '../DebouncedInput.jsx';
import LineBreakdownPopover from './LineBreakdownPopover.jsx';
import { applyLineAdjustments, clampPct } from '../../lib/pricing.js';
import { formatMoney } from '../../lib/format.js';
import { parseSubtype, composeSubtype, GRADE_OPTIONS } from '../../lib/subtype.js';

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
  line, quote, onChange, onRemove, onDuplicate, autoFocus, dragHandleProps,
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
  const unit = applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
  const lineTotal = unit * (line.qty || 0);
  const fmt = (v) => formatMoney(v, currency, rates);
  // Only render the adjustment chip when there's a live discount or a
  // legacy margin to explain (new lines never set margin, but old quotes
  // may have it). Without this gate the c/u line shows on every adjusted
  // row even when the chip itself is empty.
  const discount = Number(line.lineDiscountPct) || 0;
  const margin = Number(line.lineMarginPct) || 0;
  const hasAdjustment = discount !== 0 || margin !== 0;

  return (
    <li className="px-3 sm:px-5 py-3.5 sm:py-4 group transition-colors duration-150 hover:bg-ink-50/40">
      <TopStrip
        family={line.family}
        expanded={expanded}
        onToggleExpand={() => setExpanded((v) => !v)}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        dragHandleProps={dragHandleProps}
      />

      <div className="sm:flex sm:items-stretch sm:gap-5 sm:mt-1.5">
        <IdentityBand
          line={line}
          onChange={onChange}
          refInputRef={refInput}
        />
        <CalculatorBand
          line={line}
          unit={unit}
          lineTotal={lineTotal}
          fmt={fmt}
          hasAdjustment={hasAdjustment}
          breakdownOpen={breakdownOpen}
          onChange={onChange}
          onToggleBreakdown={() => setBreakdownOpen((v) => !v)}
          onCloseBreakdown={() => setBreakdownOpen(false)}
          currency={currency}
          rates={rates}
        />
      </div>

      {expanded && <DetailsPanel line={line} onChange={onChange} />}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Top strip — family chip + row actions. The chip slot always renders (with
// a muted placeholder when empty) so the action cluster stays pinned to
// the right edge regardless of fill state.
// ---------------------------------------------------------------------------
function TopStrip({ family, expanded, onToggleExpand, onDuplicate, onRemove, dragHandleProps }) {
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
      {family ? (
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-700 bg-brand-50 border border-brand-100 px-2 py-0.5 rounded-full">
          {family}
        </span>
      ) : (
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-300 px-1">
          Sin familia
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
      <OverflowMenu onDuplicate={onDuplicate} onRemove={onRemove} />
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
function IdentityBand({ line, onChange, refInputRef }) {
  return (
    <div className="flex items-start gap-3 sm:gap-4 flex-1 min-w-0 mb-3.5 sm:mb-0">
      <Thumbnail
        imageId={line.imageId}
        onChange={(id) => onChange({ imageId: id })}
        kind="quote-line"
        ownerId={line.id}
      />
      <div className="flex-1 min-w-0 space-y-1.5">
        <HeroInput
          placeholder="Nombre del artículo"
          value={line.name || ''}
          onCommit={(v) => onChange({ name: v })}
          autoCapitalize="words"
          enterKeyHint="next"
        />
        <GradeFabricRow line={line} onChange={onChange} />
        <SpecStrip line={line} onChange={onChange} refInputRef={refInputRef} />
      </div>
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
  const { grade, fabric } = parseSubtype(line.subtype);
  const commit = (next) => onChange({ subtype: composeSubtype(next.grade, next.fabric) });
  return (
    <div className="flex items-baseline gap-1 -ml-1.5">
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
            (refs, page numbers, dimensions). Named grades stand alone.
            The optgroup labels structure the dropdown menu only. */}
        <option value="">Grade —</option>
        <optgroup label="Tela / Fabric">
          {['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((g) => (
            <option key={g} value={g}>Grade {g}</option>
          ))}
        </optgroup>
        <optgroup label="Otros">
          <option value="Cuir">Cuir</option>
          <option value="COM">COM</option>
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
        className="flex-1 min-w-0 bg-transparent border-0 border-b border-transparent hover:border-ink-200 focus:!border-ink-900 px-1 py-1 coarse:min-h-10 text-[13px] coarse:text-[14px] text-ink-700 placeholder:text-ink-300 focus:outline-none focus:ring-0 transition-colors"
      />
    </div>
  );
}

// Compact inline strip of identifying meta — ref, page, dimensions. On
// narrow widths the InlineEditors wrap naturally onto a second line.
function SpecStrip({ line, onChange, refInputRef }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-0.5">
      <InlineEditor
        label="Ref."
        ref={refInputRef}
        value={line.reference || ''}
        onCommit={(v) => onChange({ reference: v })}
        placeholder="—"
        mono
        widthClass="w-[7.5rem]"
        autoCapitalize="characters"
        autoComplete="off"
      />
      <InlineEditor
        label="Pág."
        value={line.pageRef || ''}
        onCommit={(v) => onChange({ pageRef: v })}
        placeholder="—"
        widthClass="w-12"
        inputMode="numeric"
        autoComplete="off"
      />
      <InlineEditor
        label="Dim."
        value={line.dimensions || ''}
        onCommit={(v) => onChange({ dimensions: v })}
        placeholder="H × W × D"
        mono
        widthClass="w-44"
        autoComplete="off"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calculator band — the only place numbers live on a line. Reads as an
// equation: Cantidad × Unitario = TOTAL. Total is the heaviest element
// (~1.4× the input typography). Sits on a faint inset surface so the
// math reads as one unit, distinct from identity.
//
// Total is a button — clicking it toggles the breakdown popover with the
// per-line math (discount applied) broken out.
// ---------------------------------------------------------------------------
function CalculatorBand({
  line, unit, lineTotal, fmt, hasAdjustment, breakdownOpen,
  onChange, onToggleBreakdown, onCloseBreakdown, currency, rates,
}) {
  return (
    <div className="bg-ink-50 rounded-lg border border-ink-100 px-3 py-2.5 sm:px-4 sm:py-3 sm:flex-shrink-0 sm:w-[26rem] transition-shadow group-hover:shadow-soft">
      <div className="flex items-end gap-2 sm:gap-3">
        <CalcCell label="Cant.">
          <DebouncedInput
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            className="w-14 sm:w-16 text-right tabular-nums input min-h-9 coarse:min-h-10 py-1.5 px-2"
            value={line.qty ?? 1}
            onCommit={(v) => onChange({ qty: Math.max(0, Number(v) || 0) })}
            aria-label="Cantidad"
          />
        </CalcCell>

        <Operator>×</Operator>

        <CalcCell label="Unitario">
          <MoneyInput
            currency={currency}
            value={line.unitPrice}
            onCommit={(v) => onChange({ unitPrice: v })}
            widthClass="w-24 sm:w-32"
            aria-label="Precio unitario"
          />
        </CalcCell>

        <Operator>=</Operator>

        <div className="flex-1 min-w-0 text-right relative">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-500 mb-0.5">Total</div>
          <button
            type="button"
            onClick={onToggleBreakdown}
            className="block w-full text-right px-1 py-1 -mx-1 -my-1 rounded hover:bg-white active:bg-ink-100 transition-colors"
            title="Ver desglose"
            aria-expanded={breakdownOpen}
          >
            <div className="text-[18px] sm:text-[19px] font-semibold tabular-nums text-ink-900 leading-tight">
              {fmt(lineTotal)}
            </div>
            {hasAdjustment ? (
              <div className="text-[10px] text-ink-500 tabular-nums leading-tight mt-0.5">
                <span className="whitespace-nowrap">{fmt(unit)} c/u</span>
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

function CalcCell({ label, children }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-500 mb-0.5">
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
function OverflowMenu({ onDuplicate, onRemove }) {
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
        <div role="menu" className="absolute right-0 mt-1.5 w-48 rounded-md border border-ink-200 bg-white shadow-pop py-1 z-30">
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
// catalog identity (family is editable for autocomplete fallback) and
// per-line discount, plus the text fields. Yardage and line-level margin
// are intentionally absent — the line model doesn't surface them anymore.
// ---------------------------------------------------------------------------
function DetailsPanel({ line, onChange }) {
  return (
    <div className="mt-4 pt-4 border-t border-ink-100 space-y-5">
      <FieldGroup title="Catálogo">
        <Field label="Familia">
          <DebouncedInput
            className="input"
            placeholder="AMÉDÉE, TOGO…"
            value={line.family || ''}
            onCommit={(v) => onChange({ family: v })}
            autoCapitalize="characters"
          />
        </Field>
      </FieldGroup>

      <FieldGroup title="Ajuste" columns={2}>
        <Field label="Descuento %" hint="Aplicado al precio unitario de esta línea.">
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
        <Field label="Descripción (visible en el PDF)" widthClass="col-span-2">
          <DebouncedTextarea
            className="input min-h-[60px]"
            placeholder="Descripción del PDF de tarifa…"
            value={line.description || ''}
            onCommit={(v) => onChange({ description: v })}
            autoCapitalize="sentences"
          />
        </Field>
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
