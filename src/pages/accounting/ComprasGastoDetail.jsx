import { useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Receipt, Trash2, Loader2, BookOpen, FileText, Ship } from 'lucide-react';
import BackLink from '../../components/BackLink.jsx';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import { syncShopify } from '../../lib/shopifySync.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { formatDop, formatDate } from '../../lib/format.js';
import { resolvePurchaseExpenseDetail, resolveKardex, debitTotal, creditTotal } from '../../core/accounting/index.js';

const PAY_LABEL = { cash: 'Efectivo', bank: 'Banco', card: 'Tarjeta', credit: 'Crédito' };
const NATURE_BADGE = {
  gasto: 'bg-ink-100 text-ink-600',
  mercancia: 'bg-emerald-50 text-emerald-700',
  activo: 'bg-sky-50 text-sky-700',
};

function Meta({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow text-ink-400">{label}</div>
      <div className="text-sm text-ink-700 truncate">{children || '—'}</div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className="rounded-xl border border-ink-100 bg-surface px-3 py-2 shadow-xs">
      <div className="eyebrow text-ink-400">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${accent || 'text-ink-800'}`}>{value}</div>
    </div>
  );
}

/**
 * Detalle de una compra o gasto — the full drill-down of one supplier invoice:
 * meta strip, money band, the article líneas (mercancía) and the posted asiento.
 * "Eliminar" reverses everything the registration posted — the asiento and, for
 * mercancía, the kardex IN + the items' on-hand/avg (movement-sourced, so each
 * touched item recomputes from what's LEFT; an item minted only by this invoice
 * is removed). Mirrors the expediente reversal. Self-gates on accounting/admin.
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
      let touched = [];
      if (detail.source === 'purchase') {
        const moves = (await db.inventoryMovements.where('refId').equals(doc.id).toArray()).filter((m) => m.refTable === 'purchases');
        touched = [...new Set(moves.map((m) => m.itemId).filter(Boolean))];
        if (doc.journalEntryId) {
          const jl = await db.journalLines.where('entryId').equals(doc.journalEntryId).toArray();
          await db.journalLines.bulkDelete(jl.map((l) => l.id));
          await db.journalEntries.delete(doc.journalEntryId);
        }
        await db.inventoryMovements.bulkDelete(moves.map((m) => m.id));
        for (const itemId of touched) {
          const remaining = await db.inventoryMovements.where('itemId').equals(itemId).toArray();
          if (!remaining.length) { await db.inventoryItems.delete(itemId); continue; }
          const k = resolveKardex(remaining);
          await db.inventoryItems.update(itemId, { qtyOnHand: k.qty, avgCost: k.avgCost });
        }
        await db.purchases.delete(doc.id);
      } else {
        if (doc.journalEntryId) {
          const jl = await db.journalLines.where('entryId').equals(doc.journalEntryId).toArray();
          await db.journalLines.bulkDelete(jl.map((l) => l.id));
          await db.journalEntries.delete(doc.journalEntryId);
        }
        await db.expenses.delete(doc.id);
      }
      if (touched.length) syncShopify(touched).catch(() => {});
      navigate('/accounting/compras-gastos');
    } catch (ex) {
      setErr(userMessageFor(ex));
      setDeleting(false);
    }
  }

  const d = detail;
  return (
    <AccountingGate title="Compras y gastos">
      <BackLink to="/accounting/compras-gastos">Volver a compras y gastos</BackLink>
      <PageHeader
        title={`${d.natureLabel}${d.number != null ? ` #${d.number}` : ''}`}
        subtitle={`${formatDate(d.date)}${d.supplierName ? ` · ${d.supplierName}` : ''}`}
        actions={(
          <button type="button" onClick={reverseDoc} disabled={deleting}
            className="btn-secondary text-rose-600 hover:bg-rose-50 hover:border-rose-200 disabled:opacity-50">
            {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} <span className="hidden sm:inline">Eliminar</span>
          </button>
        )}
      />
      {err && <p className="text-sm text-rose-600 mb-3">{err}</p>}

      {/* Meta strip */}
      <div className="card p-3 mb-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Meta label="Tipo"><span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${NATURE_BADGE[d.nature]}`}>{d.natureLabel}</span></Meta>
        <Meta label="Proveedor">{d.supplierName}</Meta>
        <Meta label="Destino">{d.destination}</Meta>
        <Meta label="NCF">{d.ncf}</Meta>
        <Meta label="Pago">{d.paymentLabel || PAY_LABEL[d.payment]}</Meta>
        <Meta label="Expediente">
          {d.expediente
            ? <Link to={`/accounting/importaciones/${d.expediente.id}`} className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700"><Ship size={12} />{d.expediente.label}</Link>
            : '—'}
        </Meta>
        {d.description && <Meta label="Descripción">{d.description}</Meta>}
      </div>

      {/* Money band */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
        <Stat label="Base" value={formatDop(d.base)} />
        <Stat label="ITBIS" value={formatDop(d.itbis)} accent="text-sky-700" />
        <Stat label="Ret. ISR" value={formatDop(d.retIsr)} />
        <Stat label="Ret. ITBIS" value={formatDop(d.retItbis)} />
        <Stat label="Total" value={formatDop(d.total)} />
        <Stat label="Neto a pagar" value={formatDop(d.net)} accent="text-emerald-700" />
      </div>

      {/* Mercancía líneas */}
      {d.lines.length > 0 && (
        <div className="card overflow-hidden mb-4">
          <div className="card-header"><h2 className="inline-flex items-center gap-1.5"><FileText size={14} /> Líneas ({d.lines.length})</h2></div>
          <div className="overflow-x-auto">
            <table className="table min-w-[520px]">
              <thead>
                <tr>
                  <th>Artículo</th>
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
              <tfoot>
                <tr className="border-t border-ink-200 font-semibold">
                  <td>Base</td>
                  <td colSpan={2} className="text-right tabular-nums whitespace-nowrap">{formatDop(d.base)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Asiento contable */}
      {asientoLines.length > 0 && (
        <div className="card overflow-hidden">
          <div className="card-header"><h2 className="inline-flex items-center gap-1.5"><BookOpen size={14} /> Asiento contable</h2></div>
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
        </div>
      )}
    </AccountingGate>
  );
}
