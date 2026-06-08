import { useMemo, useState } from 'react';
import { Loader2, Check, X, Plus, Trash2, FileText, Upload, Ship, Receipt } from 'lucide-react';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { formatDop } from '../../lib/format.js';
import { syncShopify } from '../../lib/shopifySync.js';
import { effectiveDopRate } from '../../lib/exchangeRate.js';
import { parseInvoicePdf } from '../../lib/loadRosetInvoice.js';
import {
  resolveExpediente, buildExpedienteEntry, expedienteCostTotals, COST_CONCEPTS, weightedAverageIn,
} from '../../core/accounting/index.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const blankLine = () => ({ id: newId(), itemId: '', name: '', reference: '', qty: '', fob: '', selectivo: '' });
const blankFactura = () => ({ id: newId(), supplierId: '', invoiceRef: '', ncf: '', lines: [blankLine()] });
const blankEmbarque = () => ({ id: newId(), bl: '', containerId: '', customsRef: '', flete: '', seguro: '', facturas: [blankFactura()] });

const field = 'rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm';
const num = 'w-28 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right tabular-nums';

/** A single landed-cost KPI tile. */
function Stat({ label, value, accent }) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-ink-400">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${accent || 'text-ink-800'}`}>{value}</div>
    </div>
  );
}

/**
 * Expediente de importación — the executive customs workspace. One file spans
 * EMBARQUES (each a BL/contenedor with its own DUA, flete & seguro), each holding
 * supplier FACTURAS, each with product LÍNEAS (FOB + selectivo). A Roset invoice
 * PDF can seed a factura's lines. Everything reconciles live through
 * `resolveExpediente`: per line CIF → gravamen 20% → selectivo → ITBIS 18%, the
 * shared cost sheet prorated by CIF → landed unit cost. Saving posts ONE asiento
 * and a kardex IN per line; the KPI band + DUA cuadre stay in sync with the DUA.
 */
