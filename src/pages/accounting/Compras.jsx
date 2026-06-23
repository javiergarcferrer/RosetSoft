import { userMessageFor } from '../../lib/errorMessages.js';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShoppingCart, Plus, Loader2, Check, X, Trash2, FileText } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import RowCards from '../../components/RowCards.jsx';
import SearchPicker from '../../components/SearchPicker.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import useColumns from '../../components/search/useColumns.js';
import useColumnWidths from '../../components/search/useColumnWidths.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import {
  buildPurchaseEntry, computeExpenseTaxes, resolveAccountingConfig,
  classOf, postableAccounts, weightedAverageIn, resolvePurchaseLines,
} from '../../core/accounting/index.js';

const KIND_LABEL = { goods: 'Mercancía', asset: 'Activo fijo', service: 'Servicio' };
const PAY_LABEL = { cash: 'Efectivo', bank: 'Banco', card: 'Tarjeta', credit: 'Crédito' };

/** Short label for a linked expediente — its number + BL. */
const expLabel = (e) => (e ? `#${e.number ?? ''}${e.bl ? ` · ${e.bl}` : ''}`.trim() : '');
/** Article count of a purchase row — the multi-line count, else the legacy single item. */
const articleCount = (p) => (p.lines?.length ? p.lines.length : (p.kind === 'goods' && p.itemId ? 1 : 0));

/**
 * Desktop table columns (Shopify-orders-style customizable list). ONE ordered
 * definition drives both the table render (`cell`) and the Columns menu. `date`
 * is the fixed identity anchor (`canHide: false`); everything else toggles.
 * Each `cell` is a pure render off the per-row `ctx` the row assembles.
 */
const COMPRAS_COLUMNS = [
  {
    key: 'date', label: 'Fecha', canHide: false,
    thClass: 'whitespace-nowrap', tdClass: 'text-ink-500 whitespace-nowrap',
    cell: ({ p }) => formatDate(p.purchaseAt),
  },
  {
    key: 'supplier', label: 'Proveedor',
    tdClass: 'min-w-[120px]',
    cell: ({ supplierName }) => supplierName || '—',
  },
  {
    key: 'kind', label: 'Tipo',
    thClass: 'whitespace-nowrap', tdClass: 'text-ink-600 whitespace-nowrap',
    cell: ({ p }) => KIND_LABEL[p.kind] || p.kind,
  },
  {
    key: 'articulos', label: 'Artículos',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums text-ink-600 whitespace-nowrap',
    cell: ({ p }) => articleCount(p) || '—',
  },
  {
    key: 'expediente', label: 'Expediente',
    thClass: 'whitespace-nowrap', tdClass: 'text-ink-600 whitespace-nowrap',
    cell: ({ expedienteLabel }) => expedienteLabel || '—',
  },
  {
    key: 'ncf', label: 'NCF',
    thClass: 'whitespace-nowrap', tdClass: 'tabular-nums text-ink-500 whitespace-nowrap',
    cell: ({ p }) => p.ncf || '—',
  },
  {
    key: 'base', label: 'Base',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ p }) => formatDop(p.base),
  },
  {
    key: 'itbis', label: 'ITBIS',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums whitespace-nowrap',
    cell: ({ p }) => formatDop(p.itbis),
  },
  {
    key: 'total', label: 'Total',
    thClass: 'text-right whitespace-nowrap', tdClass: 'text-right tabular-nums font-medium whitespace-nowrap',
    cell: ({ p }) => formatDop((p.base || 0) + (p.itbis || 0)),
  },
  {
    key: 'payment', label: 'Pago',
    thClass: 'whitespace-nowrap', tdClass: 'text-ink-600 whitespace-nowrap',
    cell: ({ p }) => PAY_LABEL[p.paymentMethod] || p.paymentMethod,
  },
];

// Default visibility for the hideable columns — the set the table shipped with
// (date is the always-on anchor). Persisted per-browser; bump the suffix to
// force-reset after changing the column set.
const COMPRAS_DEFAULT = {
  supplier: true, kind: true, articulos: true, expediente: true, ncf: true, base: true, itbis: true, total: true, payment: true,
};
const COMPRAS_COLS_KEY = 'rs.compras.cols.v2';

