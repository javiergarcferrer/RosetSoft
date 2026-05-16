import { useEffect, useRef, useState } from 'react';
import { Trash2, ChevronDown } from 'lucide-react';
import ImageDrop from '../ImageDrop.jsx';
import { DebouncedInput, DebouncedTextarea } from '../DebouncedInput.jsx';
import { applyLineAdjustments, clampPct } from '../../lib/pricing.js';
import { formatMoney } from '../../lib/format.js';
import QtyStepper from './QtyStepper.jsx';

/**
 * Mobile card for a quote line. Mirrors QuoteLineRow's field set but in a
 * stacked layout: image + name/reference up top, qty stepper + price in
 * the middle, and a collapsible "Más detalles" panel for dimensions /
 * yardage / margin / discount / description / notes.
 */
export default function QuoteLineCard({ line, quote, onChange, onRemove, autoFocus }) {
  const [expanded, setExpanded] = useState(false);
  const refInput = useRef(null);
  useEffect(() => {
    if (autoFocus && refInput.current) {
      refInput.current.focus();
      refInput.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [autoFocus]);
  const unit = applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
  const lineTotal = unit * (line.qty || 0);
  const fmt = (v) => formatMoney(v, quote.currencyCode || 'USD', quote.rates || { USD: 1 });
  return (
    <li className="px-4 py-3 space-y-3">
      <div className="flex items-start gap-3">
        <ImageDrop
          imageId={line.imageId}
          onChange={(id) => onChange({ imageId: id })}
          kind="quote-line"
          ownerId={line.id}
          label=""
          imgClassName="w-20 h-20 object-contain bg-white border border-ink-100 rounded flex-shrink-0"
          allowUrl={false}
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <DebouncedInput
            className="input font-semibold text-sm"
            placeholder="Nombre del artículo"
            value={line.name || ''}
            onCommit={(v) => onChange({ name: v })}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <DebouncedInput
              className="input text-xs"
              placeholder="Familia"
              value={line.family || ''}
              onCommit={(v) => onChange({ family: v })}
            />
            <DebouncedInput
              ref={refInput}
              className="input font-mono text-xs"
              placeholder="Ref."
              value={line.reference || ''}
              onCommit={(v) => onChange({ reference: v })}
            />
          </div>
          <DebouncedInput
            className="input text-xs"
            placeholder="Subtipo / grado / acabado"
            value={line.subtype || ''}
            onCommit={(v) => onChange({ subtype: v })}
          />
        </div>
        <button onClick={onRemove} className="text-ink-400 hover:text-red-600 p-2 -m-2" aria-label="Eliminar">
          <Trash2 size={16} />
        </button>
      </div>

      <div className="flex items-center justify-between gap-3">
        <QtyStepper value={line.qty ?? 1} onChange={(q) => onChange({ qty: q })} />
        <div className="flex items-center gap-2 flex-1 justify-end">
          <span className="text-xs text-ink-500">Unit. $</span>
          <DebouncedInput
            type="number"
            min="0"
            className="input w-24 text-right"
            placeholder="0"
            value={line.unitPrice ?? ''}
            onCommit={(v) => onChange({ unitPrice: Math.max(0, Number(v) || 0) })}
          />
        </div>
      </div>
      <div className="text-right">
        <div className="text-base font-semibold">{fmt(lineTotal)}</div>
        {(line.lineMarginPct || line.lineDiscountPct) ? (
          <div className="text-[11px] text-ink-500">{fmt(unit)} c/u después de ajustes</div>
        ) : null}
      </div>

      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between text-xs text-ink-500 hover:text-ink-900 py-2 border-t border-ink-100"
      >
        <span>Dimensiones / yardage / margen / descuento / notas</span>
        <ChevronDown size={14} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="grid grid-cols-2 gap-3 bg-ink-50 rounded p-3">
          <div className="col-span-2">
            <div className="label">Dimensiones</div>
            <DebouncedInput
              className="input"
              placeholder="H 33 · W 30¼ · D 32¼ · S 15"
              value={line.dimensions || ''}
              onCommit={(v) => onChange({ dimensions: v })}
            />
          </div>
          <div>
            <div className="label">Yardage</div>
            <DebouncedInput
              className="input"
              placeholder="2.40yd"
              value={line.yardage || ''}
              onCommit={(v) => onChange({ yardage: v })}
            />
          </div>
          <div>
            <div className="label">Pág. PDF</div>
            <DebouncedInput
              className="input"
              placeholder="85"
              value={line.pageRef || ''}
              onCommit={(v) => onChange({ pageRef: v })}
            />
          </div>
          <div>
            <div className="label">Margen %</div>
            <DebouncedInput
              type="number"
              className="input"
              value={line.lineMarginPct ?? 0}
              onCommit={(v) => onChange({ lineMarginPct: Number(v) || 0 })}
            />
          </div>
          <div>
            <div className="label">Descuento %</div>
            <DebouncedInput
              type="number"
              min="0"
              max="100"
              className="input"
              value={line.lineDiscountPct ?? 0}
              onCommit={(v) => onChange({ lineDiscountPct: clampPct(v) })}
            />
          </div>
          <div className="col-span-2">
            <div className="label">Descripción (visible en el PDF)</div>
            <DebouncedTextarea
              className="input min-h-[60px]"
              value={line.description || ''}
              onCommit={(v) => onChange({ description: v })}
            />
          </div>
          <div className="col-span-2">
            <div className="label">Notas internas</div>
            <DebouncedTextarea
              className="input min-h-[60px]"
              value={line.notes || ''}
              onCommit={(v) => onChange({ notes: v })}
            />
          </div>
        </div>
      )}
    </li>
  );
}
