import { useEffect, useState } from 'react';
import { RefreshCw, Check, AlertTriangle, Shield, ChevronDown, Plus, Trash2 } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ImageDrop from '../components/ImageDrop.jsx';
import { useApp } from '../context/AppContext.jsx';
import { effectiveDopRate } from '../lib/exchangeRate.js';
import { EXCHANGE_RATE_PULL_ENABLED } from '../lib/constants.js';
import { formatDateTime } from '../lib/format.js';
import CredentialInput from '../components/settings/CredentialInput.jsx';
import SettingsSection from '../components/settings/SettingsSection.jsx';
import { clampPct } from '../lib/pricing.js';
import { userMessageFor } from '../lib/errorMessages.js';
import { db, newId } from '../db/database.js';
import { useLiveQuery } from '../db/hooks.js';
import { resolveTermsPresets } from '../core/quote/index.js';
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
      // userMessageFor routes the raw error through captureError (the admin
      // error console) — no need for a separate console.error.
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
        <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/40 px-4 py-3 mb-5 text-sm text-red-700 dark:text-red-200 min-w-0">
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
          <SettingsSection title="Empresa">
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
          </SettingsSection>

          {/* Currency (DR-focused) */}
          <RateCard local={local} set={set} saveSettings={saveSettings} />

          {/* Defaults */}
          <SettingsSection title="Predeterminados de cotización">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="label">Descuento por defecto %</div>
                <input className="input" type="number" min="0" max="100" inputMode="decimal" enterKeyHint="done" value={local.defaultDiscountPct ?? 0} onChange={(e) => set('defaultDiscountPct', clampPct(e.target.value))} />
              </div>
              <div>
                <label className="label" htmlFor="settings-itbis">ITBIS</label>
                <input
                  id="settings-itbis"
                  className="input bg-ink-50 text-ink-500 cursor-not-allowed"
                  value="18% (fijo)"
                  disabled
                  readOnly
                />
              </div>
              <div>
                <div className="label">Tasa mensual plan de pago %</div>
                <input className="input" type="number" min="0" step="0.01" inputMode="decimal" enterKeyHint="done" value={local.paymentPlanMonthlyRatePct ?? 2} onChange={(e) => set('paymentPlanMonthlyRatePct', Math.max(0, Number(e.target.value) || 0))} />
              </div>
              <QuoteTermsPresets local={local} set={set} />
              <div className="sm:col-span-2">
                <div className="label">Pie de página (en cada página del PDF)</div>
                <input className="input" value={local.quoteFooter || ''} onChange={(e) => set('quoteFooter', e.target.value)} />
              </div>
            </div>
          </SettingsSection>

        {/* Orders */}
        <OrdersCard local={local} set={set} />

        {/* Public storefront */}
        <StoreCard settings={settings} saveSettings={saveSettings} customers={customers} />
      </div>
    </>
  );
}

