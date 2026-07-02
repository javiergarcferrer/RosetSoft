import { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { resolveVendorProfile } from '../../core/accounting/index.js';

/**
 * Proveedor 360 — pick a supplier and see its open balance, year-to-date spend
 * and retentions (ISR/ITBIS), 606 doc count and recent documents. Self-gates.
 */
export default function VendorProfile() {
  const { profileId } = useApp();
  const scope = profileId || 'team';
  const year = new Date().getFullYear();

  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const expensesQ = useLiveQueryStatus(() => db.expenses.where('profileId').equals(scope).toArray(), [scope], []);
  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const paymentsQ = useLiveQueryStatus(() => db.payments.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = suppliersQ.loaded && expensesQ.loaded && purchasesQ.loaded && paymentsQ.loaded;

  // The selected supplier is URL-driven (?supplier=id) so other pages can deep-
  // link straight to a vendor's 360 (relational navigation). The dropdown keeps
  // the URL in sync so the view stays shareable/bookmarkable.
  const [params, setParams] = useSearchParams();
  const paramSupplier = params.get('supplier') || '';
  const [sid, setSid] = useState(paramSupplier);
  useEffect(() => { setSid(paramSupplier); }, [paramSupplier]);
  function selectSupplier(id) {
    setSid(id);
    setParams(id ? { supplier: id } : {}, { replace: true });
  }
  const supplier = useMemo(() => suppliersQ.data.find((s) => s.id === sid) || null, [suppliersQ.data, sid]);
  const v = useMemo(
    () => (supplier ? resolveVendorProfile({ supplier, expenses: expensesQ.data, purchases: purchasesQ.data, payments: paymentsQ.data, year }) : null),
    [supplier, expensesQ.data, purchasesQ.data, paymentsQ.data, year],
  );

  return (
    <AccountingGate title="Proveedor 360">
      <PageHeader title="Proveedor 360" subtitle="Balance, compras y retenciones del año por proveedor — valores en RD$"
        actions={(
          <select value={sid} onChange={(e) => selectSupplier(e.target.value)} className="input sm:min-w-[220px]">
            <option value="">— Elige un proveedor —</option>
            {suppliersQ.data.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )} />

      {!loaded ? <ListLoading /> : !v ? (
        <EmptyState icon={Building2} title="Selecciona un proveedor" description="Elige un proveedor para ver su resumen 360." />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <div className="card p-3 min-w-0"><div className="eyebrow-xs text-ink-500 mb-1">Balance (CxP)</div><div className="font-display text-lg font-semibold tabular-nums whitespace-nowrap overflow-x-auto">{formatDop(v.balance)}</div></div>
            <div className="card p-3 min-w-0"><div className="eyebrow-xs text-ink-500 mb-1">Compras {year}</div><div className="font-display text-lg font-semibold tabular-nums whitespace-nowrap overflow-x-auto">{formatDop(v.ytd.spend)}</div></div>
            <div className="card p-3 min-w-0"><div className="eyebrow-xs text-ink-500 mb-1">ISR retenido {year}</div><div className="font-display text-lg font-semibold tabular-nums whitespace-nowrap overflow-x-auto">{formatDop(v.ytd.retIsr)}</div></div>
            <div className="card p-3 min-w-0"><div className="eyebrow-xs text-ink-500 mb-1">ITBIS retenido {year}</div><div className="font-display text-lg font-semibold tabular-nums whitespace-nowrap overflow-x-auto">{formatDop(v.ytd.retItbis)}</div></div>
          </div>
          <p className="text-sm text-ink-500 mb-3">
            {v.supplier.rnc ? `RNC ${v.supplier.rnc} · ` : ''}{v.docCount} documento(s) · {v.ncf606Count} con NCF (606){v.lastAt ? ` · última actividad ${formatDate(v.lastAt)}` : ''}
          </p>

          <div className="card p-4 overflow-x-auto min-w-0">
            {v.recentDocs.length === 0 ? (
              <p className="text-sm text-ink-400 py-2">Sin documentos registrados para este proveedor.</p>
            ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-ink-200">
                  <th className="py-2 pr-3 text-left eyebrow-xs font-semibold text-ink-500">Fecha</th>
                  <th className="py-2 px-3 text-left eyebrow-xs font-semibold text-ink-500">Tipo</th>
                  <th className="py-2 px-3 text-left eyebrow-xs font-semibold text-ink-500">NCF</th>
                  <th className="py-2 px-3 text-right eyebrow-xs font-semibold text-ink-500">Base</th>
                  <th className="py-2 px-3 text-right eyebrow-xs font-semibold text-ink-500">ITBIS</th>
                  <th className="py-2 pl-3 text-right eyebrow-xs font-semibold text-ink-500">Total</th>
                </tr>
              </thead>
              <tbody>
                {v.recentDocs.map((d) => (
                  <tr key={d.id} className="border-b border-ink-50 last:border-0">
                    <td className="py-1.5 pr-3 text-sm text-ink-500 whitespace-nowrap">{formatDate(d.date)}</td>
                    <td className="py-1.5 px-3 text-sm">{d.kind}</td>
                    <td className="py-1.5 px-3 text-sm tabular-nums text-ink-500">{d.ncf || '—'}</td>
                    <td className="py-1.5 px-3 text-right text-sm tabular-nums whitespace-nowrap">{formatDop(d.base)}</td>
                    <td className="py-1.5 px-3 text-right text-sm tabular-nums whitespace-nowrap">{formatDop(d.itbis)}</td>
                    <td className="py-1.5 pl-3 text-right text-sm tabular-nums font-medium whitespace-nowrap">{formatDop(d.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </div>
        </>
      )}
    </AccountingGate>
  );
}