export default function ExpedienteForm({ scope, config, settings, suppliers, items, orders, containers, onClose }) {
  const [head, setHead] = useState({
    date: new Date().toISOString().slice(0, 10), orderId: '', paymentMethod: 'bank',
    rate: String(effectiveDopRate(settings) || ''), duaTotal: '',
  });
  const [embs, setEmbs] = useState([blankEmbarque()]);
  const [costs, setCosts] = useState([]);
  const [parsing, setParsing] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // ── nested immutable updaters ───────────────────────────────────────────
  const patchEmb = (eid, patch) => setEmbs((es) => es.map((e) => (e.id === eid ? { ...e, ...patch } : e)));
  const delEmb = (eid) => setEmbs((es) => es.filter((e) => e.id !== eid));
  const addFac = (eid) => setEmbs((es) => es.map((e) => (e.id !== eid ? e : { ...e, facturas: [...e.facturas, blankFactura()] })));
  const patchFac = (eid, fid, patch) => setEmbs((es) => es.map((e) => (e.id !== eid ? e : { ...e, facturas: e.facturas.map((f) => (f.id === fid ? { ...f, ...patch } : f)) })));
  const delFac = (eid, fid) => setEmbs((es) => es.map((e) => (e.id !== eid ? e : { ...e, facturas: e.facturas.filter((f) => f.id !== fid) })));
  const addLine = (eid, fid) => mapLines(eid, fid, (ls) => [...ls, blankLine()]);
  const delLine = (eid, fid, lid) => mapLines(eid, fid, (ls) => ls.filter((l) => l.id !== lid));
  const patchLine = (eid, fid, lid, patch) => mapLines(eid, fid, (ls) => ls.map((l) => (l.id === lid ? { ...l, ...patch } : l)));
  function mapLines(eid, fid, fn) {
    setEmbs((es) => es.map((e) => (e.id !== eid ? e : { ...e, facturas: e.facturas.map((f) => (f.id !== fid ? f : { ...f, lines: fn(f.lines) })) })));
  }
  function pickItem(eid, fid, lid, itemId) {
    const it = items.find((i) => i.id === itemId);
    patchLine(eid, fid, lid, { itemId, name: it?.name || '', reference: it?.sku || '' });
  }

  async function importPdf(eid, fid, file) {
    if (!file) return;
    setErr(''); setParsing(fid);
    try {
      const parsed = await parseInvoicePdf(file);
      const rate = Number(head.rate) || 0;
      const seeded = parsed.furniture.map((l) => {
        const match = items.find((i) => (i.sku || '').trim().startsWith(l.reference));
        return {
          id: newId(), itemId: match?.id || '', name: match?.name || l.description, reference: l.reference,
          qty: l.quantity, fob: rate > 0 ? r2(l.unitCostUsd * l.quantity * rate) : '', selectivo: '',
        };
      });
      if (!seeded.length) { setErr('No se encontraron muebles en el PDF.'); return; }
      mapLines(eid, fid, (ls) => [...ls.filter((l) => l.name || l.fob !== ''), ...seeded]);
    } catch (e) {
      setErr(e?.message || 'No se pudo leer el PDF.');
    } finally {
      setParsing('');
    }
  }

  // ── live projection ─────────────────────────────────────────────────────
  const expediente = useMemo(() => ({
    id: 'preview', profileId: scope, paymentMethod: head.paymentMethod, cif: 0, duty: 0, importItbis: 0, lines: [],
    embarques: embs.map((e) => ({
      ...e, flete: Number(e.flete) || 0, seguro: Number(e.seguro) || 0,
      facturas: e.facturas.map((f) => ({
        ...f, lines: f.lines.map((l) => ({ ...l, qty: Number(l.qty) || 0, fob: Number(l.fob) || 0, selectivo: Number(l.selectivo) || 0 })),
      })),
    })),
    costs: costs.map((c) => ({ ...c, amount: Number(c.amount) || 0, itbis: Number(c.itbis) || 0 })),
  }), [scope, head.paymentMethod, embs, costs]);

  const resolved = useMemo(() => resolveExpediente(expediente, config), [expediente, config]);
  const byLine = useMemo(() => Object.fromEntries(resolved.lines.map((l) => [l.id, l])), [resolved]);
  const t = resolved.totals;
  const costT = expedienteCostTotals(expediente.costs);
  const dua = Number(head.duaTotal) || 0;
  const duaDiff = r2(dua - t.impuestos);

  function setCost(id, patch) { setCosts((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c))); }
  function addCost() { setCosts((cs) => [...cs, { id: newId(), concept: 'agenciamiento', supplierId: '', ncf: '', amount: '', itbis: '', paymentMethod: 'bank' }]); }
  function removeCost(id) { setCosts((cs) => cs.filter((c) => c.id !== id)); }

  async function save() {
    setErr('');
    if (t.cif <= 0) { setErr('Agrega al menos una línea con valor FOB.'); return; }
    setSaving(true);
    try {
      const id = newId();
      const postedAt = new Date(head.date).getTime();
      const exp = { ...expediente, id, bl: embs[0]?.bl || '', supplierId: embs[0]?.facturas?.[0]?.supplierId || null };
      const built = buildExpedienteEntry({ newId, config, expediente: exp, postedAt });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'importExpedientes', profileId: scope, start: 1,
        build: (n) => ({
          id, profileId: scope, number: n, bl: exp.bl, customsRef: embs[0]?.customsRef || '',
          supplierId: exp.supplierId, orderId: head.orderId || null, containerId: embs[0]?.containerId || null,
          liquidatedAt: postedAt,
          cif: t.cif, duty: t.gravamen, selectivo: t.selectivo, importItbis: t.importItbis,
          embarques: exp.embarques, costs: exp.costs,
          lines: resolved.lines.map((l) => ({ id: l.id, itemId: l.itemId, name: l.name, reference: l.reference, qty: l.qty, fob: l.fob, selectivo: l.selectivo, cifValue: l.cif })),
          paymentMethod: head.paymentMethod, journalEntryId: built.entry.id,
        }),
      });
      // Land each line into inventory at its landed unit cost.
      const touched = [];
      for (const l of resolved.lines) {
        if (!l.itemId || l.qty <= 0 || l.landedUnitCost <= 0) continue;
        await db.inventoryMovements.put({
          id: newId(), profileId: scope, itemId: l.itemId, type: 'in', qty: l.qty, unitCost: l.landedUnitCost,
          movedAt: postedAt, refTable: 'import_expedientes', refId: id, journalEntryId: built.entry.id,
        });
        const it = items.find((i) => i.id === l.itemId);
        if (it) {
          const avg = weightedAverageIn(it.qtyOnHand || 0, it.avgCost || 0, l.qty, l.landedUnitCost);
          await db.inventoryItems.update(l.itemId, { qtyOnHand: (it.qtyOnHand || 0) + l.qty, avgCost: avg });
        }
        touched.push(l.itemId);
      }
      if (touched.length) syncShopify(touched).catch(() => {});
      onClose();
    } catch (e) {
      setErr(e?.message || String(e));
      setSaving(false);
    }
  }

  const supplierOpts = suppliers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const itemOpts = items.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return (
    <div className="card p-4 mb-4 border-ink-300">
      <div className="flex items-center justify-between mb-3 gap-2 min-w-0">
        <h3 className="font-semibold inline-flex items-center gap-2 min-w-0 truncate"><FileText size={16} className="shrink-0" /> Nuevo expediente de importación</h3>
        <button type="button" onClick={onClose} className="text-ink-400 hover:text-ink-700 shrink-0 p-2 -m-1 min-h-[44px] min-w-[44px] flex items-center justify-center"><X size={18} /></button>
      </div>

      {/* Expediente meta */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="text-xs text-ink-500">Fecha<input type="date" value={head.date} onChange={(e) => setHead((h) => ({ ...h, date: e.target.value }))} className={`${field} w-full mt-0.5`} /></label>
        {orders.length > 0 && (
          <label className="text-xs text-ink-500">Pedido<select value={head.orderId} onChange={(e) => setHead((h) => ({ ...h, orderId: e.target.value }))} className={`${field} w-full mt-0.5`}>
            <option value="">— Opcional —</option>
            {orders.map((o) => <option key={o.id} value={o.id}>#{o.number} {o.name || ''}</option>)}
          </select></label>
        )}
        <label className="text-xs text-ink-500">Tasa USD→DOP <span className="text-ink-400">(importar PDF)</span><input type="number" step="0.01" min="0" inputMode="decimal" value={head.rate} onChange={(e) => setHead((h) => ({ ...h, rate: e.target.value }))} className={`${field} w-full mt-0.5 text-right tabular-nums`} /></label>
        <label className="text-xs text-ink-500">Pago aduanas<select value={head.paymentMethod} onChange={(e) => setHead((h) => ({ ...h, paymentMethod: e.target.value }))} className={`${field} w-full mt-0.5`}>
          <option value="bank">Banco</option><option value="credit">Crédito</option><option value="cash">Efectivo</option><option value="card">Tarjeta</option>
        </select></label>
      </div>

      {/* KPI band */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mt-4">
        <Stat label="CIF (valor aduana)" value={formatDop(t.cif)} />
        <Stat label="Gravamen 20%" value={formatDop(t.gravamen)} />
        <Stat label="Selectivo (ISC)" value={formatDop(t.selectivo)} />
        <Stat label="ITBIS al crédito" value={formatDop(t.creditableItbis)} accent="text-sky-700" />
        <Stat label="Costo en destino" value={formatDop(t.landed)} accent="text-emerald-700" />
      </div>

      {/* Embarques → facturas → líneas */}
      <div className="mt-4 space-y-3">
        {embs.map((emb, ei) => (
          <div key={emb.id} className="rounded-xl border border-ink-200 bg-ink-50/40 p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium text-ink-700 inline-flex items-center gap-1.5"><Ship size={15} /> Embarque {ei + 1}</h4>
              {embs.length > 1 && <button type="button" onClick={() => delEmb(emb.id)} className="text-ink-300 hover:text-rose-600"><Trash2 size={15} /></button>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
              <input value={emb.bl} onChange={(e) => patchEmb(emb.id, { bl: e.target.value })} placeholder="BL / conocimiento" className={`${field} w-full lg:col-span-2`} />
              <input value={emb.customsRef} onChange={(e) => patchEmb(emb.id, { customsRef: e.target.value })} placeholder="DUA" className={`${field} w-full`} />
              <input type="number" step="0.01" min="0" inputMode="decimal" value={emb.flete} onChange={(e) => patchEmb(emb.id, { flete: e.target.value })} placeholder="Flete RD$" className={`${field} w-full text-right tabular-nums`} />
              <input type="number" step="0.01" min="0" inputMode="decimal" value={emb.seguro} onChange={(e) => patchEmb(emb.id, { seguro: e.target.value })} placeholder="Seguro RD$" className={`${field} w-full text-right tabular-nums`} />
            </div>
            {containers?.length > 0 && (
              <select value={emb.containerId} onChange={(e) => patchEmb(emb.id, { containerId: e.target.value })} className={`${field} mt-2 w-full sm:w-64`}>
                <option value="">— Contenedor (tracking) —</option>
                {containers.map((c) => <option key={c.id} value={c.id}>{c.code || c.number || c.id}</option>)}
              </select>
            )}

            {/* Facturas */}
            <div className="mt-3 space-y-2">
              {emb.facturas.map((fac) => (
                <div key={fac.id} className="rounded-lg border border-ink-200 bg-white p-2.5">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <Receipt size={14} className="text-ink-400 shrink-0" />
                    <select value={fac.supplierId} onChange={(e) => patchFac(emb.id, fac.id, { supplierId: e.target.value })} className={`${field} flex-1 min-w-[140px]`}>
                      <option value="">— Suplidor de la factura —</option>
                      {supplierOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <input value={fac.invoiceRef} onChange={(e) => patchFac(emb.id, fac.id, { invoiceRef: e.target.value })} placeholder="No. factura" className={`${field} w-28 min-w-0`} />
                    <input value={fac.ncf} onChange={(e) => patchFac(emb.id, fac.id, { ncf: e.target.value })} placeholder="NCF" className={`${field} w-28 min-w-0`} />
                    <label className="btn-ghost text-xs inline-flex items-center gap-1 cursor-pointer min-h-[44px] px-2">
                      {parsing === fac.id ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} PDF
                      <input type="file" accept="application/pdf" className="hidden" onChange={(e) => importPdf(emb.id, fac.id, e.target.files?.[0])} />
                    </label>
                    {emb.facturas.length > 1 && <button type="button" onClick={() => delFac(emb.id, fac.id)} className="text-ink-300 hover:text-rose-600 min-h-[44px] min-w-[44px] flex items-center justify-center"><Trash2 size={14} /></button>}
                  </div>

                  {/* Líneas */}
                  <div className="overflow-x-auto -mx-2.5">
                  <table className="w-full text-sm min-w-[520px]">
                    <thead className="text-ink-400 text-[11px] uppercase tracking-wide">
                      <tr>
                        <th className="text-left font-medium pb-1 pl-2.5">Artículo</th>
                        <th className="text-right font-medium pb-1 w-16 whitespace-nowrap">Cant.</th>
                        <th className="text-right font-medium pb-1 w-28 whitespace-nowrap">FOB RD$</th>
                        <th className="text-right font-medium pb-1 w-24 whitespace-nowrap">Selectivo</th>
                        <th className="text-right font-medium pb-1 w-28 whitespace-nowrap">C. unit.</th>
                        <th className="w-8 pr-2.5"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {fac.lines.map((l) => (
                        <tr key={l.id}>
                          <td className="py-0.5 pr-2 pl-2.5">
                            <select value={l.itemId} onChange={(e) => pickItem(emb.id, fac.id, l.id, e.target.value)} className={`${field} w-full`}>
                              <option value="">{l.name || '— Artículo a inventariar —'}</option>
                              {itemOpts.map((i) => <option key={i.id} value={i.id}>{i.name}{i.sku ? ` (${i.sku})` : ''}</option>)}
                            </select>
                          </td>
                          <td className="py-0.5"><input type="number" min="0" step="1" inputMode="numeric" value={l.qty} onChange={(e) => patchLine(emb.id, fac.id, l.id, { qty: e.target.value })} className="w-16 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right tabular-nums" /></td>
                          <td className="py-0.5"><input type="number" min="0" step="0.01" inputMode="decimal" value={l.fob} onChange={(e) => patchLine(emb.id, fac.id, l.id, { fob: e.target.value })} className={num} /></td>
                          <td className="py-0.5"><input type="number" min="0" step="0.01" inputMode="decimal" value={l.selectivo} onChange={(e) => patchLine(emb.id, fac.id, l.id, { selectivo: e.target.value })} placeholder="0" className="w-24 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right tabular-nums" /></td>
                          <td className="py-0.5 text-right text-xs text-ink-500 tabular-nums whitespace-nowrap pr-1">{byLine[l.id]?.landedUnitCost > 0 ? formatDop(byLine[l.id].landedUnitCost) : '—'}</td>
                          <td className="py-0.5 text-right pr-2.5"><button type="button" onClick={() => delLine(emb.id, fac.id, l.id)} className="text-ink-300 hover:text-rose-600 p-1 min-h-[44px] min-w-[44px] flex items-center justify-center"><Trash2 size={14} /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                  <button type="button" onClick={() => addLine(emb.id, fac.id)} className="btn-ghost text-xs inline-flex items-center gap-1 mt-1 min-h-[44px] px-2"><Plus size={12} /> Línea</button>
                </div>
              ))}
              <button type="button" onClick={() => addFac(emb.id)} className="btn-ghost text-xs inline-flex items-center gap-1"><Plus size={12} /> Factura</button>
            </div>
          </div>
        ))}
        <button type="button" onClick={() => setEmbs((es) => [...es, blankEmbarque()])} className="btn-ghost text-sm inline-flex items-center gap-1.5"><Plus size={14} /> Embarque</button>
      </div>

      {/* Cost sheet */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-1.5">
          <h4 className="text-sm font-medium text-ink-700">Costos del expediente (agenciamiento, transporte, puerto…)</h4>
          <button type="button" onClick={addCost} className="btn-ghost text-xs inline-flex items-center gap-1"><Plus size={13} /> Costo</button>
        </div>
        {costs.length === 0 ? (
          <p className="text-xs text-ink-400">El neto suma al costo del producto (prorrateado por CIF); el ITBIS va al crédito fiscal.</p>
        ) : (
          <div className="space-y-2">
            {costs.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2">
                <select value={c.concept} onChange={(e) => setCost(c.id, { concept: e.target.value })} className={`${field} w-full sm:w-44`}>
                  {COST_CONCEPTS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
                <select value={c.supplierId} onChange={(e) => setCost(c.id, { supplierId: e.target.value })} className={`${field} flex-1 min-w-[130px]`}>
                  <option value="">— Proveedor (606) —</option>
                  {supplierOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input value={c.ncf} onChange={(e) => setCost(c.id, { ncf: e.target.value })} placeholder="NCF" className={`${field} w-28 min-w-0`} />
                <input type="number" step="0.01" min="0" inputMode="decimal" value={c.amount} onChange={(e) => setCost(c.id, { amount: e.target.value })} placeholder="Monto RD$" className={num} />
                <input type="number" step="0.01" min="0" inputMode="decimal" value={c.itbis} onChange={(e) => setCost(c.id, { itbis: e.target.value })} placeholder="ITBIS" className="w-24 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right tabular-nums" />
                <select value={c.paymentMethod} onChange={(e) => setCost(c.id, { paymentMethod: e.target.value })} className={`${field} w-full sm:w-auto`}>
                  <option value="bank">Banco</option><option value="credit">Crédito</option><option value="cash">Efectivo</option><option value="card">Tarjeta</option>
                </select>
                <button type="button" onClick={() => removeCost(c.id)} className="text-ink-300 hover:text-rose-600 min-h-[44px] min-w-[44px] flex items-center justify-center"><Trash2 size={15} /></button>
              </div>
            ))}
            <div className="text-xs text-ink-500">Costos: bruto <b className="tabular-nums">{formatDop(costT.gross)}</b> · ITBIS crédito <b className="tabular-nums">{formatDop(costT.itbis)}</b> · neto al costo <b className="tabular-nums">{formatDop(costT.net)}</b></div>
          </div>
        )}
      </div>

      {/* Cuadre vs DUA + save */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4 pt-3 border-t border-ink-100">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-ink-500">Total impuestos DUA (Colector)<br />
            <input type="number" step="0.01" min="0" inputMode="decimal" enterKeyHint="done" value={head.duaTotal} onChange={(e) => setHead((h) => ({ ...h, duaTotal: e.target.value }))} placeholder="opcional" className={`${num} mt-0.5`} />
          </label>
          <div className="text-xs">
            <div className="text-ink-500">Impuestos calculados <b className="tabular-nums">{formatDop(t.impuestos)}</b></div>
            {dua > 0 && (Math.abs(duaDiff) < 1
              ? <span className="inline-flex items-center gap-1 text-emerald-700"><Check size={13} /> Cuadra con la DUA</span>
              : <span className="text-amber-700">Diferencia {formatDop(duaDiff)} — revisa FOB / selectivo / arancel</span>)}
          </div>
        </div>
        <button type="button" onClick={save} disabled={saving} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40 self-start sm:self-auto min-h-[44px] px-4">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar expediente
        </button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}
