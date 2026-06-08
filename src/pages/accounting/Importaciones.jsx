import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Shield, Ship, FileText } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import {
  resolveImportsList, resolveAccountingConfig, expedienteLanded, expedienteCreditableItbis,
} from '../../core/accounting/index.js';
import ExpedienteForm from './ExpedienteForm.jsx';

/**
 * Importaciones — the import-expediente workspace (DGA customs). An expediente
 * spans embarques (BLs) → supplier facturas → product lines; it capitalizes
 * CIF + gravamen + selectivo + the prorated cost sheet into a per-line landed
 * cost, credits the ITBIS, posts the asiento and lands each line into inventory.
 * Self-gates on accounting/admin. (Legacy single liquidations stay listed,
 * read-only, below.)
 */
export default function Importaciones() {
  const { profileId, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const importsQ = useLiveQueryStatus(() => db.importLiquidations.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const ordersQ = useLiveQueryStatus(() => db.orders.where('profileId').equals(scope).toArray(), [scope], []);
  const containersQ = useLiveQueryStatus(() => db.containers.where('profileId').equals(scope).toArray(), [scope], []);
  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = importsQ.loaded && suppliersQ.loaded && itemsQ.loaded;

  const list = useMemo(() => resolveImportsList({ imports: importsQ.data, suppliers: suppliersQ.data, items: itemsQ.data }),
    [importsQ.data, suppliersQ.data, itemsQ.data]);
  const [params] = useSearchParams();
  const [showExpediente, setShowExpediente] = useState(!!params.get('new'));

  if (!allowed) {
    return (
      <>
        <PageHeader title="Importaciones" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Importaciones" subtitle="Expediente aduanal (DGA) → costo en destino al inventario"
        actions={(
          <button type="button" onClick={() => setShowExpediente((v) => !v)} className="btn-primary text-sm inline-flex items-center gap-1.5 min-h-[44px] px-3"><FileText size={15} /> <span className="hidden sm:inline">Nuevo expediente</span><span className="sm:hidden">Nuevo</span></button>
        )} />

      {showExpediente && loaded && (
        <ExpedienteForm scope={scope} config={config} settings={settings} suppliers={suppliersQ.data} items={itemsQ.data}
          orders={ordersQ.data || []} containers={containersQ.data || []} onClose={() => setShowExpediente(false)} />
      )}

      {!loaded ? <ListLoading /> : (list.count === 0 && !(expedientesQ.data?.length)) ? (
        <EmptyState icon={Ship} title="Sin importaciones" description="Registra un expediente con “Nuevo expediente”." />
      ) : (
        <>
          {expedientesQ.data?.length > 0 && (
            <ExpedientesList expedientes={expedientesQ.data} suppliers={suppliersQ.data} />
          )}
          {list.count > 0 && (
          <div className="card overflow-hidden mt-4">
          <div className="px-3 py-2 text-xs uppercase tracking-wide text-ink-500 bg-ink-50 font-medium">Liquidaciones simples (histórico)</div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left py-2 px-3 whitespace-nowrap">Fecha</th>
                <th className="text-left py-2 px-3">Proveedor</th>
                <th className="text-left py-2 px-3">Artículo</th>
                <th className="text-right py-2 px-3 whitespace-nowrap">CIF</th>
                <th className="text-right py-2 px-3 whitespace-nowrap">Gravamen</th>
                <th className="text-right py-2 px-3 whitespace-nowrap">ITBIS imp.</th>
                <th className="text-right py-2 px-3 whitespace-nowrap">Costo destino</th>
                <th className="text-right py-2 px-3 whitespace-nowrap">C. unit.</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map(({ liq: l, supplier, item, landed, unitCost }) => (
                <tr key={l.id} className="border-t border-ink-50">
                  <td className="py-1.5 px-3 text-ink-500 whitespace-nowrap">{formatDate(l.liquidatedAt)}</td>
                  <td className="py-1.5 px-3 min-w-0">{supplier?.name || '—'}</td>
                  <td className="py-1.5 px-3 min-w-0">{item?.name || '—'}{l.qty ? <span className="text-ink-400"> ×{l.qty}</span> : null}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(l.cif)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(l.duty)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(l.importItbis)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-medium whitespace-nowrap">{formatDop(landed)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(unitCost)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-ink-200 font-semibold">
                <td className="py-2 px-3" colSpan={3}>{list.count} liquidaciones</td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(list.totals.cif)}</td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(list.totals.duty)}</td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(list.totals.importItbis)}</td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(list.totals.landed)}</td>
                <td className="py-2 px-3"></td>
              </tr>
            </tfoot>
          </table>
          </div>
          </div>
          )}
        </>
      )}
    </>
  );
}

/** Count product lines across an expediente's embarques (fallback: legacy flat lines). */
function lineCount(e) {
  if (e.embarques?.length) return e.embarques.reduce((s, em) => s + (em.facturas || []).reduce((a, f) => a + (f.lines || []).length, 0), 0);
  return (e.lines || []).length;
}

/** The expedientes list — one row per import file, with its derived landed cost
 *  and recoverable ITBIS (read off the stored totals). */
function ExpedientesList({ expedientes, suppliers }) {
  const rows = expedientes.slice().sort((a, b) => (b.liquidatedAt || 0) - (a.liquidatedAt || 0));
  return (
    <div className="card overflow-hidden">
      <div className="px-3 py-2 text-xs uppercase tracking-wide text-ink-500 bg-ink-50 font-medium">Expedientes</div>
      <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[540px]">
        <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
          <tr>
            <th className="text-left py-2 px-3 whitespace-nowrap">Fecha</th>
            <th className="text-left py-2 px-3 whitespace-nowrap">BL</th>
            <th className="text-left py-2 px-3">Proveedor</th>
            <th className="text-right py-2 px-3 whitespace-nowrap">Líneas</th>
            <th className="text-right py-2 px-3 whitespace-nowrap">CIF</th>
            <th className="text-right py-2 px-3 whitespace-nowrap">Costo destino</th>
            <th className="text-right py-2 px-3 whitespace-nowrap">ITBIS créd.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const supplier = suppliers.find((s) => s.id === e.supplierId);
            const embCount = e.embarques?.length || 0;
            return (
              <tr key={e.id} className="border-t border-ink-50">
                <td className="py-1.5 px-3 text-ink-500 whitespace-nowrap">{formatDate(e.liquidatedAt)}</td>
                <td className="py-1.5 px-3 font-mono text-xs whitespace-nowrap">{e.bl || '—'}{embCount > 1 ? <span className="text-ink-400"> +{embCount - 1}</span> : null}</td>
                <td className="py-1.5 px-3 min-w-0">{supplier?.name || '—'}</td>
                <td className="py-1.5 px-3 text-right tabular-nums">{lineCount(e)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(e.cif)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums font-medium whitespace-nowrap">{formatDop(expedienteLanded(e))}</td>
                <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(expedienteCreditableItbis(e))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}
