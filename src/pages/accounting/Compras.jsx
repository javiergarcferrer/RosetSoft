import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Shield, ShoppingCart, Plus, Loader2, Check, X } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import {
  buildPurchaseEntry, computeExpenseTaxes, resolveAccountingConfig,
  classOf, postableAccounts, weightedAverageIn,
} from '../../core/accounting/index.js';

const KIND_LABEL = { goods: 'Mercancía', asset: 'Activo fijo', service: 'Servicio' };
const PAY_LABEL = { cash: 'Efectivo', bank: 'Banco', card: 'Tarjeta', credit: 'Crédito' };

/**
 * Compras — purchase capture. Goods capitalize into inventory (and create a
 * kardex IN); asset/service hit a chart account. Each posts a balanced asiento
 * and feeds the 606. Self-gates on accounting/admin.
 */
export default function Compras() {
  const { profileId, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
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

  if (!allowed) {
    return (
      <>
        <PageHeader title="Compras" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  const rows = purchasesQ.data.slice().sort((a, b) => (b.purchaseAt || 0) - (a.purchaseAt || 0));

  return (
    <>
      <PageHeader title="Compras" subtitle="Compra de mercancía (a inventario), activos y servicios — se asienta sola"
        actions={<button type="button" onClick={() => setShowForm((v) => !v)} className="btn-primary text-sm inline-flex items-center gap-1.5 min-h-[44px]"><Plus size={15} /> Nueva compra</button>} />

      {showForm && loaded && (
        <NewPurchaseForm scope={scope} config={config} suppliers={suppliersQ.data} suppliersById={suppliersById}
          accounts={accountsQ.data} items={itemsQ.data} onClose={() => setShowForm(false)} />
      )}

      {!loaded ? <ListLoading /> : rows.length === 0 ? (
        <EmptyState icon={ShoppingCart} title="Sin compras" description="Registra una compra con “Nueva compra”." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left py-2 px-3 whitespace-nowrap">Fecha</th>
                  <th className="text-left py-2 px-3">Proveedor</th>
                  <th className="text-left py-2 px-3 whitespace-nowrap">Tipo</th>
                  <th className="text-left py-2 px-3">NCF</th>
                  <th className="text-right py-2 px-3 whitespace-nowrap">Base</th>
                  <th className="text-right py-2 px-3 whitespace-nowrap">ITBIS</th>
                  <th className="text-right py-2 px-3 whitespace-nowrap">Total</th>
                  <th className="text-left py-2 px-3 whitespace-nowrap">Pago</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-t border-ink-50">
                    <td className="py-1.5 px-3 text-ink-500 whitespace-nowrap">{formatDate(p.purchaseAt)}</td>
                    <td className="py-1.5 px-3">{suppliersById.get(p.supplierId)?.name || '—'}</td>
                    <td className="py-1.5 px-3 text-ink-600 whitespace-nowrap">{KIND_LABEL[p.kind] || p.kind}</td>
                    <td className="py-1.5 px-3 tabular-nums text-ink-500">{p.ncf || '—'}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(p.base)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{formatDop(p.itbis)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-medium whitespace-nowrap">{formatDop((p.base || 0) + (p.itbis || 0))}</td>
                    <td className="py-1.5 px-3 text-ink-600 whitespace-nowrap">{PAY_LABEL[p.paymentMethod] || p.paymentMethod}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
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
      setErr(e?.message || String(e));
      setSaving(false);
    }
  }

  const field = 'rounded-lg border border-ink-200 px-3 py-2 text-sm w-full min-h-[44px]';
  const numField = 'w-28 rounded-lg border border-ink-200 px-2 py-2 text-sm text-right tabular-nums min-h-[44px]';
  const net = (Number(form.base) || 0) + (Number(form.itbis) || 0) - (Number(form.retIsr) || 0) - (Number(form.retItbis) || 0);

  return (
    <div className="card p-4 mb-4 border-ink-300 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Nueva compra</h3>
        <button type="button" onClick={onClose} className="text-ink-400 hover:text-ink-700 min-h-[44px] min-w-[44px] flex items-center justify-center"><X size={18} /></button>
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
        <button type="button" onClick={save} disabled={saving} className="btn-primary text-sm inline-flex items-center gap-1.5 min-h-[44px] disabled:opacity-40">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar compra
        </button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}
