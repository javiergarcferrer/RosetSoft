import { useMemo, useState } from 'react';
import { Loader2, Check, X, Plus, Trash2, FileText } from 'lucide-react';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { formatDop } from '../../lib/format.js';
import { syncShopify } from '../../lib/shopifySync.js';
import {
  buildExpedienteEntry, allocateExpediente, computeImportTaxes, expedienteLanded,
  expedienteCreditableItbis, expedienteCostTotals, expedienteTaxCheck, COST_CONCEPTS,
  weightedAverageIn,
} from '../../core/accounting/index.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sum = (arr, f) => r2(arr.reduce((s, x) => s + (Number(f(x)) || 0), 0));

/**
 * Expediente de importación — the complete customs file for one BL: product
 * lines (each with a CIF value) + DGA taxes + an itemized cost sheet
 * (agenciamiento, transporte, puerto, tasa DGA…). Each cost's NET capitalizes
 * into the per-line landed cost (prorated by CIF value); the ITBIS is credited.
 * Saving posts ONE asiento and a kardex IN per line. The total CIF is derived
 * from the lines, so the per-line landed costs always reconcile to the whole.
 */
export default function ExpedienteForm({ scope, config, suppliers, items, orders, containers, onClose }) {
  const [head, setHead] = useState({
    bl: '', supplierId: '', orderId: '', containerId: '', customsRef: '',
    date: new Date().toISOString().slice(0, 10), paymentMethod: 'bank',
    duty: '', importItbis: '', dutyTouched: false,
  });
  const [lines, setLines] = useState([{ id: newId(), itemId: '', name: '', reference: '', qty: '', cifValue: '' }]);
  const [costs, setCosts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const cif = useMemo(() => sum(lines, (l) => l.cifValue), [lines]);
  // Gravamen + ITBIS auto-suggest from the CIF (editable to match the DUA).
  const suggested = useMemo(() => computeImportTaxes({ cif, config }), [cif, config]);
  const duty = head.dutyTouched ? (Number(head.duty) || 0) : suggested.duty;
  const importItbis = head.importItbis !== '' ? (Number(head.importItbis) || 0) : suggested.importItbis;

  const expediente = useMemo(() => ({
    id: 'preview', profileId: scope, bl: head.bl, supplierId: head.supplierId || null,
    liquidatedAt: 0, paymentMethod: head.paymentMethod,
    cif, duty, importItbis,
    costs: costs.map((c) => ({ ...c, amount: Number(c.amount) || 0, itbis: Number(c.itbis) || 0 })),
    lines: lines.map((l) => ({ ...l, qty: Number(l.qty) || 0, cifValue: Number(l.cifValue) || 0 })),
  }), [scope, head, cif, duty, importItbis, costs, lines]);

  const landed = expedienteLanded(expediente);
  const creditItbis = expedienteCreditableItbis(expediente);
  const costT = expedienteCostTotals(expediente.costs);
  const taxCheck = useMemo(() => expedienteTaxCheck({ cif, duty, importItbis, config }), [cif, duty, importItbis, config]);
  const alloc = useMemo(() => allocateExpediente(expediente), [expediente]);
  const unitById = useMemo(() => Object.fromEntries(alloc.pieces.map((p) => [p.line.id, p.landedUnitCost])), [alloc]);

  function setLine(id, patch) { setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l))); }
  function addLine() { setLines((ls) => [...ls, { id: newId(), itemId: '', name: '', reference: '', qty: '', cifValue: '' }]); }
  function removeLine(id) { setLines((ls) => ls.filter((l) => l.id !== id)); }
  function pickItem(id, itemId) {
    const it = items.find((i) => i.id === itemId);
    setLine(id, { itemId, name: it?.name || '', reference: it?.sku || '' });
  }
  function setCost(id, patch) { setCosts((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c))); }
  function addCost() { setCosts((cs) => [...cs, { id: newId(), concept: 'agenciamiento', supplierId: '', ncf: '', amount: '', itbis: '', paymentMethod: 'bank' }]); }
  function removeCost(id) { setCosts((cs) => cs.filter((c) => c.id !== id)); }

  async function save() {
    setErr('');
    if (cif <= 0) { setErr('Agrega al menos una línea con valor CIF.'); return; }
    setSaving(true);
    try {
      const id = newId();
      const postedAt = new Date(head.date).getTime();
      const exp = { ...expediente, id, orderId: head.orderId || null, containerId: head.containerId || null, customsRef: head.customsRef };
      const built = buildExpedienteEntry({ newId, config, expediente: exp, postedAt });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'importExpedientes', profileId: scope, start: 1,
        build: (n) => ({
          id, profileId: scope, number: n, bl: head.bl, customsRef: head.customsRef,
          supplierId: head.supplierId || null, orderId: head.orderId || null, containerId: head.containerId || null,
          liquidatedAt: postedAt, cif, duty, importItbis, costs: exp.costs, lines: exp.lines,
          paymentMethod: head.paymentMethod, journalEntryId: built.entry.id,
        }),
      });
      // Land each line into inventory at its landed unit cost.
      const touched = [];
      for (const p of alloc.pieces) {
        const itemId = p.line.itemId;
        const qty = Number(p.line.qty) || 0;
        if (!itemId || qty <= 0 || p.landedUnitCost <= 0) continue;
        await db.inventoryMovements.put({
          id: newId(), profileId: scope, itemId, type: 'in', qty, unitCost: p.landedUnitCost,
          movedAt: postedAt, refTable: 'import_expedientes', refId: id, journalEntryId: built.entry.id,
        });
        const it = items.find((i) => i.id === itemId);
        if (it) {
          const avg = weightedAverageIn(it.qtyOnHand || 0, it.avgCost || 0, qty, p.landedUnitCost);
          await db.inventoryItems.update(itemId, { qtyOnHand: (it.qtyOnHand || 0) + qty, avgCost: avg });
        }
        touched.push(itemId);
      }
      if (touched.length) syncShopify(touched).catch(() => {});
      onClose();
    } catch (e) {
      setErr(e?.message || String(e));
      setSaving(false);
    }
  }

  const field = 'rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm';
  const num = 'w-28 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right tabular-nums';
  const supplierOpts = suppliers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return (
    <div className="card p-4 mb-4 border-ink-300">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold inline-flex items-center gap-2"><FileText size={16} /> Nuevo expediente de importación</h3>
        <button type="button" onClick={onClose} className="text-ink-400 hover:text-ink-700"><X size={18} /></button>
      </div>

      {/* Header */}
      <div className="grid sm:grid-cols-3 gap-3">
        <input value={head.bl} onChange={(e) => setHead((h) => ({ ...h, bl: e.target.value }))} placeholder="BL (conocimiento de embarque)" className={field} />
        <input value={head.customsRef} onChange={(e) => setHead((h) => ({ ...h, customsRef: e.target.value }))} placeholder="DUA / declaración" className={field} />
        <input type="date" value={head.date} onChange={(e) => setHead((h) => ({ ...h, date: e.target.value }))} className={field} />
        <select value={head.supplierId} onChange={(e) => setHead((h) => ({ ...h, supplierId: e.target.value }))} className={field}>
          <option value="">— Proveedor (exterior) —</option>
          {supplierOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {orders.length > 0 && (
          <select value={head.orderId} onChange={(e) => setHead((h) => ({ ...h, orderId: e.target.value }))} className={field}>
            <option value="">— Pedido (opcional) —</option>
            {orders.map((o) => <option key={o.id} value={o.id}>#{o.number} {o.name || ''}</option>)}
          </select>
        )}
        {containers?.length > 0 && (
          <select value={head.containerId} onChange={(e) => setHead((h) => ({ ...h, containerId: e.target.value }))} className={field}>
            <option value="">— Contenedor (tracking) —</option>
            {containers.map((c) => <option key={c.id} value={c.id}>{c.code || c.number || c.id}</option>)}
          </select>
        )}
      </div>

      {/* Product lines */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-1.5">
          <h4 className="text-sm font-medium text-ink-700">Productos del embarque</h4>
          <button type="button" onClick={addLine} className="btn-ghost text-xs inline-flex items-center gap-1"><Plus size={13} /> Línea</button>
        </div>
        <div className="space-y-1.5">
          {lines.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-2">
              <select value={l.itemId} onChange={(e) => pickItem(l.id, e.target.value)} className={`${field} flex-1 min-w-[180px]`}>
                <option value="">— Artículo a inventariar —</option>
                {items.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((i) => <option key={i.id} value={i.id}>{i.name}{i.sku ? ` (${i.sku})` : ''}</option>)}
              </select>
              <input type="number" min="0" step="1" value={l.qty} onChange={(e) => setLine(l.id, { qty: e.target.value })} placeholder="Cant." className="w-20 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right" />
              <input type="number" min="0" step="0.01" value={l.cifValue} onChange={(e) => setLine(l.id, { cifValue: e.target.value })} placeholder="Valor CIF RD$" className={num} />
              <span className="text-xs text-ink-500 w-28 text-right tabular-nums">{unitById[l.id] > 0 ? `u. ${formatDop(unitById[l.id])}` : ''}</span>
              <button type="button" onClick={() => removeLine(l.id)} className="text-ink-300 hover:text-rose-600"><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
        <div className="text-xs text-ink-500 mt-1.5">CIF total <b className="tabular-nums">{formatDop(cif)}</b></div>
      </div>

      {/* DGA taxes */}
      <div className="flex flex-wrap items-end gap-3 mt-4">
        <label className="text-sm">Gravamen<br /><input type="number" step="0.01" min="0" value={head.dutyTouched ? head.duty : suggested.duty} onChange={(e) => setHead((h) => ({ ...h, duty: e.target.value, dutyTouched: true }))} className={num} /></label>
        <label className="text-sm">ITBIS imp.<br /><input type="number" step="0.01" min="0" value={head.importItbis !== '' ? head.importItbis : suggested.importItbis} onChange={(e) => setHead((h) => ({ ...h, importItbis: e.target.value }))} className={num} /></label>
        <label className="text-sm">Pago aduanas<br />
          <select value={head.paymentMethod} onChange={(e) => setHead((h) => ({ ...h, paymentMethod: e.target.value }))} className={field}>
            <option value="bank">Banco</option><option value="credit">Crédito</option><option value="cash">Efectivo</option><option value="card">Tarjeta</option>
          </select>
        </label>
        {cif > 0 && !taxCheck.matches && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            Calculado al {config.dutyRate}% / {config.itbisRate}%: gravamen {formatDop(taxCheck.computed.duty)} · ITBIS {formatDop(taxCheck.computed.importItbis)}. Revisa el arancel (HS) si no coincide con la DUA.
          </p>
        )}
      </div>

      {/* Cost sheet */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-1.5">
          <h4 className="text-sm font-medium text-ink-700">Costos del expediente (agenciamiento, transporte, puerto…)</h4>
          <button type="button" onClick={addCost} className="btn-ghost text-xs inline-flex items-center gap-1"><Plus size={13} /> Costo</button>
        </div>
        {costs.length === 0 ? (
          <p className="text-xs text-ink-400">Agrega agenciamiento (FDA), transporte, puerto (Caucedo), tasa DGA… El neto suma al costo del producto; el ITBIS va al crédito fiscal.</p>
        ) : (
          <div className="space-y-1.5">
            {costs.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2">
                <select value={c.concept} onChange={(e) => setCost(c.id, { concept: e.target.value })} className={`${field} w-44`}>
                  {COST_CONCEPTS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                <select value={c.supplierId} onChange={(e) => setCost(c.id, { supplierId: e.target.value })} className={`${field} flex-1 min-w-[140px]`}>
                  <option value="">— Proveedor (606) —</option>
                  {supplierOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input value={c.ncf} onChange={(e) => setCost(c.id, { ncf: e.target.value })} placeholder="NCF" className={`${field} w-32`} />
                <input type="number" step="0.01" min="0" value={c.amount} onChange={(e) => setCost(c.id, { amount: e.target.value })} placeholder="Monto RD$" className={num} />
                <input type="number" step="0.01" min="0" value={c.itbis} onChange={(e) => setCost(c.id, { itbis: e.target.value })} placeholder="ITBIS" className="w-24 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right tabular-nums" />
                <select value={c.paymentMethod} onChange={(e) => setCost(c.id, { paymentMethod: e.target.value })} className={field}>
                  <option value="bank">Banco</option><option value="credit">Crédito</option><option value="cash">Efectivo</option><option value="card">Tarjeta</option>
                </select>
                <button type="button" onClick={() => removeCost(c.id)} className="text-ink-300 hover:text-rose-600"><Trash2 size={15} /></button>
              </div>
            ))}
            <div className="text-xs text-ink-500">Costos: bruto <b className="tabular-nums">{formatDop(costT.gross)}</b> · ITBIS crédito <b className="tabular-nums">{formatDop(costT.itbis)}</b> · neto al costo <b className="tabular-nums">{formatDop(costT.net)}</b></div>
          </div>
        )}
      </div>

      {/* Totals + save */}
      <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-3 border-t border-ink-100">
        <div className="text-sm text-ink-600 space-x-4">
          <span>Costo en destino <b className="tabular-nums">{formatDop(landed)}</b></span>
          <span>ITBIS al crédito <b className="tabular-nums">{formatDop(creditItbis)}</b></span>
        </div>
        <button type="button" onClick={save} disabled={saving} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar expediente
        </button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}
