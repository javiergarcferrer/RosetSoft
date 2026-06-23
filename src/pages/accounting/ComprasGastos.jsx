import { userMessageFor } from '../../lib/errorMessages.js';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Receipt, Plus, Loader2, Check, X, Download, Search, Trash2, FileText } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import RowCards from '../../components/RowCards.jsx';
import SearchPicker from '../../components/SearchPicker.jsx';
import TabPills from '../../components/accounting/TabPills.jsx';
import PeriodPicker, { periodWindow } from '../../components/accounting/PeriodPicker.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { isoDate, parseISODate } from '../../lib/commissionCycle.js';
import { downloadCsv, downloadText } from '../../lib/csv.js';
import {
  resolvePurchasesExpenses, resolve606, NATURES, NATURE_LABEL,
  buildExpenseEntry, buildPurchaseEntry, computeExpenseTaxes, resolvePurchaseLines,
  resolveAccountingConfig, classOf, postableAccounts, weightedAverageIn,
  dgii606Txt, dgiiPeriod, dgiiTxtFilename,
} from '../../core/accounting/index.js';

const PAY_LABEL = { cash: 'Efectivo', bank: 'Banco', card: 'Tarjeta', credit: 'Crédito' };
const NATURE_BADGE = {
  gasto: 'bg-ink-100 text-ink-600',
  mercancia: 'bg-emerald-50 text-emerald-700',
  activo: 'bg-sky-50 text-sky-700',
};

