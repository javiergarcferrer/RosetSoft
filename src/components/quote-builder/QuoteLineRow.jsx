import { Trash2 } from 'lucide-react';
import ImageDrop from '../ImageDrop.jsx';
import { DebouncedInput, DebouncedTextarea } from '../DebouncedInput.jsx';
import { applyLineAdjustments, clampPct } from '../../lib/pricing.js';
import { formatMoney } from '../../lib/format.js';

/**
 * Desktop table row for a quote line. The line carries its own copy of every
 * field (family / reference / name / subtype / dimensions / yardage / image
 * / description / unit price) — there is no normalized catalog it points
 * back to. The user types everything in by reading the source price list
 * PDF in the side panel.
 *
 * The second row hosts the expanded edit panel so it stays attached to its
 * parent line when the table wraps to a new page.
 */
export default function QuoteLineRow({ line, quote, onChange, onRemove }) {
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
          <DebouncedInput
            className="input mb-1 font-semibold text-sm"
            placeholder="Nombre del artículo (p. ej. ARMCHAIR PART A)"
            value={line.name || ''}
            onCommit={(v) => onChange({ name: v })}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <DebouncedInput
              className="input text-xs"
              placeholder="Familia (AMÉDÉE, LIGHTING…)"
              value={line.family || ''}
              onCommit={(v) => onChange({ family: v })}
            />
            <DebouncedInput
              className="input text-xs"
              placeholder="Subtipo / grado / acabado"
              value={line.subtype || ''}
              onCommit={(v) => onChange({ subtype: v })}
            />
          </div>
        </td>
        <td>
          <DebouncedInput
            className="input font-mono text-xs"
            placeholder="18211150"
            value={line.reference || ''}
            onCommit={(v) => onChange({ reference: v })}
          />
          <DebouncedInput
            className="input text-[11px] mt-1"
            placeholder="Pág. 85"
            value={line.pageRef || ''}
            onCommit={(v) => onChange({ pageRef: v })}
          />
        </td>
        <td>
          <input
            type="number"
            min="0"
            className="input text-right"
            value={line.qty ?? 1}
            onChange={(e) => onChange({ qty: Math.max(0, Number(e.target.value) || 0) })}
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
        <td>
          <button onClick={onRemove} className="text-ink-400 hover:text-red-600" aria-label="Eliminar">
            <Trash2 size={14} />
          </button>
        </td>
      </tr>
      <tr>
        <td colSpan={7} className="!py-2 !border-b-0 border-b border-ink-50">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 px-3 py-2 bg-ink-50 rounded">
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
    </>
  );
}
