// AdsManager — the full Instagram/Meta ads command surface, in a modal off the
// command center. It manages the whole Marketing-API hierarchy the way Ads
// Manager does: the Campaign → Ad set → Ad tree (lazy-drilled), per-node
// insights, and the complete lifecycle — pause/resume, edit budget, schedule,
// targeting and name, duplicate, delete — plus a "create promotion" wizard that
// boosts an existing Instagram post. Every read/write rides the meta-social
// Edge Function (`ads` op); tokens never reach the browser, and everything that
// moves real spend is confirm-gated. Money/status/metric rules live in the
// Model (lib/instagramAds via core/jarvis); this file is the View.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronRight, ChevronDown, Plus, RefreshCw, Megaphone, Layers, Image as ImageIcon,
  Play, Pause, Pencil, Copy, Trash2, BarChart3, Search, Check, X, ArrowLeft, Rocket,
} from 'lucide-react';
import ImageView from '../ImageView.tsx';
import { supabase } from '../../db/supabaseClient.js';
import { resolveAdsBoard, resolveAdChildren, adInsightTiles } from '../../core/jarvis/index.js';
import {
  statusInfo, formatAdMoney, objectiveLabel, summarizeTargeting,
  OBJECTIVES, objectiveInfo, GENDER_OPTIONS, COUNTRY_OPTIONS, AGE_BOUNDS, buildTargeting,
} from '../../lib/instagramAds.js';

const DATE_PRESETS = [
  ['today', 'Hoy'],
  ['last_7d', '7 días'],
  ['last_28d', '28 días'],
  ['last_90d', '90 días'],
  ['maximum', 'Histórico'],
];

const TONE = {
  emerald: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-700',
  ink: 'bg-ink-100 text-ink-600',
};

