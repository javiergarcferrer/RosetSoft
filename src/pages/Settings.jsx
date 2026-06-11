import { useEffect, useState } from 'react';
import { RefreshCw, Check, AlertTriangle, Shield, Loader2, ChevronDown } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ImageDrop from '../components/ImageDrop.jsx';
import { useApp } from '../context/AppContext.jsx';
import { effectiveDopRate } from '../lib/exchangeRate.js';
import { EXCHANGE_RATE_PULL_ENABLED } from '../lib/constants.js';
import { formatDateTime } from '../lib/format.js';
import { saveShopifyConfig, syncShopify, pingShopify, SHOPIFY_STORE_ALCOVER, SHOPIFY_STORE_LSG } from '../lib/shopifySync.js';
import WhatsAppCard from '../components/settings/WhatsAppCard.jsx';
import { clampPct } from '../lib/pricing.js';
import { userMessageFor } from '../lib/errorMessages.js';
import { db } from '../db/database.js';
import { useLiveQuery } from '../db/hooks.js';
import { storeLinkUrl } from '../lib/storefront.js';
import { useExchangeRatePull } from '../lib/useExchangeRatePull.js';

export default function Settings() {
  const { profileId, settings, saveSettings, isAdmin } = useApp();
  const customers = useLiveQuery(
    () => db.customers.where('profileId').equals(profileId || '').toArray(),
    [profileId], [],
  );
  const [local, setLocal] = useState(settings || {});
  const [saveState, setSaveState] = useState('idle'); // 'idle' | 'saving' | 'saved' | 'error'
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    setLocal(settings || {});
  }, [settings]);

  function set(k, v) { setLocal((s) => ({ ...s, [k]: v })); }

  async function save() {
    if (saveState === 'saving') return;
    setSaveState('saving');
    setSaveError(null);
    try {
      // The rate's single source of truth is settings.exchangeRate — nothing
      // derived to keep in sync here, so just persist the form as-is.
      await saveSettings(local);
      setSaveState('saved');
      // Drop the "Guardado" badge after a beat so the button is reusable.
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (e) {
      console.error('saveSettings failed', e);
      setSaveError(userMessageFor(e));
      setSaveState('error');
    }
  }

  // Configuración is admin-only: company info, exchange rates,
  // commission defaults, etc. Employees typing /settings in the URL
  // bar see the same restricted-access screen as on other admin
  // routes (same pattern as admin/Users + admin/Commissions).
  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Configuración" subtitle=" " />
        <EmptyState
          icon={Shield}
          title="Acceso restringido"
          description="Solo administradores pueden ver o modificar la configuración del equipo."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Configuración" subtitle="Empresa, tasa de cambio, condiciones y datos" actions={
        <button
          onClick={save}
          disabled={saveState === 'saving'}
          className={[
            'btn-primary active:scale-[0.98] transition-all disabled:opacity-60 disabled:cursor-wait',
            saveState === 'saved' ? '!bg-emerald-600 !border-emerald-600' : '',
          ].join(' ')}
        >
          {saveState === 'saving' && <><RefreshCw size={14} className="animate-spin" aria-hidden /> Guardando…</>}
          {saveState === 'saved' && <><Check size={14} aria-hidden /> Guardado</>}
          {(saveState === 'idle' || saveState === 'error') && 'Guardar cambios'}
        </button>
      } />
      {saveState === 'error' && saveError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 mb-5 text-sm text-red-700 min-w-0">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" aria-hidden />
          <span className="min-w-0 break-words">No se pudo guardar: {saveError}</span>
        </div>
      )}

      {/* Settings is a single-column layout now. The right sidebar used
          to carry the "Lista de precios" upload and a static "Almacenamiento"
          info card; both were removed, so there's nothing left to put in
          a second column. */}
      <div className="space-y-5">
          {/* Company */}
          <div className="card card-pad">
            <div className="card-header -mx-5 -mt-5 mb-4">
              <h2 className="font-semibold">Empresa</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-4">
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
                    <input
                      className="input"
                      value={local.companyName || ''}
                      onChange={(e) => set('companyName', e.target.value)}
                      autoComplete="organization"
                      autoCapitalize="words"
                    />
                  </div>
                  <div className="grid grid-cols-1 min-[480px]:grid-cols-2 gap-3">
                    <div>
                      <div className="label">Teléfono</div>
                      <input
                        className="input"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        value={local.companyPhone || ''}
                        onChange={(e) => set('companyPhone', e.target.value)}
                      />
                    </div>
                    <div>
                      <div className="label">Correo</div>
                      <input
                        className="input"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        value={local.companyEmail || ''}
                        onChange={(e) => set('companyEmail', e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div className="sm:col-span-2">
                <div className="label">Dirección</div>
                <textarea className="input min-h-[60px]" value={local.companyAddress || ''} onChange={(e) => set('companyAddress', e.target.value)} placeholder="Calle, ciudad, provincia, R.D." />
              </div>
              <div className="sm:col-span-2">
                <div className="label">Correo de Ligne Roset (reporte de ventas)</div>
                <input
                  className="input"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={local.lrReportEmail || ''}
                  onChange={(e) => set('lrReportEmail', e.target.value)}
                  placeholder="ventas@ligne-roset.com"
                />
                <p className="text-xs text-ink-500 mt-1">Destinatario del reporte mensual de ventas de piso (Ventas → Ventas Ligne Roset).</p>
              </div>
            </div>
          </div>

          {/* Currency (DR-focused) */}
          <RateCard local={local} set={set} saveSettings={saveSettings} />

          {/* Defaults */}
          <div className="card card-pad">
            <div className="card-header -mx-5 -mt-5 mb-4">
              <h2 className="font-semibold">Predeterminados de cotización</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="label">Descuento por defecto %</div>
                <input className="input" type="number" min="0" max="100" inputMode="decimal" enterKeyHint="done" value={local.defaultDiscountPct ?? 0} onChange={(e) => set('defaultDiscountPct', clampPct(e.target.value))} />
              </div>
              <div>
                <div className="label">ITBIS</div>
                <div className="input bg-ink-50 text-ink-500 cursor-not-allowed">18% (fijo)</div>
              </div>
              <div className="sm:col-span-2">
                <div className="label">Términos (se imprimen en el PDF)</div>
                <textarea className="input min-h-[100px]" value={local.quoteTerms || ''} onChange={(e) => set('quoteTerms', e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <div className="label">Pie de página (en cada página del PDF)</div>
                <input className="input" value={local.quoteFooter || ''} onChange={(e) => set('quoteFooter', e.target.value)} />
              </div>
            </div>
          </div>

        {/* Orders */}
        <OrdersCard local={local} set={set} />

        {/* Public storefront */}
        <StoreCard settings={settings} saveSettings={saveSettings} customers={customers} />

        {/* WhatsApp Business (Cloud API) */}
        <WhatsAppCard settings={settings} saveSettings={saveSettings} />

        {/* Shopify connections — one per store. */}
        <ShopifyCard settings={settings} store={SHOPIFY_STORE_ALCOVER} />
        <ShopifyCard settings={settings} store={SHOPIFY_STORE_LSG} />
      </div>
    </>
  );
}

// Public storefront ("Tienda") config: pick the house-account customer whose
// quotes stock the store, and surface the shareable public link.
//
// The customer choice AUTO-SAVES the instant it changes — it does NOT ride the
// page-level "Guardar". It used to live in the shared `local` form state, which
// the parent resets from `settings` on every refresh (the realtime settings
// channel, the rate pull, …), so a pick made before pressing Guardar got wiped
// and "couldn't be saved". Persisting on change, like the rate card does, fixes
// that and gives immediate feedback. Self-contained: reads the saved value off
// `settings`, writes through `saveSettings`.
function StoreCard({ settings, saveSettings, customers }) {
  const url = storeLinkUrl();
  const [copied, setCopied] = useState(false);
  const [value, setValue] = useState(settings?.storeCustomerId || '');
  const [status, setStatus] = useState('idle'); // idle | saving | saved | error
  // Re-sync to the persisted value when it changes elsewhere / after a save.
  useEffect(() => { setValue(settings?.storeCustomerId || ''); }, [settings?.storeCustomerId]);

  const sorted = [...(customers || [])].sort((a, b) =>
    (a.company || a.name || '').localeCompare(b.company || b.name || ''));

  async function pick(e) {
    const next = e.target.value || null;
    setValue(next || '');       // optimistic — the select reflects the choice now
    setStatus('saving');
    try {
      await saveSettings({ storeCustomerId: next });
      setStatus('saved');
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (err) {
      console.error('store customer save failed', err);
      setStatus('error');
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the field is selectable as a fallback */ }
  }

  return (
    <div className="card card-pad">
      <div className="card-header -mx-5 -mt-5 mb-4">
        <h2 className="font-semibold">Tienda pública</h2>
      </div>
      <p className="text-xs text-ink-500 mb-4">
        La tienda muestra los productos de las cotizaciones cuyo cliente sea la
        cuenta de la casa (ALCOVER). Elige ese cliente y comparte el enlace —
        cualquiera puede verlo sin iniciar sesión.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="label inline-flex items-center gap-2">
            Cliente de la casa
            {status === 'saving' && <span className="text-[11px] font-normal text-ink-400">Guardando…</span>}
            {status === 'saved' && <span className="text-[11px] font-normal text-emerald-700 inline-flex items-center gap-0.5"><Check size={11} /> Guardado</span>}
            {status === 'error' && <span className="text-[11px] font-normal text-red-600">No se pudo guardar</span>}
          </div>
          <select
            className="input"
            value={value}
            onChange={pick}
          >
            <option value="">— Selecciona un cliente —</option>
            {sorted.map((c) => (
              <option key={c.id} value={c.id}>
                {c.company || c.name}
                {c.company && c.name && c.company !== c.name ? ` · ${c.name}` : ''}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-ink-500 mt-1.5">
            Se guarda automáticamente. Sus cotizaciones (excepto rechazadas y archivadas) surten la tienda.
          </p>
        </div>
        <div>
          <div className="label">Enlace público</div>
          <div className="flex flex-col gap-2 min-[400px]:flex-row min-[400px]:flex-wrap min-[400px]:items-center">
            <input
              className="input w-full min-[400px]:flex-1 min-w-0 font-mono text-xs text-ink-600"
              readOnly
              value={url}
              onFocus={(e) => e.target.select()}
            />
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={copy}
                className={`btn-ghost text-xs whitespace-nowrap active:scale-[0.97] transition-all ${copied ? '!text-emerald-700 !border-emerald-200' : ''}`}
              >
                {copied ? <><Check size={12} aria-hidden /> Copiado</> : 'Copiar'}
              </button>
              <a href={url} target="_blank" rel="noreferrer" className="btn-ghost text-xs whitespace-nowrap active:scale-[0.97] transition-transform">
                Abrir
              </a>
            </div>
          </div>
          <p className="text-[11px] text-ink-500 mt-1.5">
            Compártelo con tus clientes — no requiere iniciar sesión.
          </p>
        </div>
      </div>
    </div>
  );
}

function OrdersCard({ local, set }) {
  return (
    <div className="card card-pad">
      <div className="card-header -mx-5 -mt-5 mb-4">
        <h2 className="font-semibold">Pedidos</h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="label">Monto mínimo para despacho (USD)</div>
          <input
            className="input"
            type="number"
            min="0"
            step="100"
            inputMode="decimal"
            enterKeyHint="done"
            value={local.dispatchThreshold ?? 50000}
            onChange={(e) => set('dispatchThreshold', Math.max(0, Number(e.target.value) || 0))}
          />
          <p className="text-[11px] text-ink-500 mt-1.5">
            Un contenedor llega al estado &ldquo;listo para cerrar&rdquo; al alcanzar este monto.
          </p>
        </div>
      </div>
    </div>
  );
}


function RateCard({ local, set, saveSettings }) {
  // Banco Popular's published rate, stored under `settings.exchangeRate`.
  // The daily auto-pull and "Actualizar ahora" are the usual writers; the
  // manual override below is a stopgap until the BPD subscription is live.
  // Legacy `bsc` / `bpd` shapes are read as fallbacks — see readExchangeRate.
  const rate = local.exchangeRate || local.bsc || local.bpd || { buy: null, sell: null, updatedAt: null };

  // "Actualizar ahora": pull Banco Popular's published rate on demand. The
  // Edge Function writes settings.exchange_rate server-side (OAuth secret
  // never reaches the browser); the hook re-reads settings so the new figure
  // shows here and across the app immediately, not on the next daily pull.
  const { pull: fetchNow, pulling: fetching, error: fetchErr } = useExchangeRatePull();

  // Manual override — a stopgap while the BPD subscription is approved.
  // Writes settings.exchangeRate (the single source of truth), so the app
  // quotes on it immediately. A later successful pull overwrites it; a
  // failed pull (e.g. a 401) never does.
  const [manualBuy, setManualBuy] = useState('');
  const [manualSell, setManualSell] = useState('');
  const [savingManual, setSavingManual] = useState(false);
  const [manualErr, setManualErr] = useState(null);
  const [manualOk, setManualOk] = useState(false);
  useEffect(() => {
    setManualBuy(rate.buy ?? '');
    setManualSell(rate.sell ?? '');
  }, [rate.buy, rate.sell]);
  async function saveManual() {
    const sell = Number(manualSell);
    if (!sell || sell <= 0) { setManualErr('Ingresa una tasa de venta válida.'); return; }
    const buy = manualBuy === '' ? sell : Number(manualBuy);
    setSavingManual(true); setManualErr(null); setManualOk(false);
    try {
      await saveSettings({ exchangeRate: { buy, sell, updatedAt: Date.now() } });
      setManualOk(true);
    } catch (e) {
      setManualErr(e?.message || 'No se pudo guardar la tasa.');
    } finally {
      setSavingManual(false);
    }
  }

  const eff = effectiveDopRate(local);
  const sample = (10000 / eff).toFixed(2);
  const sampleInverse = (100 * eff).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const fmt = (n) => (n == null || n === '' ? '—' : Number(n).toFixed(2));

  return (
    <div className="card card-pad">
      <div className="card-header -mx-5 -mt-5 mb-4">
        <h2 className="font-semibold">Tasa de cambio USD → DOP</h2>
      </div>
      <p className="text-xs text-ink-500 mb-4">
        Los precios del catálogo están en USD (lista oficial Ligne Roset). La tasa la publica Banco Popular Dominicano: tráela con el botón “Actualizar ahora”, o ajústala manualmente más abajo. {EXCHANGE_RATE_PULL_ENABLED
          ? 'Además se actualiza sola al abrir la app cada día.'
          : '(La actualización automática diaria se activará en producción.)'} Se cotiza con la tasa de venta.
      </p>

      {/* Bank logo shown SMALL next to the converted DOP rate on the client
          link + PDF. Upload the official Banco Popular logo (SVG or PNG) once;
          it lives in your storage, not the codebase. */}
      <div className="mb-4 flex items-start gap-3 min-w-0">
        <ImageDrop
          imageId={local.rateLogoImageId}
          onChange={(id) => set('rateLogoImageId', id)}
          kind="logo"
          label="Logo del banco"
          imgClassName="h-12 w-12 object-contain bg-white rounded-md border border-ink-100"
        />
        <p className="text-[11px] text-ink-500 min-w-0">
          Se muestra pequeño junto a la tasa (“≈ RD$ … DOP/USD”) en el enlace del
          cliente y el PDF. Sube el logo de Banco Popular (SVG o PNG).
        </p>
      </div>

      {/* Banco Popular — read-only. The dealer can't adjust it; the daily
          job and the button below are the only writers. */}
      <div className="rounded-lg border border-ink-100 bg-ink-50/70 px-4 py-3.5 mb-3">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="font-medium text-sm text-ink-800">Banco Popular Dominicano</div>
          <button
            type="button"
            onClick={fetchNow}
            disabled={fetching}
            className="btn-ghost text-xs disabled:opacity-60 disabled:cursor-wait active:scale-[0.97] transition-transform"
            title="Trae ahora la tasa USD publicada por Banco Popular Dominicano"
          >
            <RefreshCw size={13} className={fetching ? 'animate-spin' : ''} />
            {fetching ? 'Actualizando…' : 'Actualizar ahora'}
          </button>
        </div>
        {fetchErr && (
          <div className="text-[11px] text-red-600 mb-3 flex items-start gap-1.5 bg-red-50 border border-red-100 rounded-md px-2.5 py-1.5">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" /> {fetchErr}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-white border border-ink-100 shadow-xs px-3 py-2.5">
            <div className="eyebrow-xs font-medium tracking-wide">Compra</div>
            <div className="text-lg font-semibold text-ink-900 mt-1 tabular-nums">{fmt(rate.buy)}</div>
            <div className="text-[10px] text-ink-400 mt-0.5">RD$ por 1 USD</div>
          </div>
          <div className="rounded-lg bg-white border border-ink-100 shadow-xs px-3 py-2.5">
            <div className="eyebrow-xs font-medium tracking-wide">Venta</div>
            <div className="text-lg font-semibold text-ink-900 mt-1 tabular-nums">{fmt(rate.sell)}</div>
            <div className="text-[10px] text-ink-400 mt-0.5">RD$ por 1 USD · se cotiza con esta</div>
          </div>
        </div>
        <div className="text-[10px] text-ink-400 mt-2.5">
          {rate.updatedAt
            ? <>Actualizado {formatDateTime(rate.updatedAt)}</>
            : 'Aún sin datos — presiona “Actualizar ahora” o ajústala manualmente más abajo.'}
        </div>
      </div>

      {/* Manual override — stopgap until the BPD subscription is live. */}
      <details className="group rounded-lg border border-ink-100 mb-3 overflow-hidden">
        <summary className="flex items-center justify-between cursor-pointer select-none px-4 py-3 min-h-11 text-sm font-medium text-ink-700 hover:bg-ink-50/60 transition-colors list-none">
          <span>Ajustar tasa manualmente</span>
          <ChevronDown size={14} className="disclosure-chevron text-ink-400" aria-hidden />
        </summary>
        <div className="px-4 pb-4 pt-1 border-t border-ink-100 bg-ink-50/40">
          <p className="text-[11px] text-ink-500 mb-3 mt-2 leading-relaxed">
            Úsala mientras se conecta la API de Banco Popular. La tasa que guardes aquí se aplica a todas las cotizaciones nuevas hasta la próxima actualización automática.
          </p>
          <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-3">
            <div>
              <div className="label">Compra (RD$ / USD)</div>
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                className="input mt-1"
                value={manualBuy}
                onChange={(e) => { setManualBuy(e.target.value); setManualOk(false); setManualErr(null); }}
                placeholder="58.50"
              />
            </div>
            <div>
              <div className="label">Venta (se cotiza con esta)</div>
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                className="input mt-1"
                value={manualSell}
                onChange={(e) => { setManualSell(e.target.value); setManualOk(false); setManualErr(null); }}
                placeholder="62.00"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <button type="button" onClick={saveManual} disabled={savingManual} className="btn-primary text-xs disabled:opacity-60 disabled:cursor-wait active:scale-[0.98] transition-transform">
              {savingManual ? 'Guardando…' : 'Guardar tasa manual'}
            </button>
            {manualOk && (
              <span className="text-[11px] text-emerald-700 inline-flex items-center gap-1">
                <Check size={12} /> Guardada
              </span>
            )}
            {manualErr && (
              <span className="text-[11px] text-red-600 inline-flex items-center gap-1">
                <AlertTriangle size={12} /> {manualErr}
              </span>
            )}
          </div>
        </div>
      </details>

      {/* Effective */}
      <div className="rounded-lg bg-brand-50 border border-brand-200 px-4 py-3.5">
        <div className="eyebrow-xs font-medium tracking-wider text-brand-700">Tasa efectiva</div>
        <div className="text-xl font-semibold text-brand-900 mt-1 tabular-nums">
          1 USD = {eff.toFixed(2)} DOP
        </div>
        <div className="text-[11px] text-brand-700 mt-1 tabular-nums">
          RD$ 100 ≈ US$ {sample} · US$ 100 ≈ RD$ {sampleInverse}
        </div>
      </div>

      {/* Default currency */}
      <div className="mt-4">
        <div className="label">Moneda por defecto al mostrar precios</div>
        <select className="input w-full sm:max-w-[240px]" value={local.defaultCurrency || 'DOP'} onChange={(e) => set('defaultCurrency', e.target.value)}>
          <option value="DOP">DOP — Pesos dominicanos</option>
          <option value="USD">USD — Dólares</option>
        </select>
      </div>
    </div>
  );
}

/**
 * One Shopify connection card — the app talks to TWO stores, each with its own
 * custom app + Admin token:
 *   • alcover         — alcover.do, where the inventory sync PUBLISHES
 *     in-stock pieces ("Sincronizar todo" reconciles it).
 *   • lifestylegarden — lifestylegarden.do, where the brand catalog import
 *     PULLS from (the sync button lives on its Catálogos page).
 * The Admin token is saved through a write-only RPC (never read back); only
 * the domain + a "connected" timestamp surface here.
 */
const SHOPIFY_STORES = {
  [SHOPIFY_STORE_ALCOVER]: {
    title: 'Shopify — ALCOVER (inventario)',
    domainField: 'shopifyDomain',
    connectedField: 'shopifyConnectedAt',
    defaultDomain: 'alcoversdq.myshopify.com',
    description: <>Cada artículo en inventario con precio y foto se añade automáticamente a la tienda
      de <strong>alcover.do</strong> dentro de la colección <strong>Ligne Roset Inventory</strong>; al
      agotarse, se retira. Las ventas se pueden manejar desde Shopify o desde el cotizador.</>,
  },
  [SHOPIFY_STORE_LSG]: {
    title: 'Shopify — LifestyleGarden (catálogo)',
    domainField: 'shopifyLsgDomain',
    connectedField: 'shopifyLsgConnectedAt',
    defaultDomain: 'alcoversrl.myshopify.com',
    description: <>La tienda de <strong>lifestylegarden.do</strong> es la fuente del catálogo
      LifestyleGarden del cotizador. Conéctala aquí y sincroniza el catálogo
      desde <strong>Administración › Catálogos › LifestyleGarden</strong>.</>,
  },
};

function ShopifyCard({ settings, store }) {
  const cfg = SHOPIFY_STORES[store];
  const savedDomain = settings?.[cfg.domainField] || '';
  const [domain, setDomain] = useState(savedDomain || cfg.defaultDomain);
  // Credential mode: 'dashboard' = the CURRENT Shopify flow (a Dev Dashboard
  // app's Client ID + Client secret; the server mints short-lived tokens) —
  // 'token' = the legacy in-admin custom app's static shpat_ token.
  const [mode, setMode] = useState('dashboard');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('idle'); // idle | saving | saved | error
  const [msg, setMsg] = useState('');
  const [syncing, setSyncing] = useState(false);
  const connectedAt = settings?.[cfg.connectedField];

  useEffect(() => { setDomain(savedDomain || cfg.defaultDomain); }, [savedDomain, cfg.defaultDomain]);

  async function save() {
    setStatus('saving');
    setMsg('');
    try {
      await saveShopifyConfig(mode === 'dashboard'
        ? { domain, clientId, clientSecret, store }
        : { domain, token, store });
      setToken('');
      setClientSecret('');
      // Verify the token actually reaches the store before claiming success —
      // a bad or under-scoped credential is caught here, not later as "0 published".
      const ping = await pingShopify(store);
      if (ping?.ok) {
        const missing = ping.missingScopes || [];
        setStatus(missing.length ? 'error' : 'saved');
        setMsg(missing.length
          ? `Conectado a ${ping.shop}, pero la app no tiene estos permisos: ${missing.join(', ')}. Añádelos a la app en Shopify (y reinstálala en la tienda) y vuelve a guardar.`
          : `Conectado a ${ping.shop}. ✓`);
      } else {
        setStatus('error');
        setMsg(ping?.error || 'Guardado, pero no se pudo verificar la conexión con Shopify.');
      }
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 4000);
    } catch (e) {
      setStatus('error');
      setMsg(e?.message || 'No se pudo guardar.');
    }
  }

  async function syncAll() {
    setSyncing(true);
    setMsg('');
    try {
      const res = await syncShopify();
      if (res?.configured === false) {
        setStatus('error');
        setMsg('Conecta Shopify primero (guarda el token).');
      } else if (res?.error) {
        setStatus('error');
        setMsg(res.error);
      } else {
        const parts = [`${res?.synced ?? 0} publicado(s)`, `${res?.archived ?? 0} retirado(s)`];
        if (res?.skipped) parts.push(`${res.skipped} sin existencia o precio`);
        setStatus('saved');
        setMsg(`Sincronizado: ${parts.join(', ')}.${res?.errors?.length ? ` ${res.errors.length} con error.` : ''}`);
      }
    } catch (e) {
      setStatus('error');
      setMsg(e?.message || 'No se pudo sincronizar.');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="card card-pad">
      <div className="card-header -mx-5 -mt-5 mb-4">
        <h2 className="font-semibold">{cfg.title}</h2>
      </div>
      <p className="text-xs text-ink-500 mb-4">
        {cfg.description}{' '}
        Usa el dominio <code>.myshopify.com</code> de ESA tienda (p. ej. <code>{cfg.defaultDomain}</code>,
        no el dominio público). Crea la app en el <strong>Dev Dashboard</strong> (dev.shopify.com),
        instálala en la tienda con los permisos necesarios, y pega aquí el <strong>Client ID</strong> y
        el <strong>Client secret</strong> de su página Settings — el sistema obtiene los tokens por sí
        solo. (¿App personalizada clásica con token <code>shpat_…</code>? Cambia el modo abajo.)
      </p>
      <div className="mb-3 inline-flex rounded-md border border-ink-200 overflow-hidden text-xs font-medium select-none">
        {[['dashboard', 'App del Dev Dashboard'], ['token', 'Token clásico (shpat_)']].map(([m, label]) => (
          <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
            className={mode === m
              ? 'px-3 py-1.5 min-h-8 coarse:min-h-11 bg-ink-900 text-ink-50'
              : 'px-3 py-1.5 min-h-8 coarse:min-h-11 text-ink-600 hover:bg-ink-100 active:bg-ink-200 transition-colors'}>
            {label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label" htmlFor={`shopify-domain-${store}`}>Dominio</label>
          <input id={`shopify-domain-${store}`} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={cfg.defaultDomain}
            className="input mt-1" />
        </div>
        {mode === 'dashboard' ? (
          <>
            <div>
              <label className="label" htmlFor={`shopify-client-id-${store}`}>Client ID</label>
              <input id={`shopify-client-id-${store}`} value={clientId} onChange={(e) => setClientId(e.target.value)}
                placeholder="p. ej. 8b13…"
                className="input mt-1" />
            </div>
            <div>
              <label className="label" htmlFor={`shopify-client-secret-${store}`}>Client secret</label>
              <input id={`shopify-client-secret-${store}`} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)}
                placeholder={connectedAt ? '•••••••• (guardado)' : 'Secret de la app'}
                className="input mt-1" />
            </div>
          </>
        ) : (
          <div>
            <label className="label" htmlFor={`shopify-token-${store}`}>Admin API access token</label>
            <input id={`shopify-token-${store}`} type="password" value={token} onChange={(e) => setToken(e.target.value)}
              placeholder={connectedAt ? '•••••••• (guardado)' : 'shpat_…'}
              className="input mt-1" />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" onClick={save} disabled={status === 'saving'} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
          {status === 'saving' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar conexión
        </button>
        {store === SHOPIFY_STORE_ALCOVER && (
          <button type="button" onClick={syncAll} disabled={syncing} className="btn-ghost text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
            {syncing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Sincronizar todo
          </button>
        )}
        {connectedAt ? <span className="text-[11px] text-ink-400 min-w-0 truncate">Conectado · {formatDateTime(connectedAt)}</span> : null}
      </div>
      {msg && <p className={`text-xs mt-2 ${status === 'error' ? 'text-rose-600' : 'text-ink-500'}`}>{msg}</p>}
    </div>
  );
}
