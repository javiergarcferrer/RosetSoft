import { useEffect, useState } from 'react';
import { RefreshCw, Check, AlertTriangle, Shield, Loader2 } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ImageDrop from '../components/ImageDrop.jsx';
import { useApp } from '../context/AppContext.jsx';
import { effectiveDopRate } from '../lib/exchangeRate.js';
import { EXCHANGE_RATE_PULL_ENABLED } from '../lib/constants.js';
import { formatDateTime } from '../lib/format.js';
import { saveShopifyConfig, syncShopify } from '../lib/shopifySync.js';
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
        <button onClick={save} disabled={saveState === 'saving'} className="btn-primary">
          {saveState === 'saving' && <><RefreshCw size={14} className="animate-spin" /> Guardando…</>}
          {saveState === 'saved' && <><Check size={14} /> Guardado</>}
          {(saveState === 'idle' || saveState === 'error') && 'Guardar'}
        </button>
      } />
      {saveState === 'error' && saveError && (
        <div className="card card-pad mb-4 text-sm text-red-700 bg-red-50 border-red-200">
          No se pudo guardar: {saveError}
        </div>
      )}

      {/* Settings is a single-column layout now. The right sidebar used
          to carry the "Lista de precios" upload and a static "Almacenamiento"
          info card; both were removed, so there's nothing left to put in
          a second column. */}
      <div className="space-y-5">
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
                    <input
                      className="input"
                      value={local.companyName || ''}
                      onChange={(e) => set('companyName', e.target.value)}
                      autoComplete="organization"
                      autoCapitalize="words"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
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
              <div className="col-span-2">
                <div className="label">Dirección</div>
                <textarea className="input min-h-[60px]" value={local.companyAddress || ''} onChange={(e) => set('companyAddress', e.target.value)} placeholder="Calle, ciudad, provincia, R.D." />
              </div>
              <div className="col-span-2">
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
            <h2 className="font-semibold mb-3">Predeterminados de cotización</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="label">Descuento por defecto %</div>
                <input className="input" type="number" min="0" max="100" value={local.defaultDiscountPct ?? 0} onChange={(e) => set('defaultDiscountPct', clampPct(e.target.value))} />
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

        {/* Orders */}
        <OrdersCard local={local} set={set} />

        {/* Public storefront */}
        <StoreCard settings={settings} saveSettings={saveSettings} customers={customers} />

        {/* Shopify catalog sync */}
        <ShopifyCard settings={settings} />
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
      <h2 className="font-semibold mb-1">Tienda pública</h2>
      <p className="text-xs text-ink-500 mb-4">
        La tienda muestra los productos de las cotizaciones cuyo cliente sea la
        cuenta de la casa (Alcover). Elige ese cliente y comparte el enlace —
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
          <div className="flex items-center gap-2">
            <input
              className="input flex-1 font-mono text-xs"
              readOnly
              value={url}
              onFocus={(e) => e.target.select()}
            />
            <button type="button" onClick={copy} className="btn-ghost border border-ink-200 text-xs whitespace-nowrap">
              {copied ? 'Copiado' : 'Copiar'}
            </button>
            <a href={url} target="_blank" rel="noreferrer" className="btn-ghost border border-ink-200 text-xs whitespace-nowrap">
              Abrir
            </a>
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
      <h2 className="font-semibold mb-3">Pedidos</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="label">Monto mínimo para despacho (USD)</div>
          <input
            className="input"
            type="number"
            min="0"
            step="100"
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
      <h2 className="font-semibold mb-2">Tasa de cambio USD → DOP</h2>
      <p className="text-xs text-ink-500 mb-4">
        Los precios del catálogo están en USD (lista oficial Ligne Roset). La tasa la publica Banco Popular Dominicano: tráela con el botón “Actualizar ahora”, o ajústala manualmente más abajo. {EXCHANGE_RATE_PULL_ENABLED
          ? 'Además se actualiza sola al abrir la app cada día.'
          : '(La actualización automática diaria se activará en producción.)'} Se cotiza con la tasa de venta.
      </p>

      {/* Bank logo shown SMALL next to the converted DOP rate on the client
          link + PDF. Upload the official Banco Popular logo (SVG or PNG) once;
          it lives in your storage, not the codebase. */}
      <div className="mb-4 flex items-center gap-3">
        <ImageDrop
          imageId={local.rateLogoImageId}
          onChange={(id) => set('rateLogoImageId', id)}
          kind="logo"
          label="Logo del banco"
          imgClassName="h-12 w-12 object-contain bg-white rounded-md border border-ink-100"
        />
        <p className="text-[11px] text-ink-500 max-w-xs">
          Se muestra pequeño junto a la tasa (“≈ RD$ … DOP/USD”) en el enlace del
          cliente y el PDF. Sube el logo de Banco Popular (SVG o PNG).
        </p>
      </div>

      {/* Banco Popular — read-only. The dealer can't adjust it; the daily
          job and the button below are the only writers. */}
      <div className="rounded-md border border-ink-100 bg-ink-50 px-4 py-3 mb-3">
        <div className="flex items-center justify-between mb-3">
          <div className="font-medium text-sm">Banco Popular Dominicano</div>
          <button
            type="button"
            onClick={fetchNow}
            disabled={fetching}
            className="btn-ghost text-xs disabled:opacity-60 disabled:cursor-wait"
            title="Trae ahora la tasa USD publicada por Banco Popular Dominicano"
          >
            <RefreshCw size={13} className={fetching ? 'animate-spin' : ''} />
            {fetching ? 'Actualizando…' : 'Actualizar ahora'}
          </button>
        </div>
        {fetchErr && (
          <div className="text-[11px] text-red-600 mb-3 flex items-start gap-1">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" /> {fetchErr}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md bg-white border border-ink-100 px-3 py-2">
            <div className="eyebrow-xs font-medium tracking-wide">Compra</div>
            <div className="text-lg font-semibold text-ink-900 mt-0.5 tabular-nums">{fmt(rate.buy)}</div>
            <div className="text-[10px] text-ink-400">RD$ por 1 USD</div>
          </div>
          <div className="rounded-md bg-white border border-ink-100 px-3 py-2">
            <div className="eyebrow-xs font-medium tracking-wide">Venta</div>
            <div className="text-lg font-semibold text-ink-900 mt-0.5 tabular-nums">{fmt(rate.sell)}</div>
            <div className="text-[10px] text-ink-400">RD$ por 1 USD · se cotiza con esta</div>
          </div>
        </div>
        <div className="text-[10px] text-ink-500 mt-2">
          {rate.updatedAt
            ? <>Actualizado {formatDateTime(rate.updatedAt)}</>
            : 'Aún sin datos — presiona “Actualizar ahora” o ajústala manualmente más abajo.'}
        </div>
      </div>

      {/* Manual override — stopgap until the BPD subscription is live. */}
      <details className="rounded-md border border-ink-100 px-4 py-3 mb-3">
        <summary className="text-sm font-medium cursor-pointer select-none">Ajustar tasa manualmente</summary>
        <p className="text-[11px] text-ink-500 mt-2 mb-3">
          Úsala mientras se conecta la API de Banco Popular. La tasa que guardes aquí se aplica a todas las cotizaciones nuevas hasta la próxima actualización automática.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="eyebrow-xs font-medium tracking-wide text-ink-600">Compra (RD$ por 1 USD)</div>
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
            <div className="eyebrow-xs font-medium tracking-wide text-ink-600">Venta (se cotiza con esta)</div>
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
          <button type="button" onClick={saveManual} disabled={savingManual} className="btn-primary text-xs disabled:opacity-60 disabled:cursor-wait">
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
      </details>

      {/* Effective */}
      <div className="rounded-md bg-brand-50 border border-brand-200 px-4 py-3">
        <div className="eyebrow-xs font-medium tracking-wider text-brand-700">Tasa efectiva</div>
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

/**
 * Catálogo Shopify — connect the store and run a full sync. The Admin token is
 * saved through a write-only RPC (never read back); only the domain + a
 * "connected" timestamp surface here. "Sincronizar todo" reconciles the whole
 * catalog with current inventory (publish in-stock, archive sold-out).
 */
function ShopifyCard({ settings }) {
  const [domain, setDomain] = useState(settings?.shopifyDomain || '');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('idle'); // idle | saving | saved | error
  const [msg, setMsg] = useState('');
  const [syncing, setSyncing] = useState(false);
  const connectedAt = settings?.shopifyConnectedAt;

  useEffect(() => { setDomain(settings?.shopifyDomain || ''); }, [settings?.shopifyDomain]);

  async function save() {
    setStatus('saving');
    setMsg('');
    try {
      await saveShopifyConfig({ domain, token });
      setToken('');
      setStatus('saved');
      setMsg('Conexión guardada.');
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
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
      setMsg(res?.configured === false
        ? 'Conecta Shopify primero (guarda el token).'
        : `Sincronizado: ${res?.synced ?? 0} publicado(s), ${res?.archived ?? 0} retirado(s).`);
    } catch (e) {
      setMsg(e?.message || 'No se pudo sincronizar.');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="card card-pad">
      <h2 className="font-semibold mb-1">Catálogo Shopify</h2>
      <p className="text-xs text-ink-500 mb-4">
        Cada artículo en inventario con precio y foto se publica automáticamente en tu tienda Shopify;
        al agotarse, se retira. Pega el token de tu app personalizada de Shopify para conectar.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="label">Dominio
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="alcover.myshopify.com"
            className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-1.5 text-sm" />
        </label>
        <label className="label">Admin API token
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)}
            placeholder={connectedAt ? '•••••••• (guardado)' : 'shpat_…'}
            className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-1.5 text-sm" />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button type="button" onClick={save} disabled={status === 'saving'} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
          {status === 'saving' ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Guardar conexión
        </button>
        <button type="button" onClick={syncAll} disabled={syncing} className="btn-ghost text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
          {syncing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Sincronizar todo
        </button>
        {connectedAt ? <span className="text-[11px] text-ink-400">Conectado · {formatDateTime(connectedAt)}</span> : null}
      </div>
      {msg && <p className={`text-xs mt-2 ${status === 'error' ? 'text-rose-600' : 'text-ink-500'}`}>{msg}</p>}
    </div>
  );
}
