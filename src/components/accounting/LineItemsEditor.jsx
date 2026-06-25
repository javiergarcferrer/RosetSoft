import { Plus, Trash2 } from 'lucide-react';

/**
 * LineItemsEditor — the shared editable line grid for accounting entries
 * (compra por líneas, mercancía, factura de venta…). One component so every
 * editor's line entry reads the same, the way an ERP sublist does
 * (NetSuite/Odoo): a real aligned TABLE on desktop, and STACKED labeled line
 * blocks on a phone (never a horizontally-scrolled mini-table squeezed into a
 * card). A trailing "Agregar línea" footer; a per-row delete.
 *
 * `columns`: [{
 *   key,                       // stable id
 *   header,                    // column label
 *   headerHint?,               // small muted note after the header (desktop)
 *   width?: 'w-28',            // desktop column width (numeric/short cols)
 *   align?: 'right',           // desktop cell + mobile value alignment
 *   render: (row, i) => node,  // the editor control (or a display node)
 * }]
 * `rows`, `onAdd`, `onDelete(row,i)`, `addLabel`, optional `addHint`.
 */
export default function LineItemsEditor({ columns, rows, onAdd, onDelete, addLabel = 'Agregar línea', addHint }) {
  const cols = (columns || []).filter(Boolean);
  return (
    <div className="rounded-lg border border-ink-200 overflow-hidden bg-surface">
      {/* Desktop: aligned table */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-ink-50/70 border-b border-ink-100">
              {cols.map((c) => (
                <th key={c.key}
                  className={`px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-500 ${c.align === 'right' ? 'text-right' : 'text-left'} ${c.width || ''}`}>
                  {c.header}{c.headerHint && <span className="ml-1 normal-case font-normal text-ink-400">{c.headerHint}</span>}
                </th>
              ))}
              <th className="w-9 px-1" aria-label="" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.id ?? i} className="border-b border-ink-100 last:border-0 align-middle">
                {cols.map((c) => (
                  <td key={c.key} className={`px-2.5 py-1.5 ${c.align === 'right' ? 'text-right' : ''}`}>{c.render(row, i)}</td>
                ))}
                <td className="px-1 py-1.5 text-right">
                  <button type="button" onClick={() => onDelete(row, i)} className="btn-icon-danger" title="Eliminar línea" aria-label="Eliminar línea"><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: one labeled block per line */}
      <div className="sm:hidden divide-y divide-ink-100">
        {rows.map((row, i) => (
          <div key={row.id ?? i} className="px-3 py-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="eyebrow-xs text-ink-400">Línea {i + 1}</span>
              <button type="button" onClick={() => onDelete(row, i)} className="btn-icon-danger -mr-1" title="Eliminar línea" aria-label="Eliminar línea"><Trash2 size={14} /></button>
            </div>
            <div className="space-y-2">
              {cols.map((c) => (
                <div key={c.key} className="flex items-baseline gap-3 min-w-0">
                  <span className="w-24 shrink-0 text-[11px] font-medium text-ink-500 leading-tight">{c.header}</span>
                  <div className={`min-w-0 flex-1 ${c.align === 'right' ? 'text-right' : ''}`}>{c.render(row, i)}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Add-line footer — spans the whole grid, reads as part of the table */}
      <button type="button" onClick={onAdd}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-brand-600 hover:bg-ink-50 border-t border-ink-100 transition-colors">
        <Plus size={14} /> {addLabel}
        {addHint && <span className="text-ink-400 font-normal hidden sm:inline">· {addHint}</span>}
      </button>
    </div>
  );
}
