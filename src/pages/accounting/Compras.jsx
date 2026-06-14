import { userMessageFor } from '../../lib/errorMessages.js';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShoppingCart, Plus, Loader2, Check, X } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import RowCards from '../../components/RowCards.jsx';
import ColumnsMenu from '../../components/search/ColumnsMenu.jsx';
import useColumns from '../../components/search/useColumns.js';
import { formatDop, formatDate } from '../../lib/format.js';
import {
  buildPurchaseEntry, computeExpenseTaxes, resolveAccountingConfig,
  classOf, postableAccounts, weightedAverageIn,
} from '../../core/accounting/index.js';

const KIND_LABEL = { goods: 'Mercancía', asset: 'Activo fijo', service: 'Servicio' };
const PAY_LABEL = { cash: 'Efectivo', bank: 'Banco', card: 'Tarjeta', credit: 'Crédito' };

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
  supplier: true, kind: true, ncf: true, base: true, itbis: true, total: true, payment: true,
};
const COMPRAS_COLS_KEY = 'rs.compras.cols.v1';

/**
 * Compras — purchase capture. Goods capitalize into inventory (and create a
 * kardex IN); asset/service hit a chart account. Each posts a balanced asiento
 * and feeds the 606. Self-gates on accounting/admin.
 */
export default function Compras() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const purchasesQ = useLiveQueryStatus(() => db.purchases.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = purchasesQ.loaded && suppliersQ.loaded && accountsQ.loaded && itemsQ.loaded;

  const suppliersById = useMemo(() => new Map(suppliersQ.data.map((s) => [s.id, s])), [suppliersQ.data]);
  const [params] = useSearchParams();
  const [showForm, setShowForm] = useState(!!params.get('new'));

  // Column visibility (Shopify "edit columns") — persisted per browser.
  const { visible, setVisible, reset, cols } = useColumns(COMPRAS_COLUMNS, COMPRAS_DEFAULT, COMPRAS_COLS_KEY);

  const rows = purchasesQ.data.slice().sort((a, b) => (b.purchaseAt || 0) - (a.purchaseAt || 0));

  return (
    <AccountingGate title="Compras">
      <PageHeader title="Compras" subtitle="Compra de mercancía (a inventario), activos y servicios — se asienta sola"
        actions={<button type="button" onClick={() => setShowForm((v) => !v)} className="btn-primary"><Plus size={15} /> Nueva compra</button>} />

      {showForm && loaded && (
        <NewPurchaseForm scope={scope} config={config} suppliers={suppliersQ.data} suppliersById={suppliersById}
          accounts={accountsQ.data} items={itemsQ.data} onClose={() => setShowForm(false)} />
      )}

      {!loaded ? <ListLoading /> : rows.length === 0 ? (
        <EmptyState icon={ShoppingCart} title="Sin compras" description="Registra una compra con “Nueva compra”." />
      ) : (
        <>
        <RowCards
          rows={rows.map((p) => ({
            key: p.id,
            title: suppliersById.get(p.supplierId)?.name || '—',
            right: formatDop((p.base || 0) + (p.itbis || 0)),
            sub: KIND_LABEL[p.kind] || p.kind,
            kv: [
              ['Fecha', formatDate(p.purchaseAt)],
              ['NCF', p.ncf || '—'],
              ['Base', formatDop(p.base)],
              ['ITBIS', formatDop(p.itbis)],
              ['Pago', PAY_LABEL[p.paymentMethod] || p.paymentMethod],
            ],
          }))}
        />
        <div className="hidden md:block">
          <div className="flex justify-end mb-2">
            <ColumnsMenu columns={COMPRAS_COLUMNS} visible={visible} onChange={setVisible} onReset={reset} />
          </div>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="table min-w-[640px]">
                <thead>
                  <tr>
                    {cols.map((col) => (
                      <th key={col.key} className={col.thClass || ''}>{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const ctx = { p, supplierName: suppliersById.get(p.supplierId)?.name };
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

function NewPurchaseForm({ scope, config, suppliers, suppliersById, accounts, items, onClose }) {
  const [form, setForm] = useState({
    supplierId: '', date: new Date().toISOString().slice(0, 10), ncf: '', kind: 'goods',
    accountCode: '', itemId: '', qty: '', base: '', itbis: '', retIsr: '', retItbis: '', paymentMethod: 'credit',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const assetAccounts = useMemo(() => postableAccounts(accounts).filter((a) => classOf(a.code) === 1).sort((a, b) => a.code.localeCompare(b.code)), [accounts]);
  const serviceAccounts = useMemo(() => postableAccounts(accounts).filter((a) => classOf(a.code) === 6).sort((a, b) => a.code.localeCompare(b.code)), [accounts]);

  function recompute(base, supplier) {
    const t = computeExpenseTaxes({ base: Number(base) || 0, retainIsr: !!supplier?.retainIsr, retainItbis: !!supplier?.retainItbis, config });
    return { itbis: String(t.itbis), retIsr: String(t.retIsr), retItbis: String(t.retItbis) };
  }
  function onSupplier(id) { const s = suppliersById.get(id); setForm((f) => ({ ...f, supplierId: id, ...recompute(f.base, s) })); }
  function onBase(v) { const s = suppliersById.get(form.supplierId); setForm((f) => ({ ...f, base: v, ...recompute(v, s) })); }

  async function save() {
    setErr('');
    const base = Number(form.base) || 0;
    const itbis = Number(form.itbis) || 0;
    const retIsr = Number(form.retIsr) || 0;
    const retItbis = Number(form.retItbis) || 0;
    const qty = Number(form.qty) || 0;
    if (base <= 0) { setErr('El monto base debe ser mayor que cero.'); return; }
    if (form.kind === 'goods' && (!form.itemId || qty <= 0)) { setErr('Para mercancía, elige el artículo y la cantidad.'); return; }
    if (form.kind !== 'goods' && !form.accountCode) { setErr('Elige la cuenta de destino.'); return; }
    setSaving(true);
    try {
      const id = newId();
      const postedAt = new Date(form.date).getTime();
      const built = buildPurchaseEntry({
        newId, config, postedAt,
        purchase: {
          id, supplierId: form.supplierId || null, kind: form.kind,
          accountCode: form.kind === 'goods' ? null : form.accountCode,
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
          ncf: form.ncf, ncfType: '', kind: form.kind, accountCode: form.kind === 'goods' ? null : form.accountCode,
          itemId: form.kind === 'goods' ? form.itemId : null, qty: form.kind === 'goods' ? qty : 0,
          base, itbis, itbisCreditable: true, retentionIsr: retIsr, retentionItbis: retItbis,
          paymentMethod: form.paymentMethod, paidAt: form.paymentMethod === 'credit' ? null : postedAt,
          journalEntryId: built.entry.id,
        }),
      });
      // Goods → kardex IN at unit cost = base / qty, and refresh the item cache.
      if (form.kind === 'goods' && form.itemId && qty > 0) {
        const unitCost = Math.round((base / qty) * 10000) / 10000;
        await db.inventoryMovements.put({
          id: newId(), profileId: scope, itemId: form.itemId, type: 'in', qty, unitCost,
          movedAt: postedAt, refTable: 'purchases', refId: id, journalEntryId: built.entry.id,
        });
        const item = items.find((i) => i.id === form.itemId);
        if (item) {
          const newAvg = weightedAverageIn(item.qtyOnHand || 0, item.avgCost || 0, qty, unitCost);
          await db.inventoryItems.update(form.itemId, { qtyOnHand: (item.qtyOnHand || 0) + qty, avgCost: newAvg });
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
  const net = (Number(form.base) || 0) + (Number(form.itbis) || 0) - (Number(form.retIsr) || 0) - (Number(form.retItbis) || 0);

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
        {form.kind === 'goods' ? (
          <>
            <select value={form.itemId} onChange={(e) => setForm((f) => ({ ...f, itemId: e.target.value }))} className={field}>
              <option value="">— Artículo —</option>
              {items.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((i) => <option key={i.id} value={i.id}>{i.name}{i.sku ? ` (${i.sku})` : ''}</option>)}
            </select>
            <input type="number" min="0" step="1" inputMode="numeric" value={form.qty} onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))} placeholder="Cantidad" className={field} />
          </>
        ) : (
          <select value={form.accountCode} onChange={(e) => setForm((f) => ({ ...f, accountCode: e.target.value }))} className={`${field} sm:col-span-2`}>
            <option value="">— Cuenta de destino —</option>
            {(form.kind === 'asset' ? assetAccounts : serviceAccounts).map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        )}
      </div>

      <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-end gap-3 mt-3">
        <label className="text-sm">Base<br /><input type="number" step="0.01" min="0" inputMode="decimal" value={form.base} onChange={(e) => onBase(e.target.value)} className={`${numField} w-full sm:w-28`} /></label>
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
        <div className="text-sm text-ink-600">Neto a pagar <b className="tabular-nums">{formatDop(net)}</b></div>
        <button type="button" onClick={save} disabled={saving} className="btn-primary">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar compra
        </button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}
