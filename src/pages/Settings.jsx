import { useEffect, useState } from 'react';
import { Database, RefreshCw, ExternalLink, Cloud, Wrench } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import ImageDrop from '../components/ImageDrop.jsx';
import Modal from '../components/Modal.jsx';
import { useApp } from '../context/AppContext.jsx';
import { fetchMarketRate, effectiveDopRate, BPD_PUBLIC_URL } from '../lib/exchangeRate.js';
import { formatDateTime } from '../lib/format.js';
import { dedupCatalogReferences } from '../lib/catalogDedup.js';
import { dedupProductsByName } from '../lib/productDedup.js';
import { purgeCatalog, CATALOG_PURGE_PHRASE } from '../lib/catalogPurge.js';

const COMMON_CURRENCIES = ['DOP', 'USD', 'EUR', 'MXN', 'CAD', 'GBP'];

export default function Settings() {
  const { profileId, settings, saveSettings } = useApp();
  const [local, setLocal] = useState(settings || {});

  useEffect(() => {
    setLocal(settings || {});
  }, [settings]);

  function set(k, v) { setLocal((s) => ({ ...s, [k]: v })); }

  async function save() {
    // Keep currencyRates.DOP in sync with whichever rate the user chose
    const dop = effectiveDopRate(local);
    const next = { ...local, currencyRates: { ...(local.currencyRates || {}), USD: 1, DOP: dop } };
    await saveSettings(next);
  }

  const rates = local.currencyRates || { USD: 1 };

  return (
    <>
      <PageHeader title="Configuración" subtitle="Empresa, tasa de cambio, condiciones y datos" actions={
        <button onClick={save} className="btn-primary">Guardar</button>
      } />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-5">
          {/* Company */}
          <div className="card card-pad">
            <h2 className="font-semibold mb-3">Empresa</h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-4">
                <ImageDrop
                  imageId={local.logoImageId}
                  onChange={(id) => set('logoImageId', id)}
                  kind="logo"
                  ownerId={profileId}
                  label="Logo"
                  imgClassName="w-full aspect-square object-contain bg-white rounded-md"
                />
                <div className="space-y-3">
                  <div>
                    <div className="label">Razón social</div>
                    <input className="input" value={local.companyName || ''} onChange={(e) => set('companyName', e.target.value)} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="label">Teléfono</div>
                      <input className="input" value={local.companyPhone || ''} onChange={(e) => set('companyPhone', e.target.value)} />
                    </div>
                    <div>
                      <div className="label">Correo</div>
                      <input className="input" type="email" value={local.companyEmail || ''} onChange={(e) => set('companyEmail', e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>
              <div className="col-span-2">
                <div className="label">Dirección</div>
                <textarea className="input min-h-[60px]" value={local.companyAddress || ''} onChange={(e) => set('companyAddress', e.target.value)} placeholder="Calle, ciudad, provincia, R.D." />
              </div>
            </div>
          </div>

          {/* Currency (DR-focused) */}
          <RateCard local={local} set={set} saveSettings={() => saveSettings(local)} />

          {/* Defaults */}
          <div className="card card-pad">
            <h2 className="font-semibold mb-3">Predeterminados de cotización</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="label">Descuento por defecto %</div>
                <input className="input" type="number" value={local.defaultDiscountPct ?? 0} onChange={(e) => set('defaultDiscountPct', Number(e.target.value) || 0)} />
              </div>
              <div>
                <div className="label">ITBIS</div>
                <div className="input bg-ink-50 text-ink-500 cursor-not-allowed">18% (fijo)</div>
              </div>
              <div className="col-span-2">
                <div className="label">Términos (se imprimen en el PDF)</div>
                <textarea className="input min-h-[100px]" value={local.quoteTerms || ''} onChange={(e) => set('quoteTerms', e.target.value)} />
              </div>
              <div className="col-span-2">
                <div className="label">Pie de página (en cada página del PDF)</div>
                <input className="input" value={local.quoteFooter || ''} onChange={(e) => set('quoteFooter', e.target.value)} />
              </div>
            </div>
          </div>

          {/* Containers */}
          <div className="card card-pad">
            <h2 className="font-semibold mb-1">Contenedores</h2>
            <p className="text-xs text-ink-500 mb-3">
              Un contenedor está listo para despachar cuando la suma de las cotizaciones fijadas alcanza este monto (en USD).
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="label">Monto mínimo para despacho (USD)</div>
                <input
                  className="input"
                  type="number"
                  step="100"
                  value={local.dispatchThreshold ?? 50000}
                  onChange={(e) => set('dispatchThreshold', Number(e.target.value) || 0)}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-5">
          <div className="card card-pad">
            <h2 className="font-semibold mb-3 flex items-center gap-2"><Cloud size={16} /> Almacenamiento</h2>
            <p className="text-xs text-ink-500 mb-3">
              Los datos del equipo están en la nube (Supabase). Cualquier miembro autenticado los ve y los edita en tiempo real.
            </p>
            <p className="text-xs text-ink-500">
              Las imágenes se guardan en el bucket público <code className="kbd">images</code> y se sirven directamente como URLs.
            </p>
          </div>

          <CatalogMaintenanceCard />
        </div>
      </div>
    </>
  );
}

function CatalogMaintenanceCard() {
  // Which dedup is busy (preview or applying)?
  const [busyMode, setBusyMode] = useState(null); // 'variants' | 'products' | 'all' | null
  const [applying, setApplying] = useState(false);

  // Preview state, lifted out of the buttons so the modal can render.
  // shape: { mode, productGroups, variantGroups, summary }
  const [preview, setPreview] = useState(null);

  function closeModal() {
    if (applying) return; // don't let the user close mid-write
    setPreview(null);
  }

  async function previewVariants() {
    if (busyMode) return;
    setBusyMode('variants');
    try {
      const result = await dedupCatalogReferences({ dryRun: true });
      if (result.canonicalGroups === 0) {
        alert('No se encontraron referencias duplicadas. El catálogo ya está limpio.');
        return;
      }
      setPreview({
        mode: 'variants',
        productGroups: [],
        variantGroups: result.groups,
        summary: `Se encontraron ${result.mergedVariants} variantes duplicadas ` +
                 `en ${result.canonicalGroups} referencias.`,
      });
    } catch (e) {
      console.error('Variant dedup preview failed', e);
      alert('No se pudo generar la vista previa: ' + (e?.message || e));
    } finally {
      setBusyMode(null);
    }
  }

  async function previewProducts() {
    if (busyMode) return;
    setBusyMode('products');
    try {
      const result = await dedupProductsByName({ dryRun: true });
      if (result.canonicalProducts === 0 && result.canonicalRefGroups === 0) {
        alert('No hay productos ni referencias duplicadas.');
        return;
      }
      setPreview({
        mode: 'products',
        productGroups: result.productGroups,
        variantGroups: result.variantGroups,
        summary:
          `Se encontraron ${result.mergedProducts} productos duplicados ` +
          `en ${result.canonicalProducts} nombres distintos` +
          (result.canonicalRefGroups
            ? ` y ${result.mergedVariants} variantes duplicadas en ` +
              `${result.canonicalRefGroups} referencias.`
            : '.'),
      });
    } catch (e) {
      console.error('Product dedup preview failed', e);
      alert('No se pudo generar la vista previa: ' + (e?.message || e));
    } finally {
      setBusyMode(null);
    }
  }

  async function previewAll() {
    if (busyMode) return;
    setBusyMode('all');
    try {
      // Product dryRun already includes the variant dryRun inside, so a
      // single call gives us both lists.
      const result = await dedupProductsByName({ dryRun: true });
      if (result.canonicalProducts === 0 && result.canonicalRefGroups === 0) {
        alert('El catálogo ya está limpio. No hay productos ni referencias duplicadas.');
        return;
      }
      const parts = [];
      if (result.canonicalProducts > 0) {
        parts.push(
          `${result.mergedProducts} productos duplicados en ` +
          `${result.canonicalProducts} nombres distintos`,
        );
      }
      if (result.canonicalRefGroups > 0) {
        parts.push(
          `${result.mergedVariants} variantes duplicadas en ` +
          `${result.canonicalRefGroups} referencias`,
        );
      }
      setPreview({
        mode: 'all',
        productGroups: result.productGroups,
        variantGroups: result.variantGroups,
        summary: 'Se encontraron ' + parts.join(' y ') + '.',
      });
    } catch (e) {
      console.error('Combined dedup preview failed', e);
      alert('No se pudo generar la vista previa: ' + (e?.message || e));
    } finally {
      setBusyMode(null);
    }
  }

  async function applyPreview() {
    if (!preview || applying) return;
    setApplying(true);
    try {
      let msg;
      if (preview.mode === 'variants') {
        const r = await dedupCatalogReferences();
        msg = `Listo. Se fusionaron ${r.mergedVariants} variantes en ` +
              `${r.canonicalGroups} filas canónicas; se redirigieron ` +
              `${r.repointedLines} líneas de cotización.`;
      } else if (preview.mode === 'products') {
        const r = await dedupProductsByName();
        msg = `Listo. Se fusionaron ${r.mergedProducts} productos en ` +
              `${r.canonicalProducts} entradas canónicas; ` +
              `se fusionaron ${r.mergedVariants} variantes y se redirigieron ` +
              `${r.repointedLines} líneas de cotización.`;
      } else {
        // 'all' — product dedup already chains the variant sweep at the end.
        const r = await dedupProductsByName();
        // Run variant dedup a second time to also catch ref groups that
        // didn't involve a product merge.
        const v = await dedupCatalogReferences();
        msg = `Listo. Se fusionaron ${r.mergedProducts} productos y ` +
              `${r.mergedVariants + v.mergedVariants} variantes; ` +
              `se redirigieron ${r.repointedLines + v.repointedLines} ` +
              `líneas de cotización.`;
      }
      setPreview(null);
      alert(msg);
    } catch (e) {
      console.error('Dedup apply failed', e);
      alert('No se pudo completar la limpieza: ' + (e?.message || e));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="card card-pad">
      <h2 className="font-semibold mb-3 flex items-center gap-2"><Wrench size={16} /> Mantenimiento del catálogo</h2>
      <p className="text-xs text-ink-500 mb-3">
        Une productos con el mismo nombre + diseñador y variantes con la
        misma referencia (ignora mayúsculas, acentos, espacios invisibles
        y signos). Verás una vista previa antes de aplicar; las
        cotizaciones existentes se redirigen automáticamente a la entrada
        canónica.
      </p>
      <button
        type="button"
        onClick={previewAll}
        disabled={!!busyMode}
        className="btn-primary w-full"
      >
        {busyMode === 'all' ? 'Buscando…' : 'Limpiar todo el catálogo'}
      </button>
      <div className="grid grid-cols-1 gap-2 mt-3">
        <button
          type="button"
          onClick={previewProducts}
          disabled={!!busyMode}
          className="btn-secondary w-full"
        >
          {busyMode === 'products' ? 'Buscando…' : 'Solo productos duplicados'}
        </button>
        <button
          type="button"
          onClick={previewVariants}
          disabled={!!busyMode}
          className="btn-secondary w-full"
        >
          {busyMode === 'variants' ? 'Buscando…' : 'Solo referencias duplicadas'}
        </button>
      </div>

      <div className="mt-5 pt-4 border-t border-ink-100">
        <h3 className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-2">Zona peligrosa</h3>
        <p className="text-xs text-ink-500 mb-2">
          Elimina todo el catálogo: productos, variantes, materiales, colores,
          categorías y sus imágenes. Las cotizaciones existentes se conservan
          pero sus líneas quedarán sin producto / material asignado.
        </p>
        <DeleteCatalogButton disabled={!!busyMode} />
      </div>

      <Modal
        open={!!preview}
        onClose={closeModal}
        size="lg"
        title="Vista previa de limpieza del catálogo"
        footer={
          <>
            <button
              type="button"
              onClick={closeModal}
              disabled={applying}
              className="btn-ghost"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={applyPreview}
              disabled={applying}
              className="btn-primary"
            >
              {applying ? 'Aplicando…' : 'Confirmar y aplicar'}
            </button>
          </>
        }
      >
        {preview && <DedupPreviewBody preview={preview} />}
      </Modal>
    </div>
  );
}

function DeleteCatalogButton({ disabled }) {
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [working, setWorking] = useState(false);

  const matched = phrase.trim().toLowerCase() === CATALOG_PURGE_PHRASE;

  function reset() {
    setPhrase('');
    setWorking(false);
    setOpen(false);
  }

  async function confirmDelete() {
    if (!matched || working) return;
    setWorking(true);
    try {
      const counts = await purgeCatalog();
      reset();
      alert(
        `Catálogo eliminado:\n` +
        `· ${counts.products} productos\n` +
        `· ${counts.variants} variantes\n` +
        `· ${counts.materials} materiales\n` +
        `· ${counts.materialColors} colores\n` +
        `· ${counts.categories} categorías\n` +
        `· ${counts.imageRows} imágenes (${counts.storageObjects} archivos en almacenamiento)`
      );
    } catch (e) {
      setWorking(false);
      alert('No se pudo eliminar el catálogo: ' + (e?.message || e));
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="btn w-full bg-red-600 text-white hover:bg-red-700"
      >
        Eliminar catálogo completo
      </button>
      <Modal
        open={open}
        onClose={() => !working && reset()}
        size="md"
        title="Eliminar catálogo completo"
        footer={
          <>
            <button
              type="button"
              onClick={reset}
              disabled={working}
              className="btn-ghost"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={!matched || working}
              className="btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:pointer-events-none"
            >
              {working ? 'Eliminando…' : 'Eliminar catálogo'}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-ink-700">
            Esta acción <b>no se puede deshacer</b>. Se eliminarán todos los
            productos, variantes, materiales, colores, categorías y sus
            imágenes (tanto las filas como los archivos en almacenamiento).
          </p>
          <p className="text-sm text-ink-700">
            Las cotizaciones y los contenedores se conservan, pero sus líneas
            quedarán sin referencia a productos / materiales.
          </p>
          <div>
            <label className="text-xs font-medium text-ink-600 mb-1.5 block uppercase tracking-wide">
              Para confirmar, escribe <code className="kbd">delete catalog</code>
            </label>
            <input
              type="text"
              className="input"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder="delete catalog"
              disabled={working}
            />
          </div>
        </div>
      </Modal>
    </>
  );
}

function DedupPreviewBody({ preview }) {
  const { productGroups, variantGroups, summary } = preview;
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-700">{summary}</p>
      <p className="text-xs text-ink-500">
        En cada grupo, la primera fila (resaltada) es la entrada que se
        conserva (la canónica). Las filas siguientes se fusionarán en ella
        y luego se eliminarán.
      </p>

      {productGroups.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2">
            Productos duplicados ({productGroups.length} grupos,{' '}
            {productGroups.reduce((n, g) => n + g.losers.length, 0)} a fusionar)
          </h3>
          <div className="space-y-3 max-h-72 overflow-y-auto rounded-md border border-ink-100 p-2 bg-ink-50/40">
            {productGroups.map((g) => (
              <ProductGroup key={g.key} group={g} />
            ))}
          </div>
        </section>
      )}

      {variantGroups.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2">
            Referencias duplicadas ({variantGroups.length} grupos,{' '}
            {variantGroups.reduce((n, g) => n + g.losers.length, 0)} a fusionar)
          </h3>
          <div className="space-y-3 max-h-72 overflow-y-auto rounded-md border border-ink-100 p-2 bg-ink-50/40">
            {variantGroups.map((g) => (
              <VariantGroup key={g.key} group={g} />
            ))}
          </div>
        </section>
      )}

      {productGroups.length === 0 && variantGroups.length === 0 && (
        <p className="text-sm text-ink-500">Nada que limpiar.</p>
      )}
    </div>
  );
}

function ProductGroup({ group }) {
  const rows = [{ row: group.winner, winner: true }, ...group.losers.map((row) => ({ row, winner: false }))];
  return (
    <div className="rounded-md bg-white border border-ink-100">
      <table className="w-full text-xs">
        <tbody>
          {rows.map(({ row, winner }) => (
            <tr key={row.id} className={winner ? 'bg-brand-50' : ''}>
              <td className="px-3 py-1.5 w-16 text-[10px] font-medium uppercase tracking-wider text-ink-500">
                {winner ? 'Conservar' : 'Fusionar'}
              </td>
              <td className="px-3 py-1.5 font-medium">{row.name || <span className="text-ink-400">(sin nombre)</span>}</td>
              <td className="px-3 py-1.5 text-ink-500">{row.designer || ''}</td>
              <td className="px-3 py-1.5 text-ink-400 text-[10px]">{row.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VariantGroup({ group }) {
  const rows = [{ row: group.winner, winner: true }, ...group.losers.map((row) => ({ row, winner: false }))];
  return (
    <div className="rounded-md bg-white border border-ink-100">
      <table className="w-full text-xs">
        <tbody>
          {rows.map(({ row, winner }) => (
            <tr key={row.id} className={winner ? 'bg-brand-50' : ''}>
              <td className="px-3 py-1.5 w-16 text-[10px] font-medium uppercase tracking-wider text-ink-500">
                {winner ? 'Conservar' : 'Fusionar'}
              </td>
              <td className="px-3 py-1.5 font-mono">{row.reference || <span className="text-ink-400">(sin ref.)</span>}</td>
              <td className="px-3 py-1.5 text-ink-500">{row.name || ''}</td>
              <td className="px-3 py-1.5 text-ink-400 text-[10px]">{row.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RateCard({ local, set, saveSettings }) {
  const bpd = local.bpd || { buy: null, sell: null, updatedAt: null };
  const market = local.market || { rate: null, date: null, source: null };
  const mode = local.dopRateMode || 'bpd-sell';
  const [fetching, setFetching] = useState(false);
  const [fetchErr, setFetchErr] = useState(null);

  function setBpd(patch) {
    set('bpd', { ...bpd, ...patch, updatedAt: Date.now() });
  }

  async function refreshMarket() {
    setFetching(true);
    setFetchErr(null);
    const result = await fetchMarketRate();
    if (result) {
      set('market', result);
    } else {
      setFetchErr('No se pudo obtener la tasa de mercado.');
    }
    setFetching(false);
  }

  const eff = effectiveDopRate(local);
  const sample = (10000 / eff).toFixed(2); // USD a comprar con 10,000 pesos
  const sampleInverse = (100 * eff).toLocaleString('en-US', { maximumFractionDigits: 0 });

  return (
    <div className="card card-pad">
      <h2 className="font-semibold mb-2">Tasa de cambio USD → DOP</h2>
      <p className="text-xs text-ink-500 mb-4">
        Los precios del catálogo están en USD (lista oficial Ligne Roset). Aquí defines la tasa que se aplica para convertir a pesos dominicanos en cotizaciones.
      </p>

      {/* Mode selector */}
      <div className="label">Tasa que usar al cotizar</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
        {[
          { key: 'bpd-sell', label: 'BPD — Venta', hint: 'Para cobrar al cliente' },
          { key: 'bpd-buy', label: 'BPD — Compra', hint: 'Si te paga en USD' },
          { key: 'market', label: 'Mercado', hint: 'open.er-api.com' },
          { key: 'custom', label: 'Personalizada', hint: 'Manual abajo' },
        ].map((opt) => (
          <button
            key={opt.key}
            type="button"
            onClick={() => set('dopRateMode', opt.key)}
            className={`text-left rounded-md border px-3 py-2 transition ${mode === opt.key ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 hover:border-ink-400'}`}
          >
            <div className="text-sm font-medium">{opt.label}</div>
            <div className={`text-[10px] mt-0.5 ${mode === opt.key ? 'text-ink-300' : 'text-ink-500'}`}>{opt.hint}</div>
          </button>
        ))}
      </div>

      {/* BPD rates */}
      <div className="rounded-md border border-ink-100 bg-ink-50 px-4 py-3 mb-3">
        <div className="flex items-center justify-between mb-2">
          <div className="font-medium text-sm">Banco Popular Dominicano</div>
          <a href={BPD_PUBLIC_URL} target="_blank" rel="noreferrer" className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1">
            popularenlinea.com <ExternalLink size={10} />
          </a>
        </div>
        <p className="text-[11px] text-ink-500 mb-3">
          Actualiza desde la app del BPD o su sitio web. La tasa de venta es la que paga tu cliente al adquirir USD.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-ink-600">Compra (RD$ por 1 USD)</div>
            <input
              type="number"
              step="0.01"
              className="input mt-1"
              value={bpd.buy ?? ''}
              onChange={(e) => setBpd({ buy: e.target.value === '' ? null : Number(e.target.value) })}
              placeholder="58.50"
            />
          </div>
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-ink-600">Venta (RD$ por 1 USD)</div>
            <input
              type="number"
              step="0.01"
              className="input mt-1"
              value={bpd.sell ?? ''}
              onChange={(e) => setBpd({ sell: e.target.value === '' ? null : Number(e.target.value) })}
              placeholder="62.00"
            />
          </div>
        </div>
        {bpd.updatedAt && (
          <div className="text-[10px] text-ink-500 mt-2">
            Actualizado {formatDateTime(bpd.updatedAt)}
          </div>
        )}
      </div>

      {/* Market */}
      <div className="rounded-md border border-ink-100 px-4 py-3 mb-3">
        <div className="flex items-center justify-between mb-2">
          <div className="font-medium text-sm">Tasa de mercado</div>
          <button
            type="button"
            onClick={refreshMarket}
            disabled={fetching}
            className="btn-ghost text-xs"
          >
            <RefreshCw size={11} className={fetching ? 'animate-spin' : ''} />
            {fetching ? 'Obteniendo…' : 'Actualizar'}
          </button>
        </div>
        <div className="text-sm">
          {market.rate ? (
            <span>1 USD ≈ <b>{Number(market.rate).toFixed(2)} DOP</b></span>
          ) : (
            <span className="text-ink-500">Sin datos. Haz clic en <b>Actualizar</b>.</span>
          )}
        </div>
        {market.date && (
          <div className="text-[10px] text-ink-500 mt-1">
            {market.source} · {market.date}
          </div>
        )}
        {fetchErr && <div className="text-[11px] text-red-600 mt-1">{fetchErr}</div>}
      </div>

      {/* Custom */}
      {mode === 'custom' && (
        <div className="rounded-md border border-ink-100 px-4 py-3 mb-3">
          <div className="label">Tasa personalizada (RD$ por 1 USD)</div>
          <input
            type="number"
            step="0.01"
            className="input"
            value={local.currencyRates?.DOP ?? ''}
            onChange={(e) => set('currencyRates', { ...(local.currencyRates || {}), USD: 1, DOP: Number(e.target.value) || 0 })}
          />
        </div>
      )}

      {/* Effective */}
      <div className="rounded-md bg-brand-50 border border-brand-200 px-4 py-3">
        <div className="text-[10px] font-medium uppercase tracking-wider text-brand-700">Tasa efectiva</div>
        <div className="text-xl font-semibold text-brand-900 mt-0.5">
          1 USD = {eff.toFixed(2)} DOP
        </div>
        <div className="text-[11px] text-brand-700 mt-1">
          RD$ 100 ≈ US$ {sample} · US$ 100 ≈ RD$ {sampleInverse}
        </div>
      </div>

      {/* Default currency */}
      <div className="mt-4">
        <div className="label">Moneda por defecto al mostrar precios</div>
        <select className="input max-w-[160px]" value={local.defaultCurrency || 'DOP'} onChange={(e) => set('defaultCurrency', e.target.value)}>
          <option value="DOP">DOP — Pesos dominicanos</option>
          <option value="USD">USD — Dólares</option>
        </select>
      </div>
    </div>
  );
}
