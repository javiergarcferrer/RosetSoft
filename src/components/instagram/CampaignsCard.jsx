// CampaignsCard — the ads surface, INLINE on the pane (was buried in the
// "Anuncios" modal). Buckets every campaign the account returns — including
// boosts made from the Meta Business Suite Ads tab — into Activas / Pausadas /
// Inactivas (Activas default), with pause/resume (real money → confirm-gated).
// Its header carries the ad actions: Crear anuncio (the full AdsManager wizard)
// and a jump straight to the Business Suite ad summary. (Publicar — posting
// content — lives on the Contenido section, not here.)
import { useCallback, useMemo, useState } from 'react';
import {
  Megaphone, ExternalLink, ChevronDown, MousePointerClick, Target, Eye, Coins, Percent,
} from 'lucide-react';
import { supabase } from '../../db/supabaseClient.js';
import ImageView from '../ImageView.tsx';

const money = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const money2 = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = (n) => Number(n || 0).toLocaleString('en-US');

// One labelled figure in the expanded ad's analytics grid — null values are
// filtered out by the caller, so a tile only renders when there's a real number.
function MetricTile({ icon: Icon, label, value }) {
  return (
    <div className="rounded-lg bg-ink-50 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-ink-400">
        <Icon size={12} /> {label}
      </div>
      <div className="mt-0.5 font-display text-base font-semibold tabular-nums text-ink-900">{value}</div>
    </div>
  );
}
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
  const [openId, setOpenId] = useState(null); // the tapped ad, expanded to its visual + analytics

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
              <div className="space-y-1.5">
                {rows.map((c) => {
                  const b = bucketOf(c);
                  const cur = c.currency || adCurrency; // each campaign bills in its own account's currency
                  const open = openId === c.id;
                  const dot = b === 'active' ? 'bg-emerald-500' : b === 'paused' ? 'bg-amber-400' : 'bg-ink-300';
                  const metrics = [
                    { key: 'spend', icon: Coins, label: 'Gasto', value: c.spend != null ? `${money(c.spend)}${cur ? ` ${cur}` : ''}` : null },
                    { key: 'results', icon: Target, label: 'Resultados', value: c.results != null ? intFmt(c.results) : null },
                    { key: 'cpr', icon: Coins, label: 'Costo/resultado', value: c.costPerResult != null ? `${money2(c.costPerResult)}${cur ? ` ${cur}` : ''}` : null },
                    { key: 'clicks', icon: MousePointerClick, label: 'Clics', value: c.clicks != null ? intFmt(c.clicks) : null },
                    { key: 'ctr', icon: Percent, label: 'CTR', value: c.ctrPct != null ? `${c.ctrPct.toFixed(2)}%` : null },
                    { key: 'cpc', icon: Coins, label: 'CPC', value: c.cpc != null ? `${money2(c.cpc)}${cur ? ` ${cur}` : ''}` : null },
                    { key: 'impr', icon: Eye, label: 'Impresiones', value: c.impressions != null ? intFmt(c.impressions) : null },
                  ].filter((m) => m.value != null);
                  return (
                    <div key={c.id} className="overflow-hidden rounded-xl border border-ink-100 bg-surface">
                      {/* Tap the row to peek the ad's visual + full analytics. */}
                      <button
                        type="button"
                        onClick={() => setOpenId(open ? null : c.id)}
                        aria-expanded={open}
                        className="flex w-full items-center gap-3 px-2.5 py-2 text-left transition-colors hover:bg-ink-50"
                      >
                        <div className="relative h-12 w-12 flex-none overflow-hidden rounded-lg bg-ink-100">
                          {c.thumb ? (
                            <ImageView id={null} fallbackUrl={c.thumb} alt="" className="h-full w-full object-cover" placeholderClassName="h-full w-full" />
                          ) : (
                            <span className="flex h-full w-full items-center justify-center text-ink-300"><Megaphone size={18} /></span>
                          )}
                          <span className={`absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-surface ${dot}`} title={c.status || ''} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink-800">{c.name}</div>
                          <div className="mt-0.5 truncate text-xs text-ink-400 tabular-nums">
                            {c.spend != null ? `${money(c.spend)}${cur ? ` ${cur}` : ''}` : '—'}{c.results != null ? ` · ${intFmt(c.results)} res.` : ''}
                          </div>
                        </div>
                        <ChevronDown size={16} className={`flex-none text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`} />
                      </button>

                      {open && (
                        <div className="border-t border-ink-100 px-2.5 pb-2.5 pt-2.5">
                          {c.image && (
                            <div className="mb-2.5 overflow-hidden rounded-lg bg-ink-100">
                              <ImageView id={null} fallbackUrl={c.image} alt={c.name} className="max-h-52 w-full object-cover" placeholderClassName="aspect-square w-full" />
                            </div>
                          )}
                          {metrics.length > 0 ? (
                            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                              {metrics.map((m) => <MetricTile key={m.key} icon={m.icon} label={m.label} value={m.value} />)}
                            </div>
                          ) : (
                            <div className="text-xs text-ink-400">Aún sin métricas reportadas para este anuncio.</div>
                          )}
                          <div className="mt-2.5 flex items-center justify-end gap-2">
                            {b !== 'inactive' && (
                              <button
                                type="button"
                                disabled={busy === c.id || !c.id}
                                onClick={() => toggle(c)}
                                className={`rounded-full px-3 py-1 text-xs font-medium disabled:opacity-50 ${b === 'active' ? 'bg-amber-50 text-amber-700 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}
                              >
                                {busy === c.id ? '…' : b === 'active' ? 'Pausar' : 'Reanudar'}
                              </button>
                            )}
                          </div>
                        </div>
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