function Pill({ status }) {
  const i = statusInfo(status);
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[i.tone] || TONE.ink}`}>{i.label}</span>;
}

// A compact at-a-glance metric line for a tree row (spend · results · CTR).
function MetricStrip({ ins, currency }) {
  if (!ins?.hasData) return <span className="text-xs text-ink-400">Sin datos aún</span>;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-500 tabular-nums">
      <span><span className="text-ink-400">Gasto</span> {formatAdMoney(ins.spend, currency)}</span>
      {ins.results != null && <span><span className="text-ink-400">{ins.resultLabel}</span> {Number(ins.results).toLocaleString('en-US')}</span>}
      {ins.costPerResult != null && <span><span className="text-ink-400">c/u</span> {formatAdMoney(ins.costPerResult, currency)}</span>}
      {ins.ctr != null && <span><span className="text-ink-400">CTR</span> {ins.ctr.toFixed(2)}%</span>}
    </div>
  );
}

function insightsGrid(ins, currency) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 rounded-lg bg-ink-50 p-3">
      {adInsightTiles(ins, currency).map((t) => (
        <div key={t.key}>
          <div className="text-[10px] uppercase tracking-wide text-ink-400">{t.label}</div>
          <div className="text-sm font-semibold tabular-nums text-ink-900">{t.value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Targeting editor (geo · age · gender · interests) — used by the ad-set
// editor and the create wizard. Emits a plain { countries, ageMin, ageMax,
// genders, interests } the caller turns into the API shape via buildTargeting.
function TargetingEditor({ value, onChange }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const set = (patch) => onChange({ ...value, ...patch });
  const toggleCountry = (code) => {
    const has = value.countries.includes(code);
    set({ countries: has ? value.countries.filter((c) => c !== code) : [...value.countries, code] });
  };
  const searchInterests = useCallback(async () => {
    const term = q.trim();
    if (!term) return;
    setSearching(true);
    try {
      const { data } = await supabase.functions.invoke('meta-social', { body: { ads: { op: 'search', q: term, searchType: 'adinterest' } } });
      setResults((data?.ok ? data.results : []).map((r) => ({ id: r.id, name: r.name })));
    } catch { setResults([]); } finally { setSearching(false); }
  }, [q]);
  const addInterest = (it) => {
    if (value.interests.some((x) => x.id === it.id)) return;
    set({ interests: [...value.interests, it] });
    setResults([]); setQ('');
  };

  const genderId = value.genders.length === 1 ? value.genders[0] : 0;
  return (
    <div className="space-y-3">
      <div>
        <div className="eyebrow-xs mb-1.5">Ubicación</div>
        <div className="flex flex-wrap gap-1.5">
          {COUNTRY_OPTIONS.map((c) => {
            const on = value.countries.includes(c.code);
            return (
              <button key={c.code} type="button" onClick={() => toggleCountry(c.code)}
                className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-brand-300 bg-brand-50 text-brand-700' : 'border-ink-200 text-ink-600 hover:bg-ink-50'}`}>
                {on && <Check size={11} className="mr-1 inline" />}{c.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="eyebrow-xs mb-1.5">Edad</div>
          <div className="flex items-center gap-2">
            <select className="input" value={value.ageMin} onChange={(e) => set({ ageMin: Number(e.target.value) })}>
              {AGE_BOUNDS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span className="text-ink-400">–</span>
            <select className="input" value={value.ageMax} onChange={(e) => set({ ageMax: Number(e.target.value) })}>
              {AGE_BOUNDS.map((n) => <option key={n} value={n}>{n === 65 ? '65+' : n}</option>)}
            </select>
          </div>
        </div>
        <div>
          <div className="eyebrow-xs mb-1.5">Género</div>
          <div className="inline-flex rounded-full border border-ink-200 bg-surface p-0.5 text-xs">
            {GENDER_OPTIONS.map((g) => {
              const on = genderId === g.id;
              return (
                <button key={g.id} type="button" onClick={() => set({ genders: g.genders })}
                  className={`rounded-full px-3 py-1 font-medium ${on ? 'bg-brand-600 text-white' : 'text-ink-500 hover:text-ink-800'}`}>
                  {g.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div>
        <div className="eyebrow-xs mb-1.5">Intereses</div>
        {value.interests.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {value.interests.map((it) => (
              <span key={it.id} className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-700">
                {it.name}
                <button type="button" onClick={() => set({ interests: value.interests.filter((x) => x.id !== it.id) })} className="text-ink-400 hover:text-red-600"><X size={11} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-300" />
            <input className="input pl-9" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); searchInterests(); } }} placeholder="Buscar interés (ej. decoración)…" />
          </div>
          <button type="button" className="btn-secondary" onClick={searchInterests} disabled={searching || !q.trim()}>{searching ? <RefreshCw size={14} className="animate-spin" /> : 'Buscar'}</button>
        </div>
        {results.length > 0 && (
          <div className="mt-1.5 max-h-40 overflow-y-auto rounded-lg border border-ink-100 divide-y divide-ink-100">
            {results.map((r) => (
              <button key={r.id} type="button" onClick={() => addInterest(r)} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-ink-50">
                <span className="text-ink-800">{r.name}</span><Plus size={14} className="text-ink-400" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const emptyTargeting = () => ({ countries: ['DO'], ageMin: 18, ageMax: 65, genders: [], interests: [] });
function seedTargeting(t) {
  if (!t) return emptyTargeting();
  return {
    countries: (t.geo_locations?.countries || ['DO']),
    ageMin: t.age_min || 18,
    ageMax: t.age_max || 65,
    genders: t.genders || [],
    interests: (t.flexible_spec || []).flatMap((s) => (s.interests || []).map((i) => ({ id: i.id, name: i.name }))),
  };
}
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
};

// ── Inline node editor (budget · schedule · targeting · name · destructive) ──
function NodeEditor({ node, currency, busy, onSave, onDelete, onDuplicate, onClose }) {
  const [name, setName] = useState(node.name === '—' ? '' : node.name);
  const budgetKind = node.dailyBudget != null ? 'daily' : node.lifetimeBudget != null ? 'lifetime' : null;
  const [budget, setBudget] = useState(budgetKind === 'daily' ? node.dailyBudget : budgetKind === 'lifetime' ? node.lifetimeBudget : '');
  const isAdset = node.level === 'adset';
  const [start, setStart] = useState(toLocalInput(node.startTime));
  const [end, setEnd] = useState(toLocalInput(node.endTime));
  const [tgt, setTgt] = useState(seedTargeting(node.targeting));

  return (
    <div className="mt-2 space-y-4 rounded-xl border border-ink-100 bg-surface p-4">
      <div>
        <div className="eyebrow-xs mb-1.5">Nombre</div>
        <div className="flex gap-2">
          <input className="input flex-1" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          <button type="button" className="btn-secondary" disabled={busy || !name.trim() || name.trim() === node.name} onClick={() => onSave({ op: 'rename', name: name.trim() })}>Guardar</button>
        </div>
      </div>

      {budgetKind && (
        <div>
          <div className="eyebrow-xs mb-1.5">Presupuesto {budgetKind === 'daily' ? 'diario' : 'total'} ({currency || 'moneda'})</div>
          <div className="flex gap-2">
            <input type="number" min="1" step="0.01" className="input flex-1" value={budget} onChange={(e) => setBudget(e.target.value)} />
            <button type="button" className="btn-secondary" disabled={busy || !(Number(budget) > 0)} onClick={() => onSave(budgetKind === 'daily' ? { op: 'budget', dailyBudget: Number(budget), currency } : { op: 'budget', lifetimeBudget: Number(budget), currency })}>Guardar</button>
          </div>
        </div>
      )}

      {isAdset && (
        <>
          <div>
            <div className="eyebrow-xs mb-1.5">Programación</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="text-xs text-ink-500">Inicio<input type="datetime-local" className="input mt-1" value={start} onChange={(e) => setStart(e.target.value)} /></label>
              <label className="text-xs text-ink-500">Fin (opcional)<input type="datetime-local" className="input mt-1" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
            </div>
            <button type="button" className="btn-secondary mt-2" disabled={busy || (!start && !end)} onClick={() => onSave({ op: 'schedule', startTime: start ? new Date(start).toISOString() : undefined, endTime: end ? new Date(end).toISOString() : undefined })}>Guardar fechas</button>
          </div>
          <div>
            <div className="eyebrow-xs mb-2">Público</div>
            <TargetingEditor value={tgt} onChange={setTgt} />
            <button type="button" className="btn-secondary mt-2" disabled={busy} onClick={() => onSave({ op: 'targeting', targeting: buildTargeting(tgt) })}>Guardar público</button>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
        {(node.level === 'campaign' || node.level === 'adset') && (
          <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={onDuplicate}><Copy size={14} /> Duplicar</button>
        )}
        <button type="button" className="btn-secondary text-sm text-red-600 hover:bg-red-50" disabled={busy} onClick={onDelete}><Trash2 size={14} /> Eliminar</button>
        <button type="button" className="btn-ghost text-sm ml-auto" onClick={onClose}>Cerrar</button>
      </div>
    </div>
  );
}

const LEVEL_META = {
  campaign: { icon: Megaphone, child: 'adset', childLabel: 'conjuntos' },
  adset: { icon: Layers, child: 'ad', childLabel: 'anuncios' },
  ad: { icon: ImageIcon, child: null, childLabel: null },
};

// The full 4-tile financial strip — the single-account header (unchanged look).
function AccountStrip({ account }) {
  const cur = account.currency;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {[
        ['Cuenta', account.name || '—'],
        ['Gastado', formatAdMoney(account.amountSpent, cur)],
        ['Saldo', account.balance != null ? formatAdMoney(account.balance, cur) : '—'],
        ['Límite de gasto', account.spendCap != null ? formatAdMoney(account.spendCap, cur) : 'Sin límite'],
      ].map(([k, v]) => (
        <div key={k} className="rounded-lg border border-ink-100 bg-ink-50 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-400">{k}</div>
          <div className="truncate text-sm font-semibold text-ink-900" title={String(v)}>{v}</div>
        </div>
      ))}
    </div>
  );
}

// Compact per-account banner above each account's campaigns when several
// accounts are aggregated (name + currency + spent/balance at a glance).
function AccountBanner({ account }) {
  const cur = account.currency;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-ink-100 bg-ink-50 px-3 py-2">
      <span className="text-sm font-semibold text-ink-900">{account.name || 'Cuenta publicitaria'}</span>
      {cur && <span className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-500">{cur}</span>}
      {account.disabled && <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">Inactiva</span>}
      <span className="ml-auto flex flex-wrap items-center gap-x-3 text-xs text-ink-500 tabular-nums">
        <span><span className="text-ink-400">Gastado</span> {formatAdMoney(account.amountSpent, cur)}</span>
        {account.balance != null && <span><span className="text-ink-400">Saldo</span> {formatAdMoney(account.balance, cur)}</span>}
      </span>
    </div>
  );
}

export default function AdsManager({ onChanged }) {
  const [preset, setPreset] = useState('last_28d');
  const [board, setBoard] = useState({ loading: true, error: null, accounts: [], account: null, currency: null, campaigns: [] });
  const [expanded, setExpanded] = useState({}); // id → bool
  const [kids, setKids] = useState({});          // parentId → { loading, error, level, rows }
  const [showInsights, setShowInsights] = useState({}); // id → bool
  const [editing, setEditing] = useState(null);  // node id
  const [busyId, setBusyId] = useState(null);
  const [note, setNote] = useState(null);        // { ok, text }
  const [view, setView] = useState('tree');      // 'tree' | 'create'

  const call = useCallback(async (ads) => {
    const { data, error } = await supabase.functions.invoke('meta-social', { body: { ads } });
    if (error) throw new Error(error.message || 'Sin respuesta');
    if (!data?.ok) throw new Error(data?.error || 'No se pudo completar');
    return data;
  }, []);

  const loadBoard = useCallback(async (p = preset) => {
    setBoard((b) => ({ ...b, loading: true, error: null }));
    try {
      const data = await call({ op: 'board', datePreset: p });
      setBoard({ loading: false, error: null, ...resolveAdsBoard(data) });
    } catch (e) {
      setBoard({ loading: false, error: e.message || 'No se pudieron leer los anuncios', accounts: [], account: null, currency: null, campaigns: [] });
    }
  }, [call, preset]);

  useEffect(() => { loadBoard(preset); }, [preset, loadBoard]);

  const loadChildren = useCallback(async (node) => {
    const childLevel = LEVEL_META[node.level].child;
    if (!childLevel) return;
    setKids((k) => ({ ...k, [node.id]: { ...(k[node.id] || {}), loading: true, error: null } }));
    try {
      const data = await call({ op: 'children', level: childLevel, parentId: node.id, datePreset: preset });
      // Children inherit their campaign's account currency (the board mixes
      // accounts that may bill in different currencies).
      setKids((k) => ({ ...k, [node.id]: { loading: false, error: null, ...resolveAdChildren(data, node.currency || board.currency) } }));
    } catch (e) {
      setKids((k) => ({ ...k, [node.id]: { loading: false, error: e.message || 'Error', level: childLevel, rows: [] } }));
    }
  }, [call, preset, board.currency]);

  const toggle = useCallback((node) => {
    setExpanded((ex) => {
      const open = !ex[node.id];
      if (open && !kids[node.id]) loadChildren(node);
      return { ...ex, [node.id]: open };
    });
  }, [kids, loadChildren]);

  // Refresh just the scope a mutation touched: campaign → board; adset/ad →
  // the parent's children (so sibling state and expansions survive).
  const refreshScope = useCallback((node) => {
    if (node.level === 'campaign') return loadBoard();
    const parentId = node.level === 'adset' ? node.campaignId : node.adsetId;
    if (parentId && expanded[parentId]) return loadChildren({ id: parentId, level: node.level === 'adset' ? 'campaign' : 'adset', currency: node.currency });
    return loadBoard();
  }, [loadBoard, loadChildren, expanded]);

  const runMutation = useCallback(async (node, ads, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusyId(node.id);
    setNote(null);
    try {
      await call({ id: node.id, level: node.level, ...ads });
      setNote({ ok: true, text: 'Hecho.' });
      setEditing(null);
      await refreshScope(node);
      onChanged?.();
    } catch (e) {
      setNote({ ok: false, text: e.message || 'No se pudo completar' });
    } finally {
      setBusyId(null);
    }
  }, [call, refreshScope, onChanged]);

  const toggleStatus = (node) => {
    const next = node.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    runMutation(node, { op: 'status', status: next }, next === 'ACTIVE'
      ? `¿Activar "${node.name}"? Empezará a gastar presupuesto.`
      : `¿Pausar "${node.name}"?`);
  };
  const del = (node) => runMutation(node, { op: 'delete' }, `¿Eliminar "${node.name}"? Esta acción no se puede deshacer.`);
  const dup = (node) => runMutation(node, { op: 'duplicate' }, `¿Duplicar "${node.name}"? La copia se crea pausada.`);

  const NodeRow = ({ node, depth }) => {
    const meta = LEVEL_META[node.level];
    const Icon = meta.icon;
    const open = !!expanded[node.id];
    const isBusy = busyId === node.id;
    const child = kids[node.id];
    return (
      <div>
        <div className="flex items-start gap-2 rounded-xl border border-ink-100 bg-surface px-3 py-2.5" style={{ marginLeft: depth * 16 }}>
          {meta.child ? (
            <button type="button" onClick={() => toggle(node)} className="mt-0.5 text-ink-400 hover:text-ink-700" aria-label={open ? 'Contraer' : 'Expandir'}>
              {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          ) : (
            <span className="mt-0.5 w-4 shrink-0" />
          )}
          {node.thumb ? (
            <div className="mt-0.5 h-9 w-9 shrink-0 overflow-hidden rounded-md bg-ink-100">
              <ImageView id={null} fallbackUrl={node.thumb} alt="" className="h-full w-full object-cover" placeholderClassName="h-full w-full" />
            </div>
          ) : (
            <Icon size={16} className="mt-1 shrink-0 text-ink-400" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-ink-900" title={node.name}>{node.name}</span>
              <Pill status={node.effectiveStatus} />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-400">
              {node.level === 'campaign' && node.objective && <span>{objectiveLabel(node.objective)}</span>}
              {node.dailyBudget != null && <span>{formatAdMoney(node.dailyBudget, node.currency)}/día</span>}
              {node.lifetimeBudget != null && <span>{formatAdMoney(node.lifetimeBudget, node.currency)} total</span>}
              {node.targetingSummary && <span className="truncate">{node.targetingSummary}</span>}
            </div>
            <div className="mt-1"><MetricStrip ins={node.insights} currency={node.currency} /></div>
            {showInsights[node.id] && <div className="mt-2">{insightsGrid(node.insights, node.currency)}</div>}
            {editing === node.id && (
              <NodeEditor
                node={node} currency={node.currency} busy={isBusy}
                onSave={(ads) => runMutation(node, ads)}
                onDelete={() => del(node)}
                onDuplicate={() => dup(node)}
                onClose={() => setEditing(null)}
              />
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button type="button" title={node.status === 'ACTIVE' ? 'Pausar' : 'Activar'} disabled={isBusy} onClick={() => toggleStatus(node)}
              className="grid h-8 w-8 place-items-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-900 disabled:opacity-40">
              {isBusy ? <RefreshCw size={15} className="animate-spin" /> : node.status === 'ACTIVE' ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <button type="button" title="Métricas" onClick={() => setShowInsights((s) => ({ ...s, [node.id]: !s[node.id] }))}
              className={`grid h-8 w-8 place-items-center rounded-md hover:bg-ink-100 ${showInsights[node.id] ? 'text-brand-700' : 'text-ink-500 hover:text-ink-900'}`}>
              <BarChart3 size={15} />
            </button>
            <button type="button" title="Editar" onClick={() => setEditing((e) => (e === node.id ? null : node.id))}
              className={`grid h-8 w-8 place-items-center rounded-md hover:bg-ink-100 ${editing === node.id ? 'text-brand-700' : 'text-ink-500 hover:text-ink-900'}`}>
              <Pencil size={15} />
            </button>
          </div>
        </div>

        {open && (
          <div className="mt-1.5 space-y-1.5">
            {child?.loading && <div className="py-2 text-xs text-ink-400" style={{ marginLeft: (depth + 1) * 16 }}>Cargando {meta.childLabel}…</div>}
            {child?.error && <div className="py-2 text-xs text-amber-700" style={{ marginLeft: (depth + 1) * 16 }}>{child.error}</div>}
            {child && !child.loading && !child.error && child.rows.length === 0 && (
              <div className="py-2 text-xs text-ink-400" style={{ marginLeft: (depth + 1) * 16 }}>Sin {meta.childLabel}.</div>
            )}
            {(child?.rows || []).map((c) => <NodeRow key={c.id} node={c} depth={depth + 1} />)}
          </div>
        )}
      </div>
    );
  };

  if (view === 'create') {
    return <CreateWizard currency={board.currency} onBack={() => setView('tree')} onCreated={() => { setView('tree'); loadBoard(); onChanged?.(); }} call={call} />;
  }

  const accounts = board.accounts || [];
  const multiAccount = accounts.length > 1;
  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-full border border-ink-200 bg-surface p-0.5 text-xs">
          {DATE_PRESETS.map(([id, label]) => (
            <button key={id} type="button" onClick={() => setPreset(id)}
              className={`rounded-full px-2.5 py-1 font-medium ${preset === id ? 'bg-brand-600 text-white' : 'text-ink-500 hover:text-ink-800'}`}>{label}</button>
          ))}
        </div>
        <button type="button" className="btn-ghost text-sm" onClick={() => loadBoard()} disabled={board.loading} title="Actualizar">
          <RefreshCw size={14} className={board.loading ? 'animate-spin' : ''} />
        </button>
        <button type="button" className="btn-brand ml-auto" onClick={() => setView('create')}><Plus size={15} /> Crear anuncio</button>
      </div>

      {/* Single account: the full financial strip (unchanged). */}
      {!multiAccount && accounts[0] && <AccountStrip account={accounts[0]} />}

      {note && <div className={`text-sm ${note.ok ? 'text-emerald-700' : 'text-red-600'}`}>{note.text}</div>}

      {/* Campaign tree — grouped by ad account so EVERY ad shows (Instagram
          boosts + Business Suite promotions included, across every account). */}
      {board.loading && board.campaigns.length === 0 ? (
        <div className="py-8 text-center text-sm text-ink-400">Leyendo anuncios…</div>
      ) : board.error ? (
        <div className="rounded-xl border border-ink-100 bg-ink-50 p-4 text-sm">
          <div className="text-red-600">{board.error}</div>
          <div className="mt-1 text-xs text-ink-400">Verifica que el token de Meta Business tenga el permiso <code>ads_management</code> y una cuenta publicitaria.</div>
        </div>
      ) : board.campaigns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-200 p-8 text-center">
          <Megaphone size={22} className="mx-auto text-ink-300" />
          <div className="mt-2 text-sm text-ink-500">Aún no hay campañas en {multiAccount ? 'estas cuentas' : 'esta cuenta'}.</div>
          <button type="button" className="btn-brand mt-3" onClick={() => setView('create')}><Plus size={15} /> Crear tu primer anuncio</button>
        </div>
      ) : multiAccount ? (
        <div className="space-y-5">
          {accounts.map((account) => (
            <section key={account.id} className="space-y-2">
              <AccountBanner account={account} />
              {account.campaigns.length === 0 ? (
                <div className="rounded-xl border border-dashed border-ink-200 px-3 py-3 text-xs text-ink-400">
                  {account.unreadable ? 'No se pudo leer esta cuenta (revisa permisos).' : 'Sin campañas en esta cuenta.'}
                </div>
              ) : account.campaigns.map((c) => <NodeRow key={c.id} node={c} depth={0} />)}
            </section>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {(accounts[0]?.campaigns || []).map((c) => <NodeRow key={c.id} node={c} depth={0} />)}
        </div>
      )}
    </div>
  );
}

// ── Create wizard: boost an existing IG post into a campaign+adset+ad ───────
function CreateWizard({ currency, onBack, onCreated, call }) {
  const [step, setStep] = useState(0);
  const [media, setMedia] = useState({ loading: true, items: [], error: null });
  const [picked, setPicked] = useState(null);
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('OUTCOME_ENGAGEMENT');
  const [budgetKind, setBudgetKind] = useState('daily'); // 'daily' | 'lifetime'
  const [budget, setBudget] = useState('5');
  const [tgt, setTgt] = useState(emptyTargeting());
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [launchPaused, setLaunchPaused] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await call({ op: 'promotable' });
        setMedia({ loading: false, error: null, items: (data.media || []).map((m) => ({
          id: m.id,
          caption: m.caption || '',
          thumb: m.media_type === 'VIDEO' ? (m.thumbnail_url || m.media_url) : (m.media_url || m.thumbnail_url),
        })) });
      } catch (e) {
        setMedia({ loading: false, error: e.message || 'No se pudieron leer las publicaciones', items: [] });
      }
    })();
  }, [call]);

  const submit = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const info = objectiveInfo(objective);
      await call({
        op: 'create',
        name: name.trim() || (picked?.caption ? picked.caption.slice(0, 40) : 'Promoción'),
        objective,
        optimizationGoal: info.optimizationGoal,
        billingEvent: info.billingEvent,
        mediaId: picked.id,
        currency,
        dailyBudget: budgetKind === 'daily' ? Number(budget) : null,
        lifetimeBudget: budgetKind === 'lifetime' ? Number(budget) : null,
        targeting: buildTargeting(tgt),
        startTime: start ? new Date(start).toISOString() : undefined,
        endTime: end ? new Date(end).toISOString() : undefined,
        launchPaused,
      });
      onCreated();
    } catch (e) {
      setErr(e.message || 'No se pudo crear el anuncio');
    } finally {
      setBusy(false);
    }
  }, [call, name, objective, picked, currency, budgetKind, budget, tgt, start, end, launchPaused, onCreated]);

  const STEPS = ['Publicación', 'Objetivo', 'Presupuesto', 'Público', 'Revisar'];
  const canNext = [!!picked, !!objective, Number(budget) > 0, tgt.countries.length > 0, true][step];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button type="button" className="btn-ghost text-sm" onClick={onBack}><ArrowLeft size={15} /> Volver</button>
        <div className="ml-auto flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <span key={s} className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-brand-600' : i < step ? 'w-3 bg-brand-300' : 'w-3 bg-ink-200'}`} title={s} />
          ))}
        </div>
      </div>
      <div className="text-sm font-medium text-ink-900">{step + 1}. {STEPS[step]}</div>

      {step === 0 && (
        media.loading ? <div className="py-6 text-sm text-ink-400">Cargando publicaciones…</div>
          : media.error ? <div className="text-sm text-red-600">{media.error}</div>
          : (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {media.items.map((m) => (
                <button key={m.id} type="button" onClick={() => setPicked(m)}
                  className={`relative aspect-square overflow-hidden rounded-lg bg-ink-100 ring-2 ${picked?.id === m.id ? 'ring-brand-600' : 'ring-transparent hover:ring-ink-200'}`}>
                  <ImageView id={null} fallbackUrl={m.thumb} alt={m.caption} className="h-full w-full object-cover" placeholderClassName="h-full w-full" />
                  {picked?.id === m.id && <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-brand-600 text-white"><Check size={12} /></span>}
                </button>
              ))}
            </div>
          )
      )}

      {step === 1 && (
        <div className="space-y-2">
          {OBJECTIVES.map((o) => (
            <button key={o.id} type="button" onClick={() => setObjective(o.id)}
              className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${objective === o.id ? 'border-brand-300 bg-brand-50' : 'border-ink-200 hover:bg-ink-50'}`}>
              <Rocket size={18} className={objective === o.id ? 'text-brand-700' : 'text-ink-400'} />
              <div><div className="text-sm font-medium text-ink-900">{o.label}</div><div className="text-xs text-ink-500">{o.hint}</div></div>
              {objective === o.id && <Check size={16} className="ml-auto text-brand-700" />}
            </button>
          ))}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <div className="inline-flex rounded-full border border-ink-200 bg-surface p-0.5 text-xs">
            {[['daily', 'Diario'], ['lifetime', 'Total']].map(([id, label]) => (
              <button key={id} type="button" onClick={() => setBudgetKind(id)} className={`rounded-full px-3 py-1 font-medium ${budgetKind === id ? 'bg-brand-600 text-white' : 'text-ink-500 hover:text-ink-800'}`}>{label}</button>
            ))}
          </div>
          <div>
            <div className="eyebrow-xs mb-1.5">Importe ({currency || 'moneda'})</div>
            <input type="number" min="1" step="0.01" className="input" value={budget} onChange={(e) => setBudget(e.target.value)} />
            <p className="mt-1 text-xs text-ink-400">{budgetKind === 'daily' ? 'Gasto máximo por día.' : 'Gasto total durante toda la campaña.'}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="text-xs text-ink-500">Inicio (opcional)<input type="datetime-local" className="input mt-1" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label className="text-xs text-ink-500">Fin {budgetKind === 'lifetime' ? '(requerido para total)' : '(opcional)'}<input type="datetime-local" className="input mt-1" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          </div>
        </div>
      )}

      {step === 3 && <TargetingEditor value={tgt} onChange={setTgt} />}

      {step === 4 && (
        <div className="space-y-3">
          <div className="flex gap-3 rounded-xl border border-ink-100 p-3">
            {picked?.thumb && <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-ink-100"><ImageView id={null} fallbackUrl={picked.thumb} alt="" className="h-full w-full object-cover" placeholderClassName="h-full w-full" /></div>}
            <div className="min-w-0 text-sm">
              <div className="font-medium text-ink-900">{name.trim() || (picked?.caption ? picked.caption.slice(0, 40) : 'Promoción')}</div>
              <div className="text-ink-500">{objectiveInfo(objective).label} · {budgetKind === 'daily' ? `${formatAdMoney(Number(budget), currency)}/día` : `${formatAdMoney(Number(budget), currency)} total`}</div>
              <div className="mt-0.5 text-xs text-ink-400">{summarizeTargeting(buildTargeting(tgt)) || 'Público amplio'}</div>
            </div>
          </div>
          <div>
            <div className="eyebrow-xs mb-1.5">Nombre de la campaña (opcional)</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Promoción de junio…" />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" checked={launchPaused} onChange={(e) => setLaunchPaused(e.target.checked)} />
            Crear pausado (revisar antes de gastar)
          </label>
          {err && <div className="text-sm text-red-600">{err}</div>}
        </div>
      )}

      {/* Footer nav */}
      <div className="flex items-center gap-2 border-t border-ink-100 pt-3">
        {step > 0 && <button type="button" className="btn-secondary" onClick={() => setStep((s) => s - 1)} disabled={busy}>Atrás</button>}
        {step < STEPS.length - 1 ? (
          <button type="button" className="btn-brand ml-auto" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>Siguiente</button>
        ) : (
          <button type="button" className="btn-brand ml-auto" disabled={busy || !picked} onClick={submit}>
            {busy ? <RefreshCw size={15} className="animate-spin" /> : <Rocket size={15} />} {launchPaused ? 'Crear pausado' : 'Crear y publicar'}
          </button>
        )}
      </div>
    </div>
  );
}
