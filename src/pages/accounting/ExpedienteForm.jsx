import { userMessageFor } from '../../lib/errorMessages.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Check, X, Plus, Trash2, FileText, Upload, Ship, Receipt, History, Sparkles } from 'lucide-react';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { formatDop } from '../../lib/format.js';
import { syncShopify } from '../../lib/shopifySync.js';
import { effectiveDopRate } from '../../lib/exchangeRate.js';
import { parseInvoicePdf } from '../../lib/loadRosetInvoice.js';
import SearchPicker from '../../components/SearchPicker.jsx';
import { groupFamilies, catalogSellingPrice } from '../../lib/catalog.js';
import {
  resolveExpediente, buildExpedienteEntry, expedienteCostTotals, COST_CONCEPTS, weightedAverageIn,
} from '../../core/accounting/index.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const blankLine = () => ({ id: newId(), itemId: '', name: '', reference: '', qty: '', fob: '', selectivo: '', fabric: '' });
const blankFactura = () => ({ id: newId(), supplierId: '', invoiceRef: '', ncf: '', lines: [blankLine()] });
const blankEmbarque = () => ({ id: newId(), bl: '', containerId: '', customsRef: '', flete: '', seguro: '', facturas: [blankFactura()] });

const field = 'input';
const num = 'input w-28 text-right tabular-nums';

const draftKey = (scope) => `rosetsoft.importacionDraft.${scope}`;
export const TEMPLATE_KEY = (scope) => `rosetsoft.importacionTemplate.${scope}`;

/** Read the entry seed: an explicit template (set by "Usar como plantilla" on a
 *  saved expediente, consumed once) wins over a leftover autosaved draft. */
function readSeed(scope, defaults) {
  try {
    const tpl = localStorage.getItem(TEMPLATE_KEY(scope));
    if (tpl) {
      localStorage.removeItem(TEMPLATE_KEY(scope));
      return { kind: 'template', ...JSON.parse(tpl) };
    }
    const draft = localStorage.getItem(draftKey(scope));
    if (draft) return { kind: 'draft', ...JSON.parse(draft) };
  } catch { /* a corrupt seed just means a blank form */ }
  return { kind: '', head: defaults, embs: null, costs: null };
}

