import { userMessageFor } from '../../lib/errorMessages.js';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, Loader2, Check, Trash2, FileText, Receipt, Search } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import { useSetBreadcrumb } from '../../context/Breadcrumbs.jsx';
import BackLink from '../../components/BackLink.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import SearchPicker from '../../components/SearchPicker.jsx';
import { FieldRow as Field } from '../../components/accounting/FormFields.jsx';
import LineItemsEditor from '../../components/accounting/LineItemsEditor.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { isoDate, parseISODate } from '../../lib/commissionCycle.js';
import { lookupRnc, cleanRnc, isValidRncOrCedula } from '../../lib/rncLookup.js';
import {
  NATURES, NATURE_LABEL, purchaseNature, buildExpenseEntry, buildPurchaseEntry, computeExpenseTaxes,
  resolvePurchaseLines, resolveAccountingConfig, classOf, postableAccounts, weightedAverageIn,
  resolveBillLines, buildBillEntry, taxPresetById, tipo606For, DGII_606_TIPO_LABEL,
} from '../../core/accounting/index.js';
import { reverseComprasGastoPosting, recomputeItems } from '../../lib/comprasGastosDoc.js';

// A mercancía line is a full DGII factura line: artículo · cant. · costo unit. ·
// descuento · ITBIS. A new row defaults to ITBIS 18% (the common case for goods).
const blankLine = () => ({ id: newId(), itemId: '', name: '', reference: '', qty: '', unitCost: '', discount: '', taxIds: ['itbis18'] });
const expOptLabel = (e) => `#${e.number ?? ''}${e.bl ? ` · ${e.bl}` : ''}`.trim();

