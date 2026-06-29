import { useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Shield, Ship, Receipt, Plus, Copy, Container, BookOpen, Trash2, Loader2, Pencil, ShoppingCart } from 'lucide-react';
import BackLink from '../../components/BackLink.jsx';
import { useConfirm } from '../../components/ConfirmProvider.jsx';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import { useSetBreadcrumb } from '../../context/Breadcrumbs.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import { formatDop, formatDate, formatMoney } from '../../lib/format.js';
import { effectiveDopRate } from '../../lib/exchangeRate.js';
import { syncShopify } from '../../lib/shopifySync.js';
import { driveDelete } from '../../lib/google.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { reverseExpedientePosting } from '../../lib/comprasGastosDoc.js';
import {
  resolveExpedienteDetail, resolveAccountingConfig, debitTotal, creditTotal,
  resolvePurchasesExpenses, NATURE_LABEL,
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
 * Per-factura líneas columns (Shopify-style customizable list). ONE ordered
 * definition drives the read-only landed-cost cascade table (`cell`), its
 * subtotal footer (`foot`) and the Columns menu (`label`/`canHide`). `name` is
 * the fixed identity anchor (never hidden); the rest the team can toggle. Each
 * `cell`/`foot` is a pure render off the per-line `ctx` bag (or the factura bag)
 * the table assembles.
 */
const LINE_COLUMNS = [
  {
    key: 'name', label: 'Artículo', canHide: false,
    thClass: 'text-left font-medium pb-1 pl-2.5', tdClass: 'py-1.5 pr-2 pl-2.5 min-w-0',
    cell: ({ l }) => (
      <>
        {l.name}
        {l.reference && <span className="ml-1.5 font-mono text-xs text-ink-400">{l.reference}</span>}
        {!l.inInventory && <span className="ml-1.5 inline-flex items-center gap-0.5 text-[11px] text-amber-700"><Plus size={10} /> sin artículo</span>}
      </>
    ),
    footClass: 'py-1.5 pl-2.5', foot: () => 'Subtotal factura',
  },
  {
    key: 'qty', label: 'Cant.',
    thClass: 'text-right font-medium pb-1 whitespace-nowrap', tdClass: 'py-1.5 text-right tabular-nums whitespace-nowrap',
    cell: ({ l }) => l.qty || '—',
  },
  {
    key: 'fob', label: 'FOB (US$)',
    thClass: 'text-right font-medium pb-1 whitespace-nowrap', tdClass: 'py-1.5 text-right tabular-nums whitespace-nowrap',
    cell: ({ l }) => formatMoney(l.fobUsd, 'USD'),
    footClass: 'py-1.5 text-right tabular-nums whitespace-nowrap', foot: ({ f }) => formatMoney(f.fobUsd, 'USD'),
  },
  {
    key: 'cif', label: 'CIF',
    thClass: 'text-right font-medium pb-1 whitespace-nowrap', tdClass: 'py-1.5 text-right tabular-nums whitespace-nowrap',
    cell: ({ l }) => formatDop(l.cif),
  },
  {
    key: 'taxes', label: 'Impuestos',
    thClass: 'text-right font-medium pb-1 whitespace-nowrap', tdClass: 'py-1.5 text-right tabular-nums whitespace-nowrap text-ink-500',
    cell: ({ l }) => <span title={`Gravamen ${formatDop(l.gravamen)} · Selectivo ${formatDop(l.selectivo)} · ITBIS ${formatDop(l.itbis)}`}>{formatDop(l.taxes)}</span>,
  },
  {
    key: 'landedTotal', label: 'C. destino',
    thClass: 'text-right font-medium pb-1 whitespace-nowrap', tdClass: 'py-1.5 text-right tabular-nums font-medium whitespace-nowrap',
    cell: ({ l }) => formatDop(l.landedTotal),
    footClass: 'py-1.5 text-right tabular-nums font-medium whitespace-nowrap', foot: ({ f }) => formatDop(f.landed),
  },
  {
    key: 'landedUnitCost', label: 'C. unit.',
    thClass: 'text-right font-medium pb-1 pr-2.5 whitespace-nowrap', tdClass: 'py-1.5 text-right tabular-nums whitespace-nowrap pr-2.5',
    cell: ({ l }) => (l.landedUnitCost > 0 ? formatDop(l.landedUnitCost) : '—'),
  },
];
const LINE_DEFAULT = { qty: true, fob: true, cif: true, taxes: true, landedTotal: true, landedUnitCost: true };
const LINE_COLS_KEY = 'rs.importacion.detail.lines.cols.v1';

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
  const confirm = useConfirm();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const expQ = useLiveQueryStatus(() => db.importExpedientes.get(id), [id], null);
  const linkedPurchasesQ = useLiveQueryStatus(() => db.purchases.where('expedienteId').equals(id).toArray(), [id], []);
  const linkedExpensesQ = useLiveQueryStatus(() => db.expenses.where('expedienteId').equals(id).toArray(), [id], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const containersQ = useLiveQueryStatus(() => db.containers.where('profileId').equals(scope).toArray(), [scope], []);
  const ordersQ = useLiveQueryStatus(() => db.orders.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  useSetBreadcrumb(expQ.data ? `Expediente${expQ.data.number != null ? ` #${expQ.data.number}` : ''}` : null);
  const jeId = expQ.data?.journalEntryId || '';
  const jLinesQ = useLiveQueryStatus(
    () => (jeId ? db.journalLines.where('entryId').equals(jeId).toArray() : []),
    [jeId], [],
  );

  const fallbackRate = useMemo(() => effectiveDopRate(settings), [settings]);
  const detail = useMemo(() => resolveExpedienteDetail({
    expediente: expQ.data, config, suppliers: suppliersQ.data, items: itemsQ.data,
    containers: containersQ.data, orders: ordersQ.data, rate: fallbackRate,
  }), [expQ.data, config, suppliersQ.data, itemsQ.data, containersQ.data, ordersQ.data, fallbackRate]);

  const accountName = useMemo(() => {
    const m = new Map(accountsQ.data.map((a) => [a.code, a.name]));
    return (code) => m.get(code) || '';
  }, [accountsQ.data]);
  const asientoLines = useMemo(
    () => jLinesQ.data.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)),
    [jLinesQ.data],
  );

  // The ONE costs section: the expediente's own cost-sheet rows (capitalized
  // into landed cost) AND the compras/gastos the team linked to this file, in a
  // single list. Reuses the unified merge VM — passing the expediente folds its
  // cost sheet in as `expediente-cost` rows alongside the linked documents.
  const linkedCompras = useMemo(() => resolvePurchasesExpenses({
    expenses: linkedExpensesQ.data, purchases: linkedPurchasesQ.data,
    expedientes: expQ.data ? [expQ.data] : [],
    suppliers: suppliersQ.data, accounts: accountsQ.data,
  }), [linkedExpensesQ.data, linkedPurchasesQ.data, expQ.data, suppliersQ.data, accountsQ.data]);

  // Customizable columns (Shopify "Columnas") — persisted per browser. The
  // per-factura líneas tables all share ONE choice (one hook). Each renders
  // `cols` (anchor + toggled-on, in order) and feeds the full set to <ColumnsMenu>.
  const lineCols = useColumns(LINE_COLUMNS, LINE_DEFAULT, LINE_COLS_KEY);
  // Drag-to-resize widths (persisted). The per-factura líneas tables share ONE
  // widths state (one hook). tableRef points at the last-rendered líneas
  // instance — fine, every instance reads the same widths/style/thProps.
  const {
    tableRef: lineTableRef, tableStyle: lineTableStyle, thProps: lineThProps,
    ResizeHandle: LineResizeHandle, reset: resetLineWidths,
  } = useColumnWidths(lineCols.cols, 'rs.importacion.detail.lines.widths.v1');

  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState('');

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

  const { meta, totals, embarques } = detail;
  const isDraft = expQ.data.status === 'draft';

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
    navigate('/accounting/importaciones/nuevo');
  }

  /** Delete this expediente and undo everything its save posted: the asiento
   *  (entry + lines), the kardex IN movements it created, and — since movements
   *  are the source of truth — each touched item's on-hand/avg recomputed from
   *  its REMAINING movements (and items the import minted, now movement-less,
   *  removed). Lets the team re-register a file cleanly while the
   *  import engine is in testing. The expediente row goes last so a mid-way
   *  failure leaves it in place to retry; the steps are idempotent. */
  async function deleteExpediente() {
    const e = expQ.data;
    if (!e || deleting) return;
    const ok = await confirm({
      title: 'Eliminar expediente',
      message: `¿Eliminar el expediente${e.number != null ? ` #${e.number}` : ''}? Se revierten el asiento, los movimientos de inventario y las existencias${e.driveFolderId ? ', y se borra su carpeta de documentos en Drive' : ''}. Esta acción no se puede deshacer.`,
      confirmLabel: 'Eliminar',
      tone: 'danger',
    });
    if (!ok) return;
    setErr('');
    setDeleting(true);
    try {
      // Reverse the liquidación asiento + kardex INs (shared with the editor's
      // re-liquidar). Orphan items minted only by this import are removed.
      const { touched } = await reverseExpedientePosting({ id: e.id, journalEntryId: e.journalEntryId });
      // The expediente itself goes last (idempotent retry on a mid-way failure).
      await db.importExpedientes.delete(e.id);
      // 5. Its Google Drive folder + documents (best-effort — a Drive blip must
      //    not block the accounting reversal that already succeeded).
      if (e.driveFolderId) driveDelete(e.driveFolderId).catch(() => {});
      // Stock changed → reflect it in the Shopify catalog (best-effort).
      if (touched.length) syncShopify(touched).catch(() => {});
      navigate('/accounting/importaciones');
    } catch (ex) {
      setErr(userMessageFor(ex));
      setDeleting(false);
    }
  }

  return (
    <>
      <BackLink to="/accounting/importaciones">Volver a importaciones</BackLink>
      <PageHeader
        title={`Expediente${meta.number != null ? ` #${meta.number}` : ''}`}
        subtitle={`${formatDate(meta.date)}${meta.bl ? ` · BL ${meta.bl}` : ''}${isDraft ? ' · Borrador (sin contabilizar)' : ''}`}
        actions={(
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => navigate(`/accounting/importaciones/${expQ.data.id}/editar`)} className="btn-primary">
              <Pencil size={14} /> {isDraft ? 'Editar / Contabilizar' : 'Editar'}
            </button>
            <button type="button" onClick={useAsTemplate} className="btn-secondary">
              <Copy size={14} /> Usar como plantilla
            </button>
            <button type="button" onClick={deleteExpediente} disabled={deleting}
              className="btn-secondary text-rose-600 hover:bg-rose-50 hover:border-rose-200 disabled:opacity-50">
              {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} <span className="hidden sm:inline">Eliminar</span>
            </button>
          </div>
        )}
      />
      {err && <p className="text-sm text-rose-600 mb-3">{err}</p>}

      {/* Meta strip */}
      <div className="card p-3 mb-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Meta label="Proveedor">{meta.supplierId
          ? <Link to={`/accounting/proveedor-360?supplier=${meta.supplierId}`} className="text-brand-600 hover:text-brand-700 hover:underline">{meta.supplierName}</Link>
          : meta.supplierName}</Meta>
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
              <h4 className="font-display font-medium text-ink-700 inline-flex items-center gap-1.5"><Ship size={15} /> Embarque {ei + 1}</h4>
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
                    {f.supplierId
                      ? <Link to={`/accounting/proveedor-360?supplier=${f.supplierId}`} className="font-medium text-brand-600 hover:text-brand-700 hover:underline">{f.supplierName || 'Factura'}</Link>
                      : <span className="font-medium text-ink-700">{f.supplierName || 'Factura'}</span>}
                    {f.invoiceRef && <span className="text-xs text-ink-500">No. {f.invoiceRef}</span>}
                    {f.ncf && <span className="font-mono text-xs text-ink-500">{f.ncf}</span>}
                    <span className="ml-auto text-xs text-ink-500 tabular-nums">{f.lines.length} línea{f.lines.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="hidden md:flex justify-end mb-2">
                    <ColumnsMenu columns={lineCols.columns} visible={lineCols.visible} onChange={lineCols.setVisible} onReset={() => { lineCols.reset(); resetLineWidths(); }} />
                  </div>
                  <div className="overflow-x-auto -mx-2.5">
                  <table ref={lineTableRef} style={lineTableStyle} className="w-full text-sm min-w-[640px]">
                    <thead className="text-ink-400 text-[11px] uppercase tracking-wide">
                      <tr>
                        {lineCols.cols.map((col) => (
                          <th key={col.key} className={col.thClass || ''} {...lineThProps(col.key)}>{col.label}{LineResizeHandle(col.key)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {f.lines.map((l) => {
                        const ctx = { l };
                        return (
                          <tr key={l.id} className="border-t border-ink-50">
                            {lineCols.cols.map((col) => (
                              <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-ink-100 text-xs text-ink-500">
                        {lineCols.cols.map((col) => (
                          <td key={col.key} className={col.footClass || ''}>
                            {col.foot ? col.foot({ f }) : null}
                          </td>
                        ))}
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

      {/* Costos del expediente — ONE section: the expediente's own cost-sheet
          rows (capitalized into landed cost) AND the linked compras/gastos, in a
          single list. A cost row that's a standalone compra/gasto opens its own
          document; the expediente's inline cost rows are read-only here. */}
      <div className="card overflow-hidden mt-4">
        <div className="card-header">
          <h2 className="inline-flex items-center gap-1.5"><ShoppingCart size={14} /> Costos del expediente</h2>
        </div>
        {linkedCompras.count === 0 ? (
          <p className="text-xs text-ink-400 px-3 py-3">Sin costos adicionales — el costo en destino es CIF + impuestos capitalizables. Registra un gasto o compra y enlázalo a este expediente para que aparezca aquí.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table min-w-[680px]">
              <thead>
                <tr>
                  <th className="whitespace-nowrap">Fecha</th>
                  <th>Proveedor</th>
                  <th>Concepto</th>
                  <th className="whitespace-nowrap">NCF</th>
                  <th className="text-right whitespace-nowrap">Neto al costo</th>
                  <th className="text-right whitespace-nowrap">ITBIS</th>
                  <th className="text-right whitespace-nowrap">Total</th>
                </tr>
              </thead>
              <tbody>
                {linkedCompras.rows.map((c) => {
                  const own = c.source === 'expediente-cost';
                  return (
                    <tr key={c.id}
                      onClick={() => { if (!own) navigate(`/accounting/compras-gastos/${c.id}`); }}
                      onKeyDown={own ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/accounting/compras-gastos/${c.id}`); } }}
                      tabIndex={own ? undefined : 0}
                      className={own ? '' : 'cursor-pointer hover:bg-ink-50 transition-colors focus-visible:bg-ink-50 focus-visible:outline-none'}>
                      <td className="text-ink-500 whitespace-nowrap">{formatDate(c.date)}</td>
                      <td className="min-w-0">{c.supplierName || '—'}</td>
                      <td className="text-ink-600 min-w-0">
                        {c.destination}
                        <span className="ml-1.5 text-[11px] text-ink-400">{own ? 'expediente' : (NATURE_LABEL[c.nature] || c.nature)}</span>
                      </td>
                      <td className="tabular-nums text-ink-500 whitespace-nowrap">{c.ncf || '—'}</td>
                      <td className="text-right tabular-nums whitespace-nowrap">{formatDop(c.base)}</td>
                      <td className="text-right tabular-nums text-ink-500 whitespace-nowrap">{formatDop(c.itbis)}</td>
                      <td className="text-right tabular-nums font-medium whitespace-nowrap">{formatDop(c.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-ink-200 font-semibold">
                  <td colSpan={4}>{linkedCompras.count} costo{linkedCompras.count === 1 ? '' : 's'}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{formatDop(linkedCompras.totals.base)}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{formatDop(linkedCompras.totals.itbis)}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{formatDop(linkedCompras.totals.total)}</td>
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