/** A single landed-cost KPI tile. */
function Stat({ label, value, accent }) {
  return (
    <div className="rounded-xl border border-ink-200 bg-surface px-3 py-2 min-w-0">
      <div className="eyebrow text-ink-400">{label}</div>
      <div className={`text-base font-semibold tabular-nums whitespace-nowrap ${accent || 'text-ink-800'}`}>{value}</div>
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
 *
 * Built for speed of entry: the item cell is a typeahead (search by name/SKU,
 * Enter picks); a line that doesn't match an existing artículo is created in
 * inventory automatically on save; Enter on the last cell adds the next line
 * and focuses it; the half-entered form autosaves as a draft and a saved
 * expediente can seed a new one as a template.
 */
export default function ExpedienteForm({ scope, config, settings, suppliers, items, orders, containers, products, materials, onClose }) {
  // Catalog families (by SKU root) → the list price an imported piece is sold at.
  // A newly-minted inventory item is priced from the catalog, by reference +
  // the fabric (grade) it shipped in; cost still comes from the landed liquidation.
  const families = useMemo(() => new Map(groupFamilies(products || []).map((f) => [f.root, f])), [products]);
  const defaults = useMemo(() => ({
    date: new Date().toISOString().slice(0, 10), orderId: '', paymentMethod: 'bank',
    rate: String(effectiveDopRate(settings) || ''), duaTotal: '',
  }), [settings]);
  const seedRef = useRef(null);
  if (seedRef.current == null) seedRef.current = readSeed(scope, defaults);
  const seed = seedRef.current;

  const [head, setHead] = useState({ ...defaults, ...(seed.head || {}) });
  const [embs, setEmbs] = useState(seed.embs?.length ? seed.embs : [blankEmbarque()]);
  const [costs, setCosts] = useState(seed.costs?.length ? seed.costs : []);
  const [seededFrom, setSeededFrom] = useState(seed.kind);
  const [parsing, setParsing] = useState('');
  const [pdfNote, setPdfNote] = useState(null); // { fid, matched, toCreate }
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // ── nested immutable updaters ───────────────────────────────────────────
  const patchEmb = (eid, patch) => setEmbs((es) => es.map((e) => (e.id === eid ? { ...e, ...patch } : e)));
  const delEmb = (eid) => setEmbs((es) => es.filter((e) => e.id !== eid));
  const addFac = (eid) => setEmbs((es) => es.map((e) => (e.id !== eid ? e : { ...e, facturas: [...e.facturas, blankFactura()] })));
  const patchFac = (eid, fid, patch) => setEmbs((es) => es.map((e) => (e.id !== eid ? e : { ...e, facturas: e.facturas.map((f) => (f.id === fid ? { ...f, ...patch } : f)) })));
  const delFac = (eid, fid) => setEmbs((es) => es.map((e) => (e.id !== eid ? e : { ...e, facturas: e.facturas.filter((f) => f.id !== fid) })));
  const delLine = (eid, fid, lid) => mapLines(eid, fid, (ls) => ls.filter((l) => l.id !== lid));
  const patchLine = (eid, fid, lid, patch) => mapLines(eid, fid, (ls) => ls.map((l) => (l.id === lid ? { ...l, ...patch } : l)));
  function mapLines(eid, fid, fn) {
    setEmbs((es) => es.map((e) => (e.id !== eid ? e : { ...e, facturas: e.facturas.map((f) => (f.id !== fid ? f : { ...f, lines: fn(f.lines) })) })));
  }
  /** Add a line and move the cursor straight into its item cell — the Enter-Enter
   *  rhythm that makes long facturas fast. */
  function addLine(eid, fid) {
    const l = blankLine();
    mapLines(eid, fid, (ls) => [...ls, l]);
    requestAnimationFrame(() => document.querySelector(`[data-line-focus="${l.id}"]`)?.focus());
  }

  // ── draft autosave: anything half-entered survives a navigation/crash ───
  const hasContent = useMemo(() => (
    costs.length > 0 || !!head.duaTotal
    || embs.some((e) => e.bl || e.customsRef || e.flete || e.seguro
      || e.facturas.some((f) => f.supplierId || f.invoiceRef || f.lines.some((l) => l.name || l.itemId || l.fob !== '' || l.qty !== '')))
  ), [head.duaTotal, embs, costs]);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (hasContent) localStorage.setItem(draftKey(scope), JSON.stringify({ head, embs, costs }));
        else localStorage.removeItem(draftKey(scope));
      } catch { /* quota — the draft is best-effort */ }
    }, 400);
    return () => clearTimeout(t);
  }, [scope, head, embs, costs, hasContent]);

  function resetForm() {
    try { localStorage.removeItem(draftKey(scope)); } catch { /* best-effort */ }
    setHead(defaults);
    setEmbs([blankEmbarque()]);
    setCosts([]);
    setSeededFrom('');
    setPdfNote(null);
    setErr('');
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
          fabric: l.fabric || '', // the material → its grade → the catalog price on save
        };
      });
      if (!seeded.length) { setErr('No se encontraron muebles en el PDF.'); return; }
      mapLines(eid, fid, (ls) => [...ls.filter((l) => l.name || l.fob !== ''), ...seeded]);
      const matched = seeded.filter((l) => l.itemId).length;
      setPdfNote({ fid, matched, toCreate: seeded.length - matched });
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setParsing('');
    }
  }

  // ── live projection ─────────────────────────────────────────────────────
  const toModel = (embsArr, costsArr) => ({
    id: 'preview', profileId: scope, paymentMethod: head.paymentMethod, cif: 0, duty: 0, importItbis: 0, lines: [],
    embarques: embsArr.map((e) => ({
      ...e, flete: Number(e.flete) || 0, seguro: Number(e.seguro) || 0,
      facturas: e.facturas.map((f) => ({
        ...f, lines: f.lines.map((l) => ({ ...l, qty: Number(l.qty) || 0, fob: Number(l.fob) || 0, selectivo: Number(l.selectivo) || 0 })),
      })),
    })),
    costs: costsArr.map((c) => ({ ...c, amount: Number(c.amount) || 0, itbis: Number(c.itbis) || 0 })),
  });
  const expediente = useMemo(() => toModel(embs, costs), [scope, head.paymentMethod, embs, costs]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolved = useMemo(() => resolveExpediente(expediente, config), [expediente, config]);
  const byLine = useMemo(() => Object.fromEntries(resolved.lines.map((l) => [l.id, l])), [resolved]);
  const t = resolved.totals;
  const costT = expedienteCostTotals(expediente.costs);
  const dua = Number(head.duaTotal) || 0;
  const duaDiff = r2(dua - t.impuestos);
  const newItemCount = useMemo(
    () => embs.reduce((s, e) => s + e.facturas.reduce((a, f) => a + f.lines.filter((l) => !l.itemId && (l.name || '').trim() && Number(l.qty) > 0).length, 0), 0),
    [embs],
  );

  function setCost(id, patch) { setCosts((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c))); }
  function addCost() { setCosts((cs) => [...cs, { id: newId(), concept: 'agenciamiento', supplierId: '', ncf: '', amount: '', itbis: '', paymentMethod: 'bank' }]); }
  function removeCost(id) { setCosts((cs) => cs.filter((c) => c.id !== id)); }

  async function save() {
    setErr('');
    if (t.cif <= 0) { setErr('Agrega al menos una línea con valor FOB.'); return; }
    setSaving(true);
    try {
      // Free-text lines first become real inventory items, so the kardex IN and
      // the stored expediente both point at them — entry never blocks on
      // pre-creating artículos. Identity is MODEL + VARIANT: a Ligne Roset
      // reference (e.g. 14100100 = Mini Togo) is a model code SHARED across
      // covers, so match/dedupe by (sku + name) — four covers stay four items,
      // while the same variant (existing, or just minted in THIS save) is reused
      // instead of duplicated. Mirrors inventory_items_sku_name_uq; this is what
      // removes the false "Ya existe un registro con esos datos".
      const newItems = [];
      const priceByItem = new Map(); // itemId → catalog list price (USD), when resolvable
      const variantKey = (sku, name) => JSON.stringify([(sku || '').trim(), (name || '').trim()]);
      const idByVariant = new Map(items.map((i) => [variantKey(i.sku, i.name), i.id]));
      const embsPatched = embs.map((e) => ({
        ...e,
        facturas: e.facturas.map((f) => ({
          ...f,
          lines: f.lines.map((l) => {
            if (l.itemId || !(l.name || '').trim() || !(Number(l.qty) > 0)) return l;
            const sku = (l.reference || '').trim();
            const name = l.name.trim();
            // The catalog list price for this piece — by reference + the fabric's
            // grade. The product + material come off the invoice; the PRICE comes
            // off the catalog (the landed cost still drives avgCost).
            const price = catalogSellingPrice(families, materials, sku, l.fabric);
            const k = variantKey(sku, name);
            const reuse = idByVariant.get(k);
            if (reuse) {
              if (price != null) priceByItem.set(reuse, price);
              return { ...l, itemId: reuse };
            }
            const itemId = newId();
            newItems.push({
              id: itemId, profileId: scope, sku, name, unit: 'unidad', qtyOnHand: 0, avgCost: 0,
              ...(price != null ? { sellingPrice: price } : {}),
            });
            if (price != null) priceByItem.set(itemId, price);
            idByVariant.set(k, itemId);
            return { ...l, itemId };
          }),
        })),
      }));
      if (newItems.length) await db.inventoryItems.bulkPut(newItems);
      const itemById = new Map([...items, ...newItems].map((i) => [i.id, i]));

      const id = newId();
      const postedAt = new Date(head.date).getTime();
      const exp = { ...toModel(embsPatched, costs), id, bl: embsPatched[0]?.bl || '', supplierId: embsPatched[0]?.facturas?.[0]?.supplierId || null };
      const resolvedSave = resolveExpediente(exp, config);
      const built = buildExpedienteEntry({ newId, config, expediente: exp, postedAt });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      await assignSequenceNumber({
        table: 'importExpedientes', profileId: scope, start: 1,
        build: (n) => ({
          id, profileId: scope, number: n, bl: exp.bl, customsRef: embsPatched[0]?.customsRef || '',
          supplierId: exp.supplierId, orderId: head.orderId || null, containerId: embsPatched[0]?.containerId || null,
          liquidatedAt: postedAt,
          cif: resolvedSave.totals.cif, duty: resolvedSave.totals.gravamen, selectivo: resolvedSave.totals.selectivo, importItbis: resolvedSave.totals.importItbis,
          embarques: exp.embarques, costs: exp.costs,
          lines: resolvedSave.lines.map((l) => ({ id: l.id, itemId: l.itemId, name: l.name, reference: l.reference, qty: l.qty, fob: l.fob, selectivo: l.selectivo, cifValue: l.cif })),
          paymentMethod: head.paymentMethod, journalEntryId: built.entry.id,
        }),
      });
      // Land each line into inventory at its landed unit cost.
      const touched = [];
      for (const l of resolvedSave.lines) {
        if (!l.itemId || l.qty <= 0 || l.landedUnitCost <= 0) continue;
        await db.inventoryMovements.put({
          id: newId(), profileId: scope, itemId: l.itemId, type: 'in', qty: l.qty, unitCost: l.landedUnitCost,
          movedAt: postedAt, refTable: 'import_expedientes', refId: id, journalEntryId: built.entry.id,
        });
        const it = itemById.get(l.itemId);
        if (it) {
          const avg = weightedAverageIn(it.qtyOnHand || 0, it.avgCost || 0, l.qty, l.landedUnitCost);
          const patch = { qtyOnHand: (it.qtyOnHand || 0) + l.qty, avgCost: avg };
          // Backfill the catalog price onto an existing item that never carried
          // one (newly-minted items already have it). A dealer-set price wins.
          const price = priceByItem.get(l.itemId);
          if (price != null && it.sellingPrice == null) patch.sellingPrice = price;
          await db.inventoryItems.update(l.itemId, patch);
        }
        touched.push(l.itemId);
      }
      if (touched.length) syncShopify(touched).catch(() => {});
      try { localStorage.removeItem(draftKey(scope)); } catch { /* best-effort */ }
      onClose();
    } catch (e) {
      setErr(userMessageFor(e));
      setSaving(false);
    }
  }

  const supplierOpts = suppliers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const itemOptions = useMemo(
    () => items.slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map((i) => ({ id: i.id, label: i.name, sublabel: i.sku || '' })),
    [items],
  );

  return (
    <div className="card p-4 mb-4 border-ink-300">
      <div className="flex items-center justify-between mb-3 gap-2 min-w-0">
        <h3 className="font-display font-semibold inline-flex items-center gap-2 min-w-0 truncate"><FileText size={16} className="shrink-0" /> Nuevo expediente de importación</h3>
        <button type="button" onClick={onClose} className="btn-icon text-ink-400 shrink-0" aria-label="Cerrar"><X size={18} /></button>
      </div>

      {seededFrom && (
        <div className="flex flex-wrap items-center gap-2 mb-3 rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-xs text-sky-800">
          {seededFrom === 'template'
            ? <><Sparkles size={13} className="shrink-0" /> Formulario sembrado desde la plantilla del expediente — revisa cantidades y montos.</>
            : <><History size={13} className="shrink-0" /> Borrador restaurado — seguiste donde lo dejaste.</>}
          <button type="button" onClick={resetForm} className="ml-auto underline underline-offset-2 hover:text-sky-950 inline-flex items-center min-h-8 coarse:min-h-11">Empezar en blanco</button>
        </div>
      )}

      {/* Expediente meta */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="text-xs text-ink-500">Fecha<input type="date" value={head.date} onChange={(e) => setHead((h) => ({ ...h, date: e.target.value }))} className={`${field} w-full mt-0.5`} /></label>
        {orders.length > 0 && (
          <label className="text-xs text-ink-500">Pedido<select value={head.orderId} onChange={(e) => setHead((h) => ({ ...h, orderId: e.target.value }))} className={`${field} w-full mt-0.5`}>
            <option value="">— Opcional —</option>
            {orders.map((o) => <option key={o.id} value={o.id}>#{o.number} {o.name || ''}</option>)}
          </select>
          </label>
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
          <div key={emb.id} className="surface-subtle p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-display text-sm font-medium text-ink-700 inline-flex items-center gap-1.5"><Ship size={15} /> Embarque {ei + 1}</h4>
              {embs.length > 1 && <button type="button" onClick={() => delEmb(emb.id)} className="btn-icon-danger" title="Eliminar embarque" aria-label="Eliminar embarque"><Trash2 size={15} /></button>}
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
                <div key={fac.id} className="rounded-lg border border-ink-200 bg-surface p-2.5">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <Receipt size={14} className="text-ink-400 shrink-0" />
                    <select value={fac.supplierId} onChange={(e) => patchFac(emb.id, fac.id, { supplierId: e.target.value })} className={`${field} flex-1 min-w-[140px]`}>
                      <option value="">— Suplidor de la factura —</option>
                      {supplierOpts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <input value={fac.invoiceRef} onChange={(e) => patchFac(emb.id, fac.id, { invoiceRef: e.target.value })} placeholder="No. factura" className={`${field} w-28 min-w-0`} />
                    <input value={fac.ncf} onChange={(e) => patchFac(emb.id, fac.id, { ncf: e.target.value })} placeholder="NCF" className={`${field} w-28 min-w-0`} />
                    <label className="btn-ghost text-xs gap-1 cursor-pointer px-2">
                      {parsing === fac.id ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} PDF
                      <input type="file" accept="application/pdf" className="hidden" onChange={(e) => importPdf(emb.id, fac.id, e.target.files?.[0])} />
                    </label>
                    {emb.facturas.length > 1 && <button type="button" onClick={() => delFac(emb.id, fac.id)} className="btn-icon-danger" title="Eliminar factura" aria-label="Eliminar factura"><Trash2 size={14} /></button>}
                  </div>
                  {pdfNote?.fid === fac.id && (
                    <p className="text-xs text-ink-500 mb-1.5">
                      PDF importado: <b>{pdfNote.matched + pdfNote.toCreate}</b> líneas — {pdfNote.matched} en inventario
                      {pdfNote.toCreate > 0 && <span className="text-amber-700">, {pdfNote.toCreate} se crearán al guardar</span>}.
                    </p>
                  )}

                  {/* Líneas */}
                  <div className="overflow-x-auto -mx-2.5">
                  <table className="w-full text-sm min-w-[560px]">
                    <thead className="text-ink-400 text-[11px] uppercase tracking-wide">
                      <tr>
                        <th className="text-left font-medium pb-1 pl-2.5">Artículo <span className="normal-case font-normal">(busca o escribe uno nuevo)</span></th>
                        <th className="text-right font-medium pb-1 w-16 whitespace-nowrap">Cant.</th>
                        <th className="text-right font-medium pb-1 w-28 whitespace-nowrap">FOB RD$</th>
                        <th className="text-right font-medium pb-1 w-24 whitespace-nowrap">Selectivo</th>
                        <th className="text-right font-medium pb-1 w-28 whitespace-nowrap">C. unit.</th>
                        <th className="w-8 pr-2.5"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {fac.lines.map((l) => (
                        <tr key={l.id} className="align-top">
                          <td className="py-0.5 pr-2 pl-2.5">
                            <SearchPicker
                              options={itemOptions}
                              value={l.itemId}
                              text={l.name}
                              placeholder="— Artículo a inventariar —"
                              freeTextLabel="Crear artículo"
                              onPick={(o) => patchLine(emb.id, fac.id, l.id, { itemId: o.id, name: o.label, reference: o.sublabel || '' })}
                              allowFreeText
                              onFreeText={(txt) => patchLine(emb.id, fac.id, l.id, { itemId: '', name: txt })}
                              inputProps={{ 'data-line-focus': l.id }}
                            />
                            {(l.name || '').trim() !== '' && (!l.itemId || l.reference) && (
                              <div className="mt-0.5 inline-flex items-center gap-1.5 text-[11px] text-amber-700">
                                {!l.itemId && <span className="inline-flex items-center gap-1"><Plus size={11} /> Nuevo en inventario</span>}
                                {l.reference && <span className="font-mono text-amber-600">{l.reference}</span>}
                              </div>
                            )}
                          </td>
                          <td className="py-0.5"><input type="number" min="0" step="1" inputMode="numeric" value={l.qty} onChange={(e) => patchLine(emb.id, fac.id, l.id, { qty: e.target.value })} className="input w-16 text-right tabular-nums" /></td>
                          <td className="py-0.5"><input type="number" min="0" step="0.01" inputMode="decimal" value={l.fob} onChange={(e) => patchLine(emb.id, fac.id, l.id, { fob: e.target.value })} className={num} /></td>
                          <td className="py-0.5"><input type="number" min="0" step="0.01" inputMode="decimal" value={l.selectivo} onChange={(e) => patchLine(emb.id, fac.id, l.id, { selectivo: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLine(emb.id, fac.id); } }} placeholder="0" className="input w-24 text-right tabular-nums" /></td>
                          <td className="py-0.5 text-right text-xs text-ink-500 tabular-nums whitespace-nowrap pr-1 pt-2.5">{byLine[l.id]?.landedUnitCost > 0 ? formatDop(byLine[l.id].landedUnitCost) : '—'}</td>
                          <td className="py-0.5 text-right pr-2.5"><button type="button" onClick={() => delLine(emb.id, fac.id, l.id)} className="btn-icon-danger" title="Eliminar línea" aria-label="Eliminar línea"><Trash2 size={14} /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                  <button type="button" onClick={() => addLine(emb.id, fac.id)} className="btn-ghost text-xs gap-1 mt-1 px-2"><Plus size={12} /> Línea <span className="text-ink-300 normal-case hidden sm:inline">(o Enter en Selectivo)</span></button>
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
          <h4 className="font-display text-sm font-medium text-ink-700">Costos del expediente (agenciamiento, transporte, puerto…)</h4>
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
                <input type="number" step="0.01" min="0" inputMode="decimal" value={c.itbis} onChange={(e) => setCost(c.id, { itbis: e.target.value })} placeholder="ITBIS" className="input w-24 text-right tabular-nums" />
                <select value={c.paymentMethod} onChange={(e) => setCost(c.id, { paymentMethod: e.target.value })} className={`${field} w-full sm:w-auto`}>
                  <option value="bank">Banco</option><option value="credit">Crédito</option><option value="cash">Efectivo</option><option value="card">Tarjeta</option>
                </select>
                <button type="button" onClick={() => removeCost(c.id)} className="btn-icon-danger" title="Eliminar costo" aria-label="Eliminar costo"><Trash2 size={15} /></button>
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
          {newItemCount > 0 && (
            <span className="text-xs text-amber-700 inline-flex items-center gap-1"><Plus size={12} /> {newItemCount} artículo{newItemCount > 1 ? 's' : ''} nuevo{newItemCount > 1 ? 's' : ''} se crear{newItemCount > 1 ? 'án' : 'á'} en inventario</span>
          )}
        </div>
        <button type="button" onClick={save} disabled={saving} className="btn-primary self-start sm:self-auto">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Registrar expediente
        </button>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}
