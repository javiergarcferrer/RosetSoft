import { useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Receipt, Trash2, Loader2, BookOpen, FileText, Ship, CheckCircle2, Clock, Pencil } from 'lucide-react';
import BackLink from '../../components/BackLink.jsx';
import TabPills from '../../components/accounting/TabPills.jsx';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { syncShopify } from '../../lib/shopifySync.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { formatDop, formatDate } from '../../lib/format.js';
import { reverseComprasGastoPosting } from '../../lib/comprasGastosDoc.js';
import { resolvePurchaseExpenseDetail, debitTotal, creditTotal } from '../../core/accounting/index.js';

const NATURE_BADGE = {
  gasto: 'bg-ink-100 text-ink-600',
  mercancia: 'bg-emerald-50 text-emerald-700',
  activo: 'bg-sky-50 text-sky-700',
};

/** A label → value pair of the document header grid. */
function Field({ label, children }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 items-baseline min-w-0">
      <dt className="text-xs text-ink-400">{label}</dt>
      <dd className="text-sm text-ink-700 min-w-0 break-words">{children ?? '—'}</dd>
    </div>
  );
}

/**
 * Detalle de una compra o gasto — a vendor-bill DOCUMENT (Odoo-style): a header
 * block (proveedor · comprobante · 606 · fechas · pago · expediente) with the
 * published/paid status, then tabs for the líneas, the posted asiento (apuntes
 * contables) and the DGII classification, closing with the totals. "Eliminar"
 * reverses everything the registration posted — the asiento and, for mercancía,
 * the kardex IN + the items' on-hand/avg (movement-sourced, so each touched item
 * recomputes from what's LEFT; an item minted only by this invoice is removed).
 * Self-gates on accounting/admin.
 */
