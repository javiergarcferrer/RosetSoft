import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ClipboardList, Plus, X, Loader2, Trash2 } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import TabPills from '../../components/accounting/TabPills.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { userMessageFor } from '../../lib/errorMessages.js';
import { resolvePurchaseOrders, poTotals, PO_STATUS_LABEL } from '../../core/accounting/index.js';

const today = () => new Date().toISOString().slice(0, 10);
const STATUS_CLS = { open: 'bg-sky-100 text-sky-700', received: 'bg-amber-100 text-amber-700', billed: 'bg-emerald-100 text-emerald-700', cancelled: 'bg-ink-100 text-ink-500' };
const NEXT = { open: [['received', 'Marcar recibida'], ['cancelled', 'Cancelar']], received: [['billed', 'Marcar facturada'], ['cancelled', 'Cancelar']], billed: [], cancelled: [['open', 'Reabrir']] };

/**
 * Órdenes de compra — track POs through open → recibida → facturada. A PO is not
 * fiscal; the bill it becomes (with its NCF) is what posts to the 606. Self-gates.
 */
export default function OrdenesCompra() {
  const { profileId } = useApp();
  const scope = profileId || 'team';

  const ordersQ = useLiveQueryStatus(() => db.purchaseOrders.where('profileId').equals(scope).toArray(), [scope], []);
  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = ordersQ.loaded && suppliersQ.loaded;
  const suppliersById = useMemo(() => new Map(suppliersQ.data.map((s) => [s.id, s])), [suppliersQ.data]);

  const [statusFilter, setStatusFilter] = useState('');
  const [params] = useSearchParams();
  const [showForm, setShowForm] = useState(params.get('new') === '1');
  const list = useMemo(() => resolvePurchaseOrders({ orders: ordersQ.data, suppliersById, statusFilter }), [ordersQ.data, suppliersById, statusFilter]);

  async function setStatus(po, status) { await db.purchaseOrders.update(po.id, { status, updatedAt: Date.now() }); }
  async function remove(po) { if (window.confirm(`¿Eliminar la orden #${po.number ?? ''}?`)) await db.purchaseOrders.delete(po.id); }

  return (
    <AccountingGate title="Órdenes de compra">
      <PageHeader title="Órdenes de compra" subtitle="Seguimiento de pedidos a proveedores — valores en RD$"
        actions={<button type="button" onClick={() => setShowForm((v) => !v)} className="btn-primary"><Plus size={15} /> Nueva orden</button>} />

      {!loaded ? <ListLoading /> : (
        <>
          {showForm && <OrderForm scope={scope} suppliers={suppliersQ.data} onClose={() => setShowForm(false)} />}

          <TabPills
            tabs={[{ key: '', label: 'Todas' }, { key: 'open', label: 'Abiertas' }, { key: 'received', label: 'Recibidas' }, { key: 'billed', label: 'Facturadas' }]}
            active={statusFilter} onChange={setStatusFilter} />

          {list.count === 0 ? (
            <EmptyState icon={ClipboardList} title="Sin órdenes" description="Crea una orden de compra para seguir un pedido a un proveedor." />
          ) : (
            <div className="space-y-2">
              {list.rows.map((r) => (
                <div key={r.po.id} className="card p-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">#{r.po.number ?? '—'} · {r.supplier?.name || 'Proveedor'}</div>
                    <div className="text-xs text-ink-500">{formatDate(r.po.orderedAt)} · {r.lineCount} línea(s){r.po.notes ? ` · ${r.po.notes}` : ''}</div>
                  </div>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded whitespace-nowrap ${STATUS_CLS[r.status] || ''}`}>{r.statusLabel}</span>
                  <div className="text-right tabular-nums font-semibold whitespace-nowrap">{formatDop(r.total)}</div>
                  <div className="flex items-center gap-1.5">
                    {(NEXT[r.status] || []).map(([s, label]) => (
                      <button key={s} type="button" onClick={() => setStatus(r.po, s)} className="btn-ghost text-xs whitespace-nowrap">{label}</button>
                    ))}
                    <button type="button" onClick={() => remove(r.po)} className="btn-icon text-ink-400" aria-label="Eliminar"><Trash2 size={15} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </AccountingGate>
  );
}

function OrderForm({ scope, suppliers, onClose }) {
  const [f, setF] = useState({ supplierId: '', orderedAt: today(), notes: '' });
  const [lines, setLines] = useState([{ name: '', qty: '1', unitCost: '' }]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const total = poTotals({ lines: lines.map((l) => ({ qty: Number(l.qty) || 0, unitCost: Number(l.unitCost) || 0 })) }).total;

  function setLine(i, k, v) { setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l))); }
  function addLine() { setLines((ls) => [...ls, { name: '', qty: '1', unitCost: '' }]); }
  function delLine(i) { setLines((ls) => ls.filter((_, j) => j !== i)); }

  async function save() {
    setErr('');
    const clean = lines.map((l) => ({ name: l.name.trim(), qty: Number(l.qty) || 0, unitCost: Number(l.unitCost) || 0 })).filter((l) => l.name && l.qty > 0);
    if (!clean.length) { setErr('Agrega al menos una línea con descripción y cantidad.'); return; }
    setSaving(true);
    try {
      const id = newId();
      await assignSequenceNumber({
        table: 'purchaseOrders', profileId: scope, start: 1,
        build: (n) => ({ id, profileId: scope, number: n, supplierId: f.supplierId || null, orderedAt: new Date(f.orderedAt).getTime(), status: 'open', lines: clean, notes: f.notes.trim(), createdAt: Date.now() }),
      });
      onClose();
    } catch (e) { setErr(userMessageFor(e)); setSaving(false); }
  }

  return (
    <div className="card p-4 mb-4 border-ink-300 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display font-semibold">Nueva orden de compra</h3>
        <button type="button" onClick={onClose} className="btn-icon text-ink-400 shrink-0" aria-label="Cerrar"><X size={18} /></button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        <label className="text-sm">Proveedor<br />
          <select value={f.supplierId} onChange={(e) => setF((s) => ({ ...s, supplierId: e.target.value }))} className="input w-full">
            <option value="">—</option>
            {(suppliers || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="text-sm">Fecha<br /><input type="date" value={f.orderedAt} onChange={(e) => setF((s) => ({ ...s, orderedAt: e.target.value }))} className="input w-full" /></label>
        <label className="text-sm">Nota<br /><input value={f.notes} onChange={(e) => setF((s) => ({ ...s, notes: e.target.value }))} className="input w-full" /></label>
      </div>
      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input value={l.name} onChange={(e) => setLine(i, 'name', e.target.value)} placeholder="Descripción" className="input flex-1 min-w-[140px]" />
            <input type="number" min="0" step="1" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} placeholder="Cant." className="input w-20 text-right tabular-nums" />
            <input type="number" min="0" step="0.01" value={l.unitCost} onChange={(e) => setLine(i, 'unitCost', e.target.value)} placeholder="Costo" className="input w-28 text-right tabular-nums" />
            <button type="button" onClick={() => delLine(i)} className="btn-icon text-ink-400" aria-label="Quitar"><Trash2 size={14} /></button>
          </div>
        ))}
        <button type="button" onClick={addLine} className="text-xs text-ink-600 hover:text-ink-900 inline-flex items-center gap-1"><Plus size={13} /> Agregar línea</button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-3">{err}</p>}
      <div className="flex items-center justify-between mt-4">
        <span className="text-sm text-ink-600">Total <b className="tabular-nums">{formatDop(total)}</b></span>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">Cancelar</button>
          <button type="button" onClick={save} disabled={saving} className="btn-primary">{saving ? <Loader2 size={14} className="animate-spin" /> : null} Guardar</button>
        </div>
      </div>
    </div>
  );
}