/**
 * Compras — purchase capture. A goods invoice carries one or more article LINES
 * (each its own item, qty + cost) that capitalize into inventory and create a
 * kardex IN per line; asset/service hit a chart account. A compra can be LINKED
 * to an import expediente for traceability. Each posts a balanced asiento and
 * feeds the 606. Self-gates on accounting/admin.
 */
export default function Compras() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = purchasesQ.loaded && suppliersQ.loaded && accountsQ.loaded && itemsQ.loaded && expedientesQ.loaded;

  const suppliersById = useMemo(() => new Map(suppliersQ.data.map((s) => [s.id, s])), [suppliersQ.data]);
  const expedientesById = useMemo(() => new Map(expedientesQ.data.map((e) => [e.id, e])), [expedientesQ.data]);
  const [params] = useSearchParams();
  const [showForm, setShowForm] = useState(!!params.get('new'));

  // Column visibility (Shopify "edit columns") — persisted per browser.
  const { visible, setVisible, reset, cols } = useColumns(COMPRAS_COLUMNS, COMPRAS_DEFAULT, COMPRAS_COLS_KEY);
  // Drag-to-resize widths (persisted) for the same visible columns.
  const {
    tableRef, tableStyle, thProps, ResizeHandle, reset: resetWidths,
  } = useColumnWidths(cols, 'rs.compras.widths.v1');

  const rows = purchasesQ.data.slice().sort((a, b) => (b.purchaseAt || 0) - (a.purchaseAt || 0));

  return (
    <AccountingGate title="Compras">
      <PageHeader title="Compras" subtitle="Factura de mercancía (líneas a inventario), activos y servicios — se asienta sola"
        actions={<button type="button" onClick={() => setShowForm((v) => !v)} className="btn-primary"><Plus size={15} /> Nueva compra</button>} />

      {showForm && loaded && (
        <NewPurchaseForm scope={scope} config={config} suppliers={suppliersQ.data} suppliersById={suppliersById}
          accounts={accountsQ.data} items={itemsQ.data} expedientes={expedientesQ.data} onClose={() => setShowForm(false)} />
      )}

      {!loaded ? <ListLoading /> : rows.length === 0 ? (
        <EmptyState icon={ShoppingCart} title="Sin compras" description="Registra una compra con “Nueva compra”." />
      ) : (
        <>
        <RowCards
          rows={rows.map((p) => {
            const exp = p.expedienteId ? expedientesById.get(p.expedienteId) : null;
            const arts = articleCount(p);
            return {
              key: p.id,
              title: suppliersById.get(p.supplierId)?.name || '—',
              right: formatDop((p.base || 0) + (p.itbis || 0)),
              sub: KIND_LABEL[p.kind] || p.kind,
              kv: [
                ['Fecha', formatDate(p.purchaseAt)],
                ...(arts ? [['Artículos', String(arts)]] : []),
                ...(exp ? [['Expediente', expLabel(exp)]] : []),
                ['NCF', p.ncf || '—'],
                ['Base', formatDop(p.base)],
                ['ITBIS', formatDop(p.itbis)],
                ['Pago', PAY_LABEL[p.paymentMethod] || p.paymentMethod],
              ],
            };
          })}
        />
        <div className="hidden md:block">
          <div className="flex justify-end mb-2">
            <ColumnsMenu columns={COMPRAS_COLUMNS} visible={visible} onChange={setVisible} onReset={() => { reset(); resetWidths(); }} />
          </div>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table ref={tableRef} style={tableStyle} className="table min-w-[640px]">
                <thead>
                  <tr>
                    {cols.map((col) => (
                      <th key={col.key} className={col.thClass || ''} {...thProps(col.key)}>
                        {col.label}
                        {ResizeHandle(col.key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const ctx = {
                      p,
                      supplierName: suppliersById.get(p.supplierId)?.name,
                      expedienteLabel: p.expedienteId ? expLabel(expedientesById.get(p.expedienteId)) : '',
                    };
                    return (
                      <tr key={p.id}>
                        {cols.map((col) => (
                          <td key={col.key} className={col.tdClass || ''}>{col.cell(ctx)}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        </>
      )}
    </AccountingGate>
  );
}

const blankLine = () => ({ id: newId(), itemId: '', name: '', reference: '', qty: '', cost: '' });

function NewPurchaseForm({ scope, config, suppliers, suppliersById, accounts, items, expedientes, onClose }) {
  const [form, setForm] = useState({
    supplierId: '', date: new Date().toISOString().slice(0, 10), ncf: '', kind: 'goods',
    accountCode: '', expedienteId: '', base: '', itbis: '', retIsr: '', retItbis: '', paymentMethod: 'credit',
  });
  const [lines, setLines] = useState([blankLine()]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const goods = form.kind === 'goods';
  const assetAccounts = useMemo(() => postableAccounts(accounts).filter((a) => classOf(a.code) === 1).sort((a, b) => a.code.localeCompare(b.code)), [accounts]);
  const serviceAccounts = useMemo(() => postableAccounts(accounts).filter((a) => classOf(a.code) === 6).sort((a, b) => a.code.localeCompare(b.code)), [accounts]);
  const itemOptions = useMemo(
    () => items.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((i) => ({ id: i.id, label: i.name, sublabel: i.sku || '' })),
    [items],
  );
  const expedienteOpts = useMemo(
    () => expedientes.slice().sort((a, b) => (b.liquidatedAt || 0) - (a.liquidatedAt || 0)),
    [expedientes],
  );

  // Goods: the base is Σ(line cost), derived from the líneas. Asset/service:
  // the base is the entered amount. ITBIS/retentions follow the base.
  const lineRes = useMemo(() => resolvePurchaseLines(lines), [lines]);
  const base = goods ? lineRes.base : (Number(form.base) || 0);

  function recompute(amount, supplier) {
    const t = computeExpenseTaxes({ base: Number(amount) || 0, retainIsr: !!supplier?.retainIsr, retainItbis: !!supplier?.retainItbis, config });
    return { itbis: String(t.itbis), retIsr: String(t.retIsr), retItbis: String(t.retItbis) };
  }
  // Goods: whenever the líneas (→ base) or supplier change, refresh the
  // suggested ITBIS/retentions. A manual edit to those fields sticks until the
  // base moves again (same contract as the asset/service base input).
  useEffect(() => {
    if (!goods) return;
    setForm((f) => ({ ...f, ...recompute(lineRes.base, suppliersById.get(f.supplierId)) }));
  }, [goods, lineRes.base, form.supplierId]); // eslint-disable-line react-hooks/exhaustive-deps

  function onSupplier(id) {
    const s = suppliersById.get(id);
    setForm((f) => ({ ...f, supplierId: id, ...(goods ? {} : recompute(f.base, s)) }));
  }
  function onBase(v) { const s = suppliersById.get(form.supplierId); setForm((f) => ({ ...f, base: v, ...recompute(v, s) })); }

  const addLine = () => setLines((ls) => [...ls, blankLine()]);
  const patchLine = (id, patch) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const delLine = (id) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.id !== id) : ls.map((l) => (l.id === id ? blankLine() : l))));

  const newItemCount = useMemo(
    () => lineRes.lines.filter((l) => !l.itemId && l.name && l.qty > 0).length,
    [lineRes],
  );

  async function save() {
    setErr('');
    const itbis = Number(form.itbis) || 0;
    const retIsr = Number(form.retIsr) || 0;
    const retItbis = Number(form.retItbis) || 0;
    if (goods) {
      // Every kept line must be a complete article so the inventory debit (base
      // = Σ cost) equals the sum of the kardex INs (each cost / qty). A line with
      // a cost but no qty/article would capitalize without a movement → drift.
      const ls = lineRes.lines;
      if (ls.length === 0) { setErr('Agrega al menos una línea con artículo, cantidad y costo.'); return; }
      if (ls.some((l) => !(l.itemId || l.name))) { setErr('Cada línea necesita un artículo.'); return; }
      if (ls.some((l) => !(l.qty > 0) || !(l.cost > 0))) { setErr('Cada línea necesita cantidad y costo mayores que cero.'); return; }
    } else {
      if (base <= 0) { setErr('El monto base debe ser mayor que cero.'); return; }
      if (!form.accountCode) { setErr('Elige la cuenta de destino.'); return; }
    }
    setSaving(true);
    try {
      const id = newId();
      const postedAt = new Date(form.date).getTime();
      const expedienteId = form.expedienteId || null;

      // Goods: free-text lines first become real inventory items (matched/deduped
      // by sku + name, mirroring inventory_items_sku_name_uq), so the kardex IN
      // and the stored line both point at a real artículo.
      let storedLines = [];
      let itemById = new Map(items.map((i) => [i.id, i]));
      if (goods) {
        const newItems = [];
        const variantKey = (sku, name) => JSON.stringify([(sku || '').trim(), (name || '').trim()]);
        const idByVariant = new Map(items.map((i) => [variantKey(i.sku, i.name), i.id]));
        storedLines = lineRes.lines.map((l) => {
          if (l.itemId || !l.name) return { id: l.id, itemId: l.itemId, name: l.name, reference: l.reference, qty: l.qty, cost: l.cost };
          const reuse = idByVariant.get(variantKey(l.reference, l.name));
          if (reuse) return { id: l.id, itemId: reuse, name: l.name, reference: l.reference, qty: l.qty, cost: l.cost };
          const itemId = newId();
          newItems.push({ id: itemId, profileId: scope, sku: l.reference, name: l.name, unit: 'unidad', qtyOnHand: 0, avgCost: 0 });
          idByVariant.set(variantKey(l.reference, l.name), itemId);
          return { id: l.id, itemId, name: l.name, reference: l.reference, qty: l.qty, cost: l.cost };
        });
        if (newItems.length) await db.inventoryItems.bulkPut(newItems);
        itemById = new Map([...items, ...newItems].map((i) => [i.id, i]));
      }

      const built = buildPurchaseEntry({
        newId, config, postedAt,
        purchase: {
          id, supplierId: form.supplierId || null, kind: form.kind,
          accountCode: goods ? null : form.accountCode,
          base, itbis, retentionIsr: retIsr, retentionItbis: retItbis,
          paymentMethod: form.paymentMethod, ncf: form.ncf,
        },
      });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'purchases', profileId: scope, start: 1,
        build: (n) => ({
          id, profileId: scope, number: n, supplierId: form.supplierId || null, purchaseAt: postedAt,
          ncf: form.ncf, ncfType: '', kind: form.kind, accountCode: goods ? null : form.accountCode,
          itemId: null, qty: goods ? lineRes.qty : 0, lines: storedLines, expedienteId,
          base, itbis, itbisCreditable: true, retentionIsr: retIsr, retentionItbis: retItbis,
          paymentMethod: form.paymentMethod, paidAt: form.paymentMethod === 'credit' ? null : postedAt,
          journalEntryId: built.entry.id,
        }),
      });
      // Goods → one kardex IN per line at unit cost = cost / qty, weighted-average
      // applied sequentially (same item across lines accumulates correctly).
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
        <h3 className="font-display font-semibold">Nueva compra</h3>
        <button type="button" onClick={onClose} className="btn-icon text-ink-400 shrink-0" aria-label="Cerrar"><X size={18} /></button>
      </div>
      <div className="grid sm:grid-cols-2 gap-3 max-w-3xl">
        <select value={form.supplierId} onChange={(e) => onSupplier(e.target.value)} className={field}>
          <option value="">— Proveedor —</option>
          {suppliers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={field} />
        <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))} className={field}>
          <option value="goods">Mercancía (inventario)</option>
          <option value="asset">Activo fijo</option>
          <option value="service">Servicio</option>
        </select>
        <input value={form.ncf} onChange={(e) => setForm((f) => ({ ...f, ncf: e.target.value }))} placeholder="NCF" className={field} />
        {!goods && (
          <select value={form.accountCode} onChange={(e) => setForm((f) => ({ ...f, accountCode: e.target.value }))} className={`${field} sm:col-span-2`}>
            <option value="">— Cuenta de destino —</option>
            {(form.kind === 'asset' ? assetAccounts : serviceAccounts).map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        )}
        {expedienteOpts.length > 0 && (
          <label className="text-xs text-ink-500 sm:col-span-2 inline-flex flex-col">
            <span className="inline-flex items-center gap-1"><FileText size={12} /> Expediente de importación (opcional)</span>
            <select value={form.expedienteId} onChange={(e) => setForm((f) => ({ ...f, expedienteId: e.target.value }))} className={`${field} mt-0.5`}>
              <option value="">— Sin enlazar —</option>
              {expedienteOpts.map((e) => (
                <option key={e.id} value={e.id}>
                  {expLabel(e) || e.id}{e.liquidatedAt ? ` · ${formatDate(e.liquidatedAt)}` : ''}{e.status === 'draft' ? ' · borrador' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* Goods: article líneas → inventory (one kardex IN each) */}
      {goods && (
        <div className="mt-4">
          <h4 className="font-display text-sm font-medium text-ink-700 mb-1.5">Líneas de la factura</h4>
          {/* Mobile: stacked cards */}
          <div className="md:hidden space-y-2">
            {lines.map((l) => (
              <div key={l.id} className="rounded-lg border border-ink-100 bg-ink-50/40 p-2 space-y-2">
                <SearchPicker
                  options={itemOptions} value={l.itemId} text={l.name}
                  placeholder="— Artículo a inventariar —" freeTextLabel="Crear artículo" allowFreeText
                  onPick={(o) => patchLine(l.id, { itemId: o.id, name: o.label, reference: o.sublabel || '' })}
                  onFreeText={(txt) => patchLine(l.id, { itemId: '', name: txt })}
                />
                {(l.name || '').trim() !== '' && (!l.itemId || l.reference) && (
                  <div className="inline-flex items-center gap-1.5 text-[11px] text-amber-700">
                    {!l.itemId && <span className="inline-flex items-center gap-1"><Plus size={11} /> Nuevo en inventario</span>}
                    {l.reference && <span className="font-mono text-amber-600">{l.reference}</span>}
                  </div>
                )}
                <div className="grid grid-cols-3 gap-2 items-end">
                  <label className="text-[11px] text-ink-400">Cant.
                    <input type="number" min="0" step="1" inputMode="numeric" value={l.qty} onChange={(e) => patchLine(l.id, { qty: e.target.value })} className="input w-full text-right tabular-nums mt-0.5" /></label>
                  <label className="text-[11px] text-ink-400">Costo RD$
                    <input type="number" min="0" step="0.01" inputMode="decimal" value={l.cost} onChange={(e) => patchLine(l.id, { cost: e.target.value })} className="input w-full text-right tabular-nums mt-0.5" /></label>
                  <button type="button" onClick={() => delLine(l.id)} className="btn-icon-danger justify-self-end" title="Eliminar línea" aria-label="Eliminar línea"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
          {/* Desktop: dense table */}
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
                        <SearchPicker
                          options={itemOptions} value={l.itemId} text={l.name}
                          placeholder="— Artículo a inventariar —" freeTextLabel="Crear artículo" allowFreeText
                          onPick={(o) => patchLine(l.id, { itemId: o.id, name: o.label, reference: o.sublabel || '' })}
                          onFreeText={(txt) => patchLine(l.id, { itemId: '', name: txt })}
                        />
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

      {/* Base (goods: derived from líneas, read-only) + taxes + payment */}
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
            <option value="credit">Crédito</option><option value="bank">Banco</option><option value="cash">Efectivo</option><option value="card">Tarjeta</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mt-3 pt-3 border-t border-ink-100">
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-sm text-ink-600">Neto a pagar <b className="tabular-nums">{formatDop(net)}</b></div>
          {newItemCount > 0 && (
            <span className="text-xs text-amber-700 inline-flex items-center gap-1"><Plus size={12} /> {newItemCount} artículo{newItemCount > 1 ? 's' : ''} nuevo{newItemCount > 1 ? 's' : ''} en inventario</span>
          )}
        </div>
        <button type="button" onClick={save} disabled={saving} className="btn-primary">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar compra
        </button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}
