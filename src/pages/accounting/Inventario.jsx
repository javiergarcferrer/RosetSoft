import { userMessageFor } from '../../lib/errorMessages.js';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Boxes, Plus, Loader2, Check, X, ArrowDownToLine, RefreshCw } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
import AccountingGate from '../../components/accounting/AccountingGate.jsx';
import RowCards from '../../components/RowCards.jsx';
import ImageDrop from '../../components/ImageDrop.jsx';
import { formatDop, formatDate } from '../../lib/format.js';
import { syncShopify } from '../../lib/shopifySync.js';
import {
  resolveInventory, resolveItemKardex, buildCogsEntry, resolveAccountingConfig,
} from '../../core/accounting/index.js';

const TYPE_LABEL = { in: 'Entrada', out: 'Salida', adjust: 'Ajuste' };

/**
 * Inventario — costed stock (weighted average) projected from the kardex. New
 * items here; entries come from Compras (goods). "Salida" books the cost of
 * sale (Debit costo de venta / Credit inventario) at the current average cost.
 * Self-gates on accounting/admin.
 */
export default function Inventario() {
  const { profileId, settings } = useApp();
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const movesQ = useLiveQueryStatus(() => db.inventoryMovements.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = itemsQ.loaded && movesQ.loaded;

  const inv = useMemo(() => resolveInventory({ items: itemsQ.data, movements: movesQ.data }), [itemsQ.data, movesQ.data]);
  const [params] = useSearchParams();
  // ?item=&qty= deep-link (the salida handoff from Facturación) preselects
  // the kardex and fills the out quantity — confirming stays manual.
  const [selectedId, setSelectedId] = useState(() => params.get('item') || '');
  const kardex = useMemo(
    () => (selectedId ? resolveItemKardex({ movements: movesQ.data, itemId: selectedId }) : null),
    [selectedId, movesQ.data],
  );
  const selectedItem = useMemo(() => itemsQ.data.find((i) => i.id === selectedId) || null, [itemsQ.data, selectedId]);

  const [showItem, setShowItem] = useState(!!params.get('new'));
  const [itemForm, setItemForm] = useState({ sku: '', name: '', unit: 'unidad' });
  const [savingItem, setSavingItem] = useState(false);

  const [outQty, setOutQty] = useState(() => params.get('qty') || '');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState('');
  const [syncing, setSyncing] = useState(false);

  async function createItem() {
    if (!itemForm.name.trim()) return;
    setSavingItem(true);
    try {
      await db.inventoryItems.put({
        id: newId(), profileId: scope, sku: itemForm.sku.trim(), name: itemForm.name.trim(),
        unit: itemForm.unit.trim() || 'unidad', qtyOnHand: 0, avgCost: 0,
      });
      setItemForm({ sku: '', name: '', unit: 'unidad' });
      setShowItem(false);
    } finally {
      setSavingItem(false);
    }
  }

  async function registerSalida() {
    setErr('');
    const qty = Number(outQty) || 0;
    if (!selectedItem || qty <= 0) { setErr('Indica una cantidad válida.'); return; }
    if (kardex && qty > kardex.qty) { setErr('No hay suficiente existencia.'); return; }
    const avg = kardex?.avgCost || 0;
    const cost = Math.round(qty * avg * 100) / 100;
    setPosting(true);
    try {
      const moveId = newId();
      if (cost > 0) {
        const built = buildCogsEntry({ newId, config, cost, postedAt: Date.now(), refId: moveId, memo: `Salida ${selectedItem.name}` });
        await assignSequenceNumber({ table: 'journalEntries', profileId: scope, start: 1, build: (n) => ({ ...built.entry, number: n }) });
        await db.journalLines.bulkPut(built.lines);
        await db.inventoryMovements.put({
          id: moveId, profileId: scope, itemId: selectedItem.id, type: 'out', qty, unitCost: avg,
          movedAt: Date.now(), memo: 'Costo de venta', journalEntryId: built.entry.id,
        });
      } else {
        await db.inventoryMovements.put({
          id: moveId, profileId: scope, itemId: selectedItem.id, type: 'out', qty, unitCost: avg, movedAt: Date.now(),
        });
      }
      await db.inventoryItems.update(selectedItem.id, { qtyOnHand: (kardex?.qty || 0) - qty, avgCost: avg });
      // Stock changed → reflect it in the Shopify catalog (sold out → removed).
      syncShopify([selectedItem.id]).catch(() => {});
      setOutQty('');
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setPosting(false);
    }
  }

  async function syncAll() {
    setSyncing(true);
    setErr('');
    try {
      const res = await syncShopify();
      if (res?.configured === false) setErr('Conecta Shopify en Configuración para publicar el inventario.');
    } catch (e) {
      setErr(userMessageFor(e));
    } finally {
      setSyncing(false);
    }
  }

  const field = 'input';

  return (
    <AccountingGate title="Inventario">
      <PageHeader title="Inventario"
        subtitle={loaded ? `${inv.count} artículos · valor ${formatDop(inv.totalValue)}` : ' '}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={syncAll} disabled={syncing} className="btn-secondary">
              {syncing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} <span className="hidden sm:inline">Sincronizar Shopify</span><span className="sm:hidden">Shopify</span>
            </button>
            <button type="button" onClick={() => setShowItem((v) => !v)} className="btn-primary"><Plus size={15} /> <span className="hidden sm:inline">Nuevo artículo</span><span className="sm:hidden">Nuevo</span></button>
          </div>
        )} />

      {showItem && (
        <div className="card p-4 mb-4 border-ink-300">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">Nuevo artículo</h3>
            <button type="button" onClick={() => setShowItem(false)} className="btn-icon text-ink-400" aria-label="Cerrar"><X size={18} /></button>
          </div>
          <div className="flex flex-wrap gap-3">
            <input value={itemForm.sku} onChange={(e) => setItemForm((f) => ({ ...f, sku: e.target.value }))} placeholder="SKU / referencia" className={`${field} w-44`} />
            <input value={itemForm.name} onChange={(e) => setItemForm((f) => ({ ...f, name: e.target.value }))} placeholder="Nombre" className={`${field} flex-1 min-w-[200px]`} />
            <input value={itemForm.unit} onChange={(e) => setItemForm((f) => ({ ...f, unit: e.target.value }))} placeholder="Unidad" className={`${field} w-28`} />
            <button type="button" onClick={createItem} disabled={savingItem || !itemForm.name.trim()} className="btn-primary">
              {savingItem ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar
            </button>
          </div>
        </div>
      )}

      {!loaded ? <ListLoading /> : inv.count === 0 ? (
        <EmptyState icon={Boxes} title="Sin artículos" description="Crea un artículo y regístralo desde Compras." />
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="min-w-0">
          <RowCards
            rows={inv.rows.map(({ item, qty, avgCost, value }) => ({
              key: item.id,
              title: <>{item.name}{item.sku ? <code className="text-[11px] text-ink-400 ml-2">{item.sku}</code> : null}</>,
              right: formatDop(value),
              onClick: () => { setSelectedId(item.id); setOutQty(''); setErr(''); },
              kv: [
                ['Existencia', `${qty} ${item.unit}`],
                ['Costo prom.', formatDop(avgCost)],
              ],
            }))}
            footer={[['Valor total', formatDop(inv.totalValue)]]}
          />
          <div className="hidden md:block card overflow-hidden">
            <div className="overflow-x-auto">
            <table className="table min-w-[320px]">
              <thead>
                <tr>
                  <th>Artículo</th>
                  <th className="text-right whitespace-nowrap">Existencia</th>
                  <th className="text-right whitespace-nowrap hidden sm:table-cell">Costo prom.</th>
                  <th className="text-right whitespace-nowrap">Valor</th>
                </tr>
              </thead>
              <tbody>
                {inv.rows.map(({ item, qty, avgCost, value }) => (
                  <tr key={item.id} onClick={() => { setSelectedId(item.id); setOutQty(''); setErr(''); }}
                    className={`cursor-pointer transition-colors active:bg-ink-100 ${selectedId === item.id ? 'bg-ink-50' : ''}`}>
                    <td className="min-w-0"><div className="truncate">{item.name}{item.sku ? <code className="text-[11px] text-ink-400 ml-2">{item.sku}</code> : null}</div></td>
                    <td className="text-right tabular-nums whitespace-nowrap">{qty} {item.unit}</td>
                    <td className="text-right tabular-nums whitespace-nowrap hidden sm:table-cell">{formatDop(avgCost)}</td>
                    <td className="text-right tabular-nums font-medium whitespace-nowrap">{formatDop(value)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-ink-200 font-semibold">
                  <td colSpan={3}>Valor total</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{formatDop(inv.totalValue)}</td>
                </tr>
              </tfoot>
            </table>
            </div>
          </div>
          </div>

          <div>
            {!selectedItem ? (
              <div className="card p-6 text-sm text-ink-500">Selecciona un artículo para ver su kardex.</div>
            ) : (
              <div className="card p-4">
                <h3 className="font-semibold mb-1 min-w-0 truncate">{selectedItem.name}</h3>
                <p className="text-sm text-ink-500 mb-3">{kardex.qty} {selectedItem.unit} · costo prom. {formatDop(kardex.avgCost)} · valor {formatDop(kardex.value)}</p>

                <CatalogBlock item={selectedItem} key={selectedItem.id} />

                <div className="mb-3 pb-3 border-b border-ink-100">
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="text-sm">Salida de stock (unidades)<br />
                      <input type="number" min="0" step="1" inputMode="numeric" enterKeyHint="done" value={outQty} onChange={(e) => setOutQty(e.target.value)} placeholder="Cantidad" className="input w-32 text-right tabular-nums" />
                    </label>
                    <button type="button" onClick={registerSalida} disabled={posting} className="btn-primary">
                      {posting ? <Loader2 size={15} className="animate-spin" /> : <ArrowDownToLine size={15} />} Registrar salida
                    </button>
                  </div>
                  <p className="text-[11px] text-ink-400 mt-1">Descuenta unidades vendidas y registra el costo de venta al costo promedio (no es el precio de venta).</p>
                </div>
                {err && <p className="text-sm text-rose-600 mb-2">{err}</p>}

                {kardex.rows.length === 0 ? (
                  <p className="text-sm text-ink-500">Sin movimientos.</p>
                ) : (
                  <div className="overflow-x-auto -mx-4 px-4">
                  <table className="w-full text-sm min-w-[300px]">
                    <thead className="text-ink-500 text-xs uppercase tracking-wide">
                      <tr>
                        <th className="text-left py-1 whitespace-nowrap">Fecha</th>
                        <th className="text-left py-1">Tipo</th>
                        <th className="text-right py-1 whitespace-nowrap">Cant.</th>
                        <th className="text-right py-1 whitespace-nowrap">C. unit.</th>
                        <th className="text-right py-1 whitespace-nowrap">Saldo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {kardex.rows.slice().reverse().map(({ movement: m, qty, avgCost }) => (
                        <tr key={m.id} className="border-t border-ink-50">
                          <td className="py-1 text-ink-500 whitespace-nowrap">{formatDate(m.movedAt)}</td>
                          <td className="py-1">{TYPE_LABEL[m.type]}</td>
                          <td className="py-1 text-right tabular-nums whitespace-nowrap">{m.type === 'out' ? '−' : ''}{m.qty}</td>
                          <td className="py-1 text-right tabular-nums whitespace-nowrap">{formatDop(m.unitCost || avgCost)}</td>
                          <td className="py-1 text-right tabular-nums whitespace-nowrap">{qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </AccountingGate>
  );
}

/**
 * Turn a single-item sync result into an honest message: published, retired,
 * a Shopify error, or — the confusing case — saved-but-not-published because
 * the catalog is in-stock-and-priced only. `ok:false` styles it as an alert.
 */
function publishMessage(res, { hasPrice, hasStock }) {
  if (res?.configured === false) return { ok: false, text: 'Guardado. Conecta Shopify en Configuración para publicarlo.' };
  if (res?.error) return { ok: false, text: `Guardado, pero Shopify devolvió un error: ${res.error}` };
  if (res?.errors?.length) return { ok: false, text: `Guardado, pero Shopify devolvió un error: ${res.errors[0]}` };
  if ((res?.synced ?? 0) > 0) return { ok: true, text: 'Guardado y añadido a Shopify (colección Ligne Roset Inventory).' };
  if ((res?.archived ?? 0) > 0) return { ok: true, text: 'Guardado. Retirado del catálogo (agotado).' };
  const why = [];
  if (!hasPrice) why.push('falta el precio de venta');
  if (!hasStock) why.push('no hay existencia (registra una entrada en Compras)');
  return { ok: true, text: why.length ? `Guardado, pero aún no se publica: ${why.join(' y ')}.` : 'Guardado.' };
}

/**
 * Catalog (Shopify) block on a selected inventory item — set the PERMANENT
 * selling price (from the Alcover purchase order) and the receiving photo, then
 * publish. Keyed by item id so the local state resets when the selection
 * changes. The photo is uploaded here at receiving — never pulled from a quote.
 */
function CatalogBlock({ item }) {
  const [price, setPrice] = useState(item.sellingPrice ?? '');
  const [imageId, setImageId] = useState(item.imageId ?? null);
  const [status, setStatus] = useState('idle'); // idle | saving | saved | error
  const [msg, setMsg] = useState('');

  async function save() {
    setStatus('saving');
    setMsg('');
    try {
      await db.inventoryItems.update(item.id, {
        sellingPrice: price === '' ? null : Number(price),
        imageId: imageId || null,
      });
      const res = await syncShopify([item.id]);
      const r = publishMessage(res, { hasPrice: Number(price) > 0, hasStock: Number(item.qtyOnHand) > 0 });
      setStatus(r.ok ? 'saved' : 'error');
      setMsg(r.text);
      if (r.ok) setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 4000);
    } catch (e) {
      setStatus('error');
      setMsg(userMessageFor(e));
    }
  }

  return (
    <div className="mb-3 pb-3 border-b border-ink-100">
      <div className="label mb-2">Catálogo (Shopify)</div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">Precio de venta en tienda (USD)<br />
          <input type="number" min="0" step="0.01" inputMode="decimal" enterKeyHint="done" value={price} onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00" className="input w-36 text-right tabular-nums" />
        </label>
        <div className="w-40">
          <ImageDrop imageId={imageId} onChange={setImageId} kind="inventory-item" ownerId={item.id}
            label="Foto" imgClassName="h-24 w-full object-cover rounded-md" allowUrl={false} />
        </div>
        <button type="button" onClick={save} disabled={status === 'saving'}
          className="btn-primary">
          {status === 'saving' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar y publicar
        </button>
      </div>
      {msg && <p className={`text-xs mt-1.5 ${status === 'error' ? 'text-rose-600' : 'text-ink-500'}`}>{msg}</p>}
      <p className="text-[11px] text-ink-400 mt-1">Se publica cuando hay existencia y precio. Al agotarse, sale del catálogo.</p>
    </div>
  );
}
