import { userMessageFor } from '../../lib/errorMessages.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Check, Plus, Trash2, Upload, Ship, Receipt, History, Sparkles, Save, Search, Package, Link2, Unlink, ShoppingCart } from 'lucide-react';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { formatDop, formatDate } from '../../lib/format.js';
import { syncShopify } from '../../lib/shopifySync.js';
import { effectiveDopRate } from '../../lib/exchangeRate.js';
import { parseInvoicePdf } from '../../lib/loadRosetInvoice.js';
import { driveCreateFolder, driveUploadBlob, driveEmptyFolder } from '../../lib/google.js';
import SearchPicker from '../../components/SearchPicker.jsx';
import DriveDocumentsCard from '../../components/drive/DriveDocumentsCard.jsx';
import { groupFamilies, catalogSellingPrice } from '../../lib/catalog.js';
import {
  resolveExpediente, buildExpedienteEntry, weightedAverageIn,
  resolvePurchasesExpenses, NATURE_LABEL,
} from '../../core/accounting/index.js';
import { reverseExpedientePosting, recomputeItems } from '../../lib/comprasGastosDoc.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const blankLine = () => ({ id: newId(), itemId: '', name: '', reference: '', qty: '', fob: '', selectivo: '', fabric: '' });
const blankFactura = () => ({ id: newId(), supplierId: '', invoiceRef: '', ncf: '', lines: [blankLine()] });
const blankEmbarque = () => ({ id: newId(), bl: '', containerId: '', customsRef: '', flete: '', seguro: '', facturas: [blankFactura()] });

const field = 'input';
const num = 'input w-28 text-right tabular-nums';

const draftKey = (scope) => `rosetsoft.importacionDraft.${scope}`;
// A brand-new draft's Drive folder id, parked here so it survives a reload and is
// recycled (emptied + reused) across discarded drafts instead of orphaning.
const draftFolderKey = (scope) => `rosetsoft.importacionDraftFolder.${scope}`;
export const TEMPLATE_KEY = (scope) => `rosetsoft.importacionTemplate.${scope}`;

/** Seed the form from an EXISTING draft expediente being resumed (Editar). Its
 *  embarques/costs are already in the form's shape (toModel stored them that
 *  way), so they load straight back in. */
