import { useMemo, useState } from 'react';
import { FileText, Send, Settings as SettingsIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import { formatMoney, formatDate } from '../../lib/format.js';
import { downloadCsv } from '../../lib/csv.js';
import { linesByQuoteId } from '../../core/quote/totals.js';
import { quoteFloorSaleRows } from '../../core/bridge/index.js';
import {
  resolveLrSales, lrSalesCsv, lrSalesEmail, monthLabel, monthRange, previousMonth,
} from '../../core/accounting/index.js';

// Sell-through table columns (Shopify "edit columns"). Fecha is the fixed
// identity anchor (`canHide: false`); everything else toggles. This table uses
// the report's own `w-full text-sm` styling (not the shared `.table`), so the
// thead/td padding + alignment classes are carried verbatim on each column.
// `cell` is a pure render off the per-row `ctx`.
const LRSALES_COLUMNS = [
  {
    key: 'date', label: 'Fecha', canHide: false,
    thClass: 'text-left py-2 px-3 whitespace-nowrap', tdClass: 'py-1.5 px-3 text-ink-500 whitespace-nowrap',
    cell: ({ r }) => formatDate(r.date),
  },
  {
    key: 'number', label: '#',
    thClass: 'text-left py-2 px-3 whitespace-nowrap', tdClass: 'py-1.5 px-3 tabular-nums text-ink-400 whitespace-nowrap',
    cell: ({ r }) => r.quoteNumber ?? '—',
  },
  {
    key: 'customer', label: 'Cliente',
    thClass: 'text-left py-2 px-3', tdClass: 'py-1.5 px-3 min-w-0',
    cell: ({ r }) => r.customer || '—',
  },
  {
    key: 'reference', label: 'Referencia',
    thClass: 'text-left py-2 px-3 whitespace-nowrap', tdClass: 'py-1.5 px-3 tabular-nums text-ink-500 whitespace-nowrap',
    cell: ({ r }) => r.reference || '—',
  },
  {
    key: 'product', label: 'Producto',
    thClass: 'text-left py-2 px-3', tdClass: 'py-1.5 px-3 min-w-0',
    cell: ({ r }) => r.product || '—',
  },
  {
    key: 'fabric', label: 'Tela',
    thClass: 'text-left py-2 px-3', tdClass: 'py-1.5 px-3 text-ink-500 min-w-0',
    cell: ({ r }) => r.fabric || '—',
  },
  {
    key: 'qty', label: 'Cant.',
    thClass: 'text-right py-2 px-3 whitespace-nowrap', tdClass: 'py-1.5 px-3 text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => r.qty,
  },
  {
    key: 'unitUsd', label: 'Unit. (USD)',
    thClass: 'text-right py-2 px-3 whitespace-nowrap', tdClass: 'py-1.5 px-3 text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => formatMoney(r.unitUsd, 'USD'),
  },
  {
    key: 'totalUsd', label: 'Total (USD)',
    thClass: 'text-right py-2 px-3 whitespace-nowrap', tdClass: 'py-1.5 px-3 text-right tabular-nums font-medium whitespace-nowrap',
    cell: ({ r }) => formatMoney(r.totalUsd, 'USD'),
  },
];
const LRSALES_DEFAULT = {
  number: true, customer: true, reference: true, product: true, fabric: true, qty: true, unitUsd: true, totalUsd: true,
};

// "YYYY-MM" ⇄ { year, monthIndex } for the <input type="month"> control.
function toMonthValue({ year, monthIndex }) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}
function fromMonthValue(value) {
  const [y, m] = String(value || '').split('-').map(Number);
  return { year: y, monthIndex: (m || 1) - 1 };
}

/**
 * Ventas Ligne Roset — the monthly supplier sell-through report. Lists our floor
 * sales (accepted quotes not tied to an import order, recognized at the
 * deposit) for a chosen month, one row per product sold, and exports the CSV +
 * opens a prefilled email draft to Ligne Roset in one click. Defaults to last
 * month (what you send on the 15th). Self-gates on accounting/admin.
 */
