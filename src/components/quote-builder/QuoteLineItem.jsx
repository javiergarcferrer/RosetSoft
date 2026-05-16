import { useEffect, useRef, useState } from 'react';
import { Trash2, ChevronDown, GripVertical, Copy, MoreHorizontal } from 'lucide-react';
import ImageDrop from '../ImageDrop.jsx';
import { DebouncedInput, DebouncedTextarea } from '../DebouncedInput.jsx';
import LineBreakdownPopover from './LineBreakdownPopover.jsx';
import { applyLineAdjustments, clampPct } from '../../lib/pricing.js';
import { formatMoney } from '../../lib/format.js';

/**
 * One quote line, redesigned. Reads left → right: identity → quantity →
 * money. Drag handle and overflow menu are discoverable on hover but never
 * compete for attention with the data.
 *
 * Layout (collapsed, the 90% case):
 *
 *   ⋮⋮ [img]  AMÉDÉE                            1     $4,180.00    $4,180.00   ▾ ⋯
 *             Sofa 2-plazas                    qty   unit         total
 *             Grade C — PAMPA · ref 18211150 · p.85
 *
 * Single layout for every viewport. Uses `flex flex-wrap` so the money
 * tower drops below the identity when the column narrows (e.g. the PDF
 * panel is open). No horizontal scroll, ever.
 *
 * Per-line fields (margin, dimensions, etc.) live in an expandable panel
 * below — clicking the total opens the breakdown popover instead.
 */
export default function QuoteLineItem({
  line, quote, onChange, onRemove, onDuplicate, autoFocus, dragHandleProps,
}) {
  const [expanded, setExpanded] = useState(false);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [hover, setHover] = useState(false);
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
    <li
      className="p-3 sm:p-4 group hover:bg-ink-50/40 transition-colors"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="flex flex-wrap items-start gap-3">
        {/* Drag handle — desktop only */}
        <span
          {...(dragHandleProps || {})}
          className={`hidden sm:inline-flex self-stretch items-center cursor-grab text-ink-300 hover:text-ink-700 -ml-1 ${hover ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'} transition-opacity`}
          title="Arrastra para reordenar"
        >
          <GripVertical size={14} />
        </span>

        {/* Image */}
        <ImageDrop
          imageId={line.imageId}
          onChange={(id) => onChange({ imageId: id })}
          kind="quote-line"
          ownerId={line.id}
          label=""
          imgClassName="w-14 h-14 sm:w-16 sm:h-16 object-contain bg-white border border-ink-100 rounded"
          allowUrl={false}
        />

        {/* Identity column */}
        <div className="flex-1 min-w-[180px] space-y-1">
          {line.family ? (
            <div className="text-[9px] font-semibold uppercase tracking-widest text-brand-700">
              {line.family}
            </div>
          ) : null}
          <DebouncedInput
            className="block w-full bg-transparent border-0 px-0 py-0 text-sm font-semibold text-ink-900 placeholder:text-ink-300 focus:outline-none focus:ring-0"
            placeholder="Nombre del artículo"
            value={line.name || ''}
            onCommit={(v) => onChange({ name: v })}
          />
          {line.subtype ? (
            <div className="text-[11px] text-ink-500 break-words" title={line.subtype}>
              {line.subtype}
            </div>
          ) : null}
          {/* Micro-meta strip: ref · page · dimensions — inline, no labels */}
          <MicroMeta line={line} />
        </div>

        {/* Money tower */}
        <div className="flex flex-wrap items-end gap-2 ml-auto">
          <Cell label="Ref." width="w-24 sm:w-28">
            <DebouncedInput
              ref={refInput}
              className="input font-mono text-xs"
              placeholder="18211150"
              value={line.reference || ''}
              onCommit={(v) => onChange({ reference: v })}
            />
          </Cell>
          <Cell label="Cant." width="w-14">
            <DebouncedInput
              type="number"
              min="0"
              className="input text-right"
              value={line.qty ?? 1}
              onCommit={(v) => onChange({ qty: Math.max(0, Number(v) || 0) })}
            />
          </Cell>
          <Cell label="Unit." width="w-24">
            <DebouncedInput
              type="number"
              min="0"
              className="input text-right"
              placeholder="0"
              value={line.unitPrice ?? ''}
              onCommit={(v) => onChange({ unitPrice: Math.max(0, Number(v) || 0) })}
            />
          </Cell>

          {/* Total — clickable, opens breakdown */}
          <div className="relative w-28">
            <div className="text-[10px] font-medium text-ink-500 uppercase tracking-wide mb-1 truncate text-right">Total</div>
            <button
              type="button"
              onClick={() => setBreakdownOpen((v) => !v)}
              className="block w-full text-right pr-1 py-0.5 rounded hover:bg-ink-100/60 transition-colors"
              title="Ver desglose"
            >
              <div className="text-sm font-semibold tabular-nums truncate">{fmt(lineTotal)}</div>
              {hasAdjustment ? (
                <div className="text-[10px] text-ink-500 tabular-nums">
                  {fmt(unit)} c/u
                  <AdjustmentChip line={line} />
                </div>
              ) : null}
            </button>
            {breakdownOpen && (
              <LineBreakdownPopover
                line={line}
                currency={currency}
                rates={rates}
                onClose={() => setBreakdownOpen(false)}
              />
            )}
          </div>
        </div>

        {/* Row actions */}
        <div className="flex items-center gap-0.5 self-start -mr-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-ink-400 hover:text-ink-900 p-1.5 rounded hover:bg-ink-100/60"
            aria-label={expanded ? 'Contraer detalles' : 'Más detalles'}
            title={expanded ? 'Contraer' : 'Más detalles'}
          >
            <ChevronDown size={15} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
          <OverflowMenu onDuplicate={onDuplicate} onRemove={onRemove} />
        </div>
      </div>

      {expanded && <ExpandedFields line={line} onChange={onChange} />}
    </li>
  );
}

