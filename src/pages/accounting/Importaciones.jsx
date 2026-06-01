import { useMemo, useState } from 'react';
import { Shield, Ship, Plus, Loader2, Check, X } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import {
  resolveImportsList, buildImportEntry, computeImportTaxes, landedCost, landedUnitCost,
  weightedAverageIn, resolveAccountingConfig,
} from '../../core/accounting/index.js';

/**
 * Importaciones — customs liquidation (DGA). Capitalizes CIF + duty (20%) +
 * clearance into landed cost, credits the import ITBIS, posts the asiento and
 * lands the goods into inventory at the landed unit cost. Self-gates on
 * accounting/admin.
 */
export default function Importaciones() {
  const { profileId, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const importsQ = useLiveQueryStatus(() => db.importLiquidations.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const ordersQ = useLiveQueryStatus(() => db.orders.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = importsQ.loaded && suppliersQ.loaded && itemsQ.loaded;

  const list = useMemo(() => resolveImportsList({ imports: importsQ.data, suppliers: suppliersQ.data, items: itemsQ.data }),
    [importsQ.data, suppliersQ.data, itemsQ.data]);
  const [showForm, setShowForm] = useState(false);

  if (!allowed) {
    return (
      <>
        <PageHeader title="Importaciones" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Importaciones" subtitle="Liquidación aduanal (DGA) → costo en destino al inventario"
        actions={<button type="button" onClick={() => setShowForm((v) => !v)} className="btn-primary text-sm inline-flex items-center gap-1.5"><Plus size={15} /> Nueva liquidación</button>} />

      {showForm && loaded && (
        <NewImportForm scope={scope} config={config} suppliers={suppliersQ.data} items={itemsQ.data} orders={ordersQ.data || []} onClose={() => setShowForm(false)} />
      )}

      {!loaded ? <ListLoading /> : list.count === 0 ? (
        <EmptyState icon={Ship} title="Sin importaciones" description="Registra una liquidación aduanal con “Nueva liquidación”." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left py-2 px-3">Fecha</th>
                <th className="text-left py-2 px-3">Proveedor</th>
                <th className="text-left py-2 px-3">Artículo</th>
                <th className="text-right py-2 px-3">CIF</th>
                <th className="text-right py-2 px-3">Gravamen</th>
                <th className="text-right py-2 px-3">ITBIS imp.</th>
                <th className="text-right py-2 px-3">Costo destino</th>
                <th className="text-right py-2 px-3">C. unit.</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map(({ liq: l, supplier, item, landed, unitCost }) => (
                <tr key={l.id} className="border-t border-ink-50">
                  <td className="py-1.5 px-3 text-ink-500">{formatDate(l.liquidatedAt)}</td>
                  <td className="py-1.5 px-3">{supplier?.name || '—'}</td>
                  <td className="py-1.5 px-3">{item?.name || '—'}{l.qty ? <span className="text-ink-400"> ×{l.qty}</span> : null}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(l.cif)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(l.duty)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(l.importItbis)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-medium">{formatDop(landed)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(unitCost)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-ink-200 font-semibold">
                <td className="py-2 px-3" colSpan={3}>{list.count} liquidaciones</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatDop(list.totals.cif)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatDop(list.totals.duty)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatDop(list.totals.importItbis)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatDop(list.totals.landed)}</td>
                <td className="py-2 px-3"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}

function NewImportForm({ scope, config, suppliers, items, orders, onClose }) {
  const [form, setForm] = useState({
    orderId: '', supplierId: '', itemId: '', qty: '', customsRef: '',
    date: new Date().toISOString().slice(0, 10),
    cif: '', duty: '', importItbis: '', clearanceFees: '', otherCosts: '', paymentMethod: 'bank',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  function onCif(v) {
    const t = computeImportTaxes({ cif: Number(v) || 0, config });
    setForm((f) => ({ ...f, cif: v, duty: String(t.duty), importItbis: String(t.importItbis) }));
  }

  const parts = {
    cif: Number(form.cif) || 0, duty: Number(form.duty) || 0,
    clearanceFees: Number(form.clearanceFees) || 0, otherCosts: Number(form.otherCosts) || 0,
  };
  const landed = landedCost(parts);
  const unit = landedUnitCost(parts, Number(form.qty) || 0);

  async function save() {
    setErr('');
    if (landed <= 0) { setErr('Indica al menos el CIF.'); return; }
    setSaving(true);
    try {
      const id = newId();
      const postedAt = new Date(form.date).getTime();
      const importItbis = Number(form.importItbis) || 0;
      const built = buildImportEntry({
        newId, config, postedAt,
        liq: {
          id, supplierId: form.supplierId || null, cif: parts.cif, duty: parts.duty,
          importItbis, clearanceFees: parts.clearanceFees, otherCosts: parts.otherCosts,
          paymentMethod: form.paymentMethod, memo: 'Liquidación de importación',
        },
      });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'importLiquidations', profileId: scope, start: 1,
        build: (n) => ({
          id, profileId: scope, number: n, orderId: form.orderId || null, supplierId: form.supplierId || null,
          itemId: form.itemId || null, liquidatedAt: postedAt, customsRef: form.customsRef,
          qty: Number(form.qty) || 0, cif: parts.cif, duty: parts.duty, importItbis,
          clearanceFees: parts.clearanceFees, otherCosts: parts.otherCosts,
          paymentMethod: form.paymentMethod, journalEntryId: built.entry.id,
        }),
      });
      // Land the goods into inventory at the landed unit cost.
      const qty = Number(form.qty) || 0;
      if (form.itemId && qty > 0 && unit > 0) {
        await db.inventoryMovements.put({
          id: newId(), profileId: scope, itemId: form.itemId, type: 'in', qty, unitCost: unit,
          movedAt: postedAt, refTable: 'import_liquidations', refId: id, journalEntryId: built.entry.id,
        });
        const item = items.find((i) => i.id === form.itemId);
        if (item) {
          const newAvg = weightedAverageIn(item.qtyOnHand || 0, item.avgCost || 0, qty, unit);
          await db.inventoryItems.update(form.itemId, { qtyOnHand: (item.qtyOnHand || 0) + qty, avgCost: newAvg });
        }
      }
      onClose();
    } catch (e) {
      setErr(e?.message || String(e));
      setSaving(false);
    }
  }

  const field = 'rounded-lg border border-ink-200 px-3 py-1.5 text-sm';
  const numField = 'w-32 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right tabular-nums';

  return (
    <div className="card p-4 mb-4 border-ink-300">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Nueva liquidación de importación</h3>
        <button type="button" onClick={onClose} className="text-ink-400 hover:text-ink-700"><X size={18} /></button>
      </div>
      <div className="grid sm:grid-cols-2 gap-3 max-w-3xl">
        <select value={form.supplierId} onChange={(e) => setForm((f) => ({ ...f, supplierId: e.target.value }))} className={field}>
          <option value="">— Proveedor (exterior) —</option>
          {suppliers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={field} />
        <select value={form.itemId} onChange={(e) => setForm((f) => ({ ...f, itemId: e.target.value }))} className={field}>
          <option value="">— Artículo a inventariar —</option>
          {items.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((i) => <option key={i.id} value={i.id}>{i.name}{i.sku ? ` (${i.sku})` : ''}</option>)}
        </select>
        <input type="number" min="0" step="1" value={form.qty} onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))} placeholder="Cantidad" className={field} />
        {orders.length > 0 && (
          <select value={form.orderId} onChange={(e) => setForm((f) => ({ ...f, orderId: e.target.value }))} className={field}>
            <option value="">— Pedido (opcional) —</option>
            {orders.map((o) => <option key={o.id} value={o.id}>#{o.number} {o.name || ''}</option>)}
          </select>
        )}
        <input value={form.customsRef} onChange={(e) => setForm((f) => ({ ...f, customsRef: e.target.value }))} placeholder="DUA / declaración (opcional)" className={field} />
      </div>

      <div className="flex flex-wrap items-end gap-3 mt-3">
        <label className="text-sm">CIF (RD$)<br /><input type="number" step="0.01" min="0" value={form.cif} onChange={(e) => onCif(e.target.value)} className={numField} /></label>
        <label className="text-sm">Gravamen 20%<br /><input type="number" step="0.01" min="0" value={form.duty} onChange={(e) => setForm((f) => ({ ...f, duty: e.target.value }))} className={numField} /></label>
        <label className="text-sm">ITBIS imp.<br /><input type="number" step="0.01" min="0" value={form.importItbis} onChange={(e) => setForm((f) => ({ ...f, importItbis: e.target.value }))} className={numField} /></label>
        <label className="text-sm">Despacho/agente<br /><input type="number" step="0.01" min="0" value={form.clearanceFees} onChange={(e) => setForm((f) => ({ ...f, clearanceFees: e.target.value }))} className={numField} /></label>
        <label className="text-sm">Otros<br /><input type="number" step="0.01" min="0" value={form.otherCosts} onChange={(e) => setForm((f) => ({ ...f, otherCosts: e.target.value }))} className={numField} /></label>
        <label className="text-sm">Pago<br />
          <select value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))} className={field}>
            <option value="bank">Banco</option><option value="credit">Crédito</option><option value="cash">Efectivo</option><option value="card">Tarjeta</option>
          </select>
        </label>
      </div>

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-ink-100">
        <div className="text-sm text-ink-600">
          Costo en destino <b className="tabular-nums">{formatDop(landed)}</b>
          {unit > 0 && <> · unitario <b className="tabular-nums">{formatDop(unit)}</b></>}
        </div>
        <button type="button" onClick={save} disabled={saving} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar liquidación
        </button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}
