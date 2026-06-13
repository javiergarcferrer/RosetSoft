import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Shield, Ship, Receipt, Plus, Copy, Container, BookOpen } from 'lucide-react';
import BackLink from '../../components/BackLink.jsx';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import {
  resolveExpedienteDetail, resolveAccountingConfig, debitTotal, creditTotal,
} from '../../core/accounting/index.js';
import { TEMPLATE_KEY } from './ExpedienteForm.jsx';

/** One KPI tile of the expediente's landed-cost band. */
function Stat({ label, value, accent }) {
  return (
    <div className="rounded-xl border border-ink-100 bg-surface px-3 py-2 shadow-xs">
      <div className="eyebrow text-ink-400">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${accent || 'text-ink-800'}`}>{value}</div>
    </div>
  );
}

/** A label → value pair of the meta strip. */
function Meta({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow text-ink-400">{label}</div>
      <div className="text-sm text-ink-700 truncate">{children || '—'}</div>
    </div>
  );
}

/**
 * Detalle de un expediente de importación — the full drill-down of one saved
 * customs file: meta strip, landed-cost KPI band, every embarque with its
 * facturas and per-line cascade (FOB → CIF → impuestos → costo en destino →
 * costo unitario), the cost sheet and the posted asiento. "Usar como
 * plantilla" seeds a new expediente with this one's structure (suppliers,
 * artículos, cost concepts) with the amounts cleared.
 */
export default function ImportacionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profileId, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const expQ = useLiveQueryStatus(() => db.importExpedientes.get(id), [id], null);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const containersQ = useLiveQueryStatus(() => db.containers.where('profileId').equals(scope).toArray(), [scope], []);
  const ordersQ = useLiveQueryStatus(() => db.orders.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const jeId = expQ.data?.journalEntryId || '';
  const jLinesQ = useLiveQueryStatus(
    () => (jeId ? db.journalLines.where('entryId').equals(jeId).toArray() : []),
    [jeId], [],
  );

  const detail = useMemo(() => resolveExpedienteDetail({
    expediente: expQ.data, config, suppliers: suppliersQ.data, items: itemsQ.data,
    containers: containersQ.data, orders: ordersQ.data,
  }), [expQ.data, config, suppliersQ.data, itemsQ.data, containersQ.data, ordersQ.data]);

  const accountName = useMemo(() => {
    const m = new Map(accountsQ.data.map((a) => [a.code, a.name]));
    return (code) => m.get(code) || '';
  }, [accountsQ.data]);
  const asientoLines = useMemo(
    () => jLinesQ.data.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)),
    [jLinesQ.data],
  );

  if (!allowed) {
    return (
      <>
        <PageHeader title="Importaciones" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }
  if (!expQ.loaded || !suppliersQ.loaded || !itemsQ.loaded) return <ListLoading />;
  if (!expQ.data || !detail) {
    return (
      <>
        <BackLink to="/accounting/importaciones">Volver a importaciones</BackLink>
        <EmptyState icon={Ship} title="Expediente no encontrado" description="Puede haber sido registrado en otro perfil." />
      </>
    );
  }

  const { meta, totals, embarques, costs, costTotals } = detail;

  /** Seed a new expediente with this one's structure — suppliers, artículos and
   *  cost concepts kept; BL/DUA, montos and cantidades cleared (a stale amount
   *  silently reposted is worse than retyping it). */
  function useAsTemplate() {
    const e = expQ.data;
    const embs = (e.embarques?.length ? e.embarques : [{ facturas: [{ supplierId: e.supplierId || '', lines: e.lines || [] }] }])
      .map((em) => ({
        id: newId(), bl: '', containerId: '', customsRef: '', flete: '', seguro: '',
        facturas: (em.facturas || []).map((f) => ({
          id: newId(), supplierId: f.supplierId || '', invoiceRef: '', ncf: '',
          lines: (f.lines || []).map((l) => ({
            id: newId(), itemId: l.itemId || '', name: l.name || '', reference: l.reference || '',
            qty: '', fob: '', selectivo: '',
          })),
        })),
      }));
    const template = {
      head: { paymentMethod: e.paymentMethod || 'bank' },
      embs,
      costs: (e.costs || []).map((c) => ({
        id: newId(), concept: c.concept || 'otro', supplierId: c.supplierId || '', ncf: '',
        amount: '', itbis: '', paymentMethod: c.paymentMethod || 'bank',
      })),
    };
    try { localStorage.setItem(TEMPLATE_KEY(scope), JSON.stringify(template)); } catch { /* best-effort */ }
    navigate('/accounting/importaciones?new=1');
  }

  return (
    <>
      <BackLink to="/accounting/importaciones">Volver a importaciones</BackLink>
      <PageHeader
        title={`Expediente${meta.number != null ? ` #${meta.number}` : ''}`}
        subtitle={`${formatDate(meta.date)}${meta.bl ? ` · BL ${meta.bl}` : ''}`}
        actions={(
          <button type="button" onClick={useAsTemplate} className="btn-secondary">
            <Copy size={14} /> Usar como plantilla
          </button>
        )}
      />

      {/* Meta strip */}
      <div className="card p-3 mb-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Meta label="Proveedor">{meta.supplierName}</Meta>
        <Meta label="DUA">{meta.customsRef}</Meta>
        <Meta label="Contenedor">{meta.containerCode}</Meta>
        <Meta label="Pedido">{meta.orderLabel}</Meta>
        <Meta label="Pago aduanas">{meta.payment}</Meta>
        <Meta label="Registrado">{formatDate(meta.date)}</Meta>
      </div>

      {/* KPI band */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">
        <Stat label="CIF (valor aduana)" value={formatDop(totals.cif)} />
        <Stat label="Gravamen" value={formatDop(totals.gravamen)} />
        <Stat label="Selectivo (ISC)" value={formatDop(totals.selectivo)} />
        <Stat label="ITBIS al crédito" value={formatDop(totals.creditableItbis)} accent="text-sky-700" />
        <Stat label="Costo en destino" value={formatDop(totals.landed)} accent="text-emerald-700" />
      </div>

      {/* Embarques → facturas → líneas */}
      <div className="space-y-3">
        {embarques.map((em, ei) => (
          <div key={em.id} className="rounded-xl border border-ink-200 bg-ink-50/40 p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 text-sm">
              <h4 className="font-medium text-ink-700 inline-flex items-center gap-1.5"><Ship size={15} /> Embarque {ei + 1}</h4>
              {em.bl && <span className="font-mono text-xs text-ink-500">BL {em.bl}</span>}
              {em.customsRef && <span className="text-xs text-ink-500">DUA {em.customsRef}</span>}
              {em.containerCode && <span className="inline-flex items-center gap-0.5 text-xs text-ink-500"><Container size={12} />{em.containerCode}</span>}
              <span className="ml-auto text-xs text-ink-500 tabular-nums">Flete {formatDop(em.flete)} · Seguro {formatDop(em.seguro)}</span>
            </div>

            <div className="space-y-2">
              {em.facturas.map((f) => (
                <div key={f.id} className="rounded-lg border border-ink-200 bg-surface p-2.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1.5 text-sm">
                    <Receipt size={14} className="text-ink-400 shrink-0" />
                    <span className="font-medium text-ink-700">{f.supplierName || 'Factura'}</span>
                    {f.invoiceRef && <span className="text-xs text-ink-500">No. {f.invoiceRef}</span>}
                    {f.ncf && <span className="font-mono text-xs text-ink-500">{f.ncf}</span>}
                    <span className="ml-auto text-xs text-ink-500 tabular-nums">{f.lines.length} línea{f.lines.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="overflow-x-auto -mx-2.5">
                  <table className="w-full text-sm min-w-[640px]">
                    <thead className="text-ink-400 text-[11px] uppercase tracking-wide">
                      <tr>
                        <th className="text-left font-medium pb-1 pl-2.5">Artículo</th>
                        <th className="text-right font-medium pb-1 whitespace-nowrap">Cant.</th>
                        <th className="text-right font-medium pb-1 whitespace-nowrap">FOB</th>
                        <th className="text-right font-medium pb-1 whitespace-nowrap">CIF</th>
                        <th className="text-right font-medium pb-1 whitespace-nowrap">Impuestos</th>
                        <th className="text-right font-medium pb-1 whitespace-nowrap">C. destino</th>
                        <th className="text-right font-medium pb-1 pr-2.5 whitespace-nowrap">C. unit.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {f.lines.map((l) => (
                        <tr key={l.id} className="border-t border-ink-50">
                          <td className="py-1.5 pr-2 pl-2.5 min-w-0">
                            {l.name}
                            {l.reference && <span className="ml-1.5 font-mono text-xs text-ink-400">{l.reference}</span>}
                            {!l.inInventory && <span className="ml-1.5 inline-flex items-center gap-0.5 text-[11px] text-amber-700"><Plus size={10} /> sin artículo</span>}
                          </td>
                          <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{l.qty || '—'}</td>
                          <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{formatDop(l.fob)}</td>
                          <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{formatDop(l.cif)}</td>
                          <td className="py-1.5 text-right tabular-nums whitespace-nowrap text-ink-500" title={`Gravamen ${formatDop(l.gravamen)} · Selectivo ${formatDop(l.selectivo)} · ITBIS ${formatDop(l.itbis)}`}>{formatDop(l.taxes)}</td>
                          <td className="py-1.5 text-right tabular-nums font-medium whitespace-nowrap">{formatDop(l.landedTotal)}</td>
                          <td className="py-1.5 text-right tabular-nums whitespace-nowrap pr-2.5">{l.landedUnitCost > 0 ? formatDop(l.landedUnitCost) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-ink-100 text-xs text-ink-500">
                        <td className="py-1.5 pl-2.5" colSpan={2}>Subtotal factura</td>
                        <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{formatDop(f.fob)}</td>
                        <td colSpan={2}></td>
                        <td className="py-1.5 text-right tabular-nums font-medium whitespace-nowrap">{formatDop(f.landed)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Cost sheet */}
      <div className="card overflow-hidden mt-4">
        <div className="card-header"><h2>Costos del expediente</h2></div>
        {costs.length === 0 ? (
          <p className="text-xs text-ink-400 px-3 py-3">Sin costos adicionales — el costo en destino es CIF + impuestos capitalizables.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="table min-w-[560px]">
            <thead>
              <tr>
                <th>Concepto</th>
                <th>Proveedor</th>
                <th className="whitespace-nowrap">NCF</th>
                <th className="whitespace-nowrap">Pago</th>
                <th className="text-right whitespace-nowrap">Monto</th>
                <th className="text-right whitespace-nowrap">ITBIS</th>
                <th className="text-right whitespace-nowrap">Neto al costo</th>
              </tr>
            </thead>
            <tbody>
              {costs.map((c) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td className="min-w-0">{c.supplierName || '—'}</td>
                  <td className="font-mono text-xs whitespace-nowrap">{c.ncf || '—'}</td>
                  <td className="text-ink-500 whitespace-nowrap">{c.payment}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{formatDop(c.amount)}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{formatDop(c.itbis)}</td>
                  <td className="text-right tabular-nums font-medium whitespace-nowrap">{formatDop(c.net)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-ink-200 font-semibold">
                <td colSpan={4}>{costs.length} costo{costs.length === 1 ? '' : 's'}</td>
                <td className="text-right tabular-nums whitespace-nowrap">{formatDop(costTotals.gross)}</td>
                <td className="text-right tabular-nums whitespace-nowrap">{formatDop(costTotals.itbis)}</td>
                <td className="text-right tabular-nums whitespace-nowrap">{formatDop(costTotals.net)}</td>
              </tr>
            </tfoot>
          </table>
          </div>
        )}
      </div>

      {/* Asiento contable */}
      {asientoLines.length > 0 && (
        <div className="card overflow-hidden mt-4">
          <div className="card-header">
            <h2 className="inline-flex items-center gap-1.5"><BookOpen size={14} /> Asiento contable</h2>
          </div>
          <div className="overflow-x-auto">
          <table className="table min-w-[560px]">
            <thead>
              <tr>
                <th>Cuenta</th>
                <th>Detalle</th>
                <th className="text-right whitespace-nowrap">Débito</th>
                <th className="text-right whitespace-nowrap">Crédito</th>
              </tr>
            </thead>
            <tbody>
              {asientoLines.map((l) => (
                <tr key={l.id}>
                  <td className="whitespace-nowrap">
                    <span className="font-mono text-xs text-ink-500">{l.accountCode}</span>
                    {accountName(l.accountCode) && <span className="ml-1.5">{accountName(l.accountCode)}</span>}
                  </td>
                  <td className="min-w-0 text-ink-500">{l.memo || ''}{l.ncf ? <span className="ml-1.5 font-mono text-xs">{l.ncf}</span> : null}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{l.debit ? formatDop(l.debit) : ''}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{l.credit ? formatDop(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-ink-200 font-semibold">
                <td colSpan={2}>Totales</td>
                <td className="text-right tabular-nums whitespace-nowrap">{formatDop(debitTotal(asientoLines))}</td>
                <td className="text-right tabular-nums whitespace-nowrap">{formatDop(creditTotal(asientoLines))}</td>
              </tr>
            </tfoot>
          </table>
          </div>
        </div>
      )}
    </>
  );
}
