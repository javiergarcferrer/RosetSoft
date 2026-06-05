import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Shield, Ship, Plus, Loader2, Check, X, Upload, FileText } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { syncShopify } from '../../lib/shopifySync.js';
import { effectiveDopRate } from '../../lib/exchangeRate.js';
import { parseInvoicePdf } from '../../lib/loadRosetInvoice.js';
import {
  resolveImportsList, buildImportEntry, computeImportTaxes, landedCost, landedUnitCost,
  weightedAverageIn, resolveAccountingConfig, allocateShipment,
  expedienteLanded, expedienteCreditableItbis,
} from '../../core/accounting/index.js';
import ExpedienteForm from './ExpedienteForm.jsx';

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
  const containersQ = useLiveQueryStatus(() => db.containers.where('profileId').equals(scope).toArray(), [scope], []);
  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = importsQ.loaded && suppliersQ.loaded && itemsQ.loaded;

  const list = useMemo(() => resolveImportsList({ imports: importsQ.data, suppliers: suppliersQ.data, items: itemsQ.data }),
    [importsQ.data, suppliersQ.data, itemsQ.data]);
  const [params] = useSearchParams();
  const [showForm, setShowForm] = useState(!!params.get('new'));
  const [showImport, setShowImport] = useState(false);
  const [showExpediente, setShowExpediente] = useState(false);

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
        actions={(
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { setShowImport((v) => !v); setShowForm(false); setShowExpediente(false); }} className="btn-ghost text-sm inline-flex items-center gap-1.5"><Upload size={15} /> Importar factura</button>
            <button type="button" onClick={() => { setShowForm((v) => !v); setShowImport(false); setShowExpediente(false); }} className="btn-ghost text-sm inline-flex items-center gap-1.5"><Plus size={15} /> Liquidación simple</button>
            <button type="button" onClick={() => { setShowExpediente((v) => !v); setShowForm(false); setShowImport(false); }} className="btn-primary text-sm inline-flex items-center gap-1.5"><FileText size={15} /> Nuevo expediente</button>
          </div>
        )} />

      {showForm && loaded && (
        <NewImportForm scope={scope} config={config} suppliers={suppliersQ.data} items={itemsQ.data} orders={ordersQ.data || []} onClose={() => setShowForm(false)} />
      )}

      {showImport && loaded && (
        <ImportInvoiceForm scope={scope} config={config} settings={settings} suppliers={suppliersQ.data} items={itemsQ.data} orders={ordersQ.data || []} onClose={() => setShowImport(false)} />
      )}

      {showExpediente && loaded && (
        <ExpedienteForm scope={scope} config={config} suppliers={suppliersQ.data} items={itemsQ.data} orders={ordersQ.data || []} containers={containersQ.data || []} onClose={() => setShowExpediente(false)} />
      )}

      {!loaded ? <ListLoading /> : (list.count === 0 && !(expedientesQ.data?.length)) ? (
        <EmptyState icon={Ship} title="Sin importaciones" description="Registra un expediente con “Nuevo expediente”." />
      ) : (
        <>
          {expedientesQ.data?.length > 0 && (
            <ExpedientesList expedientes={expedientesQ.data} suppliers={suppliersQ.data} />
          )}
          {list.count > 0 && (
          <div className="card overflow-hidden mt-4">
          <div className="px-3 py-2 text-xs uppercase tracking-wide text-ink-500 bg-ink-50 font-medium">Liquidaciones simples</div>
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
      )}
    </>
  );
}

/** The expedientes list — one row per import file (BL), with its derived landed
 *  cost and recoverable ITBIS. */