// "Por líneas" = the Odoo-style bill where each row hits its own account with its
// own taxes (vs the single-account natures). A new row defaults to qty 1 + ITBIS 18%.
const blankBillLine = () => ({ id: newId(), description: '', accountCode: '', qty: '1', unitPrice: '', discount: '', taxIds: ['itbis18'] });
const ITBIS_OPTS = [{ id: 'itbis18', label: 'ITBIS 18%' }, { id: 'itbis16', label: 'ITBIS 16%' }, { id: 'exento', label: 'Exento' }];
// The nature segmented control: the three single-account natures + "Por líneas".
const NATURE_TABS = [...NATURES, { key: 'lineas', label: 'Por líneas' }];
const RET_OPTS = [
  { id: '', label: 'Sin retención' },
  { id: 'retItbis30', label: 'Ret. ITBIS 30%' }, { id: 'retItbis100', label: 'Ret. ITBIS 100%' },
  { id: 'retIsr10', label: 'Ret. ISR 10%' }, { id: 'retIsr2', label: 'Ret. ISR 2%' }, { id: 'retIsr27', label: 'Ret. ISR 27%' },
];
const isRetKind = (k) => k === 'retIsr' || k === 'retItbis';
// The two per-line selects (ITBIS · Retención) project onto the canonical taxIds array.
const itbisOf = (taxIds) => (taxIds || []).find((id) => taxPresetById(id)?.kind === 'itbis') || '';
const retOf = (taxIds) => (taxIds || []).find((id) => isRetKind(taxPresetById(id)?.kind)) || '';
const joinTax = (itbisId, retId) => [itbisId, retId].filter(Boolean);

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
    if (purchaseQ.data) return { source: 'purchase', ...purchaseQ.data, nature: purchaseQ.data.lineMode ? 'lineas' : purchaseNature(purchaseQ.data.kind) };
    if (expenseQ.data) return { source: 'expense', ...expenseQ.data, nature: 'gasto' };
    return null;
  }, [id, purchaseQ.data, expenseQ.data]);
  // Duplicar: seed a NEW doc from an existing one (fresh NCF + today's date).
  const seedDoc = useMemo(() => {
    if (id || !dupId) return null;
    if (purchaseQ.data) return { source: 'purchase', ...purchaseQ.data, nature: purchaseQ.data.lineMode ? 'lineas' : purchaseNature(purchaseQ.data.kind) };
    if (expenseQ.data) return { source: 'expense', ...expenseQ.data, nature: 'gasto' };
    return null;
  }, [id, dupId, purchaseQ.data, expenseQ.data]);

  const initialNature = NATURES.some((n) => n.key === params.get('tipo')) ? params.get('tipo') : 'gasto';
  const initial = { description: params.get('desc') || '', base: params.get('amount') || '', itbis: params.get('itbis') ?? '' };
  const backTo = id ? `/accounting/compras-gastos/${id}` : '/accounting/compras-gastos';
  const title = id
    ? (editDoc ? `Editar ${NATURE_LABEL[editDoc.nature]?.toLowerCase() || 'documento'}${editDoc.number != null ? ` #${editDoc.number}` : ''}` : 'Editar')
    : (seedDoc ? 'Duplicar compra o gasto' : 'Nueva compra o gasto');
  useSetBreadcrumb(title);

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
    description: pf.description || '', tipo606: pf.tipo606 || '',
    base: pf.nature === 'mercancia' ? '' : String(pf.base ?? ''),
    itbis: String(pf.itbis ?? ''), retIsr: String(pf.retentionIsr ?? ''),
    retItbis: String(pf.retentionItbis ?? ''), paymentMethod: pf.paymentMethod || 'bank',
  } : {
    nature: initialNature || 'gasto', supplierId: '', date: isoDate(Date.now()), ncf: '', ncfType: '',
    accountCode: '', expedienteId: '', description: initial?.description || '', tipo606: '',
    base: initial?.base || '', itbis: initial?.itbis ?? '', retIsr: '', retItbis: '', paymentMethod: 'bank',
  }));
  const [lines, setLines] = useState(() => {
    if (!(pf?.nature === 'mercancia' && pf.lines?.length)) return [blankLine()];
    // Older docs stored only a net `cost`; rehydrate the unit cost from it and
    // default the per-line ITBIS to match whether the doc carried any (so a
    // re-save doesn't silently add/drop tax). New docs carry the fields directly.
    const fallbackTax = (Number(pf?.itbis) || 0) > 0 ? ['itbis18'] : ['exento'];
    return pf.lines.map((l) => {
      const qty = Number(l.qty) || 0;
      // Reconstruct the GROSS unit cost (cost is NET = gross − discount) when the
      // doc didn't store the entered unit; new docs store `unitCost` directly.
      const unitCost = l.unitCost != null
        ? l.unitCost
        : (qty > 0 ? ((Number(l.cost) || 0) + (Number(l.discount) || 0)) / qty : '');
      return {
        id: newId(), itemId: l.itemId || '', name: l.name || '', reference: l.reference || '',
        qty: String(l.qty ?? ''), unitCost: String(unitCost ?? ''), discount: String(l.discount ?? ''),
        taxIds: Array.isArray(l.taxIds) && l.taxIds.length ? l.taxIds : fallbackTax,
      };
    });
  });
  const [billLines, setBillLines] = useState(() => (pf?.lineMode && pf.lines?.length
    ? pf.lines.map((l) => ({ id: newId(), description: l.description || '', accountCode: l.accountCode || '', qty: String(l.qty ?? ''), unitPrice: String(l.unitPrice ?? ''), discount: String(l.discount ?? ''), taxIds: Array.isArray(l.taxIds) ? l.taxIds : [] }))
    : [blankBillLine()]));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [rncDraft, setRncDraft] = useState('');
  const [lookingRnc, setLookingRnc] = useState(false);

  const nature = form.nature;
  const goods = nature === 'mercancia';
  const isBill = nature === 'lineas';
  // DGII 606 casilla 3 — defaults to the code derived from the nature/account; the
  // accountant overrides it via the selector. `tipo606 || derived` is what saves.
  const derivedTipo606 = useMemo(() => {
    if (nature === 'gasto') return tipo606For({ accountCode: form.accountCode }, 'expense');
    const kind = nature === 'mercancia' ? 'goods' : nature === 'activo' ? 'asset' : 'service';
    return tipo606For({ kind }, 'purchase');
  }, [nature, form.accountCode]);
  const tipo606 = form.tipo606 || derivedTipo606;
  // A compra's supplier RNC drives the 606 — surface an inline RNC field when the
  // selected proveedor (often just created) has none yet.
  const selectedSupplier = suppliersById.get(form.supplierId) || null;
  useEffect(() => { setRncDraft(''); }, [form.supplierId]);

  const accountOpts = useMemo(() => {
    const cls = nature === 'activo' ? 1 : 6;
    return postableAccounts(accounts).filter((a) => classOf(a.code) === cls).sort((a, b) => a.code.localeCompare(b.code));
  }, [accounts, nature]);
  const itemOptions = useMemo(
    () => items.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((i) => ({ id: i.id, label: i.name, sublabel: i.sku || '' })),
    [items],
  );
  // A bill line may hit any debitable destination: activo (1), costo (5) or gasto (6).
  const billAccountOpts = useMemo(
    () => postableAccounts(accounts).filter((a) => [1, 5, 6].includes(classOf(a.code))).sort((a, b) => a.code.localeCompare(b.code)),
    [accounts],
  );
  const expedienteOpts = useMemo(() => expedientes.slice().sort((a, b) => (b.liquidatedAt || 0) - (a.liquidatedAt || 0)), [expedientes]);

  const lineRes = useMemo(() => resolvePurchaseLines(lines), [lines]);
  const billRes = useMemo(() => resolveBillLines(billLines), [billLines]);
  const base = goods ? lineRes.base : isBill ? billRes.totals.base : (Number(form.base) || 0);

  // Gasto/activo derive their suggested ITBIS + retentions from the single base.
  // Mercancía and Por líneas carry tax PER LINE instead (Σ líneas → totals), so
  // they don't touch these header fields.
  function recompute(amount, supplier) {
    const t = computeExpenseTaxes({ base: Number(amount) || 0, retainIsr: !!supplier?.retainIsr, retainItbis: !!supplier?.retainItbis, config });
    return { itbis: String(t.itbis), retIsr: String(t.retIsr), retItbis: String(t.retItbis) };
  }

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
  // Create a proveedor inline (from the picker's free text) so a new vendor can
  // be added without leaving the registro — the RNC/details are completed later
  // in Proveedores. Selects it immediately.
  async function createSupplier(name) {
    const clean = (name || '').trim();
    if (!clean) return;
    try {
      const id = newId();
      await assignSequenceNumber({
        table: 'suppliers', profileId: scope, start: 1,
        build: (n) => ({ id, profileId: scope, number: n, name: clean }),
      });
      setForm((f) => ({ ...f, supplierId: id }));
    } catch (e) {
      setErr(userMessageFor(e));
    }
  }
  // Persist the RNC (and any looked-up fiscal name) onto the selected supplier —
  // the 606 reads it from there, not from the compra.
  async function saveSupplierRnc(rawRnc, name) {
    const clean = cleanRnc(rawRnc);
    if (!form.supplierId || !isValidRncOrCedula(clean)) return;
    try { await db.suppliers.update(form.supplierId, { rnc: clean, ...(name ? { name } : {}) }); }
    catch (e) { setErr(userMessageFor(e)); }
  }
  async function lookupSupplierRnc() {
    const clean = cleanRnc(rncDraft);
    if (!isValidRncOrCedula(clean)) { setErr('RNC (9 dígitos) o cédula (11) inválido.'); return; }
    setErr(''); setLookingRnc(true);
    try {
      const res = await lookupRnc(clean);
      await saveSupplierRnc(clean, res?.found ? (res.name || '') : '');
    } catch (e) { setErr(userMessageFor(e)); }
    finally { setLookingRnc(false); }
  }

  const addLine = () => setLines((ls) => [...ls, blankLine()]);
  const patchLine = (id, patch) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const delLine = (id) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.id !== id) : ls.map((l) => (l.id === id ? blankLine() : l))));
  // A mercancía line carries a single ITBIS preset (goods don't take retentions).
  const setMercItbis = (l, itbisId) => patchLine(l.id, { taxIds: itbisId ? [itbisId] : [] });
  const lineById = useMemo(() => new Map(lineRes.lines.map((l) => [l.id, l])), [lineRes]);

  const addBillLine = () => setBillLines((ls) => [...ls, blankBillLine()]);
  const patchBillLine = (id, patch) => setBillLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const delBillLine = (id) => setBillLines((ls) => (ls.length > 1 ? ls.filter((l) => l.id !== id) : ls.map((l) => (l.id === id ? blankBillLine() : l))));
  const setLineItbis = (l, itbisId) => patchBillLine(l.id, { taxIds: joinTax(itbisId, retOf(l.taxIds)) });
  const setLineRet = (l, retId) => patchBillLine(l.id, { taxIds: joinTax(itbisOf(l.taxIds), retId) });

  const newItemCount = useMemo(() => lineRes.lines.filter((l) => !l.itemId && l.name && l.qty > 0).length, [lineRes]);

  async function save() {
    setErr('');
    // Mercancía drives its ITBIS from the líneas (no header tax / retentions);
    // gasto/activo read the header fields.
    const itbis = goods ? lineRes.itbis : Number(form.itbis) || 0;
    const retIsr = goods ? 0 : Number(form.retIsr) || 0;
    const retItbis = goods ? 0 : Number(form.retItbis) || 0;
    if (isBill) {
      const bl = billRes.lines;
      if (bl.length === 0) { setErr('Agrega al menos una línea con cuenta y monto.'); return; }
      if (bl.some((l) => !l.accountCode)) { setErr('Cada línea necesita una cuenta.'); return; }
      if (bl.some((l) => !(l.base > 0))) { setErr('Cada línea necesita cantidad y precio mayores que cero.'); return; }
    } else if (goods) {
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

      // Por líneas → a multi-account purchase: each line debits its own account
      // with its own taxes (buildBillEntry), stored with lineMode + rich lines so
      // an edit rehydrates the grid and the 606 reads the rolled-up totals.
      if (isBill) {
        const t = billRes.totals;
        const built = buildBillEntry({
          newId, config, postedAt,
          bill: {
            id, supplierId: form.supplierId || null,
            lines: billRes.lines.map((l) => ({ accountCode: l.accountCode, base: l.base, itbis: l.itbis, retIsr: l.retIsr, retItbis: l.retItbis })),
            paymentMethod: form.paymentMethod, ncf: form.ncf, memo: form.description, source: 'purchase', refTable: 'purchases',
          },
        });
        await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
        await db.journalLines.bulkPut(built.lines);
        const storedLines = billRes.lines.map((l) => ({
          id: l.id || newId(), description: l.description, accountCode: l.accountCode,
          qty: l.qty, unitPrice: l.unitPrice, discount: l.discount, taxIds: l.taxIds,
          base: l.base, itbis: l.itbis, retIsr: l.retIsr, retItbis: l.retItbis,
        }));
        const prow = {
          id, profileId: scope, supplierId: form.supplierId || null, purchaseAt: postedAt,
          ncf: form.ncf, ncfType: form.ncfType, kind: 'service', lineMode: true, accountCode: null, description: form.description, tipo606,
          itemId: null, qty: 0, lines: storedLines, expedienteId,
          base: t.base, itbis: t.itbis, itbisCreditable: true, retentionIsr: t.retIsr, retentionItbis: t.retItbis,
          paymentMethod: form.paymentMethod, paidAt: form.paymentMethod === 'credit' ? null : postedAt,
          journalEntryId: built.entry.id,
        };
        if (editDoc) await db.purchases.put({ ...prow, number: editDoc.number });
        else await assignSequenceNumber({ table: 'purchases', profileId: scope, start: 1, build: (n) => ({ ...prow, number: n }) });
        onSaved(id);
        return;
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
          ncf: form.ncf, ncfType: form.ncfType, accountCode: form.accountCode, description: form.description, tipo606,
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
          // `cost` is the NET line total (capitalizes + feeds the kardex);
          // unitCost/discount/taxIds/itbis round-trip the factura line on edit.
          const row = {
            id: l.id, itemId: l.itemId, name: l.name, reference: l.reference, qty: l.qty,
            unitCost: l.qty > 0 ? Math.round((l.gross / l.qty) * 10000) / 10000 : 0,
            discount: l.discount, cost: l.cost, taxIds: l.taxIds, itbis: l.itbis,
          };
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
        ncf: form.ncf, ncfType: '', kind, accountCode: goods ? null : form.accountCode, description: form.description, tipo606,
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
  // Mercancía + Por líneas roll their taxes up from the líneas; gasto/activo
  // read the header fields.
  const itbisN = isBill ? billRes.totals.itbis : goods ? lineRes.itbis : Number(form.itbis) || 0;
  const retIsrN = isBill ? billRes.totals.retIsr : goods ? 0 : Number(form.retIsr) || 0;
  const retItbisN = isBill ? billRes.totals.retItbis : goods ? 0 : Number(form.retItbis) || 0;
  const total = base + itbisN;
  const net = total - retIsrN - retItbisN;

  return (
    <div className="card overflow-hidden min-w-0">
      {/* Nature toggle + live total */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-4 border-b border-ink-100 bg-ink-50/40">
        <div className="inline-flex flex-wrap rounded-lg border border-ink-200 p-0.5 bg-surface gap-0.5">
          {NATURE_TABS.map((n) => (
            <button key={n.key} type="button" onClick={() => setNature(n.key)} disabled={!!editDoc}
              title={editDoc ? 'El tipo no se puede cambiar al editar — duplica el documento para registrarlo con otro tipo.' : undefined}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${nature === n.key ? 'bg-ink-900 text-ink-50 font-medium shadow-sm' : 'text-ink-500 hover:text-ink-700 hover:bg-ink-50'}`}>
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
      <div className="px-4 sm:px-6 py-2 grid sm:grid-cols-2 gap-x-4 lg:gap-x-10 gap-y-0">
        <div className="min-w-0">
          <Field label="Proveedor">
            <SearchPicker
              options={suppliers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((s) => ({ id: s.id, label: s.name, sublabel: s.rnc || '' }))}
              value={form.supplierId} text={suppliersById.get(form.supplierId)?.name || ''}
              placeholder="— Proveedor —" freeTextLabel="Crear proveedor" allowFreeText
              onPick={(o) => onSupplier(o.id)}
              onFreeText={(txt) => createSupplier(txt)} />
          </Field>
          {selectedSupplier && !selectedSupplier.rnc && (
            <Field label="RNC / Cédula del proveedor" hint={<span className="text-[11px] text-amber-600">para el 606</span>}>
              <div className="flex gap-2">
                <input value={rncDraft} onChange={(e) => setRncDraft(e.target.value)} onBlur={() => saveSupplierRnc(rncDraft)}
                  placeholder="RNC o cédula" className={`${field} flex-1 tabular-nums min-w-0`} />
                <button type="button" onClick={lookupSupplierRnc} disabled={lookingRnc}
                  className="btn-ghost inline-flex items-center gap-1.5 disabled:opacity-40 whitespace-nowrap flex-shrink-0">
                  {lookingRnc ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Buscar
                </button>
              </div>
            </Field>
          )}
          {!goods && !isBill && (
            <Field label={nature === 'activo' ? 'Cuenta de activo' : 'Cuenta de gasto'}>
              <select value={form.accountCode} onChange={(e) => setForm((f) => ({ ...f, accountCode: e.target.value }))} className={field}>
                <option value="">— Elegir cuenta —</option>
                {accountOpts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Tipo de costos y gastos (606)">
            <select value={tipo606} onChange={(e) => setForm((f) => ({ ...f, tipo606: e.target.value }))} className={field}>
              {Object.entries(DGII_606_TIPO_LABEL).map(([code, label]) => <option key={code} value={code}>{code} · {label}</option>)}
            </select>
          </Field>
          <Field label="No. de comprobante (NCF)">
            <input value={form.ncf} onChange={(e) => setForm((f) => ({ ...f, ncf: e.target.value }))} placeholder="NCF" className={`${field} tabular-nums`} />
          </Field>
          <Field label="Descripción">
            <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder={goods ? 'Referencia de la factura' : 'Descripción'} className={field} />
          </Field>
        </div>
        <div className="min-w-0">
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
          <h4 className="eyebrow-xs text-ink-400 mb-2">Líneas de la factura</h4>
          <LineItemsEditor
            rows={lines} onAdd={addLine} onDelete={(l) => delLine(l.id)}
            addLabel="Agregar línea" addHint="o Enter en Costo unit."
            columns={[
              { key: 'item', header: 'Artículo', headerHint: '(busca o escribe uno nuevo)',
                render: (l) => (
                  <>
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
                  </>
                ) },
              { key: 'qty', header: 'Cant.', align: 'right', width: 'w-20',
                render: (l) => <input type="number" min="0" step="1" inputMode="numeric" value={l.qty} onChange={(e) => patchLine(l.id, { qty: e.target.value })} className="input w-full text-right tabular-nums" /> },
              { key: 'unit', header: 'Costo unit.', align: 'right', width: 'w-28',
                render: (l) => <input type="number" min="0" step="0.01" inputMode="decimal" value={l.unitCost} onChange={(e) => patchLine(l.id, { unitCost: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLine(); } }} className="input w-full text-right tabular-nums" /> },
              { key: 'disc', header: 'Desc. RD$', align: 'right', width: 'w-24',
                render: (l) => <input type="number" min="0" step="0.01" inputMode="decimal" value={l.discount} onChange={(e) => patchLine(l.id, { discount: e.target.value })} placeholder="0" className="input w-full text-right tabular-nums" /> },
              { key: 'itbis', header: 'ITBIS', width: 'w-28',
                render: (l) => <select value={itbisOf(l.taxIds)} onChange={(e) => setMercItbis(l, e.target.value)} className="input w-full">{ITBIS_OPTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select> },
              { key: 'amt', header: 'Importe', align: 'right', width: 'w-28',
                render: (l) => { const sub = lineById.get(l.id)?.cost || 0; return <span className="text-ink-700 tabular-nums">{sub > 0 ? formatDop(sub) : '—'}</span>; } },
            ]}
          />
        </div>
      )}

      {/* Por líneas: each row hits its own account with its own taxes */}
      {isBill && (
        <div className="px-4 sm:px-6 pb-4 border-t border-ink-100 pt-4">
          <h4 className="eyebrow-xs text-ink-400 mb-2">Líneas de la factura</h4>
          <LineItemsEditor
            rows={billLines} onAdd={addBillLine} onDelete={(l) => delBillLine(l.id)}
            addLabel="Agregar línea" addHint="o Enter en P. unit."
            columns={[
              { key: 'desc', header: 'Descripción',
                render: (l) => <input value={l.description} onChange={(e) => patchBillLine(l.id, { description: e.target.value })} placeholder="Concepto" className="input w-full" /> },
              { key: 'acct', header: 'Cuenta',
                render: (l) => (
                  <select value={l.accountCode} onChange={(e) => patchBillLine(l.id, { accountCode: e.target.value })} className="input w-full">
                    <option value="">— Cuenta —</option>
                    {billAccountOpts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                  </select>
                ) },
              { key: 'qty', header: 'Cant.', align: 'right', width: 'w-20',
                render: (l) => <input type="number" min="0" step="1" inputMode="decimal" value={l.qty} onChange={(e) => patchBillLine(l.id, { qty: e.target.value })} className="input w-full text-right tabular-nums" /> },
              { key: 'price', header: 'P. unit.', align: 'right', width: 'w-28',
                render: (l) => <input type="number" min="0" step="0.01" inputMode="decimal" value={l.unitPrice} onChange={(e) => patchBillLine(l.id, { unitPrice: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBillLine(); } }} className="input w-full text-right tabular-nums" /> },
              { key: 'disc', header: 'Desc. RD$', align: 'right', width: 'w-24',
                render: (l) => <input type="number" min="0" step="0.01" inputMode="decimal" value={l.discount} onChange={(e) => patchBillLine(l.id, { discount: e.target.value })} placeholder="0" className="input w-full text-right tabular-nums" /> },
              { key: 'itbis', header: 'ITBIS', width: 'w-28',
                render: (l) => <select value={itbisOf(l.taxIds)} onChange={(e) => setLineItbis(l, e.target.value)} className="input w-full">{ITBIS_OPTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select> },
              { key: 'ret', header: 'Retención', width: 'w-32',
                render: (l) => <select value={retOf(l.taxIds)} onChange={(e) => setLineRet(l, e.target.value)} className="input w-full">{RET_OPTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select> },
              { key: 'amt', header: 'Importe', align: 'right', width: 'w-28',
                render: (l) => { const sub = billRes.lines.find((x) => x.id === l.id)?.base || 0; return <span className="text-ink-700 tabular-nums">{sub > 0 ? formatDop(sub) : '—'}</span>; } },
            ]}
          />
        </div>
      )}

      {/* Impuestos + totales */}
      <div className="px-4 sm:px-6 py-5 border-t border-ink-100 grid gap-6 sm:grid-cols-2">
        {/* Single-account natures (gasto/activo) carry header tax; mercancía and
            Por líneas roll their taxes up from the líneas instead. */}
        {!isBill && !goods && (
        <div>
          <h4 className="eyebrow-xs text-ink-400 mb-2">Impuestos y retenciones</h4>
          <div className="max-w-sm border-t border-ink-100">
            <Field label="Base">
              <input type="number" step="0.01" min="0" inputMode="decimal" value={form.base} onChange={(e) => onBase(e.target.value)} className={numField} />
            </Field>
            <Field label="ITBIS"><input type="number" step="0.01" min="0" inputMode="decimal" value={form.itbis} onChange={(e) => setForm((f) => ({ ...f, itbis: e.target.value }))} className={numField} /></Field>
            <Field label="Ret. ISR"><input type="number" step="0.01" min="0" inputMode="decimal" value={form.retIsr} onChange={(e) => setForm((f) => ({ ...f, retIsr: e.target.value }))} className={numField} /></Field>
            <Field label="Ret. ITBIS"><input type="number" step="0.01" min="0" inputMode="decimal" value={form.retItbis} onChange={(e) => setForm((f) => ({ ...f, retItbis: e.target.value }))} className={numField} /></Field>
          </div>
        </div>
        )}
        <div className="sm:justify-self-end w-full sm:max-w-xs space-y-1.5 text-sm self-start surface-subtle rounded-lg p-3.5">
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
