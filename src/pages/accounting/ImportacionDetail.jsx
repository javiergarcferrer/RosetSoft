import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Shield, Ship, Receipt, Plus, Copy, Container, BookOpen, Trash2, Loader2, Pencil } from 'lucide-react';
import BackLink from '../../components/BackLink.jsx';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import DriveDocumentsCard from '../../components/drive/DriveDocumentsCard.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import { formatDop, formatDate, formatMoney } from '../../lib/format.js';
import { effectiveDopRate } from '../../lib/exchangeRate.js';
import { syncShopify } from '../../lib/shopifySync.js';
import { driveDelete } from '../../lib/google.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import {
  resolveExpedienteDetail, resolveAccountingConfig, debitTotal, creditTotal, resolveKardex,
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
 * Cost-sheet columns (Shopify-style customizable list). Read-only list of the
 * expediente's extra costs — `concept` is the fixed anchor; the rest toggle.
 * `cell`/`foot` are pure over the per-cost `ctx` (or the totals bag).
 */
const COST_COLUMNS = [
  {
    key: 'concept', label: 'Concepto', canHide: false,
    cell: ({ c }) => c.label,
  },
  {
    key: 'supplier', label: 'Proveedor',
    tdClass: 'min-w-0',
    cell: ({ c }) => c.supplierName || '—',
  },
  {
    key: 'ncf', label: 'NCF',
    thClass: 'whitespace-nowrap', tdClass: 'font-mono text-xs whitespace-nowrap',
    cell: ({ c }) => c.ncf || '—',
  },
  {
    key: 'payment', label: 'Pago',
    thClass: 'whitespace-nowrap', tdClass: 'text-ink-500 whitespace-nowrap',
    cell: ({ c }) => c.payment,
  },
  {
    key: 'amount', label: 'Monto',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ c }) => formatDop(c.amount),
    footClass: 'text-right tabular-nums whitespace-nowrap', foot: ({ costTotals }) => formatDop(costTotals.gross),
  },
  {
    key: 'itbis', label: 'ITBIS',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ c }) => formatDop(c.itbis),
    footClass: 'text-right tabular-nums whitespace-nowrap', foot: ({ costTotals }) => formatDop(costTotals.itbis),
  },
  {
    key: 'net', label: 'Neto al costo',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums font-medium whitespace-nowrap',
    cell: ({ c }) => formatDop(c.net),
    footClass: 'text-right tabular-nums whitespace-nowrap', foot: ({ costTotals }) => formatDop(costTotals.net),
  },
];
const COST_DEFAULT = { supplier: true, ncf: true, payment: true, amount: true, itbis: true, net: true };
const COST_COLS_KEY = 'rs.importacion.detail.costs.cols.v1';

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

  // Customizable columns (Shopify "Columnas") — persisted per browser. The
  // per-factura líneas tables all share ONE choice (one hook); the cost sheet
  // has its own. Each renders `cols` (anchor + toggled-on, in order) and feeds
  // the full set to its <ColumnsMenu>.
  const lineCols = useColumns(LINE_COLUMNS, LINE_DEFAULT, LINE_COLS_KEY);
  const costCols = useColumns(COST_COLUMNS, COST_DEFAULT, COST_COLS_KEY);
  // Drag-to-resize widths (persisted). The per-factura líneas tables share ONE
  // widths state (one hook), same as they share one columns choice; the cost
  // sheet has its own. tableRef points at the last-rendered líneas instance —
  // fine, every instance reads the same widths/style/thProps.
  const {
    tableRef: lineTableRef, tableStyle: lineTableStyle, thProps: lineThProps,
    ResizeHandle: LineResizeHandle, reset: resetLineWidths,
  } = useColumnWidths(lineCols.cols, 'rs.importacion.detail.lines.widths.v1');
  const {
    tableRef: costTableRef, tableStyle: costTableStyle, thProps: costThProps,
    ResizeHandle: CostResizeHandle, reset: resetCostWidths,
  } = useColumnWidths(costCols.cols, 'rs.importacion.detail.costs.widths.v1');

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

  const { meta, totals, embarques, costs, costTotals } = detail;
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
    navigate('/accounting/importaciones?new=1');
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
    if (!confirm(`¿Eliminar el expediente${e.number != null ? ` #${e.number}` : ''}? Se revierten el asiento, los movimientos de inventario y las existencias${e.driveFolderId ? ', y se borra su carpeta de documentos en Drive' : ''}. Esta acción no se puede deshacer.`)) return;
    setErr('');
    setDeleting(true);
    try {
      // The kardex IN movements this expediente posted (refTable/refId tag).
      const expMoves = (await db.inventoryMovements.where('refId').equals(e.id).toArray())
        .filter((m) => m.refTable === 'import_expedientes');
      const touched = [...new Set(expMoves.map((m) => m.itemId).filter(Boolean))];

      // 1. The asiento — lines first, then the entry (mirror the quote cascade).
      if (e.journalEntryId) {
        const jl = await db.journalLines.where('entryId').equals(e.journalEntryId).toArray();
        await db.journalLines.bulkDelete(jl.map((l) => l.id));
        await db.journalEntries.delete(e.journalEntryId);
      }
      // 2. This expediente's kardex movements.
      await db.inventoryMovements.bulkDelete(expMoves.map((m) => m.id));
      // 3. Recompute each touched item from what's LEFT (self-heals the
      //    denormalized qty/avg the weighted-average IN had advanced). If an
      //    item has NO movements left, this expediente was its sole source —
      //    it was minted by the import, so remove the orphaned product too
      //    instead of leaving a phantom zero-stock SKU in inventario.
      for (const itemId of touched) {
        const remaining = await db.inventoryMovements.where('itemId').equals(itemId).toArray();
        if (!remaining.length) {
          await db.inventoryItems.delete(itemId);
          continue;
        }
        const k = resolveKardex(remaining);
        await db.inventoryItems.update(itemId, { qtyOnHand: k.qty, avgCost: k.avgCost });
      }
      // 4. The expediente itself.
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
            {isDraft && (
              <button type="button" onClick={() => navigate(`/accounting/importaciones?edit=${expQ.data.id}`)} className="btn-primary">
                <Pencil size={14} /> Editar / Contabilizar
              </button>
            )}
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
                    <span className="font-medium text-ink-700">{f.supplierName || 'Factura'}</span>
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

      {/* Cost sheet */}
      <div className="card overflow-hidden mt-4">
        <div className="card-header"><h2>Costos del expediente</h2></div>
        {costs.length === 0 ? (
          <p className="text-xs text-ink-400 px-3 py-3">Sin costos adicionales — el costo en destino es CIF + impuestos capitalizables.</p>
        ) : (
          <>
          <div className="hidden md:flex justify-end px-3 pt-3">
            <ColumnsMenu columns={costCols.columns} visible={costCols.visible} onChange={costCols.setVisible} onReset={() => { costCols.reset(); resetCostWidths(); }} />
          </div>
          <div className="overflow-x-auto">
          <table ref={costTableRef} style={costTableStyle} className="table min-w-[560px]">
            <thead>
              <tr>
                {costCols.cols.map((col) => (
                  <th key={col.key} className={col.thClass || ''} {...costThProps(col.key)}>{col.label}{CostResizeHandle(col.key)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {costs.map((c) => {
                const ctx = { c };
                return (
                  <tr key={c.id}>
                    {costCols.cols.map((col) => (
                      <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-ink-200 font-semibold">
                {costCols.cols.map((col, i) => (
                  i === 0
                    ? <td key={col.key} className={col.footClass || ''}>{costs.length} costo{costs.length === 1 ? '' : 's'}</td>
                    : <td key={col.key} className={col.footClass || ''}>{col.foot ? col.foot({ costTotals }) : null}</td>
                ))}
              </tr>
            </tfoot>
          </table>
          </div>
          </>
        )}
      </div>

      {/* Documentos en Google Drive — one folder per importation */}
      <DriveDocumentsCard
        folderId={expQ.data.driveFolderId}
        folderUrl={expQ.data.driveFolderUrl}
        folderName={`Importación ${meta.number != null ? `#${meta.number}` : ''}${meta.bl ? ` — BL ${meta.bl}` : ''}`.trim()}
        onFolderSaved={({ id, url }) => db.importExpedientes.update(expQ.data.id, { driveFolderId: id, driveFolderUrl: url })}
      />

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
