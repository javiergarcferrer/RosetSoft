import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Receipt, Plus, Download, Search } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import RowCards from '../../components/RowCards.jsx';
import TabPills from '../../components/accounting/TabPills.jsx';
import ResultBar from '../../components/accounting/ResultBar.jsx';
import PeriodPicker, { periodWindow } from '../../components/accounting/PeriodPicker.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { isoDate } from '../../lib/commissionCycle.js';
import { downloadCsv, downloadText } from '../../lib/csv.js';
import {
  resolvePurchasesExpenses, resolve606, NATURES, NATURE_LABEL,
  dgii606Txt, dgiiPeriod, dgiiTxtFilename,
} from '../../core/accounting/index.js';

const PAY_LABEL = { cash: 'Efectivo', bank: 'Banco', card: 'Tarjeta', credit: 'Crédito' };
const NATURE_BADGE = {
  gasto: 'bg-ink-100 text-ink-600',
  mercancia: 'bg-emerald-50 text-emerald-700',
  activo: 'bg-sky-50 text-sky-700',
  expediente: 'bg-violet-50 text-violet-700',
};

function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function NatureBadge({ nature }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${NATURE_BADGE[nature] || NATURE_BADGE.gasto}`}>{nature === 'expediente' ? 'Expediente' : (NATURE_LABEL[nature] || nature)}</span>;
}

/**
 * Unified "Compras y gastos" list columns (Shopify-orders-style customizable
 * list). ONE ordered definition drives header, rows, footer totals AND the
 * Columns menu. `date` is the always-on anchor; each `foot` marks a numeric
 * total so the footer can place it. `cell`/`foot` are pure over the per-row ctx.
 */
const LIST_COLUMNS = [
  {
    key: 'date', label: 'Fecha', canHide: false,
    thClass: 'whitespace-nowrap', tdClass: 'text-ink-500 whitespace-nowrap',
    cell: ({ r }) => formatDate(r.date),
  },
  {
    key: 'nature', label: 'Tipo',
    thClass: 'whitespace-nowrap', tdClass: 'whitespace-nowrap',
    cell: ({ r }) => <NatureBadge nature={r.nature} />,
  },
  {
    key: 'supplier', label: 'Proveedor',
    tdClass: 'min-w-[120px]',
    cell: ({ r }) => r.supplierName || '—',
  },
  {
    key: 'destination', label: 'Destino',
    tdClass: 'text-ink-600 min-w-[160px]',
    cell: ({ r }) => r.destination || '—',
  },
  {
    key: 'expediente', label: 'Expediente',
    thClass: 'whitespace-nowrap', tdClass: 'text-ink-600 whitespace-nowrap',
    cell: ({ r }) => r.expedienteLabel || '—',
  },
  {
    key: 'ncf', label: 'NCF',
    thClass: 'whitespace-nowrap', tdClass: 'tabular-nums text-ink-500 whitespace-nowrap',
    cell: ({ r }) => r.ncf || '—',
  },
  {
    key: 'base', label: 'Base',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => formatDop(r.base),
    foot: ({ totals }) => formatDop(totals.base),
  },
  {
    key: 'itbis', label: 'ITBIS',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ r }) => formatDop(r.itbis),
    foot: ({ totals }) => formatDop(totals.itbis),
  },
  {
    key: 'total', label: 'Total',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums font-medium whitespace-nowrap',
    cell: ({ r }) => formatDop(r.total),
    foot: ({ totals }) => formatDop(totals.total),
  },
  {
    key: 'payment', label: 'Pago',
    thClass: 'whitespace-nowrap', tdClass: 'text-ink-600 whitespace-nowrap',
    cell: ({ r }) => r.paymentLabel || PAY_LABEL[r.payment] || r.payment,
  },
];
const LIST_DEFAULT = {
  nature: true, supplier: true, destination: true, expediente: true, ncf: true, base: true, itbis: true, total: true, payment: true,
};
const LIST_COLS_KEY = 'rs.comprasGastos.cols.v1';

/** 606 table columns — DGII compras de bienes y servicios. `rnc` anchors. */
const FORM606_COLUMNS = [
  { key: 'rnc', label: 'RNC/Cédula', canHide: false, thClass: 'whitespace-nowrap', tdClass: 'tabular-nums whitespace-nowrap', cell: ({ r }) => r.rnc || '—' },
  { key: 'name', label: 'Nombre', tdClass: 'min-w-[120px]', cell: ({ r }) => r.name },
  { key: 'ncf', label: 'NCF', thClass: 'whitespace-nowrap', tdClass: 'tabular-nums text-ink-500 whitespace-nowrap', cell: ({ r }) => r.ncf || '—' },
  { key: 'date', label: 'Fecha', thClass: 'whitespace-nowrap', tdClass: 'text-ink-500 whitespace-nowrap', cell: ({ r }) => formatDate(r.date) },
  { key: 'base', label: 'Base', thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap', cell: ({ r }) => formatDop(r.base), foot: ({ totals }) => formatDop(totals.base) },
  { key: 'itbis', label: 'ITBIS', thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap', cell: ({ r }) => formatDop(r.itbis), foot: ({ totals }) => formatDop(totals.itbis) },
  { key: 'retIsr', label: 'Ret. ISR', thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap', cell: ({ r }) => formatDop(r.retIsr), foot: ({ totals }) => formatDop(totals.retIsr) },
  { key: 'retItbis', label: 'Ret. ITBIS', thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap', cell: ({ r }) => formatDop(r.retItbis), foot: ({ totals }) => formatDop(totals.retItbis) },
  { key: 'total', label: 'Total', thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums font-medium whitespace-nowrap', cell: ({ r }) => formatDop(r.total), foot: ({ totals }) => formatDop(totals.total) },
];
const FORM606_DEFAULT = { name: true, ncf: true, date: true, base: true, itbis: true, retIsr: true, retItbis: true, total: true };
const FORM606_COLS_KEY = 'rs.comprasGastos.606.cols.v1';

/** Footer row that spans leading columns into a label then renders each total. */
function TotalsFoot({ cols, label, footCtx }) {
  const labelSpan = cols.findIndex((c) => c.foot);
  const leadSpan = labelSpan === -1 ? cols.length : labelSpan;
  const tailCols = labelSpan === -1 ? [] : cols.slice(labelSpan);
  return (
    <tr className="border-t border-ink-200 font-semibold">
      <td colSpan={leadSpan}>{label}</td>
      {tailCols.map((col) => (
        <td key={col.key} className={col.foot ? (col.tdClass || '') : ''}>{col.foot ? col.foot(footCtx) : null}</td>
      ))}
    </tr>
  );
}

/**
 * Compras y gastos — ONE pane for every supplier invoice. A purchase
 * (mercancía → inventario, activo fijo → cuenta) and a gasto (servicio →
 * cuenta) are the same economic event, so they register from one form (a nature
 * toggle) and list in one filterable table; the 606 tab files them all. Replaces
 * the separate Compras + Gastos pages. Self-gates on accounting/admin.
 */
export default function ComprasGastos() {
  const { profileId, settings } = useApp();
  const navigate = useNavigate();
  const scope = profileId || 'team';

  const expensesQ = useLiveQueryStatus(() => db.expenses.where('profileId').equals(scope).toArray(), [scope], []);
  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = expensesQ.loaded && purchasesQ.loaded && suppliersQ.loaded && accountsQ.loaded && itemsQ.loaded && expedientesQ.loaded;

  const suppliersById = useMemo(() => new Map(suppliersQ.data.map((s) => [s.id, s])), [suppliersQ.data]);

  const today = useMemo(() => new Date(), []);
  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') === '606' ? '606' : 'list'); // 'list' | '606'
  const [from, setFrom] = useState(() => isoDate(new Date(today.getFullYear(), today.getMonth(), 1).getTime()));
  const [to, setTo] = useState(() => isoDate(today.getTime()));
  const [nature, setNature] = useState('all');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [listQuery, setListQuery] = useState('');
  const [txtErr, setTxtErr] = useState('');

  // Register + edit are the full-page document editor now. Legacy deep-links
  // (?new=…, the commission-payout handoff; ?edit=… from older detail buttons)
  // redirect there carrying their seed params.
  const newParam = params.get('new');
  const editParam = params.get('edit');
  useEffect(() => {
    if (editParam) { navigate(`/accounting/compras-gastos/${editParam}/editar`, { replace: true }); return; }
    if (!newParam) return;
    const tipo = NATURES.some((n) => n.key === newParam) ? newParam : 'gasto';
    const qs = new URLSearchParams({ tipo });
    for (const k of ['amount', 'itbis', 'desc']) { const v = params.get(k); if (v != null) qs.set(k, v); }
    navigate(`/accounting/compras-gastos/nuevo?${qs.toString()}`, { replace: true });
  }, [newParam, editParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const win = periodWindow(from, to);
  const list = useMemo(() => resolvePurchasesExpenses({
    expenses: expensesQ.data, purchases: purchasesQ.data, suppliers: suppliersQ.data,
    accounts: accountsQ.data, expedientes: expedientesQ.data,
    query: listQuery, nature, supplierId: supplierFilter, ...win,
  }), [expensesQ.data, purchasesQ.data, suppliersQ.data, accountsQ.data, expedientesQ.data, listQuery, nature, supplierFilter, from, to]);
  const form606 = useMemo(() => resolve606({
    expenses: expensesQ.data, purchases: purchasesQ.data, expedientes: expedientesQ.data, suppliers: suppliersQ.data, ...win,
  }), [expensesQ.data, purchasesQ.data, expedientesQ.data, suppliersQ.data, from, to]);

  const listCols = useColumns(LIST_COLUMNS, LIST_DEFAULT, LIST_COLS_KEY);
  const cols606 = useColumns(FORM606_COLUMNS, FORM606_DEFAULT, FORM606_COLS_KEY);
  const listW = useColumnWidths(listCols.cols, 'rs.comprasGastos.widths.v1');
  const w606 = useColumnWidths(cols606.cols, 'rs.comprasGastos.606.widths.v1');

  function export606() {
    const rows = [
      ['RNC/Cédula', 'Nombre', 'NCF', 'Fecha', 'Monto', 'ITBIS', 'Retención ISR', 'Retención ITBIS', 'Total'],
      ...form606.rows.map((r) => [r.rnc, r.name, r.ncf, ymd(r.date), r.base, r.itbis, r.retIsr, r.retItbis, r.total]),
    ];
    downloadCsv(`606_${from}_${to}.csv`, rows);
  }
  function export606Txt() {
    setTxtErr('');
    if (!(settings?.companyRnc || '').trim()) {
      setTxtErr('Configura el "RNC del emisor" en Configuración contable para generar el TXT.');
      return;
    }
    const period = dgiiPeriod(win.end || Date.now());
    downloadText(dgiiTxtFilename('606', settings?.companyRnc, period), dgii606Txt({ rows: form606.rows, rncEmisor: settings?.companyRnc, period }));
  }

  const natureChips = [{ key: 'all', label: 'Todo' }, ...NATURES, { key: 'expediente', label: 'Expediente' }];
  // Expediente cost rows are read-only and live on the import file — a click
  // opens the expediente, not a compra/gasto detail (they aren't editable here).
  const rowHref = (r) => (r.source === 'expediente-cost' ? `/accounting/importaciones/${r.expedienteId}` : `/accounting/compras-gastos/${r.id}`);

  return (
    <AccountingGate title="Compras y gastos">
      <PageHeader title="Compras y gastos" subtitle="Toda factura de proveedor — mercancía, activos y gastos — en un solo lugar · se asienta sola · 606"
        actions={<button type="button" onClick={() => navigate('/accounting/compras-gastos/nuevo')} className="btn-primary"><Plus size={15} /> Nuevo</button>} />

      <TabPills tabs={[{ key: 'list', label: 'Movimientos' }, { key: '606', label: '606' }]} active={tab} onChange={setTab} />

      <div className="flex flex-wrap items-start gap-2">
        <PeriodPicker from={from} to={to} onChange={({ from, to }) => { setFrom(from); setTo(to); }} />
        {tab === 'list' && (
          <>
            <select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)} className="input py-1.5 text-sm">
              <option value="">Todos los proveedores</option>
              {suppliersQ.data.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <div className="relative sm:ml-auto">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-300" />
              <input value={listQuery} onChange={(e) => setListQuery(e.target.value)} placeholder="Buscar proveedor, NCF, cuenta…" className="input py-1.5 pl-8 text-sm w-56" />
            </div>
          </>
        )}
      </div>

      {tab === 'list' && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {natureChips.map((c) => {
            const active = nature === c.key;
            const n = c.key === 'all' ? list.counts.all : (list.counts[c.key] || 0);
            return (
              <button key={c.key} type="button" onClick={() => setNature(c.key)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm border transition-colors ${active ? 'bg-ink-900 text-ink-50 border-ink-900' : 'bg-surface text-ink-600 border-ink-200 hover:border-ink-300'}`}>
                {c.label}<span className={`tabular-nums text-xs ${active ? 'text-ink-50/70' : 'text-ink-400'}`}>{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {!loaded ? <ListLoading /> : tab === 'list' ? (
        list.count === 0 ? (
          (listQuery.trim() || supplierFilter || nature !== 'all') ? (
            <EmptyState icon={Receipt} title="Sin coincidencias" description="Ningún documento coincide con el filtro actual. Ajusta la búsqueda, el proveedor o el tipo." />
          ) : (
            <EmptyState icon={Receipt} title="Sin movimientos en el período" description="Registra una compra o gasto con “Nuevo”." />
          )
        ) : (
          <>
          <ResultBar count={list.count} singular="documento" plural="documentos"
            total={list.count > 0 ? formatDop(list.totals.total) : null}
            note={(() => {
              const parts = [];
              if (listQuery.trim()) parts.push(`“${listQuery.trim()}”`);
              if (supplierFilter) parts.push(suppliersById.get(supplierFilter)?.name || 'proveedor');
              if (nature !== 'all') parts.push(nature === 'expediente' ? 'Expediente' : (NATURE_LABEL[nature] || nature));
              return parts.length ? <> · filtrado por {parts.join(' · ')}</> : null;
            })()} />
          <RowCards
            rows={list.rows.map((r) => ({
              key: r.id,
              to: rowHref(r),
              title: r.supplierName || '—',
              right: formatDop(r.total),
              sub: <span className="inline-flex items-center gap-1.5"><NatureBadge nature={r.nature} />{r.destination}</span>,
              kv: [
                ['Fecha', formatDate(r.date)],
                ...(r.expedienteLabel ? [['Expediente', r.expedienteLabel]] : []),
                ['NCF', r.ncf || '—'],
                ['Base', formatDop(r.base)],
                ['ITBIS', formatDop(r.itbis)],
                ['Pago', r.paymentLabel],
              ],
            }))}
            footer={[
              ['Movimientos', list.count],
              ['Base', formatDop(list.totals.base)],
              ['ITBIS', formatDop(list.totals.itbis)],
              ['Total', formatDop(list.totals.total)],
            ]}
          />
          <div className="hidden md:block">
            <div className="flex justify-end mb-2">
              <ColumnsMenu columns={LIST_COLUMNS} visible={listCols.visible} onChange={listCols.setVisible} onReset={() => { listCols.reset(); listW.reset(); }} />
            </div>
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table ref={listW.tableRef} style={listW.tableStyle} className="table min-w-[760px]">
                  <thead>
                    <tr>{listCols.cols.map((col) => <th key={col.key} className={col.thClass || ''} {...listW.thProps(col.key)}>{col.label}{listW.ResizeHandle(col.key)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {list.rows.map((r) => (
                      <tr key={r.id} tabIndex={0}
                        onClick={() => navigate(rowHref(r))}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(rowHref(r)); } }}
                        className="cursor-pointer transition-colors active:bg-ink-100 focus-visible:bg-ink-50 focus-visible:outline-none">
                        {listCols.cols.map((col) => <td key={col.key} className={col.tdClass || ''}>{col.cell({ r })}</td>)}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><TotalsFoot cols={listCols.cols} label={`${list.count} movimientos`} footCtx={{ totals: list.totals }} /></tfoot>
                </table>
              </div>
            </div>
          </div>
          </>
        )
      ) : (
        <>
          <div className="flex flex-wrap justify-end gap-2 mb-3">
            <button type="button" onClick={export606} disabled={form606.count === 0} className="btn-ghost"><Download size={14} /> Exportar 606 (CSV)</button>
            <button type="button" onClick={export606Txt} disabled={form606.count === 0} className="btn-ghost"><Download size={14} /> TXT DGII (606)</button>
          </div>
          {txtErr && <p className="text-sm text-rose-600 text-right mb-3">{txtErr}</p>}
          {form606.count === 0 ? (
            <EmptyState icon={Receipt} title="Sin comprobantes en el período" description="El 606 se arma con las compras y gastos con NCF del período." />
          ) : (
            <>
            <RowCards
              rows={form606.rows.map((r) => ({
                key: r.id, title: r.name, right: formatDop(r.total), sub: r.rnc || '—',
                kv: [['NCF', r.ncf || '—'], ['Fecha', formatDate(r.date)], ['Base', formatDop(r.base)], ['ITBIS', formatDop(r.itbis)], ['Ret. ISR', formatDop(r.retIsr)], ['Ret. ITBIS', formatDop(r.retItbis)]],
              }))}
              footer={[
                ['Comprobantes', form606.count], ['Base', formatDop(form606.totals.base)], ['ITBIS', formatDop(form606.totals.itbis)],
                ['Ret. ISR', formatDop(form606.totals.retIsr)], ['Ret. ITBIS', formatDop(form606.totals.retItbis)], ['Total', formatDop(form606.totals.total)],
              ]}
            />
            <div className="hidden md:block">
              <div className="flex justify-end mb-2">
                <ColumnsMenu columns={FORM606_COLUMNS} visible={cols606.visible} onChange={cols606.setVisible} onReset={() => { cols606.reset(); w606.reset(); }} />
              </div>
              <div className="card overflow-hidden">
                <div className="overflow-x-auto">
                  <table ref={w606.tableRef} style={w606.tableStyle} className="table min-w-[760px]">
                    <thead>
                      <tr>{cols606.cols.map((col) => <th key={col.key} className={col.thClass || ''} {...w606.thProps(col.key)}>{col.label}{w606.ResizeHandle(col.key)}</th>)}</tr>
                    </thead>
                    <tbody>
                      {form606.rows.map((r) => (
                        <tr key={r.id}>{cols606.cols.map((col) => <td key={col.key} className={col.tdClass || ''}>{col.cell({ r })}</td>)}</tr>
                      ))}
                    </tbody>
                    <tfoot><TotalsFoot cols={cols606.cols} label={`${form606.count} comprobantes`} footCtx={{ totals: form606.totals }} /></tfoot>
                  </table>
                </div>
              </div>
            </div>
            </>
          )}
        </>
      )}
    </AccountingGate>
  );
}
