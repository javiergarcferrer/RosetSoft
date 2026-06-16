// CampaignsCard — the ads surface, INLINE on the pane (was buried in the
// "Anuncios" modal). Buckets every campaign the account returns — including
// boosts made from the Meta Business Suite Ads tab — into Activas / Pausadas /
// Inactivas (Activas default), with pause/resume (real money → confirm-gated).
// Its header carries the ad actions: Crear anuncio (the full AdsManager wizard)
// and a jump straight to the Business Suite ad summary. (Publicar — posting
// content — lives on the Contenido section, not here.)
import { useCallback, useMemo, useState } from 'react';
import { Megaphone, ExternalLink } from 'lucide-react';
import { supabase } from '../../db/supabaseClient.js';

const money = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const PAUSED = new Set(['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED']);
const bucketOf = (c) => {
  const s = String(c.status || '').toUpperCase();
  return s === 'ACTIVE' ? 'active' : PAUSED.has(s) ? 'paused' : 'inactive';
};
// Business Suite "Ads" tab — the source of truth for boosts made there.
const BUSINESS_SUITE_ADS = 'https://business.facebook.com/latest/ad_center/all_ads';
const TABS = [['active', 'Activas'], ['paused', 'Pausadas'], ['inactive', 'Inactivas']];

export default function CampaignsCard({ campaigns = [], adCurrency, spend7, hasAds, onChanged, onCreateAd }) {
  const [tab, setTab] = useState('active');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  const groups = useMemo(() => {
    const g = { active: [], paused: [], inactive: [] };
    for (const c of campaigns) g[bucketOf(c)].push(c);
    return g;
  }, [campaigns]);
  const rows = groups[tab] || [];

  const toggle = useCallback(async (c) => {
    if (busy || !c?.id) return;
    const active = bucketOf(c) === 'active';
    const next = active ? 'PAUSED' : 'ACTIVE';
    if (!window.confirm(active ? `¿Pausar la campaña “${c.name}”?` : `¿Reanudar la campaña “${c.name}”?`)) return;
    setBusy(c.id);
    setErr(null);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: { setCampaignStatus: { campaignId: c.id, status: next } },
      });
      if (error || !data?.ok) throw new Error(data?.error || error?.message || 'No se pudo cambiar la campaña');
      onChanged?.();
    } catch (e) {
      setErr(e?.message || 'No se pudo cambiar la campaña');
    } finally {
      setBusy(null);
    }
  }, [busy, onChanged]);

  return (
    <div className="card flex flex-col lg:h-full">
      <div className="card-header flex-wrap gap-2">
        <span className="flex items-center gap-2 font-medium"><Megaphone size={15} /> Anuncios</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <a href={BUSINESS_SUITE_ADS} target="_blank" rel="noreferrer" className="btn-ghost text-xs" title="Abrir el resumen de anuncios en Meta Business Suite">
            <ExternalLink size={14} /> Business Suite
          </a>
          {onCreateAd && (
            <button type="button" className="btn-brand text-xs" onClick={onCreateAd}>
              <Megaphone size={14} /> Crear anuncio
            </button>
          )}
        </div>
      </div>

      {!hasAds ? (
        <div className="card-pad text-sm text-ink-400">
          Aún no leemos campañas de esta cuenta publicitaria. Crea un anuncio aquí, o si lo hiciste
          desde la pestaña Anuncios de{' '}
          <a href={BUSINESS_SUITE_ADS} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">Meta Business Suite</a>,
          aparecerá en cuanto Meta lo reporte (y en Configuración debe estar vinculada la cuenta publicitaria correcta).
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 pt-2.5">
            <div className="inline-flex rounded-full border border-ink-200 bg-ink-100 p-1 text-xs" role="tablist" aria-label="Estado de campañas">
              {TABS.map(([id, label]) => {
                const on = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setTab(id)}
                    className={`rounded-full px-3 py-1 font-medium transition-colors ${on ? 'bg-surface text-brand-700 shadow-sm ring-1 ring-black/5' : 'text-ink-500 hover:text-ink-800'}`}
                  >
                    {label}{groups[id].length > 0 ? <span className="ml-1 tabular-nums opacity-70">{groups[id].length}</span> : null}
                  </button>
                );
              })}
            </div>
            {spend7 != null && <span className="text-xs text-ink-400 tabular-nums">{money(spend7)}{adCurrency ? ` ${adCurrency}` : ''} · 7d</span>}
          </div>
          {err && <div className="px-4 pt-2 text-xs text-red-600">{err}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {rows.length === 0 ? (
              <div className="px-2 py-5 text-sm text-ink-400">
                {tab === 'active' ? 'Sin campañas activas.' : tab === 'paused' ? 'Sin campañas pausadas.' : 'Sin campañas inactivas.'}
              </div>
            ) : (
              <div className="divide-y divide-ink-100">
                {rows.map((c) => {
                  const b = bucketOf(c);
                  const cur = c.currency || adCurrency; // each campaign bills in its own account's currency
                  return (
                    <div key={c.id} className="flex items-center gap-3 px-2 py-2.5 text-sm">
                      <span
                        className={`h-2 w-2 flex-none rounded-full ${b === 'active' ? 'bg-emerald-500' : b === 'paused' ? 'bg-amber-400' : 'bg-ink-300'}`}
                        title={c.status || ''}
                      />
                      <span className="min-w-0 flex-1 truncate text-ink-800">{c.name}</span>
                      <span className="flex-none text-xs text-ink-400 tabular-nums">
                        {c.spend != null ? money(c.spend) : '—'}{cur ? ` ${cur}` : ''}{c.results != null ? ` · ${c.results} res.` : ''}
                      </span>
                      {b !== 'inactive' && (
                        <button
                          type="button"
                          disabled={busy === c.id || !c.id}
                          onClick={() => toggle(c)}
                          className={`flex-none rounded-full px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${b === 'active' ? 'bg-amber-50 text-amber-700 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}
                        >
                          {busy === c.id ? '…' : b === 'active' ? 'Pausar' : 'Reanudar'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