export default function LigneRosetSales() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';

  const quotesQ = useLiveQueryStatus(() => db.quotes.where('profileId').equals(scope).toArray(), [scope], []);
  const linesQ = useLiveQueryStatus(() => db.quoteLines.toArray(), [], []);
  const customersQ = useLiveQueryStatus(() => db.customers.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = quotesQ.loaded && linesQ.loaded && customersQ.loaded;

  const [monthValue, setMonthValue] = useState(() => toMonthValue(previousMonth()));
  const { year, monthIndex } = fromMonthValue(monthValue);
  const label = monthLabel(year, monthIndex);

  const customersById = useMemo(() => new Map(customersQ.data.map((c) => [c.id, c])), [customersQ.data]);
  // CRM lines → priced floor-sale rows across the bridge; the accounting report
  // VM (resolveLrSales) only filters + aggregates these, never prices a line.
  const floorRowsByQuote = useMemo(() => {
    const byQuote = linesByQuoteId(linesQ.data);
    const out = new Map();
    for (const [quoteId, lines] of byQuote) out.set(quoteId, quoteFloorSaleRows({ lines }));
    return out;
  }, [linesQ.data]);

  const report = useMemo(() => {
    const { start, end } = monthRange(year, monthIndex);
    return resolveLrSales({ quotes: quotesQ.data, floorRowsByQuote, customersById, start, end });
  }, [quotesQ.data, floorRowsByQuote, customersById, year, monthIndex]);

  const recipient = settings?.lrReportEmail || '';

  // Column visibility (Shopify "edit columns"), persisted per browser.
  const cols = useColumns(LRSALES_COLUMNS, LRSALES_DEFAULT, 'rs.lrsales.cols.v1');
  // Drag-to-resize widths (persisted) for the same visible columns. The hook is
  // class-agnostic, so it works on this report's hand-rolled `w-full text-sm`
  // table just as it does on a `.table`.
  const colW = useColumnWidths(cols.cols, 'rs.lrsales.widths.v1');

  function exportAndSend() {
    if (report.lineCount === 0) return;
    // 1) Download the CSV. 2) Open the email client with a prefilled draft to
    // Ligne Roset (the file is attached manually — a mailto: can't carry one).
    downloadCsv(`Ventas Ligne Roset ${label}.csv`, lrSalesCsv(report));
    const { subject, body } = lrSalesEmail({ label, report, companyName: settings?.companyName });
    const to = recipient ? encodeURIComponent(recipient) : '';
    window.location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  return (
    <AccountingGate title="Ventas Ligne Roset">
      <PageHeader title="Ventas Ligne Roset"
        subtitle="Reporte mensual de ventas de piso para el proveedor" />

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <div className="label">Mes a reportar</div>
          <input type="month" value={monthValue} onChange={(e) => setMonthValue(e.target.value)}
            className="input w-auto" />
        </div>
        <button type="button" onClick={exportAndSend} disabled={report.lineCount === 0}
          className="btn-primary">
          <Send size={15} /> <span className="hidden sm:inline">Exportar y enviar a Ligne Roset</span><span className="sm:hidden">Exportar</span>
        </button>
      </div>

      {!recipient && (
        <p className="text-xs text-ink-500 mb-4 inline-flex items-center gap-1.5">
          <SettingsIcon size={13} />
          Define el correo de Ligne Roset en <Link to="/settings" className="underline">Configuración</Link> para
          que el borrador salga listo con el destinatario.
        </p>
      )}

      {!loaded ? <ListLoading /> : report.lineCount === 0 ? (
        <EmptyState icon={FileText} title={`Sin ventas de piso en ${label}`}
          description="Aquí aparecen las ventas de piso (cotizaciones aceptadas con depósito, sin orden de importación) del mes elegido." />
      ) : (
        <div className="card overflow-hidden">
          <div className="px-3 py-2 text-xs text-ink-500 bg-ink-50 border-b border-ink-100">
            {report.salesCount} venta{report.salesCount === 1 ? '' : 's'} · {report.lineCount} artículo{report.lineCount === 1 ? '' : 's'} · {label}
          </div>
          <div className="hidden md:flex justify-end px-3 pt-2 -mb-1">
            <ColumnsMenu columns={cols.columns} visible={cols.visible} onChange={cols.setVisible} onReset={() => { cols.reset(); colW.reset(); }} />
          </div>
          <div className="overflow-x-auto">
          <table ref={colW.tableRef} style={colW.tableStyle} className="w-full text-sm min-w-[640px]">
            <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
              <tr>
                {cols.cols.map((col) => (
                  <th key={col.key} className={col.thClass || ''} {...colW.thProps(col.key)}>{col.label}{colW.ResizeHandle(col.key)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => {
                const ctx = { r };
                return (
                  <tr key={r.id} className="border-t border-ink-50">
                    {cols.cols.map((col) => (
                      <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              {(() => {
                // "Total" label spans the visible columns BEFORE the qty column;
                // qty / unit / total then carry their own footer cells (unit is
                // blank). Hiding columns shrinks the colSpan to match.
                const leading = cols.cols.filter((c) => !['qty', 'unitUsd', 'totalUsd'].includes(c.key)).length;
                return (
                  <tr className="border-t border-ink-200 font-semibold">
                    {leading > 0 && <td className="py-2 px-3" colSpan={leading}>Total</td>}
                    {cols.cols.some((c) => c.key === 'qty') && <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{report.totals.qty}</td>}
                    {cols.cols.some((c) => c.key === 'unitUsd') && <td className="py-2 px-3"></td>}
                    {cols.cols.some((c) => c.key === 'totalUsd') && <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatMoney(report.totals.usd, 'USD')}</td>}
                  </tr>
                );
              })()}
            </tfoot>
          </table>
          </div>
        </div>
      )}
    </AccountingGate>
  );
}
