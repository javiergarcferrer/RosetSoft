import { useEffect, useState } from 'react';
import { RefreshCw, ExternalLink, Check, AlertTriangle, Shield } from 'lucide-react';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ImageDrop from '../components/ImageDrop.jsx';
import { useApp } from '../context/AppContext.jsx';
import { effectiveDopRate, BSC_PUBLIC_URL } from '../lib/exchangeRate.js';
import { formatDateTime } from '../lib/format.js';
import { clampPct } from '../lib/pricing.js';
import { userMessageFor } from '../lib/errorMessages.js';
import { db } from '../db/database.js';

export default function Settings() {
  const { profileId, settings, saveSettings, isAdmin } = useApp();
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
      // Keep currencyRates.DOP in sync with whichever rate the user chose
      const dop = effectiveDopRate(local);
      const next = { ...local, currencyRates: { ...(local.currencyRates || {}), USD: 1, DOP: dop } };
      await saveSettings(next);
      setSaveState('saved');
      // Drop the "Guardado" badge after a beat so the button is reusable.
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (e) {
      console.error('saveSettings failed', e);
      setSaveError(userMessageFor(e));
      setSaveState('error');
    }
  }

  const rates = local.currencyRates || { USD: 1 };

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
          <RateCard local={local} set={set} saveSettings={() => saveSettings(local)} />

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


function RateCard({ local, set, saveSettings }) {
  // BSC's buy/sell rates live under `settings.bsc`. We accept the
  // legacy `settings.bpd` shape transparently so existing data isn't
  // lost on the first render after this code ships — see readBscRates
  // / normalizeRateMode in lib/exchangeRate.js.
  const bsc = local.bsc || local.bpd || { buy: null, sell: null, updatedAt: null };
  const mode = (local.dopRateMode || '').startsWith('bsc-')
    ? local.dopRateMode
    : 'bsc-sell';

  function setBsc(patch) {
    set('bsc', { ...bsc, ...patch, updatedAt: Date.now() });
  }

  const eff = effectiveDopRate(local);
  const sample = (10000 / eff).toFixed(2);
  const sampleInverse = (100 * eff).toLocaleString('en-US', { maximumFractionDigits: 0 });

  return (
    <div className="card card-pad">
      <h2 className="font-semibold mb-2">Tasa de cambio USD → DOP</h2>
      <p className="text-xs text-ink-500 mb-4">
        Los precios del catálogo están en USD (lista oficial Ligne Roset). Aquí defines la tasa de Banco Santa Cruz que se aplica al convertir a pesos dominicanos en cotizaciones.
      </p>

      {/* Mode selector — three options, all anchored on BSC */}
      <div className="label">Tasa que usar al cotizar</div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
        {[
          { key: 'bsc-sell', label: 'BSC — Venta',     hint: 'Para cobrar al cliente' },
          { key: 'bsc-buy',  label: 'BSC — Compra',    hint: 'Si te paga en USD' },
          { key: 'custom',   label: 'Personalizada',   hint: 'Manual abajo' },
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

      {/* BSC rates — manual entry. BSC's web app is a Nuxt SPA with no
          public no-auth endpoint we can fetch, so we link out to their
          divisas page and let the dealer paste in today's rates. */}
      <div className="rounded-md border border-ink-100 bg-ink-50 px-4 py-3 mb-3">
        <div className="flex items-center justify-between mb-2">
          <div className="font-medium text-sm">Banco Santa Cruz</div>
          <a href={BSC_PUBLIC_URL} target="_blank" rel="noreferrer" className="text-xs text-brand-600 hover:underline inline-flex items-center gap-1">
            bsc.com.do/divisas <ExternalLink size={10} />
          </a>
        </div>
        <p className="text-[11px] text-ink-500 mb-3">
          Actualiza desde la app de BSC o su sitio web. La tasa de venta es la que paga tu cliente al adquirir USD.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-ink-600">Compra (RD$ por 1 USD)</div>
            <input
              type="number"
              step="0.01"
              className="input mt-1"
              value={bsc.buy ?? ''}
              onChange={(e) => setBsc({ buy: e.target.value === '' ? null : Number(e.target.value) })}
              placeholder="58.50"
            />
          </div>
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-ink-600">Venta (RD$ por 1 USD)</div>
            <input
              type="number"
              step="0.01"
              className="input mt-1"
              value={bsc.sell ?? ''}
              onChange={(e) => setBsc({ sell: e.target.value === '' ? null : Number(e.target.value) })}
              placeholder="62.00"
            />
          </div>
        </div>
        {bsc.updatedAt && (
          <div className="text-[10px] text-ink-500 mt-2">
            Actualizado {formatDateTime(bsc.updatedAt)}
          </div>
        )}
      </div>

      {/* Custom — only renders when selected */}
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
