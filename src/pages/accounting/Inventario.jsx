import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Shield, Boxes, Plus, Loader2, Check, X, ArrowDownToLine, RefreshCw } from 'lucide-react';
import { useLiveQueryStatus } from '../../db/hooks.js';
import { db, newId, assignSequenceNumber } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import PageHeader from '../../components/PageHeader.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import ListLoading from '../../components/ListLoading.jsx';
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
  const { profileId, currentProfile, settings } = useApp();
  const allowed = currentProfile?.role === 'accounting' || currentProfile?.role === 'admin';
  const scope = profileId || 'team';
  const config = useMemo(() => resolveAccountingConfig(settings?.accountingConfig), [settings]);

  const itemsQ = useLiveQueryStatus(() => db.inventoryItems.where('profileId').equals(scope).toArray(), [scope], []);
  const movesQ = useLiveQueryStatus(() => db.inventoryMovements.where('profileId').equals(scope).toArray(), [scope], []);
  const loaded = itemsQ.loaded && movesQ.loaded;

  const inv = useMemo(() => resolveInventory({ items: itemsQ.data, movements: movesQ.data }), [itemsQ.data, movesQ.data]);
  const [selectedId, setSelectedId] = useState('');
  const kardex = useMemo(
    () => (selectedId ? resolveItemKardex({ movements: movesQ.data, itemId: selectedId }) : null),
    [selectedId, movesQ.data],
  );
  const selectedItem = useMemo(() => itemsQ.data.find((i) => i.id === selectedId) || null, [itemsQ.data, selectedId]);

  const [params] = useSearchParams();
  const [showItem, setShowItem] = useState(!!params.get('new'));
  const [itemForm, setItemForm] = useState({ sku: '', name: '', unit: 'unidad' });
  const [savingItem, setSavingItem] = useState(false);

  const [outQty, setOutQty] = useState('');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState('');
  const [syncing, setSyncing] = useState(false);

  if (!allowed) {
    return (
      <>
        <PageHeader title="Inventario" subtitle=" " />
        <EmptyState icon={Shield} title="Acceso restringido"
          description="Sólo el equipo de Contabilidad puede ver esta página." />
      </>
    );
  }

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
      setErr(e?.message || String(e));
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
      setErr(e?.message || 'No se pudo sincronizar con Shopify.');
    } finally {
      setSyncing(false);
    }
  }

  const field = 'rounded-lg border border-ink-200 px-3 py-1.5 text-sm';

  return (
    <>
      <PageHeader title="Inventario"
        subtitle={loaded ? `${inv.count} artículos · valor ${formatDop(inv.totalValue)}` : ' '}
        actions={(
          <div className="flex items-center gap-2">
            <button type="button" onClick={syncAll} disabled={syncing} className="btn-ghost text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
              {syncing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Sincronizar Shopify
            </button>
            <button type="button" onClick={() => setShowItem((v) => !v)} className="btn-primary text-sm inline-flex items-center gap-1.5"><Plus size={15} /> Nuevo artículo</button>
          </div>
        )} />

      {showItem && (
        <div className="card p-4 mb-4 border-ink-300">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">Nuevo artículo</h3>
            <button type="button" onClick={() => setShowItem(false)} className="text-ink-400 hover:text-ink-700"><X size={18} /></button>
          </div>
          <div className="flex flex-wrap gap-3">
            <input value={itemForm.sku} onChange={(e) => setItemForm((f) => ({ ...f, sku: e.target.value }))} placeholder="SKU / referencia" className={field} />
            <input value={itemForm.name} onChange={(e) => setItemForm((f) => ({ ...f, name: e.target.value }))} placeholder="Nombre" className={`${field} flex-1 min-w-[200px]`} />
            <input value={itemForm.unit} onChange={(e) => setItemForm((f) => ({ ...f, unit: e.target.value }))} placeholder="Unidad" className={`${field} w-28`} />
            <button type="button" onClick={createItem} disabled={savingItem || !itemForm.name.trim()} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
              {savingItem ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar
            </button>
          </div>
        </div>
      )}

      {!loaded ? <ListLoading /> : inv.count === 0 ? (
        <EmptyState icon={Boxes} title="Sin artículos" description="Crea un artículo y regístralo desde Compras." />
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left py-2 px-3">Artículo</th>
                  <th className="text-right py-2 px-3">Existencia</th>
                  <th className="text-right py-2 px-3">Costo prom.</th>
                  <th className="text-right py-2 px-3">Valor</th>
                </tr>
              </thead>
              <tbody>
                {inv.rows.map(({ item, qty, avgCost, value }) => (
                  <tr key={item.id} onClick={() => { setSelectedId(item.id); setOutQty(''); setErr(''); }}
                    className={`border-t border-ink-50 cursor-pointer hover:bg-ink-50 ${selectedId === item.id ? 'bg-ink-50' : ''}`}>
                    <td className="py-1.5 px-3">{item.name}{item.sku ? <code className="text-[11px] text-ink-400 ml-2">{item.sku}</code> : null}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{qty} {item.unit}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatDop(avgCost)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-medium">{formatDop(value)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-ink-200 font-semibold">
                  <td className="py-2 px-3" colSpan={3}>Valor total</td>
                  <td className="py-2 px-3 text-right tabular-nums">{formatDop(inv.totalValue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div>
            {!selectedItem ? (
              <div className="card p-6 text-sm text-ink-500">Selecciona un artículo para ver su kardex.</div>
            ) : (
              <div className="card p-4">
                <h3 className="font-semibold mb-1">{selectedItem.name}</h3>
                <p className="text-sm text-ink-500 mb-3">{kardex.qty} {selectedItem.unit} · costo prom. {formatDop(kardex.avgCost)} · valor {formatDop(kardex.value)}</p>

                <CatalogBlock item={selectedItem} key={selectedItem.id} />

                <div className="flex flex-wrap items-end gap-2 mb-3 pb-3 border-b border-ink-100">
                  <label className="text-sm">Salida (costo de venta)<br />
                    <input type="number" min="0" step="1" value={outQty} onChange={(e) => setOutQty(e.target.value)} placeholder="Cantidad" className="w-32 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right tabular-nums" />
                  </label>
                  <button type="button" onClick={registerSalida} disabled={posting} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
                    {posting ? <Loader2 size={15} className="animate-spin" /> : <ArrowDownToLine size={15} />} Registrar salida
                  </button>
                </div>
                {err && <p className="text-sm text-rose-600 mb-2">{err}</p>}

                {kardex.rows.length === 0 ? (
                  <p className="text-sm text-ink-500">Sin movimientos.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="text-ink-500 text-xs uppercase tracking-wide">
                      <tr><th className="text-left py-1">Fecha</th><th className="text-left py-1">Tipo</th><th className="text-right py-1">Cant.</th><th className="text-right py-1">C. unit.</th><th className="text-right py-1">Saldo</th></tr>
                    </thead>
                    <tbody>
                      {kardex.rows.slice().reverse().map(({ movement: m, qty, avgCost }) => (
                        <tr key={m.id} className="border-t border-ink-50">
                          <td className="py-1 text-ink-500">{formatDate(m.movedAt)}</td>
                          <td className="py-1">{TYPE_LABEL[m.type]}</td>
                          <td className="py-1 text-right tabular-nums">{m.type === 'out' ? '−' : ''}{m.qty}</td>
                          <td className="py-1 text-right tabular-nums">{formatDop(m.unitCost || avgCost)}</td>
                          <td className="py-1 text-right tabular-nums">{qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
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
      setStatus('saved');
      setMsg(res?.configured === false
        ? 'Guardado. Conecta Shopify en Configuración para publicarlo.'
        : 'Guardado y publicado en Shopify.');
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2500);
    } catch (e) {
      setStatus('error');
      setMsg(e?.message || 'No se pudo guardar.');
    }
  }

  return (
    <div className="mb-3 pb-3 border-b border-ink-100">
      <div className="label mb-2">Catálogo (Shopify)</div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">Precio de venta (USD)<br />
          <input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00" className="w-36 rounded-lg border border-ink-200 px-2 py-1.5 text-sm text-right tabular-nums" />
        </label>
        <div className="w-40">
          <ImageDrop imageId={imageId} onChange={setImageId} kind="inventory-item" ownerId={item.id}
            label="Foto" imgClassName="h-24 w-full object-cover rounded-md" allowUrl={false} />
        </div>
        <button type="button" onClick={save} disabled={status === 'saving'}
          className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
          {status === 'saving' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar y publicar
        </button>
      </div>
      {msg && <p className={`text-xs mt-1.5 ${status === 'error' ? 'text-rose-600' : 'text-ink-500'}`}>{msg}</p>}
      <p className="text-[11px] text-ink-400 mt-1">Se publica cuando hay existencia y precio. Al agotarse, sale del catálogo.</p>
    </div>
  );
}
