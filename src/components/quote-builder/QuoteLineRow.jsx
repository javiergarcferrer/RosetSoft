import { useEffect, useRef, useState } from 'react';
import { Trash2, ChevronDown } from 'lucide-react';
import ImageDrop from '../ImageDrop.jsx';
import { DebouncedInput, DebouncedTextarea } from '../DebouncedInput.jsx';
import { applyLineAdjustments, clampPct } from '../../lib/pricing.js';
import { formatMoney } from '../../lib/format.js';

/**
 * Desktop table row for a quote line. Optimized for "I'm looking at a row
 * in the price-list PDF, transcribe it" speed:
 *
 *   - Reference is the leftmost text input + auto-focused on a fresh line
 *   - Tab order flows ref → name → qty → unit price (matches reading order)
 *   - Family / subtype / dimensions / yardage / margin / discount /
 *     description / notes are collapsed by default behind a chevron;
 *     reveal them only when the line needs them
 *
 * The expansion panel lives in a second <tr> so it page-breaks with its
 * parent when the table wraps onto a new printed page.
 */
export default function QuoteLineRow({ line, quote, onChange, onRemove, autoFocus }) {
  const [expanded, setExpanded] = useState(false);
  const refInput = useRef(null);

  useEffect(() => {
    if (autoFocus && refInput.current) refInput.current.focus();
  }, [autoFocus]);

  const unit = applyLineAdjustments(line.unitPrice, line.lineMarginPct, line.lineDiscountPct);
  const lineTotal = unit * (line.qty || 0);
  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
  return (
    <>
      <tr className="align-top">
        <td>
          <ImageDrop
            imageId={line.imageId}
            onChange={(id) => onChange({ imageId: id })}
            kind="quote-line"
            ownerId={line.id}
            label=""
            imgClassName="w-16 h-16 object-contain bg-white border border-ink-100 rounded"
            allowUrl={false}
          />
        </td>
        <td>
          {line.family && (
            <div className="text-[9px] font-medium uppercase tracking-wider text-ink-500 mb-0.5">{line.family}</div>
          )}
          <DebouncedInput
            className="input font-semibold text-sm"
            placeholder="Nombre del artículo (p. ej. ARMCHAIR PART A)"
            value={line.name || ''}
            onCommit={(v) => onChange({ name: v })}
          />
          {line.subtype && (
            <div className="text-[11px] text-ink-500 mt-0.5 truncate" title={line.subtype}>{line.subtype}</div>
          )}
        </td>
        <td>
          <DebouncedInput
            ref={refInput}
            className="input font-mono text-xs"
            placeholder="18211150"
            value={line.reference || ''}
            onCommit={(v) => onChange({ reference: v })}
          />
          {line.pageRef && (
            <div className="text-[10px] text-ink-500 mt-0.5">Pág. {line.pageRef}</div>
          )}
        </td>
        <td>
          <DebouncedInput
            type="number"
            min="0"
            className="input text-right"
            value={line.qty ?? 1}
            onCommit={(v) => onChange({ qty: Math.max(0, Number(v) || 0) })}
          />
        </td>
        <td className="text-right">
          <DebouncedInput
            type="number"
            min="0"
            className="input text-right"
            placeholder="0"
            value={line.unitPrice ?? ''}
            onCommit={(v) => onChange({ unitPrice: Math.max(0, Number(v) || 0) })}
          />
          {(line.lineMarginPct || line.lineDiscountPct) ? (
            <div className="text-[10px] text-ink-500 mt-0.5">→ {formatMoney(unit, currency, rates)}</div>
          ) : null}
        </td>
        <td className="text-right font-medium">{formatMoney(lineTotal, currency, rates)}</td>
        <td className="text-right">
          <div className="inline-flex items-center gap-1">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-ink-400 hover:text-ink-900 p-0.5"
              aria-label={expanded ? 'Contraer' : 'Más detalles'}
              title={expanded ? 'Contraer' : 'Más detalles'}
            >
              <ChevronDown size={14} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
            <button onClick={onRemove} className="text-ink-400 hover:text-red-600 p-0.5" aria-label="Eliminar">
              <Trash2 size={14} />
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="!py-2 !border-b-0 border-b border-ink-50">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 px-3 py-2 bg-ink-50 rounded">
              <div>
                <div className="text-[10px] font-medium text-ink-500 uppercase">Familia</div>
                <DebouncedInput
                  className="input mt-1"
                  placeholder="AMÉDÉE, LIGHTING…"
                  value={line.family || ''}
                  onCommit={(v) => onChange({ family: v })}
                />
              </div>
              <div className="sm:col-span-2">
                <div className="text-[10px] font-medium text-ink-500 uppercase">Subtipo / grado / acabado</div>
                <DebouncedInput
                  className="input mt-1"
                  placeholder="Grade C — PAMPA"
                  value={line.subtype || ''}
                  onCommit={(v) => onChange({ subtype: v })}
                />
              </div>
              <div>
                <div className="text-[10px] font-medium text-ink-500 uppercase">Pág. PDF</div>
                <DebouncedInput
                  className="input mt-1"
                  placeholder="85"
                  value={line.pageRef || ''}
                  onCommit={(v) => onChange({ pageRef: v })}
                />
              </div>
              <div className="sm:col-span-2">
                <div className="text-[10px] font-medium text-ink-500 uppercase">Dimensiones</div>
                <DebouncedInput
                  className="input mt-1"
                  placeholder='H 33  W 30¼  D 32¼  S 15'
                  value={line.dimensions || ''}
                  onCommit={(v) => onChange({ dimensions: v })}
                />
              </div>
              <div>
                <div className="text-[10px] font-medium text-ink-500 uppercase">Yardage</div>
                <DebouncedInput
                  className="input mt-1"
                  placeholder="2.40yd"
                  value={line.yardage || ''}
                  onCommit={(v) => onChange({ yardage: v })}
                />
              </div>
              <div>
                <div className="text-[10px] font-medium text-ink-500 uppercase">Margen %</div>
                <DebouncedInput
                  type="number"
                  className="input mt-1"
                  value={line.lineMarginPct ?? 0}
                  onCommit={(v) => onChange({ lineMarginPct: Number(v) || 0 })}
                />
              </div>
              <div>
                <div className="text-[10px] font-medium text-ink-500 uppercase">Descuento %</div>
                <DebouncedInput
                  type="number"
                  min="0"
                  max="100"
                  className="input mt-1"
                  value={line.lineDiscountPct ?? 0}
                  onCommit={(v) => onChange({ lineDiscountPct: clampPct(v) })}
                />
              </div>
              <div className="sm:col-span-2">
                <div className="text-[10px] font-medium text-ink-500 uppercase">Descripción (visible en el PDF)</div>
                <DebouncedTextarea
                  className="input mt-1 min-h-[60px]"
                  placeholder="Descripción del PDF de tarifa…"
                  value={line.description || ''}
                  onCommit={(v) => onChange({ description: v })}
                />
              </div>
              <div className="sm:col-span-2">
                <div className="text-[10px] font-medium text-ink-500 uppercase">Notas internas</div>
                <DebouncedTextarea
                  className="input mt-1 min-h-[60px]"
                  placeholder="p. ej. cojín extra, COM"
                  value={line.notes || ''}
                  onCommit={(v) => onChange({ notes: v })}
                />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