function ExpedientesList({ expedientes, suppliers }) {
  const rows = expedientes.slice().sort((a, b) => (b.liquidatedAt || 0) - (a.liquidatedAt || 0));
  return (
    <div className="card overflow-hidden">
      <div className="px-3 py-2 text-xs uppercase tracking-wide text-ink-500 bg-ink-50 font-medium">Expedientes</div>
      <table className="w-full text-sm">
        <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
          <tr>
            <th className="text-left py-2 px-3">Fecha</th>
            <th className="text-left py-2 px-3">BL</th>
            <th className="text-left py-2 px-3">Proveedor</th>
            <th className="text-right py-2 px-3">Líneas</th>
            <th className="text-right py-2 px-3">CIF</th>
            <th className="text-right py-2 px-3">Costo destino</th>
            <th className="text-right py-2 px-3">ITBIS créd.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const supplier = suppliers.find((s) => s.id === e.supplierId);
            return (
              <tr key={e.id} className="border-t border-ink-50">
                <td className="py-1.5 px-3 text-ink-500">{formatDate(e.liquidatedAt)}</td>
                <td className="py-1.5 px-3 font-mono text-xs">{e.bl || '—'}</td>
                <td className="py-1.5 px-3">{supplier?.name || '—'}</td>
                <td className="py-1.5 px-3 text-right tabular-nums">{(e.lines || []).length}</td>
                <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(e.cif)}</td>
                <td className="py-1.5 px-3 text-right tabular-nums font-medium">{formatDop(expedienteLanded(e))}</td>
                <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(expedienteCreditableItbis(e))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
      // Goods just landed in inventory → publish/refresh the item in Shopify.
      if (form.itemId) syncShopify([form.itemId]).catch(() => {});
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

/**
 * Batch import from a Ligne Roset invoice PDF. Reads the furniture lines (REF +
 * fabric, USD CIP unit cost), converts to DOP at a rate, lets the user pick
 * pieces + set selling prices, then runs ONE liquidation: allocates duty +
 * clearance + other over the pieces by CIP weight (allocateShipment), posts the
 * single aggregate asiento (buildImportEntry), creates/updates each inventory
 * item and lands its kardex IN at the landed unit cost, and re-syncs Shopify.
 */
function ImportInvoiceForm({ scope, config, settings, suppliers, orders, items, onClose }) {
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const usd = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [parsing, setParsing] = useState(false);
  const [fileName, setFileName] = useState('');
  const [pieces, setPieces] = useState([]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    supplierId: '', orderId: '', customsRef: '', date: new Date().toISOString().slice(0, 10),
    rate: String(effectiveDopRate(settings) || ''), clearanceFees: '', otherCosts: '',
    duty: '', dutyTouched: false, importItbis: '', itbisTouched: false, paymentMethod: 'bank',
  });

  async function onFile(f) {
    setErr(''); setPieces([]); setFileName(f?.name || '');
    if (!f) return;
    setParsing(true);
    try {
      const parsed = await parseInvoicePdf(f);
      const fp = parsed.furniture.map((l, i) => ({ ...l, _id: `${l.reference}-${i}`, _sel: true, _price: '' }));
      if (!fp.length) setErr('No se encontraron muebles (asientos/mesas) en la factura.');
      setPieces(fp);
    } catch (e) {
      setErr(e?.message || 'No se pudo leer el PDF.');
    } finally {
      setParsing(false);
    }
  }

  const rate = Number(form.rate) || 0;
  const selected = pieces.filter((p) => p._sel);
  const totalCipUsd = r2(selected.reduce((s, p) => s + p.unitCostUsd * p.quantity, 0));
  const totalCipDop = r2(totalCipUsd * rate);
  const taxes = computeImportTaxes({ cif: totalCipDop, config });
  const duty = form.dutyTouched ? (Number(form.duty) || 0) : taxes.duty;
  const importItbis = form.itbisTouched ? (Number(form.importItbis) || 0) : taxes.importItbis;
  const clearanceFees = Number(form.clearanceFees) || 0;
  const otherCosts = Number(form.otherCosts) || 0;
  const landedDop = r2(totalCipDop + duty + clearanceFees + otherCosts);

  const toggle = (id) => setPieces((ps) => ps.map((p) => (p._id === id ? { ...p, _sel: !p._sel } : p)));
  const setPrice = (id, v) => setPieces((ps) => ps.map((p) => (p._id === id ? { ...p, _price: v } : p)));

  async function save() {
    setErr('');
    if (rate <= 0) { setErr('Indica la tasa USD→DOP.'); return; }
    if (!selected.length) { setErr('Selecciona al menos una pieza.'); return; }
    setSaving(true);
    try {
      // Convert each piece's CIP to DOP, then allocate the DOP import costs.
      const piecesDop = selected.map((p) => ({ ...p, unitCostUsd: r2(p.unitCostUsd * rate) }));
      const alloc = allocateShipment(piecesDop, { duty, clearanceFees, otherCosts, importItbis });
      const liqId = newId();
      const postedAt = new Date(form.date).getTime();
      const built = buildImportEntry({
        newId, config, postedAt,
        liq: {
          id: liqId, supplierId: form.supplierId || null, cif: alloc.totalCip, duty, importItbis,
          clearanceFees, otherCosts, paymentMethod: form.paymentMethod,
          memo: `Liquidación importación${fileName ? ` ${fileName.replace(/\.pdf$/i, '')}` : ''}`,
        },
      });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'importLiquidations', profileId: scope, start: 1,
        build: (n) => ({
          id: liqId, profileId: scope, number: n, orderId: form.orderId || null, supplierId: form.supplierId || null,
          itemId: null, liquidatedAt: postedAt, customsRef: form.customsRef,
          qty: selected.reduce((s, p) => s + p.quantity, 0), cif: alloc.totalCip, duty, importItbis,
          clearanceFees, otherCosts, paymentMethod: form.paymentMethod, journalEntryId: built.entry.id,
        }),
      });
      // Land each piece into inventory (create or restock) at its landed cost.
      const syncIds = [];
      for (const ap of alloc.pieces) {
        const p = ap.line;
        const sku = `${p.reference} ${p.fabric}`.replace(/\s+/g, ' ').trim();
        const existing = items.find((i) => (i.sku || '').trim() === sku);
        const itemId = existing ? existing.id : newId();
        if (!existing) {
          await db.inventoryItems.put({
            id: itemId, profileId: scope, sku, name: p.description, unit: 'unidad', qtyOnHand: 0, avgCost: 0,
            ...(p._price !== '' ? { sellingPrice: Number(p._price) } : {}),
          });
        }
        await db.inventoryMovements.put({
          id: newId(), profileId: scope, itemId, type: 'in', qty: p.quantity, unitCost: ap.landedUnitCost,
          movedAt: postedAt, refTable: 'import_liquidations', refId: liqId, journalEntryId: built.entry.id,
        });
        const prevQty = existing ? (existing.qtyOnHand || 0) : 0;
        const prevAvg = existing ? (existing.avgCost || 0) : 0;
        const patch = { qtyOnHand: prevQty + p.quantity, avgCost: weightedAverageIn(prevQty, prevAvg, p.quantity, ap.landedUnitCost) };
        if (p._price !== '') patch.sellingPrice = Number(p._price);
        await db.inventoryItems.update(itemId, patch);
        syncIds.push(itemId);
      }
      if (syncIds.length) syncShopify(syncIds).catch(() => {});
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
        <h3 className="font-semibold">Importar factura Roset (liquidación por lote)</h3>
        <button type="button" onClick={onClose} className="text-ink-400 hover:text-ink-700"><X size={18} /></button>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <label className="btn-ghost text-sm inline-flex items-center gap-1.5 cursor-pointer">
          <Upload size={15} /> {fileName || 'Subir factura PDF'}
          <input type="file" accept="application/pdf" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        {parsing && <span className="text-sm text-ink-500 inline-flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> Leyendo…</span>}
        {pieces.length > 0 && <span className="text-sm text-ink-500">{selected.length}/{pieces.length} muebles seleccionados</span>}
      </div>

      {pieces.length > 0 && (
        <>
          <div className="grid sm:grid-cols-3 gap-3 max-w-3xl mb-3">
            <select value={form.supplierId} onChange={(e) => setForm((f) => ({ ...f, supplierId: e.target.value }))} className={field}>
              <option value="">— Proveedor (exterior) —</option>
              {suppliers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={field} />
            <input value={form.customsRef} onChange={(e) => setForm((f) => ({ ...f, customsRef: e.target.value }))} placeholder="DUA / declaración" className={field} />
          </div>

          <div className="card overflow-hidden mb-3">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="py-2 px-2 w-8"></th>
                  <th className="text-left py-2 px-2">Ref</th>
                  <th className="text-left py-2 px-2">Descripción</th>
                  <th className="text-right py-2 px-2">Cant.</th>
                  <th className="text-right py-2 px-2">Costo USD</th>
                  <th className="text-right py-2 px-2">Precio venta</th>
                </tr>
              </thead>
              <tbody>
                {pieces.map((p) => (
                  <tr key={p._id} className={`border-t border-ink-50 ${p._sel ? '' : 'opacity-40'}`}>
                    <td className="py-1 px-2 text-center"><input type="checkbox" checked={p._sel} onChange={() => toggle(p._id)} /></td>
                    <td className="py-1 px-2"><code className="text-[11px] text-ink-500">{p.reference}</code></td>
                    <td className="py-1 px-2">{p.description}</td>
                    <td className="py-1 px-2 text-right tabular-nums">{p.quantity}</td>
                    <td className="py-1 px-2 text-right tabular-nums">{usd(p.unitCostUsd)}</td>
                    <td className="py-1 px-2 text-right">
                      <input type="number" min="0" step="0.01" value={p._price} onChange={(e) => setPrice(p._id, e.target.value)} placeholder="—"
                        className="w-24 rounded border border-ink-200 px-1.5 py-1 text-sm text-right tabular-nums" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">Tasa USD→DOP<br /><input type="number" step="0.01" min="0" value={form.rate} onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))} className={numField} /></label>
            <label className="text-sm">Gravamen<br /><input type="number" step="0.01" min="0" value={form.dutyTouched ? form.duty : String(duty)} onChange={(e) => setForm((f) => ({ ...f, duty: e.target.value, dutyTouched: true }))} className={numField} /></label>
            <label className="text-sm">ITBIS imp.<br /><input type="number" step="0.01" min="0" value={form.itbisTouched ? form.importItbis : String(importItbis)} onChange={(e) => setForm((f) => ({ ...f, importItbis: e.target.value, itbisTouched: true }))} className={numField} /></label>
            <label className="text-sm">Despacho<br /><input type="number" step="0.01" min="0" value={form.clearanceFees} onChange={(e) => setForm((f) => ({ ...f, clearanceFees: e.target.value }))} className={numField} /></label>
            <label className="text-sm">Otros<br /><input type="number" step="0.01" min="0" value={form.otherCosts} onChange={(e) => setForm((f) => ({ ...f, otherCosts: e.target.value }))} className={numField} /></label>
            <label className="text-sm">Pago<br />
              <select value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))} className={field}>
                <option value="bank">Banco</option><option value="credit">Crédito</option><option value="cash">Efectivo</option><option value="card">Tarjeta</option>
              </select>
            </label>
          </div>

          <div className="flex items-center justify-between mt-3 pt-3 border-t border-ink-100">
            <div className="text-sm text-ink-600">
              CIP US$ <b className="tabular-nums">{usd(totalCipUsd)}</b>
              {' · '}Costo en destino <b className="tabular-nums">{formatDop(landedDop)}</b>
            </div>
            <button type="button" onClick={save} disabled={saving} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Liquidar e ingresar a inventario
            </button>
          </div>
        </>
      )}
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}
