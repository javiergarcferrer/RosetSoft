import { useEffect, useRef, useState } from 'react';
import { Trash2, ChevronDown, GripVertical, Copy, MoreHorizontal } from 'lucide-react';
import Thumbnail from '../primitives/Thumbnail.jsx';
import HeroInput from '../primitives/HeroInput.jsx';
import InlineEditor from '../primitives/InlineEditor.jsx';
import MoneyInput from '../primitives/MoneyInput.jsx';
import Operator from '../primitives/Operator.jsx';
import { FieldGroup, Field } from '../primitives/FieldGroup.jsx';
import { DebouncedInput, DebouncedTextarea } from '../DebouncedInput.jsx';
import LineBreakdownPopover from './LineBreakdownPopover.jsx';
import { applyLineAdjustments, clampPct } from '../../lib/pricing.js';
import { formatMoney } from '../../lib/format.js';

/**
 * One quote line. Designed as a product card with three vertical bands:
 *
 *   1. Top strip      family chip + drag handle + expand / overflow actions
 *   2. Identity band  thumbnail + name + subtype + inline ref / page / dims
 *   3. Calculator     qty × unit = total, on a tinted inset surface
 *
 *   + (expanded)      a grouped details panel — Identity / Specs / Pricing
 *                     / Notes — for fields that aren't shown above
 *
 * The same anatomy works on every viewport. On phones the bands stack
 * vertically; from sm up the identity and calculator bands sit side-by-side
 * with the calculator right-aligned. There is no flex-wrap fallback that
 * causes the money tower to drift below the name when the column narrows;
 * the layout is explicit at every breakpoint.
 *
 * Inline editing is always on — no separate "view" / "edit" modes. Most
 * frequently typed fields (name, ref, qty, unit) live in the always-visible
 * bands; rarely touched fields (family, yardage, margin, discount, etc.)
 * live behind the Detalles disclosure. autoFocus targets the REF input
 * because that's the dealer's primary entry point when reading from a
 * paper price list.
 *
 * Styling for inputs is delegated to primitives under ../primitives/ —
 * this component is a layout, not a place to invent new input styles.
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
  const hasAdjustment = !!(line.lineMarginPct || line.lineDiscountPct);

  return (
    <li className="px-3 sm:px-4 py-3 sm:py-4 group">
      <TopStrip
        family={line.family}
        expanded={expanded}
        onToggleExpand={() => setExpanded((v) => !v)}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        dragHandleProps={dragHandleProps}
      />

      {/* The two primary bands. Stacked on phones (default), side-by-side
          from sm up. items-stretch keeps the calculator surface aligned
          with the identity column's bottom edge on desktop. */}
      <div className="sm:flex sm:items-stretch sm:gap-5 sm:mt-1">
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
// a muted "Sin familia" placeholder when empty) so the action cluster stays
// pinned to the right edge regardless of fill state.
// ---------------------------------------------------------------------------
function TopStrip({ family, expanded, onToggleExpand, onDuplicate, onRemove, dragHandleProps }) {
  return (
    <div className="flex items-center gap-2 mb-2 -ml-1">
      <span
        {...(dragHandleProps || {})}
        className="hidden sm:inline-flex items-center cursor-grab text-ink-300 hover:text-ink-700 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
        title="Arrastra para reordenar"
        aria-label="Arrastrar para reordenar"
      >
        <GripVertical size={14} />
      </span>
      {family ? (
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-700 bg-brand-50 px-1.5 py-0.5 rounded">
          {family}
        </span>
      ) : (
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-300">
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
// Identity band — thumbnail on the left, name + subtype + inline spec strip
// on the right.
// ---------------------------------------------------------------------------
function IdentityBand({ line, onChange, refInputRef }) {
  return (
    <div className="flex items-start gap-3 flex-1 min-w-0 mb-3 sm:mb-0">
      <Thumbnail
        imageId={line.imageId}
        onChange={(id) => onChange({ imageId: id })}
        kind="quote-line"
        ownerId={line.id}
      />
      <div className="flex-1 min-w-0 space-y-1">
        <HeroInput
          placeholder="Nombre del artículo"
          value={line.name || ''}
          onCommit={(v) => onChange({ name: v })}
          autoCapitalize="words"
          enterKeyHint="next"
        />
        {line.subtype ? (
          <div className="text-[12px] text-ink-600 leading-snug break-words">
            {line.subtype}
          </div>
        ) : null}
        <SpecStrip line={line} onChange={onChange} refInputRef={refInputRef} />
      </div>
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
// equation: Cantidad × Unitario = TOTAL, with the total ~20% larger than
// the inputs so the result reads as the heaviest element on the card. Sits
// on a faint inset surface so it groups as one unit.
//
// Total is a button — clicking it toggles the breakdown popover with the
// margin / discount math broken out.
// ---------------------------------------------------------------------------
function CalculatorBand({
  line, unit, lineTotal, fmt, hasAdjustment, breakdownOpen,
  onChange, onToggleBreakdown, onCloseBreakdown, currency, rates,
}) {
  return (
    <div className="bg-ink-50 rounded-lg border border-ink-100 px-3 py-2.5 sm:px-4 sm:py-3 sm:flex-shrink-0 sm:w-[26rem]">
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
            className="block w-full text-right px-1 py-1 -mx-1 -my-1 rounded hover:bg-ink-100 active:bg-ink-200 transition-colors"
            title="Ver desglose"
            aria-expanded={breakdownOpen}
          >
            <div className="text-[17px] sm:text-[18px] font-semibold tabular-nums text-ink-900 leading-tight">
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

// One cell of the calculator equation — label above, input below. Kept
// local because it's only meaningful inside CalculatorBand; promoting it
// would invite reuse in contexts where its baseline-aligned layout is
// wrong (it's tuned to sit next to an <Operator> at the input baseline).
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

function AdjustmentChip({ line }) {
  const margin = Number(line.lineMarginPct) || 0;
  const discount = Number(line.lineDiscountPct) || 0;
  const parts = [];
  if (margin) parts.push(`${margin > 0 ? '+' : ''}${margin}%`);
  if (discount) parts.push(`–${discount}%`);
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
// Details panel — grouped, hierarchical layout for fields that aren't shown
// in the always-visible bands. Groups are intentional:
//   Identity : catalog metadata not promoted to the spec strip
//   Specs    : physical / sourcing attributes
//   Pricing  : per-line adjustments
//   Texto    : description / internal notes
// All sit on the same surface as the row above — no nested card.
// ---------------------------------------------------------------------------
function DetailsPanel({ line, onChange }) {
  return (
    <div className="mt-4 pt-4 border-t border-dashed border-ink-200 space-y-4">
      <FieldGroup title="Identidad del catálogo">
        <Field label="Familia">
          <DebouncedInput
            className="input"
            placeholder="AMÉDÉE, LIGHTING…"
            value={line.family || ''}
            onCommit={(v) => onChange({ family: v })}
            autoCapitalize="characters"
          />
        </Field>
        <Field label="Subtipo / grado / acabado" widthClass="col-span-2 sm:col-span-2">
          <DebouncedInput
            className="input"
            placeholder="Grade C — PAMPA"
            value={line.subtype || ''}
            onCommit={(v) => onChange({ subtype: v })}
          />
        </Field>
      </FieldGroup>

      <FieldGroup title="Especificaciones">
        <Field label="Yardage">
          <DebouncedInput
            className="input"
            placeholder="2.40yd"
            value={line.yardage || ''}
            onCommit={(v) => onChange({ yardage: v })}
            inputMode="decimal"
          />
        </Field>
      </FieldGroup>

      <FieldGroup title="Ajustes de precio">
        <Field label="Margen %">
          <DebouncedInput
            type="number"
            inputMode="decimal"
            step="any"
            className="input"
            value={line.lineMarginPct ?? 0}
            onCommit={(v) => onChange({ lineMarginPct: Number(v) || 0 })}
          />
        </Field>
        <Field label="Descuento %">
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

      <FieldGroup title="Texto">
        <Field label="Descripción (visible en el PDF)" widthClass="col-span-2 sm:col-span-3">
          <DebouncedTextarea
            className="input min-h-[60px]"
            placeholder="Descripción del PDF de tarifa…"
            value={line.description || ''}
            onCommit={(v) => onChange({ description: v })}
            autoCapitalize="sentences"
          />
        </Field>
        <Field label="Notas internas" widthClass="col-span-2 sm:col-span-3">
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