function MicroMeta({ line }) {
  const parts = [
    line.reference && { label: `ref ${line.reference}`, mono: true },
    line.pageRef && { label: `p.${line.pageRef}` },
    line.dimensions && { label: line.dimensions, mono: true },
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div className="text-[10px] text-ink-500 flex flex-wrap gap-x-2 gap-y-0.5">
      {parts.map((p, i) => (
        <span key={i} className={p.mono ? 'font-mono' : ''}>{p.label}</span>
      ))}
    </div>
  );
}

function AdjustmentChip({ line }) {
  const margin = Number(line.lineMarginPct) || 0;
  const discount = Number(line.lineDiscountPct) || 0;
  const parts = [];
  if (margin) parts.push(`${margin > 0 ? '+' : ''}${margin}%`);
  if (discount) parts.push(`–${discount}%`);
  return <span className="ml-1 text-brand-700">{parts.join(' ')}</span>;
}

function Cell({ label, width = '', children }) {
  return (
    <div className={width}>
      <div className="text-[10px] font-medium text-ink-500 uppercase tracking-wide mb-1 truncate">{label}</div>
      {children}
    </div>
  );
}

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
        className="text-ink-400 hover:text-ink-900 p-1.5 rounded hover:bg-ink-100/60"
        aria-label="Más acciones"
        title="Más acciones"
      >
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className="absolute right-0 mt-1.5 w-44 rounded-md border border-ink-200 bg-white shadow-pop py-1 z-30">
          {onDuplicate && (
            <button
              type="button"
              onClick={() => { onDuplicate(); setOpen(false); }}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-ink-50 inline-flex items-center gap-2"
            >
              <Copy size={13} className="text-ink-500" />
              Duplicar línea
            </button>
          )}
          <button
            type="button"
            onClick={() => { onRemove(); setOpen(false); }}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-red-50 text-red-600 inline-flex items-center gap-2"
          >
            <Trash2 size={13} />
            Eliminar línea
          </button>
        </div>
      )}
    </div>
  );
}

function ExpandedFields({ line, onChange }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 bg-ink-50 rounded-md p-3 border border-ink-100">
      <Field label="Familia">
        <DebouncedInput
          className="input"
          placeholder="AMÉDÉE, LIGHTING…"
          value={line.family || ''}
          onCommit={(v) => onChange({ family: v })}
        />
      </Field>
      <Field label="Subtipo / grado / acabado" className="sm:col-span-2">
        <DebouncedInput
          className="input"
          placeholder="Grade C — PAMPA"
          value={line.subtype || ''}
          onCommit={(v) => onChange({ subtype: v })}
        />
      </Field>
      <Field label="Pág. PDF">
        <DebouncedInput
          className="input"
          placeholder="85"
          value={line.pageRef || ''}
          onCommit={(v) => onChange({ pageRef: v })}
        />
      </Field>
      <Field label="Dimensiones" className="sm:col-span-2">
        <DebouncedInput
          className="input"
          placeholder="H 33  W 30¼  D 32¼  S 15"
          value={line.dimensions || ''}
          onCommit={(v) => onChange({ dimensions: v })}
        />
      </Field>
      <Field label="Yardage">
        <DebouncedInput
          className="input"
          placeholder="2.40yd"
          value={line.yardage || ''}
          onCommit={(v) => onChange({ yardage: v })}
        />
      </Field>
      <Field label="Margen %">
        <DebouncedInput
          type="number"
          className="input"
          value={line.lineMarginPct ?? 0}
          onCommit={(v) => onChange({ lineMarginPct: Number(v) || 0 })}
        />
      </Field>
      <Field label="Descuento %">
        <DebouncedInput
          type="number"
          min="0"
          max="100"
          className="input"
          value={line.lineDiscountPct ?? 0}
          onCommit={(v) => onChange({ lineDiscountPct: clampPct(v) })}
        />
      </Field>
      <Field label="Descripción (visible en el PDF)" className="col-span-2 sm:col-span-4">
        <DebouncedTextarea
          className="input min-h-[60px]"
          placeholder="Descripción del PDF de tarifa…"
          value={line.description || ''}
          onCommit={(v) => onChange({ description: v })}
        />
      </Field>
      <Field label="Notas internas" className="col-span-2 sm:col-span-4">
        <DebouncedTextarea
          className="input min-h-[60px]"
          placeholder="p. ej. cojín extra, COM"
          value={line.notes || ''}
          onCommit={(v) => onChange({ notes: v })}
        />
      </Field>
    </div>
  );
}

function Field({ label, className = '', children }) {
  return (
    <div className={className}>
      <div className="text-[10px] font-medium text-ink-500 uppercase tracking-wide mb-1 truncate">{label}</div>
      {children}
    </div>
  );
}