export default function ComprasGastoDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { profileId } = useApp();
  const scope = profileId || 'team';

  const purchaseQ = useLiveQueryStatus(() => db.purchases.get(id), [id], null);
  const expenseQ = useLiveQueryStatus(() => db.expenses.get(id), [id], null);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);

  const detail = useMemo(() => resolvePurchaseExpenseDetail({
    purchase: purchaseQ.data, expense: expenseQ.data,
    suppliers: suppliersQ.data, accounts: accountsQ.data, items: itemsQ.data, expedientes: expedientesQ.data,
  }), [purchaseQ.data, expenseQ.data, suppliersQ.data, accountsQ.data, itemsQ.data, expedientesQ.data]);

  const jeId = detail?.journalEntryId || '';
  const jLinesQ = useLiveQueryStatus(() => (jeId ? db.journalLines.where('entryId').equals(jeId).toArray() : []), [jeId], []);
  const accountName = useMemo(() => {
    const m = new Map(accountsQ.data.map((a) => [a.code, a.name]));
    return (code) => m.get(code) || '';
  }, [accountsQ.data]);
  const asientoLines = useMemo(() => jLinesQ.data.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)), [jLinesQ.data]);

  const [tab, setTab] = useState('lines'); // 'lines' | 'asiento' | 'dgii'
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState('');

  const bothLoaded = purchaseQ.loaded && expenseQ.loaded;
  if (!bothLoaded || !suppliersQ.loaded) return <AccountingGate title="Compras y gastos"><ListLoading /></AccountingGate>;
  if (!detail) {
    return (
      <AccountingGate title="Compras y gastos">
        <BackLink to="/accounting/compras-gastos">Volver a compras y gastos</BackLink>
        <EmptyState icon={Receipt} title="Documento no encontrado" description="Puede haber sido eliminado o registrado en otro perfil." />
      </AccountingGate>
    );
  }

  /** Reverse this invoice: undo the asiento and (mercancía) the kardex INs,
   *  recomputing each touched item from its remaining movements. The row goes
   *  last so a mid-way failure leaves it to retry; the steps are idempotent. */
  async function reverseDoc() {
    const doc = purchaseQ.data || expenseQ.data;
    if (!doc || deleting) return;
    const what = detail.natureLabel.toLowerCase();
    if (!confirm(`¿Eliminar ${what}${detail.number != null ? ` #${detail.number}` : ''}? Se revierte el asiento${detail.reversesInventory ? ', los movimientos de inventario y las existencias' : ''}. Esta acción no se puede deshacer.`)) return;
    setErr('');
    setDeleting(true);
    try {
      const { touched } = await reverseComprasGastoPosting({ id: doc.id, source: detail.source, journalEntryId: doc.journalEntryId });
      if (detail.source === 'purchase') await db.purchases.delete(doc.id);
      else await db.expenses.delete(doc.id);
      if (touched.length) syncShopify(touched).catch(() => {});
      navigate('/accounting/compras-gastos');
    } catch (ex) {
      setErr(userMessageFor(ex));
      setDeleting(false);
    }
  }

  const d = detail;
  const TABS = [
    { key: 'lines', label: 'Líneas de factura' },
    { key: 'asiento', label: 'Apuntes contables' },
    { key: 'dgii', label: 'DGII' },
  ];

  return (
    <AccountingGate title="Compras y gastos">
      <BackLink to="/accounting/compras-gastos">Volver a compras y gastos</BackLink>
      {err && <p className="text-sm text-rose-600 mb-3">{err}</p>}

      <div className="card overflow-hidden">
        {/* Action + status bar */}
        <div className="flex items-center justify-between gap-2 px-4 sm:px-6 py-2.5 border-b border-ink-100 bg-ink-50/40">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => navigate(`/accounting/compras-gastos/${id}/editar`)}
              className="btn-secondary">
              <Pencil size={14} /> <span className="hidden sm:inline">Editar</span>
            </button>
            <button type="button" onClick={reverseDoc} disabled={deleting}
              className="btn-secondary text-rose-600 hover:bg-rose-50 hover:border-rose-200 disabled:opacity-50">
              {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} <span className="hidden sm:inline">Eliminar</span>
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="status-pill status-pill-active">Publicado</span>
            {d.paymentStatus === 'paid' ? (
              <span className="status-pill bg-emerald-100 text-emerald-700 inline-flex items-center gap-1"><CheckCircle2 size={12} /> Pagada</span>
            ) : (
              <span className="status-pill bg-amber-100 text-amber-800 inline-flex items-center gap-1"><Clock size={12} /> Por pagar</span>
            )}
          </div>
        </div>

        {/* Document header */}
        <div className="px-4 sm:px-6 py-5">
          <div className="flex items-start justify-between gap-3 mb-5">
            <div className="min-w-0">
              <div className="eyebrow text-ink-400">{d.natureLabel} de proveedor</div>
              <h1 className="font-display text-2xl font-semibold text-ink-900 truncate">
                {d.natureLabel}{d.number != null ? ` #${d.number}` : ''}
              </h1>
            </div>
            <span className={`shrink-0 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${NATURE_BADGE[d.nature]}`}>{d.natureLabel}</span>
          </div>

          <div className="grid sm:grid-cols-2 gap-x-10 gap-y-3">
            <dl className="space-y-3 min-w-0">
              <Field label="Proveedor">
                {d.supplierName || '—'}
                {d.supplierRnc && <div className="text-xs text-ink-400 tabular-nums">RNC/Céd. {d.supplierRnc}</div>}
              </Field>
              {d.ncf && <Field label="No. de comprobante">{<span className="tabular-nums">{d.ncf}</span>}</Field>}
              <Field label="Tipo de costos y gastos">{<span><span className="font-mono text-xs text-ink-400 mr-1">{d.tipo606}</span>{d.tipo606Label}</span>}</Field>
              {d.description && <Field label="Descripción">{d.description}</Field>}
            </dl>
            <dl className="space-y-3 min-w-0">
              <Field label="Fecha">{formatDate(d.date)}</Field>
              <Field label="Destino">{d.destination}</Field>
              <Field label="Forma de pago">{d.paymentLabel}{d.paid && d.paidAt ? <span className="text-ink-400"> · pagado el {formatDate(d.paidAt)}</span> : null}</Field>
              <Field label="Expediente">
                {d.expediente
                  ? <Link to={`/accounting/importaciones/${d.expediente.id}`} className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700"><Ship size={12} />{d.expediente.label}</Link>
                  : '—'}
              </Field>
              <Field label="Diario">Facturas de proveedores</Field>
            </dl>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-4 sm:px-6 border-t border-ink-100 pt-4">
          <TabPills tabs={TABS} active={tab} onChange={setTab} />
        </div>

        <div className="px-4 sm:px-6 pb-2 min-w-0">
          {tab === 'lines' && (
            <div className="overflow-x-auto">
              {d.lines.length > 0 ? (
                <table className="table min-w-[520px]">
                  <thead>
                    <tr>
                      <th>Producto</th>
                      <th className="text-right whitespace-nowrap">Cant.</th>
                      <th className="text-right whitespace-nowrap">Costo</th>
                      <th className="text-right whitespace-nowrap">C. unit.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.lines.map((l) => (
                      <tr key={l.id}>
                        <td className="min-w-0">
                          {l.name}
                          {l.reference && <span className="ml-1.5 font-mono text-xs text-ink-400">{l.reference}</span>}
                          {!l.inInventory && <span className="ml-1.5 text-[11px] text-amber-700">sin artículo</span>}
                        </td>
                        <td className="text-right tabular-nums whitespace-nowrap">{l.qty || '—'}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{formatDop(l.cost)}</td>
                        <td className="text-right tabular-nums whitespace-nowrap">{l.unitCost > 0 ? formatDop(l.unitCost) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                // Gasto / activo — a single account line (Odoo's line-per-account shape).
                <table className="table min-w-[520px]">
                  <thead>
                    <tr><th>Concepto</th><th>Cuenta</th><th className="text-right whitespace-nowrap">Cant.</th><th className="text-right whitespace-nowrap">Importe</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="min-w-0">{d.description || d.natureLabel}</td>
                      <td className="text-ink-600 min-w-0"><span className="font-mono text-xs text-ink-400 mr-1">{d.accountCode}</span>{d.accountName}</td>
                      <td className="text-right tabular-nums">1</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(d.base)}</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'asiento' && (
            asientoLines.length === 0 ? (
              <p className="text-sm text-ink-400 py-6 text-center">Sin asiento contable.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="table min-w-[560px]">
                  <thead>
                    <tr><th>Cuenta</th><th>Detalle</th><th className="text-right whitespace-nowrap">Débito</th><th className="text-right whitespace-nowrap">Crédito</th></tr>
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
            )
          )}

          {tab === 'dgii' && (
            <dl className="grid sm:grid-cols-2 gap-x-10 gap-y-3 py-2 max-w-3xl">
              <Field label="NCF">{d.ncf ? <span className="tabular-nums">{d.ncf}</span> : '—'}</Field>
              <Field label="Tipo de comprobante">{d.ncfType || '—'}</Field>
              <Field label="Tipo 606">{<span><span className="font-mono text-xs text-ink-400 mr-1">{d.tipo606}</span>{d.tipo606Label}</span>}</Field>
              <Field label="ITBIS adelantado">{formatDop(d.itbis)}</Field>
              <Field label="Retención ISR">{formatDop(d.retIsr)}</Field>
              <Field label="Retención ITBIS">{formatDop(d.retItbis)}</Field>
            </dl>
          )}
        </div>

        {/* Totals */}
        <div className="border-t border-ink-100 px-4 sm:px-6 py-4 flex justify-end">
          <div className="w-full sm:max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between gap-4"><span className="text-ink-500">Subtotal</span><span className="tabular-nums">{formatDop(d.base)}</span></div>
            <div className="flex justify-between gap-4"><span className="text-ink-500">ITBIS</span><span className="tabular-nums">{formatDop(d.itbis)}</span></div>
            {(d.retIsr > 0 || d.retItbis > 0) && (
              <div className="flex justify-between gap-4"><span className="text-ink-500">Retenciones</span><span className="tabular-nums text-rose-600">−{formatDop(d.retIsr + d.retItbis)}</span></div>
            )}
            <div className="flex justify-between gap-4 pt-1.5 border-t border-ink-100 font-semibold text-ink-900">
              <span>Total</span><span className="tabular-nums">{formatDop(d.total)}</span>
            </div>
            <div className="flex justify-between gap-4 text-ink-500">
              <span>Neto a pagar</span><span className="tabular-nums">{formatDop(d.net)}</span>
            </div>
          </div>
        </div>
      </div>
    </AccountingGate>
  );
}
