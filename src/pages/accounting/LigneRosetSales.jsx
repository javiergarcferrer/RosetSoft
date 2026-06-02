import { useMemo, useState } from 'react';
import { Shield, FileText, Send, Settings as SettingsIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatMoney, formatDate } from '../../lib/format.js';
import { downloadCsv } from '../../lib/csv.js';
import { linesByQuoteId } from '../../core/quote/totals.js';
import { quoteFloorSaleRows } from '../../core/bridge/index.js';
import {
  resolveLrSales, lrSalesCsv, lrSalesEmail, monthLabel, monthRange, previousMonth,
} from '../../core/accounting/index.js';

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
  const { profileId, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
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

  function exportAndSend() {
    if (report.lineCount === 0) return;
    // 1) Download the CSV. 2) Open the email client with a prefilled draft to
    // Ligne Roset (the file is attached manually — a mailto: can't carry one).
    downloadCsv(`Ventas Ligne Roset ${label}.csv`, lrSalesCsv(report));
    const { subject, body } = lrSalesEmail({ label, report, companyName: settings?.companyName });
    const to = recipient ? encodeURIComponent(recipient) : '';
    window.location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  if (!allowed) {
    return (
      <>
        <PageHeader title="Ventas Ligne Roset" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Ventas Ligne Roset"
        subtitle="Reporte mensual de ventas de piso para el proveedor" />

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div>
          <div className="label">Mes a reportar</div>
          <input type="month" value={monthValue} onChange={(e) => setMonthValue(e.target.value)}
            className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm" />
        </div>
        <button type="button" onClick={exportAndSend} disabled={report.lineCount === 0}
          className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
          <Send size={15} /> Exportar y enviar a Ligne Roset
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
          <div className="px-3 py-2 text-xs text-ink-500 bg-ink-50">
            {report.salesCount} venta{report.salesCount === 1 ? '' : 's'} · {report.lineCount} artículo{report.lineCount === 1 ? '' : 's'} · {label}
          </div>
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left py-2 px-3">Fecha</th>
                <th className="text-left py-2 px-3">#</th>
                <th className="text-left py-2 px-3">Cliente</th>
                <th className="text-left py-2 px-3">Referencia</th>
                <th className="text-left py-2 px-3">Producto</th>
                <th className="text-left py-2 px-3">Tela</th>
                <th className="text-right py-2 px-3">Cant.</th>
                <th className="text-right py-2 px-3">Unit. (USD)</th>
                <th className="text-right py-2 px-3">Total (USD)</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.id} className="border-t border-ink-50">
                  <td className="py-1.5 px-3 text-ink-500 whitespace-nowrap">{formatDate(r.date)}</td>
                  <td className="py-1.5 px-3 tabular-nums text-ink-400">{r.quoteNumber ?? '—'}</td>
                  <td className="py-1.5 px-3">{r.customer || '—'}</td>
                  <td className="py-1.5 px-3 tabular-nums text-ink-500">{r.reference || '—'}</td>
                  <td className="py-1.5 px-3">{r.product || '—'}</td>
                  <td className="py-1.5 px-3 text-ink-500">{r.fabric || '—'}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{r.qty}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{formatMoney(r.unitUsd, 'USD')}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-medium">{formatMoney(r.totalUsd, 'USD')}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-ink-200 font-semibold">
                <td className="py-2 px-3" colSpan={6}>Total</td>
                <td className="py-2 px-3 text-right tabular-nums">{report.totals.qty}</td>
                <td className="py-2 px-3"></td>
                <td className="py-2 px-3 text-right tabular-nums">{formatMoney(report.totals.usd, 'USD')}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}