// Company account + public storefront config. ONE account, two roles:
//   1. It's the dealer's OWN account (Alcover quoting itself for store stock) —
//      hidden from the Clientes directory; its quotes are internal store-stock
//      orders priced at DEALER COST via the cost-discount field below.
//   2. Its quotes also stock the public storefront ("Tienda"), which shows
//      RETAIL prices (the cost discount never reaches it).
//
// Both fields AUTO-SAVE the instant they change — they do NOT ride the
// page-level "Guardar". They used to live in the shared `local` form state,
// which the parent resets from `settings` on every refresh (the realtime
// settings channel, the rate pull, …), so a pick made before pressing Guardar
// got wiped. Persisting on change, like the rate card does, fixes that and gives
// immediate feedback. Self-contained: reads the saved values off `settings`,
// writes through `saveSettings`.
function StoreCard({ settings, saveSettings, customers }) {
  const url = storeLinkUrl();
  const [copied, setCopied] = useState(false);
  const [value, setValue] = useState(settings?.storeCustomerId || '');
  const [status, setStatus] = useState('idle'); // idle | saving | saved | error
  const [statusErr, setStatusErr] = useState(null);
  // Cost discount %: local while editing, persisted on blur. Default 60 mirrors
  // the column default so a fresh install reads the standing dealer discount.
  const [disc, setDisc] = useState(String(settings?.companyDiscountPct ?? 60));
  const [discStatus, setDiscStatus] = useState('idle');
  const [discErr, setDiscErr] = useState(null);
  // Re-sync to the persisted values when they change elsewhere / after a save.
  useEffect(() => { setValue(settings?.storeCustomerId || ''); }, [settings?.storeCustomerId]);
  useEffect(() => { setDisc(String(settings?.companyDiscountPct ?? 60)); }, [settings?.companyDiscountPct]);

  const sorted = [...(customers || [])].sort((a, b) =>
    (a.company || a.name || '').localeCompare(b.company || b.name || ''));

  async function pick(e) {
    const next = e.target.value || null;
    setValue(next || '');       // optimistic — the select reflects the choice now
    setStatus('saving');
    setStatusErr(null);
    try {
      await saveSettings({ storeCustomerId: next });
      setStatus('saved');
      setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (err) {
      // userMessageFor captures the raw error and returns the actionable text.
      setStatusErr(userMessageFor(err));
      setStatus('error');
    }
  }

  async function saveDiscount() {
    const next = clampPct(disc);
    setDisc(String(next));      // reflect the clamp
    if (next === (settings?.companyDiscountPct ?? 60)) { setDiscStatus('idle'); return; }
    setDiscStatus('saving');
    setDiscErr(null);
    try {
      await saveSettings({ companyDiscountPct: next });
      setDiscStatus('saved');
      setTimeout(() => setDiscStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (err) {
      setDiscErr(userMessageFor(err));
      setDiscStatus('error');
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
    <SettingsSection title="Cuenta de la empresa y tienda">
      <p className="text-xs text-ink-500 mb-4">
        La cuenta de la empresa es tu propia cuenta (ALCOVER): no aparece en
        Clientes y sus cotizaciones son los pedidos de la tienda, valorados a
        precio de costo con el descuento de abajo. Esas mismas cotizaciones
        surten la tienda pública, que muestra precios de venta.{' '}
        <a href="#/tienda" target="_blank" rel="noopener"
          className="text-brand-600 hover:text-brand-700 font-medium whitespace-nowrap">
          Ver tienda →
        </a>
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="label inline-flex items-center gap-2">
            Cuenta de la empresa
            {status === 'saving' && <span className="text-[11px] font-normal text-ink-400">Guardando…</span>}
            {status === 'saved' && <span className="text-[11px] font-normal text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-0.5"><Check size={11} /> Guardado</span>}
            {status === 'error' && <span className="text-[11px] font-normal text-red-600 dark:text-red-400">No se pudo guardar</span>}
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
            Se guarda automáticamente. Se oculta de Clientes y sus cotizaciones
            (excepto rechazadas y archivadas) surten la tienda.
          </p>
          {status === 'error' && statusErr && (
            <p role="alert" className="text-[11px] text-red-600 dark:text-red-400 mt-1.5 break-words">{statusErr}</p>
          )}
        </div>
        <div>
          <div className="label inline-flex items-center gap-2">
            Descuento de costo (%)
            {discStatus === 'saving' && <span className="text-[11px] font-normal text-ink-400">Guardando…</span>}
            {discStatus === 'saved' && <span className="text-[11px] font-normal text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-0.5"><Check size={11} /> Guardado</span>}
            {discStatus === 'error' && <span className="text-[11px] font-normal text-red-600 dark:text-red-400">No se pudo guardar</span>}
          </div>
          <input
            className="input"
            type="number"
            min="0"
            max="100"
            inputMode="decimal"
            enterKeyHint="done"
            value={disc}
            onChange={(e) => setDisc(e.target.value)}
            onBlur={saveDiscount}
          />
          <p className="text-[11px] text-ink-500 mt-1.5">
            Se descuenta de cada precio en las cotizaciones de esta cuenta (total,
            Vista cliente y PDF) para reflejar tu costo. No afecta la tienda
            pública ni a otros clientes.
          </p>
          {discStatus === 'error' && discErr && (
            <p role="alert" className="text-[11px] text-red-600 dark:text-red-400 mt-1.5 break-words">{discErr}</p>
          )}
        </div>
        <div className="sm:col-span-2">
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
                className={`btn-ghost text-xs whitespace-nowrap active:scale-[0.97] transition-all ${copied ? '!text-emerald-700 dark:!text-emerald-400 !border-emerald-200 dark:!border-emerald-900/60' : ''}`}
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
    </SettingsSection>
  );
}

function OrdersCard({ local, set }) {
  return (
    <SettingsSection title="Pedidos">
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
    </SettingsSection>
  );
}


/**
 * Quote-terms templates — the named library the dealer applies to a quote with
 * one tap (the quote editor's picker). Edits the whole `quoteTermsPresets` array
 * in the page's local form state; the page-level "Guardar cambios" persists it.
 * Each preset can be tagged Piso/Especial so the picker suggests it for that
 * order type. Falls back to the seeded defaults when nothing is stored yet.
 */
function QuoteTermsPresets({ local, set }) {
  const presets = resolveTermsPresets(local);
  const update = (id, patch) =>
    set('quoteTermsPresets', presets.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const add = () =>
    set('quoteTermsPresets', [...presets, { id: newId(), label: '', body: '' }]);
  const remove = (id) =>
    set('quoteTermsPresets', presets.filter((p) => p.id !== id));

  return (
    <div className="sm:col-span-2">
      <div className="label">Plantillas de términos (se imprimen en el PDF)</div>
      <p className="text-xs text-ink-500 mb-2">
        Crea términos para pedidos de piso (stock) y especiales. En la cotización los aplicas con
        un toque; el que coincide con el tipo de orden aparece como «Sugerido».
      </p>
      <div className="space-y-3">
        {presets.map((p) => (
          <div key={p.id} className="rounded-lg border border-ink-200 bg-surface p-3 space-y-2">
            <div className="flex items-center gap-2">
              <input
                className="input flex-1"
                value={p.label || ''}
                onChange={(e) => update(p.id, { label: e.target.value })}
                placeholder="Título (p. ej. Pedido de piso)"
                maxLength={40}
                aria-label="Título de la plantilla"
              />
              <select
                className="input w-auto shrink-0"
                value={p.orderType || ''}
                onChange={(e) => update(p.id, { orderType: e.target.value || undefined })}
                aria-label="Tipo de orden sugerido"
                title="Tipo de orden para el que se sugiere esta plantilla"
              >
                <option value="">Sin tipo</option>
                <option value="floor">Piso</option>
                <option value="special">Especial</option>
              </select>
              <button
                type="button"
                onClick={() => remove(p.id)}
                className="p-1.5 rounded text-ink-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 shrink-0"
                title="Eliminar plantilla"
                aria-label="Eliminar plantilla"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <textarea
              className="input min-h-[80px]"
              value={p.body || ''}
              onChange={(e) => update(p.id, { body: e.target.value })}
              placeholder="Validez, plazos de entrega, condiciones de pago…"
              aria-label="Texto de la plantilla"
            />
          </div>
        ))}
      </div>
      <button type="button" onClick={add} className="btn-ghost text-xs inline-flex items-center gap-1 mt-2">
        <Plus size={13} /> Añadir plantilla
      </button>
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
    // Validate/clamp buy: empty or non-positive falls back to sell; reject NaN
    // (garbage like "abc") so a bad buy can never persist silently.
    const buyRaw = Number(manualBuy);
    if (manualBuy !== '' && Number.isNaN(buyRaw)) { setManualErr('Ingresa una tasa de compra válida.'); return; }
    const buy = (manualBuy === '' || buyRaw <= 0) ? sell : buyRaw;
    setSavingManual(true); setManualErr(null); setManualOk(false);
    try {
      await saveSettings({ exchangeRate: { buy, sell, updatedAt: Date.now() } });
      setManualOk(true);
    } catch (e) {
      setManualErr(userMessageFor(e));
    } finally {
      setSavingManual(false);
    }
  }

  const eff = effectiveDopRate(local);
  // Guard the sample conversions: with no rate yet (eff === 0) the math is
  // 10000/0 → Infinity and 100*0 → 0, which rendered "Infinity" / "NaN" on a
  // fresh install. Show an em dash until there's a real rate to convert with.
  const hasRate = Number.isFinite(eff) && eff > 0;
  const sample = hasRate ? (10000 / eff).toFixed(2) : '—';
  const sampleInverse = hasRate
    ? (100 * eff).toLocaleString('en-US', { maximumFractionDigits: 0 })
    : '—';
  const fmt = (n) => (n == null || n === '' ? '—' : Number(n).toFixed(2));

  return (
    <SettingsSection title="Tasa de cambio USD → DOP">
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
          <div className="text-[11px] text-red-600 dark:text-red-200 mb-3 flex items-start gap-1.5 bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900/40 rounded-md px-2.5 py-1.5">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" /> {fetchErr}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-surface border border-ink-100 shadow-xs px-3 py-2.5">
            <div className="eyebrow-xs font-medium tracking-wide">Compra</div>
            <div className="font-display text-lg font-semibold text-ink-900 mt-1 tabular-nums">{fmt(rate.buy)}</div>
            <div className="text-[10px] text-ink-400 mt-0.5">RD$ por 1 USD</div>
          </div>
          <div className="rounded-lg bg-surface border border-ink-100 shadow-xs px-3 py-2.5">
            <div className="eyebrow-xs font-medium tracking-wide">Venta</div>
            <div className="font-display text-lg font-semibold text-ink-900 mt-1 tabular-nums">{fmt(rate.sell)}</div>
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
              <label className="label" htmlFor="rate-manual-buy">Compra (RD$ / USD)</label>
              <input
                id="rate-manual-buy"
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
              <label className="label" htmlFor="rate-manual-sell">Venta (se cotiza con esta)</label>
              <input
                id="rate-manual-sell"
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
              <span className="text-[11px] text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                <Check size={12} /> Guardada
              </span>
            )}
            {manualErr && (
              <span className="text-[11px] text-red-600 dark:text-red-400 inline-flex items-center gap-1">
                <AlertTriangle size={12} /> {manualErr}
              </span>
            )}
          </div>
        </div>
      </details>

      {/* Effective */}
      <div className="rounded-lg bg-brand-50 border border-brand-200 px-4 py-3.5">
        <div className="eyebrow-xs font-medium tracking-wider text-brand-700">Tasa efectiva</div>
        <div className="font-display text-xl font-semibold text-brand-900 mt-1 tabular-nums">
          1 USD = {hasRate ? eff.toFixed(2) : '—'} DOP
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
    </SettingsSection>
  );
}

