import { useEffect, useRef, useState } from 'react';
import { Trash2, ChevronDown } from 'lucide-react';
import ImageDrop from '../ImageDrop.jsx';
import { DebouncedInput, DebouncedTextarea } from '../DebouncedInput.jsx';
import { applyLineAdjustments, clampPct } from '../../lib/pricing.js';
import { formatMoney } from '../../lib/format.js';

/**
 * One line item, rendered the same way at every viewport size — no `<table>`,
 * no `overflow-x-auto`. Fields are laid out with `flex flex-wrap` so they
 * line up horizontally when the column is wide and wrap onto extra rows when
 * it's narrow (e.g. when the PDF side panel is open). This guarantees no
 * horizontal scroll ever appears.
 *
 * The line carries its own copy of every field (family / reference / name /
 * subtype / dimensions / yardage / description / page_ref / image_id / unit
 * price) so this component just renders what the user typed — there's no
 * catalog lookup.
 */
export default function QuoteLineItem({ line, quote, onChange, onRemove, autoFocus }) {
  const [expanded, setExpanded] = useState(false);
  const refInput = useRef(null);

  useEffect(() => {
    if (autoFocus && refInput.current) {
      refInput.current.focus();
      refInput.current.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
  }, [autoFocus]);

  const unit = applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
  const lineTotal = unit * (line.qty || 0);
  const fmt = (v) => formatMoney(v, quote.currencyCode || 'USD', quote.rates || { USD: 1 });

  return (
    <li className="p-3 sm:p-4">
      <div className="flex flex-wrap items-start gap-3">
        <ImageDrop
          imageId={line.imageId}
          onChange={(id) => onChange({ imageId: id })}
          kind="quote-line"
          ownerId={line.id}
          label=""
          imgClassName="w-16 h-16 object-contain bg-white border border-ink-100 rounded"
          allowUrl={false}
        />

        {/* Identity block: family pill on top, name input bold, subtype below */}
        <div className="flex-1 min-w-[180px] space-y-1">
          {line.family ? (
            <div className="text-[9px] font-medium uppercase tracking-widest text-ink-500">
              {line.family}
            </div>
          ) : null}
          <DebouncedInput
            className="input font-semibold text-sm w-full"
            placeholder="Nombre del artículo"
            value={line.name || ''}
            onCommit={(v) => onChange({ name: v })}
          />
          {line.subtype ? (
            <div className="text-[11px] text-ink-500 break-words" title={line.subtype}>
              {line.subtype}
            </div>
          ) : null}
        </div>

        {/* Numeric block: ref / qty / unit / total. Each cell labelled so the
            user knows what they're typing into when the block wraps below
            the identity area. */}
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Ref." width="w-28">
            <DebouncedInput
              ref={refInput}
              className="input font-mono text-xs"
              placeholder="18211150"
              value={line.reference || ''}
              onCommit={(v) => onChange({ reference: v })}
            />
          </Field>
          <Field label="Cant." width="w-16">
            <DebouncedInput
              type="number"
              min="0"
              className="input text-right"
              value={line.qty ?? 1}
              onCommit={(v) => onChange({ qty: Math.max(0, Number(v) || 0) })}
            />
          </Field>
          <Field label="Unit. $" width="w-24">
            <DebouncedInput
              type="number"
              min="0"
              className="input text-right"
              placeholder="0"
              value={line.unitPrice ?? ''}
              onCommit={(v) => onChange({ unitPrice: Math.max(0, Number(v) || 0) })}
            />
          </Field>
          <div className="w-24 text-right">
            <div className="text-[10px] font-medium text-ink-500 uppercase tracking-wide mb-1">Total</div>
            <div className="text-sm font-semibold tabular-nums truncate">{fmt(lineTotal)}</div>
            {(line.lineMarginPct || line.lineDiscountPct) ? (
              <div className="text-[10px] text-ink-500">{fmt(unit)} c/u</div>
            ) : null}
          </div>
        </div>

        {/* Row actions — kept compact so they always fit on the same line as
            the image; if the rest of the row wraps below them, the buttons
            still sit at the right edge. */}
        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-ink-400 hover:text-ink-900 p-1"
            aria-label={expanded ? 'Contraer' : 'Más detalles'}
            title={expanded ? 'Contraer' : 'Más detalles'}
          >
            <ChevronDown size={16} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
          <button
            onClick={onRemove}
            className="text-ink-400 hover:text-red-600 p-1"
            aria-label="Eliminar"
            title="Eliminar"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 bg-ink-50 rounded p-3">
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
      )}
    </li>
  );
}

function Field({ label, width = '', className = '', children }) {
  return (
    <div className={`${width} ${className}`}>
      <div className="text-[10px] font-medium text-ink-500 uppercase tracking-wide mb-1 truncate">{label}</div>
      {children}
    </div>
  );
}
