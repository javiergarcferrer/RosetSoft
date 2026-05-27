import { useEffect, useState } from 'react';
import { RefreshCw, Check, AlertTriangle, Shield } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ImageDrop from '../components/ImageDrop.jsx';
import { useApp } from '../context/AppContext.jsx';
import { effectiveDopRate } from '../lib/exchangeRate.js';
import { EXCHANGE_RATE_PULL_ENABLED } from '../lib/constants.js';
import { formatDateTime } from '../lib/format.js';
import { clampPct } from '../lib/pricing.js';
import { userMessageFor } from '../lib/errorMessages.js';
import { db } from '../db/database.js';
import { supabase } from '../db/supabaseClient.js';

export default function Settings() {
  const { profileId, settings, saveSettings, refreshSettings, isAdmin } = useApp();
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
            </div>
          </div>

          {/* Currency (DR-focused) */}
          <RateCard local={local} set={set} refreshSettings={refreshSettings} saveSettings={saveSettings} />

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
      </div>
    </>
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


function RateCard({ local, set, refreshSettings, saveSettings }) {
  // Banco Popular's published rate, stored under `settings.exchangeRate`.
  // The daily auto-pull and "Actualizar ahora" are the usual writers; the
  // manual override below is a stopgap until the BPD subscription is live.
  // Legacy `bsc` / `bpd` shapes are read as fallbacks — see readExchangeRate.
  const rate = local.exchangeRate || local.bsc || local.bpd || { buy: null, sell: null, updatedAt: null };

  // "Actualizar ahora": invoke the bpd-rate Edge Function (OAuth secret
  // stays server-side). The function writes the rate to the team settings
  // row itself; we just re-read settings so the new figure shows up here
  // and across the app immediately, instead of waiting for the daily pull.
  const [fetching, setFetching] = useState(false);
  const [fetchErr, setFetchErr] = useState(null);
  async function fetchNow() {
    setFetching(true);
    setFetchErr(null);
    try {
      const { data, error } = await supabase.functions.invoke('bpd-rate');
      if (error) {
        let msg = error.message || 'No se pudo obtener la tasa';
        try {
          // The function returns { error, status, detail } on upstream
          // failures (e.g. the bank's 401 on the OAuth token call). Surface
          // the status + detail so the cause is visible here rather than
          // buried in a generic message.
          const body = await error.context?.json?.();
          if (body?.error) {
            msg = body.error;
            if (body.status) msg += ` (HTTP ${body.status})`;
            if (body.detail) msg += ` — ${String(body.detail).slice(0, 200)}`;
          }
        } catch { /* body already consumed / not JSON */ }
        throw new Error(msg);
      }
      if (!data?.usd || (!data.usd.compra && !data.usd.venta)) {
        throw new Error(data?.error || 'El banco no devolvió una tasa de USD.');
      }
      await refreshSettings();
    } catch (e) {
      setFetchErr(e?.message || 'No se pudo obtener la tasa.');
    } finally {
      setFetching(false);
    }
  }

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