function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function NatureBadge({ nature }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${NATURE_BADGE[nature] || NATURE_BADGE.gasto}`}>{NATURE_LABEL[nature] || nature}</span>;
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
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

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
  const seedNature = NATURES.some((n) => n.key === params.get('new')) ? params.get('new') : 'gasto';
  const [tab, setTab] = useState(params.get('tab') === '606' ? '606' : 'list'); // 'list' | '606'
  const [from, setFrom] = useState(() => isoDate(new Date(today.getFullYear(), today.getMonth(), 1).getTime()));
  const [to, setTo] = useState(() => isoDate(today.getTime()));
  const [showForm, setShowForm] = useState(!!params.get('new'));
  const [nature, setNature] = useState('all');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [listQuery, setListQuery] = useState('');
  const [txtErr, setTxtErr] = useState('');

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

  const natureChips = [{ key: 'all', label: 'Todo' }, ...NATURES];

  return (
    <AccountingGate title="Compras y gastos">
      <PageHeader title="Compras y gastos" subtitle="Toda factura de proveedor — mercancía, activos y gastos — en un solo lugar · se asienta sola · 606"
        actions={<button type="button" onClick={() => { setShowForm((v) => !v); setTab('list'); }} className="btn-primary"><Plus size={15} /> Nuevo</button>} />

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
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm border transition-colors ${active ? 'bg-ink-900 text-white border-ink-900' : 'bg-surface text-ink-600 border-ink-200 hover:border-ink-300'}`}>
                {c.label}<span className={`tabular-nums text-xs ${active ? 'text-white/70' : 'text-ink-400'}`}>{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {showForm && loaded && (
        <UnifiedDocForm
          scope={scope} config={config} suppliers={suppliersQ.data} suppliersById={suppliersById}
          accounts={accountsQ.data} items={itemsQ.data} expedientes={expedientesQ.data}
          initialNature={seedNature}
          initial={{ description: params.get('desc') || '', base: params.get('amount') || '', itbis: params.get('itbis') ?? '' }}
          onClose={() => setShowForm(false)} />
      )}

      {!loaded ? <ListLoading /> : tab === 'list' ? (
        list.count === 0 ? (
          <EmptyState icon={Receipt} title="Sin movimientos en el período" description="Registra una compra o gasto con “Nuevo”." />
        ) : (
          <>
          <RowCards
            rows={list.rows.map((r) => ({
              key: r.id,
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
                      <tr key={r.id}>{listCols.cols.map((col) => <td key={col.key} className={col.tdClass || ''}>{col.cell({ r })}</td>)}</tr>
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

const blankLine = () => ({ id: newId(), itemId: '', name: '', reference: '', qty: '', cost: '' });
const expOptLabel = (e) => `#${e.number ?? ''}${e.bl ? ` · ${e.bl}` : ''}`.trim();

/**
 * One registration form for every supplier invoice. A NATURE toggle (Gasto ·
 * Mercancía · Activo fijo) drives the destination: a gasto/activo hits a chart
 * account; mercancía captures article LÍNEAS that land in inventory (one kardex
 * IN each). A gasto writes to `expenses`; mercancía/activo to `purchases`. Any
 * nature can link to an import expediente. ITBIS + retentions follow the base.
 */
function UnifiedDocForm({ scope, config, suppliers, suppliersById, accounts, items, expedientes, initialNature, initial, onClose }) {
  const [form, setForm] = useState({
    nature: initialNature || 'gasto', supplierId: '', date: isoDate(Date.now()), ncf: '', ncfType: '',
    accountCode: '', expedienteId: '', description: initial?.description || '',
    base: initial?.base || '', itbis: initial?.itbis ?? '', retIsr: '', retItbis: '', paymentMethod: 'bank',
  });
  const [lines, setLines] = useState([blankLine()]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const nature = form.nature;
  const goods = nature === 'mercancia';

  const accountOpts = useMemo(() => {
    const cls = nature === 'activo' ? 1 : 6;
    return postableAccounts(accounts).filter((a) => classOf(a.code) === cls).sort((a, b) => a.code.localeCompare(b.code));
  }, [accounts, nature]);
  const itemOptions = useMemo(
    () => items.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((i) => ({ id: i.id, label: i.name, sublabel: i.sku || '' })),
    [items],
  );
  const expedienteOpts = useMemo(() => expedientes.slice().sort((a, b) => (b.liquidatedAt || 0) - (a.liquidatedAt || 0)), [expedientes]);

  const lineRes = useMemo(() => resolvePurchaseLines(lines), [lines]);
  const base = goods ? lineRes.base : (Number(form.base) || 0);

  function recompute(amount, supplier) {
    const t = computeExpenseTaxes({ base: Number(amount) || 0, retainIsr: !!supplier?.retainIsr, retainItbis: !!supplier?.retainItbis, config });
    return { itbis: String(t.itbis), retIsr: String(t.retIsr), retItbis: String(t.retItbis) };
  }
  // Mercancía has no base input (it's Σ líneas) → recompute the suggested taxes
  // whenever the líneas/supplier move. Gasto/activo recompute on the base input.
  useEffect(() => {
    if (!goods) return;
    setForm((f) => ({ ...f, ...recompute(lineRes.base, suppliersById.get(f.supplierId)) }));
  }, [goods, lineRes.base, form.supplierId]); // eslint-disable-line react-hooks/exhaustive-deps

  function setNature(n) {
    setForm((f) => ({ ...f, nature: n, accountCode: n === 'gasto' ? (suppliersById.get(f.supplierId)?.defaultAccountCode || '') : '' }));
  }
  function onSupplier(id) {
    const s = suppliersById.get(id);
    setForm((f) => ({
      ...f, supplierId: id,
      accountCode: f.nature === 'gasto' ? (s?.defaultAccountCode || f.accountCode) : f.accountCode,
      ...(goods ? {} : recompute(f.base, s)),
    }));
  }
  function onBase(v) { const s = suppliersById.get(form.supplierId); setForm((f) => ({ ...f, base: v, ...recompute(v, s) })); }

  const addLine = () => setLines((ls) => [...ls, blankLine()]);
  const patchLine = (id, patch) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const delLine = (id) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.id !== id) : ls.map((l) => (l.id === id ? blankLine() : l))));

  const newItemCount = useMemo(() => lineRes.lines.filter((l) => !l.itemId && l.name && l.qty > 0).length, [lineRes]);

  async function save() {
    setErr('');
    const itbis = Number(form.itbis) || 0;
    const retIsr = Number(form.retIsr) || 0;
    const retItbis = Number(form.retItbis) || 0;
    if (goods) {
      const ls = lineRes.lines;
      if (ls.length === 0) { setErr('Agrega al menos una línea con artículo, cantidad y costo.'); return; }
      if (ls.some((l) => !(l.itemId || l.name))) { setErr('Cada línea necesita un artículo.'); return; }
      if (ls.some((l) => !(l.qty > 0) || !(l.cost > 0))) { setErr('Cada línea necesita cantidad y costo mayores que cero.'); return; }
    } else {
      if (base <= 0) { setErr('El monto base debe ser mayor que cero.'); return; }
      if (!form.accountCode) { setErr(nature === 'activo' ? 'Elige la cuenta de activo.' : 'Elige la cuenta de gasto.'); return; }
    }
    setSaving(true);
    try {
      const id = newId();
      const postedAt = parseISODate(form.date);
      const expedienteId = form.expedienteId || null;
      const common = {
        supplierId: form.supplierId || null, base, itbis,
        retentionIsr: retIsr, retentionItbis: retItbis, paymentMethod: form.paymentMethod, ncf: form.ncf,
      };

      if (nature === 'gasto') {
        const built = buildExpenseEntry({
          newId, config, postedAt,
          expense: { id, ...common, accountCode: form.accountCode, description: form.description },
        });
        await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
        await db.journalLines.bulkPut(built.lines);
        await assignSequenceNumber({
          table: 'expenses', profileId: scope, start: 1,
          build: (n) => ({
            id, profileId: scope, number: n, supplierId: form.supplierId || null, expenseAt: postedAt,
            ncf: form.ncf, ncfType: form.ncfType, accountCode: form.accountCode, description: form.description,
            expedienteId, base, itbis, itbisCreditable: true, retentionIsr: retIsr, retentionItbis: retItbis,
            paymentMethod: form.paymentMethod, paidAt: form.paymentMethod === 'credit' ? null : postedAt,
            journalEntryId: built.entry.id,
          }),
        });
        onClose();
        return;
      }

      // mercancía / activo → purchases
      const kind = goods ? 'goods' : 'asset';
      let storedLines = [];
      let itemById = new Map(items.map((i) => [i.id, i]));
      if (goods) {
        const newItems = [];
        const variantKey = (sku, name) => JSON.stringify([(sku || '').trim(), (name || '').trim()]);
        const idByVariant = new Map(items.map((i) => [variantKey(i.sku, i.name), i.id]));
        storedLines = lineRes.lines.map((l) => {
          const row = { id: l.id, itemId: l.itemId, name: l.name, reference: l.reference, qty: l.qty, cost: l.cost };
          if (l.itemId || !l.name) return row;
          const reuse = idByVariant.get(variantKey(l.reference, l.name));
          if (reuse) return { ...row, itemId: reuse };
          const newItemId = newId();
          newItems.push({ id: newItemId, profileId: scope, sku: l.reference, name: l.name, unit: 'unidad', qtyOnHand: 0, avgCost: 0 });
          idByVariant.set(variantKey(l.reference, l.name), newItemId);
          return { ...row, itemId: newItemId };
        });
        if (newItems.length) await db.inventoryItems.bulkPut(newItems);
        itemById = new Map([...items, ...newItems].map((i) => [i.id, i]));
      }

      const built = buildPurchaseEntry({
        newId, config, postedAt,
        purchase: { id, ...common, kind, accountCode: goods ? null : form.accountCode, memo: form.description },
      });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'purchases', profileId: scope, start: 1,
        build: (n) => ({
          id, profileId: scope, number: n, supplierId: form.supplierId || null, purchaseAt: postedAt,
          ncf: form.ncf, ncfType: '', kind, accountCode: goods ? null : form.accountCode, description: form.description,
          itemId: null, qty: goods ? lineRes.qty : 0, lines: storedLines, expedienteId,
          base, itbis, itbisCreditable: true, retentionIsr: retIsr, retentionItbis: retItbis,
          paymentMethod: form.paymentMethod, paidAt: form.paymentMethod === 'credit' ? null : postedAt,
          journalEntryId: built.entry.id,
        }),
      });
      if (goods) {
        for (const l of storedLines) {
          const unitCost = l.qty > 0 ? Math.round((l.cost / l.qty) * 10000) / 10000 : 0;
          if (!l.itemId || l.qty <= 0 || unitCost <= 0) continue;
          await db.inventoryMovements.put({
            id: newId(), profileId: scope, itemId: l.itemId, type: 'in', qty: l.qty, unitCost,
            movedAt: postedAt, refTable: 'purchases', refId: id, journalEntryId: built.entry.id,
          });
          const it = itemById.get(l.itemId);
          if (it) {
            const newAvg = weightedAverageIn(it.qtyOnHand || 0, it.avgCost || 0, l.qty, unitCost);
            const newQty = (it.qtyOnHand || 0) + l.qty;
            await db.inventoryItems.update(l.itemId, { qtyOnHand: newQty, avgCost: newAvg });
            itemById.set(l.itemId, { ...it, qtyOnHand: newQty, avgCost: newAvg });
          }
        }
      }
      onClose();
    } catch (e) {
      setErr(userMessageFor(e));
      setSaving(false);
    }
  }

  const field = 'input';
  const numField = 'input text-right tabular-nums';
  const net = base + (Number(form.itbis) || 0) - (Number(form.retIsr) || 0) - (Number(form.retItbis) || 0);

  return (
    <div className="card p-4 mb-4 border-ink-300 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display font-semibold">Nueva compra o gasto</h3>
        <button type="button" onClick={onClose} className="btn-icon text-ink-400 shrink-0" aria-label="Cerrar"><X size={18} /></button>
      </div>

      {/* Nature toggle — the one decision that shapes the form */}
      <div className="inline-flex rounded-lg border border-ink-200 p-0.5 mb-3 bg-ink-50/40">
        {NATURES.map((n) => (
          <button key={n.key} type="button" onClick={() => setNature(n.key)}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors ${nature === n.key ? 'bg-surface shadow-xs font-medium text-ink-800' : 'text-ink-500 hover:text-ink-700'}`}>
            {n.label}
          </button>
        ))}
      </div>

      <div className="grid sm:grid-cols-2 gap-3 max-w-3xl">
        <select value={form.supplierId} onChange={(e) => onSupplier(e.target.value)} className={field}>
          <option value="">— Proveedor —</option>
          {suppliers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={field} />
        {!goods && (
          <select value={form.accountCode} onChange={(e) => setForm((f) => ({ ...f, accountCode: e.target.value }))} className={field}>
            <option value="">— {nature === 'activo' ? 'Cuenta de activo' : 'Cuenta de gasto'} —</option>
            {accountOpts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        )}
        <input value={form.ncf} onChange={(e) => setForm((f) => ({ ...f, ncf: e.target.value }))} placeholder="NCF" className={field} />
        <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder={goods ? 'Descripción / referencia de la factura' : 'Descripción'} className={`${field} ${goods ? 'sm:col-span-2' : ''}`} />
        {expedienteOpts.length > 0 && (
          <label className="text-xs text-ink-500 sm:col-span-2 inline-flex flex-col">
            <span className="inline-flex items-center gap-1"><FileText size={12} /> Expediente de importación (opcional)</span>
            <select value={form.expedienteId} onChange={(e) => setForm((f) => ({ ...f, expedienteId: e.target.value }))} className={`${field} mt-0.5`}>
              <option value="">— Sin enlazar —</option>
              {expedienteOpts.map((e) => <option key={e.id} value={e.id}>{expOptLabel(e) || e.id}{e.liquidatedAt ? ` · ${formatDate(e.liquidatedAt)}` : ''}{e.status === 'draft' ? ' · borrador' : ''}</option>)}
            </select>
          </label>
        )}
      </div>

      {/* Mercancía: article líneas → inventory (one kardex IN each) */}
      {goods && (
        <div className="mt-4">
          <h4 className="font-display text-sm font-medium text-ink-700 mb-1.5">Líneas de la factura</h4>
          <div className="md:hidden space-y-2">
            {lines.map((l) => (
              <div key={l.id} className="rounded-lg border border-ink-100 bg-ink-50/40 p-2 space-y-2">
                <SearchPicker options={itemOptions} value={l.itemId} text={l.name}
                  placeholder="— Artículo a inventariar —" freeTextLabel="Crear artículo" allowFreeText
                  onPick={(o) => patchLine(l.id, { itemId: o.id, name: o.label, reference: o.sublabel || '' })}
                  onFreeText={(txt) => patchLine(l.id, { itemId: '', name: txt })} />
                {(l.name || '').trim() !== '' && (!l.itemId || l.reference) && (
                  <div className="inline-flex items-center gap-1.5 text-[11px] text-amber-700">
                    {!l.itemId && <span className="inline-flex items-center gap-1"><Plus size={11} /> Nuevo en inventario</span>}
                    {l.reference && <span className="font-mono text-amber-600">{l.reference}</span>}
                  </div>
                )}
                <div className="grid grid-cols-3 gap-2 items-end">
                  <label className="text-[11px] text-ink-400">Cant.<input type="number" min="0" step="1" inputMode="numeric" value={l.qty} onChange={(e) => patchLine(l.id, { qty: e.target.value })} className="input w-full text-right tabular-nums mt-0.5" /></label>
                  <label className="text-[11px] text-ink-400">Costo RD$<input type="number" min="0" step="0.01" inputMode="decimal" value={l.cost} onChange={(e) => patchLine(l.id, { cost: e.target.value })} className="input w-full text-right tabular-nums mt-0.5" /></label>
                  <button type="button" onClick={() => delLine(l.id)} className="btn-icon-danger justify-self-end" title="Eliminar línea" aria-label="Eliminar línea"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm min-w-[480px]">
              <thead className="text-ink-400 text-[11px] uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium pb-1">Artículo <span className="normal-case font-normal">(busca o escribe uno nuevo)</span></th>
                  <th className="text-right font-medium pb-1 w-20 whitespace-nowrap">Cant.</th>
                  <th className="text-right font-medium pb-1 w-32 whitespace-nowrap">Costo RD$</th>
                  <th className="text-right font-medium pb-1 w-28 whitespace-nowrap">C. unit.</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const q = Number(l.qty) || 0;
                  const c = Number(l.cost) || 0;
                  const unit = q > 0 ? c / q : 0;
                  return (
                    <tr key={l.id} className="align-top">
                      <td className="py-0.5 pr-2">
                        <SearchPicker options={itemOptions} value={l.itemId} text={l.name}
                          placeholder="— Artículo a inventariar —" freeTextLabel="Crear artículo" allowFreeText
                          onPick={(o) => patchLine(l.id, { itemId: o.id, name: o.label, reference: o.sublabel || '' })}
                          onFreeText={(txt) => patchLine(l.id, { itemId: '', name: txt })} />
                        {(l.name || '').trim() !== '' && (!l.itemId || l.reference) && (
                          <div className="mt-0.5 inline-flex items-center gap-1.5 text-[11px] text-amber-700">
                            {!l.itemId && <span className="inline-flex items-center gap-1"><Plus size={11} /> Nuevo en inventario</span>}
                            {l.reference && <span className="font-mono text-amber-600">{l.reference}</span>}
                          </div>
                        )}
                      </td>
                      <td className="py-0.5"><input type="number" min="0" step="1" inputMode="numeric" value={l.qty} onChange={(e) => patchLine(l.id, { qty: e.target.value })} className="input w-20 text-right tabular-nums" /></td>
                      <td className="py-0.5"><input type="number" min="0" step="0.01" inputMode="decimal" value={l.cost} onChange={(e) => patchLine(l.id, { cost: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLine(); } }} className="input w-32 text-right tabular-nums" /></td>
                      <td className="py-0.5 text-right text-xs text-ink-500 tabular-nums whitespace-nowrap pr-1 pt-2.5">{unit > 0 ? formatDop(unit) : '—'}</td>
                      <td className="py-0.5 text-right"><button type="button" onClick={() => delLine(l.id)} className="btn-icon-danger" title="Eliminar línea" aria-label="Eliminar línea"><Trash2 size={14} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={addLine} className="btn-ghost text-xs gap-1 mt-1 px-2"><Plus size={12} /> Línea <span className="text-ink-300 normal-case hidden sm:inline">(o Enter en Costo)</span></button>
        </div>
      )}

      {/* Base (mercancía: derived, read-only) + taxes + payment */}
      <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-end gap-3 mt-3">
        <label className="text-sm">Base<br />
          {goods
            ? <input type="number" value={lineRes.base} readOnly tabIndex={-1} className={`${numField} w-full sm:w-28 bg-ink-50 text-ink-500`} />
            : <input type="number" step="0.01" min="0" inputMode="decimal" value={form.base} onChange={(e) => onBase(e.target.value)} className={`${numField} w-full sm:w-28`} />}
        </label>
        <label className="text-sm">ITBIS<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={form.itbis} onChange={(e) => setForm((f) => ({ ...f, itbis: e.target.value }))} className={`${numField} w-full sm:w-28`} /></label>
        <label className="text-sm">Ret. ISR<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={form.retIsr} onChange={(e) => setForm((f) => ({ ...f, retIsr: e.target.value }))} className={`${numField} w-full sm:w-28`} /></label>
        <label className="text-sm">Ret. ITBIS<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={form.retItbis} onChange={(e) => setForm((f) => ({ ...f, retItbis: e.target.value }))} className={`${numField} w-full sm:w-28`} /></label>
        <label className="text-sm col-span-2">Pago<br />
          <select value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))} className={field}>
            <option value="bank">Banco</option><option value="cash">Efectivo</option><option value="card">Tarjeta</option><option value="credit">Crédito</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mt-3 pt-3 border-t border-ink-100">
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-sm text-ink-600">Neto a pagar <b className="tabular-nums">{formatDop(net)}</b></div>
          {goods && newItemCount > 0 && (
            <span className="text-xs text-amber-700 inline-flex items-center gap-1"><Plus size={12} /> {newItemCount} artículo{newItemCount > 1 ? 's' : ''} nuevo{newItemCount > 1 ? 's' : ''} en inventario</span>
          )}
        </div>
        <button type="button" onClick={save} disabled={saving} className="btn-primary">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar
        </button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}