function seedFromExisting(e, defaults) {
  return {
    kind: 'existing',
    head: {
      date: e.liquidatedAt ? new Date(e.liquidatedAt).toISOString().slice(0, 10) : defaults.date,
      orderId: e.orderId || '',
      paymentMethod: e.paymentMethod || 'bank',
      rate: e.rate != null && e.rate !== '' ? String(e.rate) : defaults.rate,
      duaTotal: '',
    },
    embs: (e.embarques?.length ? e.embarques : null),
    costs: e.costs || null,
  };
}

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
export default function ExpedienteForm({ scope, config, settings, suppliers, items, orders, containers, products, materials, expenses = [], purchases = [], accounts = [], existing = null }) {
  const navigate = useNavigate();
  // Invoice PDFs the user imported, kept to upload into the expediente's Drive
  // folder on save (keyed by factura id so a re-import replaces). Drive archival
  // needs a connected Google account.
  const facturaFilesRef = useRef(new Map());
  const driveReady = !!settings?.googleConnectedAt;
  // Catalog families (by SKU root) → the list price an imported piece is sold at.
  // A newly-minted inventory item is priced from the catalog, by reference +
  // the fabric (grade) it shipped in; cost still comes from the landed liquidation.
  const families = useMemo(() => new Map(groupFamilies(products || []).map((f) => [f.root, f])), [products]);
  const defaults = useMemo(() => ({
    date: new Date().toISOString().slice(0, 10), orderId: '', paymentMethod: 'bank',
    rate: String(effectiveDopRate(settings) || ''), duaTotal: '',
  }), [settings]);
  const seedRef = useRef(null);
  if (seedRef.current == null) seedRef.current = existing ? seedFromExisting(existing, defaults) : readSeed(scope, defaults);
  const seed = seedRef.current;

  const [head, setHead] = useState({ ...defaults, ...(seed.head || {}) });
  const [embs, setEmbs] = useState(seed.embs?.length ? seed.embs : [blankEmbarque()]);
  const [costs, setCosts] = useState(seed.costs?.length ? seed.costs : []);
  const [seededFrom, setSeededFrom] = useState(seed.kind);
  const [parsing, setParsing] = useState('');
  const [pdfNote, setPdfNote] = useState(null); // { fid, count, matched, toCreate, importedUsd, invoiceTotal }
  const [lineQuery, setLineQuery] = useState(''); // product search across the whole expediente
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // ── Drive folder lifecycle ──────────────────────────────────────────────
  // A NEW draft's documents folder is created lazily on the first attachment and
  // parked in localStorage so it survives a reload AND is recycled if the draft
  // is discarded ("Empezar en blanco" empties it but keeps its id) — abandoned
  // drafts never pile up folders in Drive. An EXISTING expediente already owns
  // its folder on the row, so attachments persist straight onto it.
  const [driveFolder, setDriveFolder] = useState(() => {
    if (existing) return existing.driveFolderId ? { id: existing.driveFolderId, url: existing.driveFolderUrl || '' } : null;
    try { const raw = localStorage.getItem(draftFolderKey(scope)); return raw ? JSON.parse(raw) : null; } catch { return null; }
  });
  const handleFolderSaved = ({ id, url }) => {
    const f = { id, url: url || '' };
    setDriveFolder(f);
    if (existing) db.importExpedientes.update(existing.id, { driveFolderId: id, driveFolderUrl: url || '' }).catch(() => { /* persists on save too */ });
    else { try { localStorage.setItem(draftFolderKey(scope), JSON.stringify(f)); } catch { /* quota — best-effort */ } }
  };
  /** Clear both the autosaved form draft and the parked folder id (a SAVED
   *  expediente owns its folder now, so it must no longer be a free placeholder). */
  const clearDraftStorage = () => {
    try { localStorage.removeItem(draftKey(scope)); localStorage.removeItem(draftFolderKey(scope)); } catch { /* best-effort */ }
  };
  // Bumped on "Empezar en blanco" to remount the documents card so it re-lists
  // the recycled folder once it's been emptied (its id stays the same, so the
  // card wouldn't otherwise refetch).
  const [docsNonce, setDocsNonce] = useState(0);

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
    if (existing) return undefined; // editing a saved draft — don't touch the local "new" autosave
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
    // Recycle a brand-new draft's Drive folder: empty its contents but KEEP its
    // id (in state + draftFolderKey) so the fresh draft reuses the now-empty
    // folder instead of orphaning it. An existing expediente's folder is never
    // touched — it's a posted/owned file, not a recyclable placeholder.
    if (!existing && driveFolder?.id) {
      driveEmptyFolder(driveFolder.id).catch(() => { /* best-effort */ }).finally(() => setDocsNonce((n) => n + 1));
    }
    facturaFilesRef.current.clear();
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
      // Import EVERY article line — seats, tables, vases, lamps, rugs, cushions,
      // modular parts — not just the furniture subset (an expo-floor invoice is
      // ~⅔ accessories, so furniture-only dropped most of the order).
      const seeded = parsed.lines.map((l) => {
        const match = items.find((i) => (i.sku || '').trim().startsWith(l.reference));
        return {
          id: newId(), itemId: match?.id || '', name: match?.name || l.description, reference: l.reference,
          qty: l.quantity, fob: rate > 0 ? r2(l.unitCostUsd * l.quantity * rate) : '', selectivo: '',
          fabric: l.fabric || '', // the material → its grade → the catalog price on save
        };
      });
      if (!seeded.length) { setErr('No se encontraron líneas de productos en el PDF.'); return; }
      // Re-importing REPLACES the factura's lines (redo, not pile on top).
      mapLines(eid, fid, () => seeded);
      // Keep the PDF to archive into the expediente's Drive folder on save. If
      // we're editing a draft that already has a folder, upload it now.
      facturaFilesRef.current.set(fid, file);
      if (driveReady && existing?.driveFolderId) {
        driveUploadBlob({ folderId: existing.driveFolderId, filename: file.name, blob: file })
          .then(() => facturaFilesRef.current.delete(fid))
          .catch(() => { /* will retry on save */ });
      }
      const matched = seeded.filter((l) => l.itemId).length;
      // Veracity: Σ(qty × unit cost) over every imported line vs the invoice's
      // own grand total ("Importe …") — proves no line was dropped.
      const importedUsd = r2(parsed.lines.reduce((s, l) => s + l.unitCostUsd * l.quantity, 0));
      setPdfNote({ fid, count: seeded.length, matched, toCreate: seeded.length - matched, importedUsd, invoiceTotal: r2(parsed.invoiceTotal) });
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
  const dua = Number(head.duaTotal) || 0;
  const duaDiff = r2(dua - t.impuestos);
  const newItemCount = useMemo(
    () => embs.reduce((s, e) => s + e.facturas.reduce((a, f) => a + f.lines.filter((l) => !l.itemId && (l.name || '').trim() && Number(l.qty) > 0).length, 0), 0),
    [embs],
  );

  // ── line counter + product search (verify the PDF import is complete) ──────
  // Flatten every real product line across embarques/facturas with enough
  // context to point the user at it (which embarque/factura it lives in).
  const allLines = useMemo(() => embs.flatMap((e, ei) => e.facturas.flatMap((f, fi) => f.lines
    .filter((l) => (l.name || '').trim() || l.fob !== '' || Number(l.qty) > 0)
    .map((l) => ({ ...l, embIndex: ei + 1, facIndex: fi + 1 })))), [embs]);
  const lineSummary = useMemo(() => allLines.reduce(
    (s, l) => ({ count: s.count + 1, qty: s.qty + (Number(l.qty) || 0), fob: s.fob + (Number(l.fob) || 0) }),
    { count: 0, qty: 0, fob: 0 },
  ), [allLines]);
  const lineMatches = useMemo(() => {
    const q = lineQuery.trim().toLowerCase();
    if (!q) return [];
    return allLines.filter((l) => `${l.name || ''} ${l.reference || ''}`.toLowerCase().includes(q));
  }, [allLines, lineQuery]);

  // Landing costs are no longer entered here (they're linked gastos/compras
  // below). `costs` is still carried so legacy expedientes keep their books.

  // ── linked gastos & compras (the "pull in costs already registered" flow) ──
  // Costs live ONCE in the compras/gastos registry; the expediente just points
  // at them via expedienteId. Each keeps its own asiento — linking never
  // re-posts, so there's no double count. Only available once the expediente is
  // saved (it needs an id to link against).
  const expedienteId = existing?.id || null;
  const linkedCosts = useMemo(() => {
    if (!expedienteId) return [];
    return resolvePurchasesExpenses({ expenses, purchases, suppliers, accounts, expedientes: existing ? [existing] : [] })
      .rows.filter((r) => r.expedienteId === expedienteId && r.source !== 'expediente-cost');
  }, [expedienteId, expenses, purchases, suppliers, accounts, existing]);
  const linkCandidates = useMemo(() => {
    if (!expedienteId) return [];
    return resolvePurchasesExpenses({ expenses, purchases, suppliers, accounts })
      .rows.filter((r) => !r.expedienteId && (r.source === 'expense' || r.source === 'purchase'));
  }, [expedienteId, expenses, purchases, suppliers, accounts]);
  const linkedCostsTotal = useMemo(() => linkedCosts.reduce((s, r) => s + (r.total || 0), 0), [linkedCosts]);
  const tableFor = (source) => (source === 'purchase' ? 'purchases' : 'expenses');
  async function linkDoc(source, docId) {
    if (!expedienteId || !docId) return;
    try { await db[tableFor(source)].update(docId, { expedienteId, updatedAt: Date.now() }); }
    catch (e) { setErr(userMessageFor(e)); }
  }
  async function unlinkDoc(source, docId) {
    try { await db[tableFor(source)].update(docId, { expedienteId: null, updatedAt: Date.now() }); }
    catch (e) { setErr(userMessageFor(e)); }
  }
  const goRegisterCost = (tipo) => {
    if (!expedienteId) return;
    navigate(`/accounting/compras-gastos/nuevo?expediente=${expedienteId}&tipo=${tipo}`);
  };

  /** Build the row fields shared by a draft save and a posting. `lines` is the
   *  resolved cascade (flat); `totals` the rolled-up figures. */
  const buildRowFields = (exp, resolved, status, journalEntryId) => ({
    bl: exp.embarques?.[0]?.bl || '', customsRef: exp.embarques?.[0]?.customsRef || '',
    supplierId: exp.supplierId ?? exp.embarques?.[0]?.facturas?.[0]?.supplierId ?? null,
    orderId: head.orderId || null, containerId: exp.embarques?.[0]?.containerId || null,
    liquidatedAt: new Date(head.date).getTime(),
    cif: resolved.totals.cif, duty: resolved.totals.gravamen, selectivo: resolved.totals.selectivo, importItbis: resolved.totals.importItbis,
    embarques: exp.embarques, costs: exp.costs,
    lines: resolved.lines.map((l) => ({ id: l.id, itemId: l.itemId, name: l.name, reference: l.reference, qty: l.qty, fob: l.fob, selectivo: l.selectivo, cifValue: l.cif })),
    paymentMethod: head.paymentMethod, rate: Number(head.rate) || 0, status,
    ...(journalEntryId ? { journalEntryId } : {}),
  });

  /** Upload the imported factura PDFs into the expediente's Drive folder,
   *  creating the folder on first use and persisting its id on the row. Best
   *  effort: a Drive blip must never fail the save/posting that already wrote. */
  async function archiveFacturasToDrive(savedId, number, bl, folderId) {
    const files = [...facturaFilesRef.current.values()].filter(Boolean);
    if (!driveReady || !files.length) return;
    try {
      let fid = folderId;
      if (!fid) {
        const name = `Importación ${number != null ? `#${number}` : ''}${bl ? ` — BL ${bl}` : ''}`.trim() || 'Importación';
        const data = await driveCreateFolder({ name });
        fid = data.id;
        await db.importExpedientes.update(savedId, { driveFolderId: fid, driveFolderUrl: data.url || '' });
      }
      for (const f of files) await driveUploadBlob({ folderId: fid, filename: f.name, blob: f });
      facturaFilesRef.current.clear();
    } catch { /* the expediente is saved; the docs can be added from the detail page */ }
  }

  /** Save WITHOUT posting — a work-in-progress expediente you can keep editing
   *  and attach documents to. No asiento, no kardex, no inventory minted. */
  async function saveDraft() {
    setErr('');
    setSaving(true);
    try {
      const exp = toModel(embs, costs);
      const resolved = resolveExpediente(exp, config);
      const rowFields = buildRowFields(exp, resolved, 'draft');
      let savedId = existing?.id;
      let savedNumber = existing?.number;
      if (existing?.id) {
        await db.importExpedientes.update(existing.id, { ...rowFields, updatedAt: Date.now() });
      } else {
        const rec = await assignSequenceNumber({
          table: 'importExpedientes', profileId: scope, start: 1,
          build: (n) => ({ id: newId(), profileId: scope, number: n, ...rowFields, driveFolderId: driveFolder?.id || '', driveFolderUrl: driveFolder?.url || '', createdAt: Date.now() }),
        });
        savedId = rec.id;
        savedNumber = rec.number;
      }
      await archiveFacturasToDrive(savedId, savedNumber, rowFields.bl, driveFolder?.id || existing?.driveFolderId);
      if (!existing) clearDraftStorage();
      navigate(`/accounting/importaciones/${savedId}`);
    } catch (e) {
      setErr(userMessageFor(e));
      setSaving(false);
    }
  }

  async function post() {
    setErr('');
    if (t.cif <= 0) { setErr('Agrega al menos una línea con valor FOB.'); return; }
    setSaving(true);
    try {
      // Editing a POSTED expediente = re-liquidar: reverse the prior asiento +
      // kardex first (keeping any solely-minted items so the re-post can re-add
      // them), then re-post below preserving the same id + number.
      const isRepost = !!existing?.journalEntryId;
      let priorTouched = [];
      if (isRepost) {
        const rev = await reverseExpedientePosting({ id: existing.id, journalEntryId: existing.journalEntryId, keepOrphanItems: true });
        priorTouched = rev.touched;
      }

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

      // Reuse the draft's id + number when contabilizing an existing draft.
      const id = existing?.id || newId();
      const postedAt = new Date(head.date).getTime();
      const exp = { ...toModel(embsPatched, costs), id, bl: embsPatched[0]?.bl || '', supplierId: embsPatched[0]?.facturas?.[0]?.supplierId || null };
      const resolvedSave = resolveExpediente(exp, config);
      const built = buildExpedienteEntry({ newId, config, expediente: exp, postedAt });
      await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
      await db.journalLines.bulkPut(built.lines);
      const rowFields = buildRowFields(exp, resolvedSave, 'posted', built.entry.id);
      let savedNumber = existing?.number;
      if (existing?.id) {
        await db.importExpedientes.update(id, { ...rowFields, updatedAt: Date.now() });
      } else {
        const rec = await assignSequenceNumber({
          table: 'importExpedientes', profileId: scope, start: 1,
          build: (n) => ({ id, profileId: scope, number: n, ...rowFields, driveFolderId: driveFolder?.id || '', driveFolderUrl: driveFolder?.url || '', createdAt: Date.now() }),
        });
        savedNumber = rec.number;
      }
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
          // Backfill the catalog price onto an existing item that never carried
          // one (newly-minted items already have it). A dealer-set price wins.
          const price = priceByItem.get(l.itemId);
          if (isRepost) {
            // Re-liquidar: qty/avg come from the full recompute below (the
            // expediente may not be chronologically last); only the price here.
            if (price != null && it.sellingPrice == null) await db.inventoryItems.update(l.itemId, { sellingPrice: price });
          } else {
            const avg = weightedAverageIn(it.qtyOnHand || 0, it.avgCost || 0, l.qty, l.landedUnitCost);
            const patch = { qtyOnHand: (it.qtyOnHand || 0) + l.qty, avgCost: avg };
            if (price != null && it.sellingPrice == null) patch.sellingPrice = price;
            await db.inventoryItems.update(l.itemId, patch);
          }
        }
        touched.push(l.itemId);
      }
      // Re-liquidar: recompute every touched item (prior ∪ new) from ALL its
      // movements, since the re-posted lines may not be chronologically last.
      if (isRepost) await recomputeItems([...priorTouched, ...touched]);
      if (touched.length) syncShopify(touched).catch(() => {});
      await archiveFacturasToDrive(id, savedNumber, rowFields.bl, driveFolder?.id || existing?.driveFolderId);
      if (!existing) clearDraftStorage();
      navigate(`/accounting/importaciones/${id}`);
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
  // The Drive folder's display name: a saved expediente uses its number + BL; a
  // brand-new draft stays "(borrador)" until it's saved and numbered.
  const folderName = existing
    ? `Importación ${existing.number != null ? `#${existing.number}` : ''}${existing.bl ? ` — BL ${existing.bl}` : ''}`.trim() || 'Importación'
    : 'Importación (borrador)';

  return (
    <div className="card p-4 mb-4 border-ink-300">
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

      {/* Line counter + product search — verify the PDF import captured every
          product, and find any piece quickly across all embarques/facturas. */}
      <div className="mt-4 rounded-xl border border-ink-200 bg-surface p-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
          <div className="text-sm text-ink-700 inline-flex items-center gap-1.5 whitespace-nowrap">
            <Package size={15} className="text-ink-400" />
            <b className="tabular-nums">{lineSummary.count}</b> línea{lineSummary.count === 1 ? '' : 's'}
            <span className="text-ink-400">·</span>
            <b className="tabular-nums">{lineSummary.qty}</b> uds
            <span className="text-ink-400">·</span>
            FOB <b className="tabular-nums">{formatDop(lineSummary.fob)}</b>
          </div>
          <div className="relative flex-1 min-w-0">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              value={lineQuery}
              onChange={(e) => setLineQuery(e.target.value)}
              placeholder="Buscar producto importado (nombre o referencia)…"
              className="input w-full pl-8"
            />
          </div>
        </div>
        {lineQuery.trim() && (
          <div className="mt-2 text-xs">
            <div className="text-ink-500 mb-1"><b className="tabular-nums">{lineMatches.length}</b> coincidencia{lineMatches.length === 1 ? '' : 's'}</div>
            {lineMatches.length > 0 && (
              <ul className="max-h-48 overflow-y-auto divide-y divide-ink-50 rounded-lg border border-ink-100">
                {lineMatches.slice(0, 40).map((l) => (
                  <li key={l.id} className="flex items-center gap-2 px-2.5 py-1.5">
                    <span className="font-mono text-[11px] text-ink-400 w-20 shrink-0">{l.reference || '—'}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-700">{l.name || '—'}</span>
                    <span className="text-ink-400 shrink-0 tabular-nums">×{l.qty || 0}</span>
                    <span className="text-ink-500 shrink-0 tabular-nums w-24 text-right">{l.fob !== '' ? formatDop(Number(l.fob)) : '—'}</span>
                    <span className="text-ink-300 shrink-0 text-[11px] whitespace-nowrap">E{l.embIndex}·F{l.facIndex}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
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
                      PDF importado (reemplazó la factura): <b>{pdfNote.count}</b> líneas — {pdfNote.matched} en inventario
                      {pdfNote.toCreate > 0 && <span className="text-amber-700">, {pdfNote.toCreate} se crearán al guardar</span>}.
                      {pdfNote.invoiceTotal > 0 && (
                        Math.abs(pdfNote.importedUsd - pdfNote.invoiceTotal) < 1
                          ? <span className="text-emerald-700 inline-flex items-center gap-1"> <Check size={12} /> Cuadra con la factura (US${pdfNote.invoiceTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}).</span>
                          : <span className="text-amber-700"> Importado US${pdfNote.importedUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })} de US${pdfNote.invoiceTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })} — revisa, faltan líneas.</span>
                      )}
                      {driveReady && <span className="text-emerald-700"> La factura se guardará en Google Drive.</span>}
                    </p>
                  )}

                  {/* Líneas */}
                  {/* Mobile: stacked cards (the desktop table scrolls sideways on phones) */}
                  <div className="md:hidden space-y-2">
                    {fac.lines.map((l) => (
                      <div key={l.id} className="rounded-lg border border-ink-100 bg-ink-50/40 p-2 space-y-2">
                        <SearchPicker
                          options={itemOptions}
                          value={l.itemId}
                          text={l.name}
                          placeholder="— Artículo a inventariar —"
                          freeTextLabel="Crear artículo"
                          onPick={(o) => patchLine(emb.id, fac.id, l.id, { itemId: o.id, name: o.label, reference: o.sublabel || '' })}
                          allowFreeText
                          onFreeText={(txt) => patchLine(emb.id, fac.id, l.id, { itemId: '', name: txt })}
                        />
                        {(l.name || '').trim() !== '' && (!l.itemId || l.reference) && (
                          <div className="inline-flex items-center gap-1.5 text-[11px] text-amber-700">
                            {!l.itemId && <span className="inline-flex items-center gap-1"><Plus size={11} /> Nuevo en inventario</span>}
                            {l.reference && <span className="font-mono text-amber-600">{l.reference}</span>}
                          </div>
                        )}
                        <div className="grid grid-cols-3 gap-2">
                          <label className="text-[11px] text-ink-400">Cant.
                            <input type="number" min="0" step="1" inputMode="numeric" value={l.qty} onChange={(e) => patchLine(emb.id, fac.id, l.id, { qty: e.target.value })} className="input w-full text-right tabular-nums mt-0.5" /></label>
                          <label className="text-[11px] text-ink-400">FOB RD$
                            <input type="number" min="0" step="0.01" inputMode="decimal" value={l.fob} onChange={(e) => patchLine(emb.id, fac.id, l.id, { fob: e.target.value })} className="input w-full text-right tabular-nums mt-0.5" /></label>
                          <label className="text-[11px] text-ink-400">Selectivo
                            <input type="number" min="0" step="0.01" inputMode="decimal" value={l.selectivo} onChange={(e) => patchLine(emb.id, fac.id, l.id, { selectivo: e.target.value })} placeholder="0" className="input w-full text-right tabular-nums mt-0.5" /></label>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-ink-500 tabular-nums">C. unit. {byLine[l.id]?.landedUnitCost > 0 ? formatDop(byLine[l.id].landedUnitCost) : '—'}</span>
                          <button type="button" onClick={() => delLine(emb.id, fac.id, l.id)} className="btn-icon-danger" title="Eliminar línea" aria-label="Eliminar línea"><Trash2 size={14} /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Desktop: dense table */}
                  <div className="hidden md:block overflow-x-auto -mx-2.5">
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

      {/* Costos del expediente — landing costs (agenciamiento, transporte,
          puerto…) are registered ONCE in the compras/gastos registry; the
          expediente only links to them. Each keeps its own asiento, so linking
          never re-posts (no double count). */}
      <div className="mt-4 surface-subtle p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
          <h4 className="font-display text-sm font-medium text-ink-700 inline-flex items-center gap-1.5"><ShoppingCart size={14} className="text-ink-400" /> Costos del expediente (gastos y compras)</h4>
          {expedienteId && (
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => goRegisterCost('gasto')} className="btn-ghost text-xs inline-flex items-center gap-1"><Plus size={13} /> Gasto</button>
              <button type="button" onClick={() => goRegisterCost('mercancia')} className="btn-ghost text-xs inline-flex items-center gap-1"><Plus size={13} /> Compra</button>
            </div>
          )}
        </div>

        {/* Legacy: expedientes posted under the old model carry capitalized
            costs inline. They stay on the books (we don't rewrite history) and
            show on the detail; they're just not editable here anymore. */}
        {costs.length > 0 && (
          <p className="text-xs text-amber-700 mb-2">Este expediente tiene {costs.length} costo{costs.length === 1 ? '' : 's'} capitalizado{costs.length === 1 ? '' : 's'} (modelo anterior). Se conservan en el asiento y aparecen en el detalle.</p>
        )}

        {!expedienteId ? (
          <p className="text-xs text-ink-400">Guarda el borrador para registrar o enlazar gastos y compras a este expediente. Los costos se registran como gastos/compras y el expediente sólo los referencia.</p>
        ) : (
          <div className="space-y-2">
            {/* Pull in an already-registered gasto/compra (set its expedienteId). */}
            {linkCandidates.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-ink-500">
                <Link2 size={13} className="text-ink-400 shrink-0" />
                <select
                  value=""
                  onChange={(e) => { const [src, did] = e.target.value.split('::'); if (did) linkDoc(src, did); }}
                  className={`${field} flex-1 min-w-0`}
                >
                  <option value="">Enlazar un gasto o compra ya registrado…</option>
                  {linkCandidates.map((r) => (
                    <option key={`${r.source}::${r.id}`} value={`${r.source}::${r.id}`}>
                      {formatDate(r.date)} · {r.supplierName || 's/proveedor'} · {NATURE_LABEL[r.nature] || r.nature} · {r.destination} · {formatDop(r.total)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {linkedCosts.length === 0 ? (
              <p className="text-xs text-ink-400">Aún no hay gastos ni compras enlazados. Registra uno o enlaza uno existente.</p>
            ) : (
              <>
                <ul className="divide-y divide-ink-100 rounded-lg border border-ink-100 bg-surface">
                  {linkedCosts.map((r) => (
                    <li key={r.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                      <span className="text-ink-400 w-20 shrink-0 whitespace-nowrap">{formatDate(r.date)}</span>
                      <span className="text-ink-600 w-24 shrink-0 truncate">{NATURE_LABEL[r.nature] || r.nature}</span>
                      <span className="min-w-0 flex-1 truncate text-ink-700">{r.supplierName || '—'} · {r.destination}</span>
                      <span className="shrink-0 tabular-nums text-ink-600 w-24 text-right">{formatDop(r.total)}</span>
                      <button type="button" onClick={() => unlinkDoc(r.source, r.id)} className="btn-icon text-ink-400 hover:text-rose-600 shrink-0" title="Quitar enlace" aria-label="Quitar enlace"><Unlink size={13} /></button>
                    </li>
                  ))}
                </ul>
                <div className="text-xs text-ink-500">{linkedCosts.length} enlazado{linkedCosts.length === 1 ? '' : 's'} · total <b className="tabular-nums">{formatDop(linkedCostsTotal)}</b></div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Documentos en Google Drive — folder created on the first attachment,
          recycled (emptied + reused) if the draft is discarded. */}
      <DriveDocumentsCard
        key={docsNonce}
        folderId={driveFolder?.id || ''}
        folderUrl={driveFolder?.url || ''}
        folderName={folderName}
        createOnAttach
        onFolderSaved={handleFolderSaved}
      />

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
        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          {/* "Guardar borrador" is hidden when re-liquidating a POSTED expediente:
              saving it as a draft would un-post it without reversing the asiento. */}
          {!existing?.journalEntryId && (
            <button type="button" onClick={saveDraft} disabled={saving} className="btn-secondary">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Guardar borrador
            </button>
          )}
          <button type="button" onClick={post} disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {existing?.journalEntryId ? 'Re-liquidar expediente' : 'Contabilizar expediente'}
          </button>
        </div>
      </div>
      {err && <p className="text-sm text-rose-600 mt-2">{err}</p>}
    </div>
  );
}
