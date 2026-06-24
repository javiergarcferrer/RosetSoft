import { userMessageFor } from '../../lib/errorMessages.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, Loader2, Check, Trash2, FileText, Receipt } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import BackLink from '../../components/BackLink.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import SearchPicker from '../../components/SearchPicker.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { isoDate, parseISODate } from '../../lib/commissionCycle.js';
import {
  NATURES, NATURE_LABEL, purchaseNature, buildExpenseEntry, buildPurchaseEntry, computeExpenseTaxes,
  resolvePurchaseLines, resolveAccountingConfig, classOf, postableAccounts, weightedAverageIn,
} from '../../core/accounting/index.js';
import { reverseComprasGastoPosting, recomputeItems } from '../../lib/comprasGastosDoc.js';

const blankLine = () => ({ id: newId(), itemId: '', name: '', reference: '', qty: '', cost: '' });
const expOptLabel = (e) => `#${e.number ?? ''}${e.bl ? ` · ${e.bl}` : ''}`.trim();

/** A labeled control in the document grid. */
function Field({ label, hint, children, className = '' }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="text-xs text-ink-500 inline-flex items-center gap-1">{label}{hint}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

/**
 * Compra o gasto — the full-page registration/edit DOCUMENT (mirrors the detail
 * view's language). `/nuevo` creates; `/:id/editar` edits a posted doc. A NATURE
 * toggle (Gasto · Mercancía · Activo fijo) shapes it: a gasto/activo hits a chart
 * account; mercancía captures article LÍNEAS that land in inventory (one kardex
 * IN each). A gasto writes to `expenses`; mercancía/activo to `purchases`; any
 * nature can link to an import expediente. Editing reverses the prior posting and
 * re-posts with the SAME id + number (606/ledger continuity). On save it opens
 * the document. Self-gates on accounting/admin.
 */
export default function ComprasGastoEditor() {
  const { id } = useParams();                  // present ⇒ editing
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const dupId = params.get('duplicate');         // /nuevo?duplicate=<id> ⇒ Duplicar
  const srcId = id || dupId;                      // the doc we edit OR duplicate from
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const suppliersQ = useLiveQueryStatus(() => db.suppliers.where('profileId').equals(scope).toArray(), [scope], []);
  const accountsQ = useLiveQueryStatus(() => db.accounts.where('profileId').equals(scope).toArray(), [scope], []);
  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const expedientesQ = useLiveQueryStatus(() => db.importExpedientes.where('profileId').equals(scope).toArray(), [scope], []);
  const purchaseQ = useLiveQueryStatus(() => (srcId ? db.purchases.get(srcId) : Promise.resolve(null)), [srcId], null);
  const expenseQ = useLiveQueryStatus(() => (srcId ? db.expenses.get(srcId) : Promise.resolve(null)), [srcId], null);
  const loaded = suppliersQ.loaded && accountsQ.loaded && itemsQ.loaded && expedientesQ.loaded && (!srcId || (purchaseQ.loaded && expenseQ.loaded));

  const suppliersById = useMemo(() => new Map(suppliersQ.data.map((s) => [s.id, s])), [suppliersQ.data]);
  const editDoc = useMemo(() => {
    if (!id) return null;
    if (purchaseQ.data) return { source: 'purchase', ...purchaseQ.data, nature: purchaseNature(purchaseQ.data.kind) };
    if (expenseQ.data) return { source: 'expense', ...expenseQ.data, nature: 'gasto' };
    return null;
  }, [id, purchaseQ.data, expenseQ.data]);
  // Duplicar: seed a NEW doc from an existing one (fresh NCF + today's date).
  const seedDoc = useMemo(() => {
    if (id || !dupId) return null;
    if (purchaseQ.data) return { source: 'purchase', ...purchaseQ.data, nature: purchaseNature(purchaseQ.data.kind) };
    if (expenseQ.data) return { source: 'expense', ...expenseQ.data, nature: 'gasto' };
    return null;
  }, [id, dupId, purchaseQ.data, expenseQ.data]);

  const initialNature = NATURES.some((n) => n.key === params.get('tipo')) ? params.get('tipo') : 'gasto';
  const initial = { description: params.get('desc') || '', base: params.get('amount') || '', itbis: params.get('itbis') ?? '' };
  const backTo = id ? `/accounting/compras-gastos/${id}` : '/accounting/compras-gastos';
  const title = id
    ? (editDoc ? `Editar ${NATURE_LABEL[editDoc.nature]?.toLowerCase() || 'documento'}${editDoc.number != null ? ` #${editDoc.number}` : ''}` : 'Editar')
    : (seedDoc ? 'Duplicar compra o gasto' : 'Nueva compra o gasto');

  return (
    <AccountingGate title="Compras y gastos">
      <BackLink to={backTo}>{id ? 'Volver al documento' : 'Volver a compras y gastos'}</BackLink>
      <PageHeader title={title} subtitle="Factura de proveedor — se asienta sola y alimenta el 606" />
      {!loaded ? <ListLoading /> : (id && !editDoc) ? (
        <EmptyState icon={Receipt} title="Documento no encontrado" description="Puede haber sido eliminado o registrado en otro perfil." />
      ) : (
        <DocForm
          key={editDoc?.id || (seedDoc ? `dup-${seedDoc.id}` : 'new')}
          scope={scope} config={config} suppliers={suppliersQ.data} suppliersById={suppliersById}
          accounts={accountsQ.data} items={itemsQ.data} expedientes={expedientesQ.data}
          initialNature={initialNature} initial={initial} editDoc={editDoc} seedDoc={seedDoc}
          onSaved={(savedId) => navigate(`/accounting/compras-gastos/${savedId}`)}
          onCancel={() => navigate(backTo)}
        />
      )}
    </AccountingGate>
  );
}

function DocForm({ scope, config, suppliers, suppliersById, accounts, items, expedientes, initialNature, initial, editDoc, seedDoc, onSaved, onCancel }) {
  // Prefill source: editDoc (edit in place) OR seedDoc (Duplicar — a NEW doc
  // pre-filled from an existing one, with a fresh NCF + today's date).
  const pf = editDoc || seedDoc;
  const [form, setForm] = useState(() => (pf ? {
    nature: pf.nature, supplierId: pf.supplierId || '',
    date: editDoc ? isoDate(editDoc.source === 'purchase' ? editDoc.purchaseAt : editDoc.expenseAt) : isoDate(Date.now()),
    ncf: editDoc?.ncf || '', ncfType: editDoc?.ncfType || '',
    accountCode: pf.accountCode || '', expedienteId: pf.expedienteId || '',
    description: pf.description || '',
    base: pf.nature === 'mercancia' ? '' : String(pf.base ?? ''),
    itbis: String(pf.itbis ?? ''), retIsr: String(pf.retentionIsr ?? ''),
    retItbis: String(pf.retentionItbis ?? ''), paymentMethod: pf.paymentMethod || 'bank',
  } : {
    nature: initialNature || 'gasto', supplierId: '', date: isoDate(Date.now()), ncf: '', ncfType: '',
    accountCode: '', expedienteId: '', description: initial?.description || '',
    base: initial?.base || '', itbis: initial?.itbis ?? '', retIsr: '', retItbis: '', paymentMethod: 'bank',
  }));
  const [lines, setLines] = useState(() => (pf?.nature === 'mercancia' && pf.lines?.length
    ? pf.lines.map((l) => ({ id: newId(), itemId: l.itemId || '', name: l.name || '', reference: l.reference || '', qty: String(l.qty ?? ''), cost: String(l.cost ?? '') }))
    : [blankLine()]));
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
  // whenever the líneas/supplier move. On an EDIT keep the stored taxes on first
  // render — only recompute once the user actually changes the líneas/supplier.
  const skipFirstTaxCalc = useRef(!!(editDoc || seedDoc));
  useEffect(() => {
    if (!goods) return;
    if (skipFirstTaxCalc.current) { skipFirstTaxCalc.current = false; return; }
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
      const id = editDoc ? editDoc.id : newId();
      const postedAt = parseISODate(form.date);
      const expedienteId = form.expedienteId || null;
      const common = {
        supplierId: form.supplierId || null, base, itbis,
        retentionIsr: retIsr, retentionItbis: retItbis, paymentMethod: form.paymentMethod, ncf: form.ncf,
      };

      // Editar = reverse the prior posting (asiento + kardex), then re-post with
      // the SAME document id + number so the 606 and the ledger keep continuity.
      let priorTouched = [];
      if (editDoc) {
        const r = await reverseComprasGastoPosting({ id, source: editDoc.source, journalEntryId: editDoc.journalEntryId, keepOrphanItems: true });
        priorTouched = r.touched;
      }

      if (nature === 'gasto') {
        const built = buildExpenseEntry({
          newId, config, postedAt,
          expense: { id, ...common, accountCode: form.accountCode, description: form.description },
        });
        await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
        await db.journalLines.bulkPut(built.lines);
        const row = {
          id, profileId: scope, supplierId: form.supplierId || null, expenseAt: postedAt,
          ncf: form.ncf, ncfType: form.ncfType, accountCode: form.accountCode, description: form.description,
          expedienteId, base, itbis, itbisCreditable: true, retentionIsr: retIsr, retentionItbis: retItbis,
          paymentMethod: form.paymentMethod, paidAt: form.paymentMethod === 'credit' ? null : postedAt,
          journalEntryId: built.entry.id,
        };
        if (editDoc) await db.expenses.put({ ...row, number: editDoc.number });
        else await assignSequenceNumber({ table: 'expenses', profileId: scope, start: 1, build: (n) => ({ ...row, number: n }) });
        onSaved(id);
        return;
      }

      // mercancía / activo → purchases
      const kind = goods ? 'goods' : 'asset';
      // For a goods EDIT, read items AFTER the reverse so the costing is correct.
      const baseItems = (editDoc && goods)
        ? await db.inventoryItems.where('profileId').equals(scope).toArray()
        : items;
      let storedLines = [];
      let itemById = new Map(baseItems.map((i) => [i.id, i]));
      if (goods) {
        const newItems = [];
        const variantKey = (sku, name) => JSON.stringify([(sku || '').trim(), (name || '').trim()]);
        const idByVariant = new Map(baseItems.map((i) => [variantKey(i.sku, i.name), i.id]));
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
        itemById = new Map([...baseItems, ...newItems].map((i) => [i.id, i]));
      }

      const built = buildPurchaseEntry({
        newId, config, postedAt,
        purchase: { id, ...common, kind, accountCode: goods ? null : form.accountCode, memo: form.description },
      });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      const prow = {
        id, profileId: scope, supplierId: form.supplierId || null, purchaseAt: postedAt,
        ncf: form.ncf, ncfType: '', kind, accountCode: goods ? null : form.accountCode, description: form.description,
        itemId: null, qty: goods ? lineRes.qty : 0, lines: storedLines, expedienteId,
        base, itbis, itbisCreditable: true, retentionIsr: retIsr, retentionItbis: retItbis,
        paymentMethod: form.paymentMethod, paidAt: form.paymentMethod === 'credit' ? null : postedAt,
        journalEntryId: built.entry.id,
      };
      if (editDoc) await db.purchases.put({ ...prow, number: editDoc.number });
      else await assignSequenceNumber({ table: 'purchases', profileId: scope, start: 1, build: (n) => ({ ...prow, number: n }) });

      if (goods) {
        for (const l of storedLines) {
          const unitCost = l.qty > 0 ? Math.round((l.cost / l.qty) * 10000) / 10000 : 0;
          if (!l.itemId || l.qty <= 0 || unitCost <= 0) continue;
          await db.inventoryMovements.put({
            id: newId(), profileId: scope, itemId: l.itemId, type: 'in', qty: l.qty, unitCost,
            movedAt: postedAt, refTable: 'purchases', refId: id, journalEntryId: built.entry.id,
          });
          if (!editDoc) {
            // Create: a new purchase is chronologically last → incremental avg.
            const it = itemById.get(l.itemId);
            if (it) {
              const newAvg = weightedAverageIn(it.qtyOnHand || 0, it.avgCost || 0, l.qty, unitCost);
              const newQty = (it.qtyOnHand || 0) + l.qty;
              await db.inventoryItems.update(l.itemId, { qtyOnHand: newQty, avgCost: newAvg });
              itemById.set(l.itemId, { ...it, qtyOnHand: newQty, avgCost: newAvg });
            }
          }
        }
        // Edit: the edited doc may not be chronologically last → recompute every
        // touched item (prior + new) from ALL its movements.
        if (editDoc) await recomputeItems([...priorTouched, ...storedLines.map((l) => l.itemId)]);
      }
      onSaved(id);
    } catch (e) {
      setErr(userMessageFor(e));
      setSaving(false);
    }
  }

  const field = 'input w-full';
  const numField = 'input w-full text-right tabular-nums';
  const itbisN = Number(form.itbis) || 0;
  const retIsrN = Number(form.retIsr) || 0;
  const retItbisN = Number(form.retItbis) || 0;
  const total = base + itbisN;
  const net = total - retIsrN - retItbisN;

  return (
    <div className="card overflow-hidden min-w-0">
      {/* Nature toggle + live total */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-4 border-b border-ink-100 bg-ink-50/40">
        <div className="inline-flex rounded-lg border border-ink-200 p-0.5 bg-surface">
          {NATURES.map((n) => (
            <button key={n.key} type="button" onClick={() => setNature(n.key)} disabled={!!editDoc}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors disabled:opacity-50 ${nature === n.key ? 'bg-ink-900 text-white font-medium' : 'text-ink-500 hover:text-ink-700'}`}>
              {n.label}
            </button>
          ))}
        </div>
        <div className="text-right">
          <div className="eyebrow-xs text-ink-400">Total</div>
          <div className="font-display text-xl font-semibold tabular-nums text-ink-900">{formatDop(total)}</div>
        </div>
      </div>

      {/* Document fields */}
      <div className="px-4 sm:px-6 py-5 grid sm:grid-cols-2 gap-x-10 gap-y-4">
        <div className="space-y-4 min-w-0">
          <Field label="Proveedor">
            <select value={form.supplierId} onChange={(e) => onSupplier(e.target.value)} className={field}>
              <option value="">— Proveedor —</option>
              {suppliers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          {!goods && (
            <Field label={nature === 'activo' ? 'Cuenta de activo' : 'Cuenta de gasto'}>
              <select value={form.accountCode} onChange={(e) => setForm((f) => ({ ...f, accountCode: e.target.value }))} className={field}>
                <option value="">— Elegir cuenta —</option>
                {accountOpts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="No. de comprobante (NCF)">
            <input value={form.ncf} onChange={(e) => setForm((f) => ({ ...f, ncf: e.target.value }))} placeholder="NCF" className={`${field} tabular-nums`} />
          </Field>
          <Field label="Descripción">
            <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder={goods ? 'Referencia de la factura' : 'Descripción'} className={field} />
          </Field>
        </div>
        <div className="space-y-4 min-w-0">
          <Field label="Fecha">
            <input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className={field} />
          </Field>
          <Field label="Forma de pago">
            <select value={form.paymentMethod} onChange={(e) => setForm((f) => ({ ...f, paymentMethod: e.target.value }))} className={field}>
              <option value="bank">Banco</option><option value="cash">Efectivo</option><option value="card">Tarjeta</option><option value="credit">Crédito</option>
            </select>
          </Field>
          {expedienteOpts.length > 0 && (
            <Field label="Expediente de importación" hint={<FileText size={12} className="text-ink-400" />}>
              <select value={form.expedienteId} onChange={(e) => setForm((f) => ({ ...f, expedienteId: e.target.value }))} className={field}>
                <option value="">— Sin enlazar (opcional) —</option>
                {expedienteOpts.map((e) => <option key={e.id} value={e.id}>{expOptLabel(e) || e.id}{e.liquidatedAt ? ` · ${formatDate(e.liquidatedAt)}` : ''}{e.status === 'draft' ? ' · borrador' : ''}</option>)}
              </select>
            </Field>
          )}
        </div>
      </div>

      {/* Mercancía: article líneas → inventory (one kardex IN each) */}
      {goods && (
        <div className="px-4 sm:px-6 pb-4 border-t border-ink-100 pt-4">
          <h4 className="font-display text-sm font-medium text-ink-700 mb-2">Líneas de la factura</h4>
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

      {/* Impuestos + totales */}
      <div className="px-4 sm:px-6 py-5 border-t border-ink-100 grid gap-6 sm:grid-cols-2">
        <div>
          <h4 className="font-display text-sm font-medium text-ink-700 mb-2">Impuestos y retenciones</h4>
          <div className="grid grid-cols-2 gap-3 max-w-sm">
            <Field label="Base">
              {goods
                ? <input type="number" value={lineRes.base} readOnly tabIndex={-1} className={`${numField} bg-ink-50 text-ink-500`} />
                : <input type="number" step="0.01" min="0" inputMode="decimal" value={form.base} onChange={(e) => onBase(e.target.value)} className={numField} />}
            </Field>
            <Field label="ITBIS"><input type="number" step="0.01" min="0" inputMode="decimal" value={form.itbis} onChange={(e) => setForm((f) => ({ ...f, itbis: e.target.value }))} className={numField} /></Field>
            <Field label="Ret. ISR"><input type="number" step="0.01" min="0" inputMode="decimal" value={form.retIsr} onChange={(e) => setForm((f) => ({ ...f, retIsr: e.target.value }))} className={numField} /></Field>
            <Field label="Ret. ITBIS"><input type="number" step="0.01" min="0" inputMode="decimal" value={form.retItbis} onChange={(e) => setForm((f) => ({ ...f, retItbis: e.target.value }))} className={numField} /></Field>
          </div>
        </div>
        <div className="sm:justify-self-end w-full sm:max-w-xs space-y-1.5 text-sm self-start">
          <div className="flex justify-between gap-4"><span className="text-ink-500">Subtotal</span><span className="tabular-nums">{formatDop(base)}</span></div>
          <div className="flex justify-between gap-4"><span className="text-ink-500">ITBIS</span><span className="tabular-nums">{formatDop(itbisN)}</span></div>
          {(retIsrN > 0 || retItbisN > 0) && (
            <div className="flex justify-between gap-4"><span className="text-ink-500">Retenciones</span><span className="tabular-nums text-rose-600">−{formatDop(retIsrN + retItbisN)}</span></div>
          )}
          <div className="flex justify-between gap-4 pt-1.5 border-t border-ink-100 font-semibold text-ink-900"><span>Total</span><span className="tabular-nums">{formatDop(total)}</span></div>
          <div className="flex justify-between gap-4 text-ink-500"><span>Neto a pagar</span><span className="tabular-nums">{formatDop(net)}</span></div>
        </div>
      </div>

      {/* Action bar */}
      <div className="px-4 sm:px-6 py-3 border-t border-ink-100 bg-ink-50/40 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-ink-500">
          {goods && newItemCount > 0
            ? <span className="text-amber-700 inline-flex items-center gap-1"><Plus size={12} /> {newItemCount} artículo{newItemCount > 1 ? 's' : ''} nuevo{newItemCount > 1 ? 's' : ''} se crear{newItemCount > 1 ? 'án' : 'á'} en inventario</span>
            : editDoc ? 'Al guardar se revierte el asiento anterior y se re-asienta.' : 'Al registrar se asienta sola y entra al 606.'}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onCancel} disabled={saving} className="btn-secondary">Cancelar</button>
          <button type="button" onClick={save} disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {editDoc ? 'Guardar cambios' : 'Registrar'}
          </button>
        </div>
      </div>
      {err && <p className="text-sm text-rose-600 px-4 sm:px-6 pb-3">{err}</p>}
    </div>
  );
}
