import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, Bot, Cpu, KeyRound, Radar, RefreshCw, Satellite, Send, ShieldAlert,
  TrendingUp, X, Zap,
} from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { db, newId } from '../db/database.js';
import { supabase } from '../db/supabaseClient.js';
import { useLiveQueryStatus } from '../db/hooks.js';
import {
  resolveIntegrationBoard,
  resolveUplinkFeed,
  resolveActivityFeed,
  resolveBusinessPulse,
  resolveOpsFeed,
  resolveActivityHeatmap,
  systemIntegrity,
  radarPoints,
  sparkPoints,
  agoLabel,
} from '../core/jarvis/index.js';
import { formatMoney } from '../lib/format.js';
import './jarvis.css';

// Deploy telemetry baked in at build time by vite.config.js — the commit this
// deploy runs, plus the short git log ("cambios en vigor").
const BUILD = (() => {
  try {
    return JSON.parse(import.meta.env.VITE_BUILD_META || '{}');
  } catch {
    return {};
  }
})();

/** Animated count-up for the stat strip. */
function useCountUp(target, ms = 900) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const to = Number(target) || 0;
    if (!to) { setValue(to); return undefined; }
    const t0 = performance.now();
    let raf;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      setValue(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** Typewriter reveal for the newest Claude transmission. */
function TypeLine({ text }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    if (!text) return undefined;
    const iv = setInterval(() => {
      setN((v) => {
        if (v >= text.length) { clearInterval(iv); return v; }
        return v + 2;
      });
    }, 18);
    return () => clearInterval(iv);
  }, [text]);
  const done = n >= (text || '').length;
  return (
    <span className="body">
      {(text || '').slice(0, n)}
      {!done && <span className="jv-caret" />}
    </span>
  );
}

function StatusChip({ status, label }) {
  return (
    <span className={`jv-chip jv-${status}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

export default function Jarvis() {
  const { profileId, settings, isAdmin, refreshSettings } = useApp();

  // Cross-client freshness: invalidate() only fires for THIS tab's mutations,
  // so a slow tick re-runs the queries to pick up Claude's replies and rows
  // written from other devices.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(iv);
  }, []);

  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const iv = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(iv);
  }, []);

  const { data: messages } = useLiveQueryStatus(
    () => db.claudeMessages.where('profileId').equals(profileId || '').toArray(),
    [profileId, tick],
    [],
  );

  // The business rows themselves (not just counts) — the pulse panel and the
  // ops feed project honest figures straight from them. `tick` keeps them
  // fresh across devices, same as the uplink thread.
  const { data: biz } = useLiveQueryStatus(
    async () => {
      const [quotes, orders, customers, products, quoteLines] = await Promise.all([
        db.quotes.where('profileId').equals(profileId || '').toArray(),
        db.orders.where('profileId').equals(profileId || '').toArray(),
        db.customers.where('profileId').equals(profileId || '').toArray(),
        db.products.where('profileId').equals(profileId || '').toArray(),
        db.quoteLines.toArray(),
      ]);
      return { quotes, orders, customers, products, quoteLines };
    },
    [profileId, tick],
    { quotes: [], orders: [], customers: [], products: [], quoteLines: [] },
  );

  // ── live diagnostics ─────────────────────────────────────────────────
  const [probes, setProbes] = useState({});
  const [scanning, setScanning] = useState(false);
  const setProbe = useCallback((key, value) => {
    setProbes((p) => ({ ...p, [key]: value }));
  }, []);

  const runDiagnostics = useCallback(async () => {
    if (scanning) return;
    setScanning(true);

    const timed = async (fn) => {
      const t0 = performance.now();
      const out = await fn();
      return { ms: Math.round(performance.now() - t0), ...(out || {}) };
    };
    const invoke = async (name, body) => {
      const { data, error } = await supabase.functions.invoke(name, body ? { body } : undefined);
      if (error) {
        let msg = error.message || 'sin respuesta';
        try {
          const detail = await error.context?.json?.();
          if (detail?.error) msg = String(detail.error).slice(0, 120);
        } catch { /* not JSON */ }
        throw new Error(msg);
      }
      return data;
    };

    const checks = [
      ['supabase', () => timed(async () => {
        await db.settings.get(profileId || '');
        return { note: 'Postgres responde' };
      })],
      ['claude', () => timed(async () => {
        const data = await invoke('claude-chat', { test: true });
        if (data?.configured === false) return { soft: true, note: 'Sin llave API' };
        if (!data?.ok) throw new Error(data?.error || 'llave rechazada');
        return { note: data.model };
      })],
      ['bpd', () => timed(async () => {
        const data = await invoke('bpd-rate');
        if (!data?.usd || (!data.usd.compra && !data.usd.venta)) {
          throw new Error(data?.error || 'el banco no devolvió tasa');
        }
        await refreshSettings();
        const dop = Number(data.usd.venta) || Number(data.usd.compra);
        return { note: `1 USD ≈ RD$ ${dop.toFixed(2)}` };
      })],
      ['shopify', () => timed(async () => {
        const data = await invoke('shopify-sync', { test: true, store: 'alcover' });
        if (data?.configured === false) return { soft: true, note: 'Sin credenciales' };
        if (!data?.ok) throw new Error(data?.error || (data?.missingScopes?.length ? `faltan scopes: ${data.missingScopes.join(', ')}` : 'token rechazado'));
        return { note: data.shop || data.domain || 'Token válido' };
      })],
      ['shopifyLsg', () => timed(async () => {
        const data = await invoke('shopify-sync', { test: true, store: 'lifestylegarden' });
        if (data?.configured === false) return { soft: true, note: 'Sin credenciales' };
        if (!data?.ok) throw new Error(data?.error || 'token rechazado');
        return { note: data.shop || data.domain || 'Token válido' };
      })],
      ['whatsapp', () => timed(async () => {
        const data = await invoke('wa-send', { test: true });
        if (data?.configured === false) return { soft: true, note: 'Sin credenciales' };
        if (!data?.ok) throw new Error(data?.error || 'token rechazado');
        return { note: 'Meta Graph responde' };
      })],
    ];

    await Promise.all(checks.map(async ([key, run]) => {
      setProbe(key, { state: 'scanning' });
      try {
        const r = await run();
        setProbe(key, { state: 'ok', ...r });
      } catch (e) {
        setProbe(key, { state: 'fail', note: e?.message || 'fallo' });
      }
    }));
    setScanning(false);
  }, [scanning, profileId, refreshSettings, setProbe]);

  // ── uplink console ───────────────────────────────────────────────────
  // With a Claude API key linked, the console is a LIVE channel: claude-chat
  // (Edge Function) relays the message to the Claude API and persists both
  // turns server-side. Without a key, messages queue as pending directives.
  const claudeLinked = !!settings?.claudeConnectedAt;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [uplinkError, setUplinkError] = useState(null);
  const consoleEndRef = useRef(null);

  const transmit = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setUplinkError(null);
    try {
      if (claudeLinked) {
        const { data, error } = await supabase.functions.invoke('claude-chat', {
          body: { message: content },
        });
        if (error) throw new Error(error.message || 'Sin respuesta del enlace');
        if (data?.configured === false || data?.ok === false || data?.error) {
          throw new Error(data?.error || 'El enlace no respondió');
        }
        setDraft('');
        // Both turns were written server-side — pull them in now.
        setTick((t) => t + 1);
      } else {
        await db.claudeMessages.put({
          id: newId(),
          profileId: profileId || 'team',
          role: 'user',
          kind: 'directive',
          content,
          status: 'pending',
          meta: {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        setDraft('');
      }
    } catch (e) {
      setUplinkError(e?.message || 'Fallo de transmisión');
    } finally {
      setSending(false);
    }
  }, [draft, sending, profileId, claudeLinked]);

  // One-time key link: the RPC writes the write-only claude_config table and
  // stamps settings.claudeConnectedAt (the UI mirror). OPTIONAL — the channel
  // works without it as a directive queue answered by Claude Code sessions
  // (the existing subscription); the key only buys instant in-app replies.
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState(null);
  const linkClaude = useCallback(async () => {
    const key = apiKey.trim();
    if (!key || linking) return;
    setLinking(true);
    setLinkError(null);
    try {
      const { error } = await supabase.rpc('save_claude_config', {
        p_api_key: key,
        p_model: 'claude-opus-4-8',
      });
      if (error) throw new Error(error.message);
      setApiKey('');
      await refreshSettings();
    } catch (e) {
      setLinkError(e?.message || 'No se pudo guardar la llave');
    } finally {
      setLinking(false);
    }
  }, [apiKey, linking, refreshSettings]);

  // ── projections ──────────────────────────────────────────────────────
  const now = clock.getTime();
  // Minute-resolution clock for the row-heavy projections — the money rollup
  // shouldn't re-run on every second tick (ago labels are minute-grained).
  const nowMin = Math.floor(now / 60_000) * 60_000;
  const board = useMemo(
    () => resolveIntegrationBoard({ settings: settings || {}, probes, now }),
    [settings, probes, now],
  );
  const integrity = useMemo(() => systemIntegrity(board), [board]);
  const blips = useMemo(() => radarPoints(board), [board]);
  const thread = useMemo(() => resolveUplinkFeed(messages), [messages]);
  const activity = useMemo(
    () => resolveActivityFeed({ commits: BUILD.log || [], messages, now }),
    [messages, now],
  );
  const pulse = useMemo(
    () => resolveBusinessPulse({ quotes: biz.quotes, lines: biz.quoteLines, now: nowMin }),
    [biz, nowMin],
  );
  const heatmap = useMemo(
    () => resolveActivityHeatmap({
      quotes: biz.quotes, orders: biz.orders, customers: biz.customers, now: nowMin,
    }),
    [biz, nowMin],
  );
  const opsFeed = useMemo(
    () => resolveOpsFeed({
      quotes: biz.quotes, orders: biz.orders, customers: biz.customers, now: nowMin,
    }),
    [biz, nowMin],
  );

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.length]);

  const pendingCount = thread.filter((m) => m.role === 'user' && m.status === 'pending').length;
  const lastClaudeId = [...thread].reverse().find((m) => m.role === 'claude')?.id;
  const integrityShown = useCountUp(integrity);
  const nQuotes = useCountUp(biz.quotes.length);
  const nOrders = useCountUp(biz.orders.length);
  const nCustomers = useCountUp(biz.customers.length);
  const nProducts = useCountUp(biz.products.length);
  const usdPipeline = useCountUp(Math.round(pulse.pipelineUsd));
  const usdOutstanding = useCountUp(Math.round(pulse.outstandingUsd));
  const usdWon = useCountUp(Math.round(pulse.wonMonth.totalUsd));

  if (!isAdmin) {
    return (
      <div className="jarvis flex items-center justify-center">
        <div className="jv-panel p-8 text-center max-w-sm">
          <ShieldAlert size={28} className="mx-auto mb-3 jv-fail" />
          <div className="jv-title" style={{ fontSize: '1rem' }}>Acceso restringido</div>
          <p className="text-sm mt-2" style={{ color: 'var(--jv-muted)' }}>
            El núcleo JARVIS solo responde al administrador.
          </p>
          <Link to="/" className="jv-btn mt-4">
            <X size={14} /> Volver a la app
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="jarvis">
      {/* ── HUD header ─────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-end justify-between gap-3 px-1 pb-4">
        <div>
          <div className="jv-kicker">Roset Ops Core · v{String(BUILD.sha || '').slice(0, 7) || 'dev'}</div>
          <h1 className="jv-title">JARVIS</h1>
        </div>
        <div className="flex items-start gap-4">
          <div className="jv-mono text-right text-xs" style={{ color: 'var(--jv-muted)' }}>
            <div style={{ color: 'var(--jv-fg)', fontSize: '1.05rem' }}>
              {clock.toLocaleTimeString('es-DO', { hour12: false })}
            </div>
            <div>{clock.toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
            <div className="mt-1">
              <StatusChip
                status={navigator.onLine ? 'online' : 'fail'}
                label={navigator.onLine ? 'Enlace activo' : 'Sin red'}
              />
            </div>
          </div>
          <Link to="/" className="jv-btn flex-none" aria-label="Salir de JARVIS">
            <X size={14} /> Salir
          </Link>
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-[280px_1fr_300px]">
        {/* ── left column: reactor + stats ─────────────────────────── */}
        <div className="space-y-4">
          <section className="jv-panel p-4">
            <div className="jv-gauge">
              <svg viewBox="0 0 120 120" aria-hidden="true">
                <circle className="track" cx="60" cy="60" r="52" />
                <circle
                  className="value"
                  cx="60"
                  cy="60"
                  r="52"
                  style={{ strokeDashoffset: 326.73 * (1 - integrityShown / 100) }}
                />
              </svg>
              <div className="reading">
                <b>{integrityShown}%</b>
                <span>Integridad</span>
              </div>
            </div>
            <p className="jv-mono text-center text-xs mt-3" style={{ color: 'var(--jv-muted)' }}>
              {board.filter((c) => c.status === 'online').length} sistemas en línea ·{' '}
              {board.filter((c) => c.status === 'fail' || c.status === 'offline').length} fuera
            </p>
          </section>

          <section className="jv-panel">
            <div className="jv-panel-head"><Activity size={12} /> Telemetría</div>
            <div className="grid grid-cols-2 gap-3 p-4">
              <div className="jv-stat"><b>{nQuotes}</b><span>Cotizaciones</span></div>
              <div className="jv-stat"><b>{nOrders}</b><span>Pedidos</span></div>
              <div className="jv-stat"><b>{nCustomers}</b><span>Clientes</span></div>
              <div className="jv-stat"><b>{nProducts}</b><span>Productos</span></div>
            </div>
          </section>
        </div>

        {/* ── center: business pulse + integration grid ────────────── */}
        <div className="space-y-4">
        <section className="jv-panel">
          <div className="jv-panel-head justify-between">
            <span className="flex items-center gap-2"><TrendingUp size={12} /> Pulso comercial</span>
            <span style={{ color: 'var(--jv-faint)', fontWeight: 400 }}>USD · datos reales en vivo</span>
          </div>
          <div className="p-4 space-y-4">
            {/* KPI strip — each figure traces to rows via core/quote/totals */}
            <div className="grid gap-2.5 sm:grid-cols-3">
              <div className="jv-kpi">
                <span className="label">En juego</span>
                <b className="jv-mono">${usdPipeline.toLocaleString('en-US')}</b>
                <span className="sub">
                  {pulse.funnel.find((f) => f.key === 'sent')?.count || 0} enviadas esperando respuesta
                </span>
              </div>
              <div className="jv-kpi">
                <span className="label">Por cobrar</span>
                <b className="jv-mono">${usdOutstanding.toLocaleString('en-US')}</b>
                <span className="sub">saldo pendiente en aceptadas</span>
              </div>
              <div className="jv-kpi is-won">
                <span className="label">
                  Ganado · {clock.toLocaleDateString('es-DO', { month: 'long' })}
                </span>
                <b className="jv-mono">${usdWon.toLocaleString('en-US')}</b>
                <span className="sub">{pulse.wonMonth.count} cotizaciones aceptadas</span>
              </div>
            </div>

            {/* pipeline funnel — bar length is the money each stage holds */}
            <div className="space-y-1.5">
              {pulse.funnel.map((f) => (
                <div key={f.key} className="jv-funnel-row">
                  <span className="name">{f.label}</span>
                  <span className="n jv-mono">{f.count}</span>
                  <div className="bar">
                    <i className={f.key} style={{ width: `${Math.max(f.totalUsd > 0 ? 2 : 0, f.share * 100)}%` }} />
                  </div>
                  <span className="money jv-mono">{formatMoney(f.totalUsd)}</span>
                </div>
              ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {/* weekly cadence — created vs accepted on ONE shared scale */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="jv-kicker">Cadencia · 12 semanas</span>
                  {pulse.weekDelta.created.pct != null && (
                    <span className={`jv-delta ${pulse.weekDelta.created.pct >= 0 ? 'up' : 'down'}`}>
                      {pulse.weekDelta.created.pct >= 0 ? '+' : ''}{pulse.weekDelta.created.pct}% vs sem. ant.
                    </span>
                  )}
                </div>
                {(() => {
                  const created = pulse.series.map((s) => s.created);
                  const accepted = pulse.series.map((s) => s.accepted);
                  const max = Math.max(1, ...created, ...accepted);
                  const cPts = sparkPoints(created, 100, 28, 2, max);
                  const aPts = sparkPoints(accepted, 100, 28, 2, max);
                  return (
                    <svg viewBox="0 0 100 28" className="jv-spark" preserveAspectRatio="none" aria-hidden="true">
                      <defs>
                        <linearGradient id="jvSparkFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--jv-accent)" stopOpacity="0.3" />
                          <stop offset="100%" stopColor="var(--jv-accent)" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      {cPts && <polygon fill="url(#jvSparkFill)" points={`2,26 ${cPts} 98,26`} />}
                      {cPts && <polyline className="created" points={cPts} />}
                      {aPts && <polyline className="accepted" points={aPts} />}
                    </svg>
                  );
                })()}
                <div className="jv-legend">
                  <span><i className="created" /> creadas</span>
                  <span><i className="accepted" /> aceptadas</span>
                </div>
              </div>

              {/* activity heatmap — one cell per real day, GitHub-style */}
              <div>
                <div className="jv-kicker mb-1.5">Actividad · 12 semanas</div>
                <div className="jv-heatmap" role="img" aria-label="Mapa de actividad diaria">
                  {heatmap.cols.map((col) => (
                    <div key={col[0].start} className="col">
                      {col.map((c) => (
                        <i
                          key={c.start}
                          className={c.future ? 'future' : `lv${c.level}`}
                          title={`${new Date(c.start).toLocaleDateString('es-DO', { day: 'numeric', month: 'short' })} · ${c.count} evento${c.count === 1 ? '' : 's'}`}
                        />
                      ))}
                    </div>
                  ))}
                </div>
                <div className="jv-legend mt-1.5">
                  <span>menos</span>
                  {[0, 1, 2, 3, 4].map((l) => <i key={l} className={`hm lv${l}`} />)}
                  <span>más</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="jv-panel">
          <div className="jv-panel-head justify-between">
            <span className="flex items-center gap-2"><Satellite size={12} /> Integraciones</span>
            <button type="button" className="jv-btn" onClick={runDiagnostics} disabled={scanning}>
              {scanning ? <RefreshCw size={12} className="animate-spin" /> : <Zap size={12} />}
              {scanning ? 'Escaneando' : 'Diagnóstico'}
            </button>
          </div>
          <div className="grid gap-2.5 p-3 sm:grid-cols-2">
            {board.map((c) => (
              <div key={c.id} className={`jv-card ${c.status === 'scanning' ? 'is-scanning' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="jv-mono text-sm" style={{ color: 'var(--jv-fg)' }}>{c.name}</div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--jv-muted)' }}>{c.desc}</div>
                  </div>
                  <StatusChip status={c.status} label={c.statusLabel} />
                </div>
                <div className="jv-mono text-xs mt-2 flex items-center justify-between" style={{ color: 'var(--jv-muted)' }}>
                  <span>{c.detail}</span>
                  <span style={{ color: 'var(--jv-muted)' }}>
                    {c.latencyMs != null ? `${c.latencyMs} ms` : c.ago || ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
        </div>

        {/* ── right column: radar + live feeds ─────────────────────── */}
        <div className="space-y-4">
          <section className="jv-panel p-3">
            <div className="jv-panel-head -m-3 mb-2"><Radar size={12} /> Mapa de estado</div>
            <svg viewBox="0 0 100 100" className="jv-radar w-full">
              {[18, 30, 42].map((r) => (
                <circle key={r} className="grid-ring" cx="50" cy="50" r={r} />
              ))}
              {blips.map((b) => (
                <circle
                  key={b.id}
                  cx={b.x}
                  cy={b.y}
                  r="1.8"
                  fill={
                    b.status === 'online' ? 'var(--jv-success)'
                      : b.status === 'fail' ? 'var(--jv-danger)'
                        : b.status === 'stale' ? 'var(--jv-warning)'
                          : b.status === 'offline' ? 'var(--jv-faint)'
                            : 'var(--jv-muted)'
                  }
                >
                  <title>{b.name}</title>
                </circle>
              ))}
              <circle cx="50" cy="50" r="2" fill="var(--jv-fg)" />
            </svg>
          </section>

          <section className="jv-panel">
            <div className="jv-panel-head"><Activity size={12} /> Actividad comercial</div>
            <div className="jv-timeline p-3 max-h-64 overflow-y-auto">
              {opsFeed.map((e) => (
                <div key={e.id} className="trow">
                  <span className={`tdot ${e.tone}`} />
                  <span className="ttext">{e.text}</span>
                  <span className="tago jv-mono">{e.ago || ''}</span>
                </div>
              ))}
              {!opsFeed.length && (
                <div className="text-xs py-2" style={{ color: 'var(--jv-muted)' }}>
                  Sin actividad registrada todavía.
                </div>
              )}
            </div>
          </section>

          <section className="jv-panel">
            <div className="jv-panel-head"><Cpu size={12} /> Cambios en vigor</div>
            <div className="jv-feed jv-mono p-3 max-h-72 overflow-y-auto">
              {BUILD.builtAt ? (
                <div className="item">
                  <span className="tag">deploy</span>
                  <span style={{ color: 'var(--jv-fg)' }}>
                    Build {String(BUILD.sha || '').slice(0, 7)} · {BUILD.ref || 'main'} · {agoLabel(BUILD.builtAt, now)}
                  </span>
                </div>
              ) : null}
              {activity.map((e) => (
                <div key={e.id} className="item">
                  <span className={`tag ${e.type}`}>{e.type === 'commit' ? String(e.tag).slice(0, 7) : e.tag}</span>
                  <span style={{ color: 'var(--jv-fg)' }}>{e.text}</span>
                  <span className="ml-auto flex-none" style={{ color: 'var(--jv-muted)', fontSize: '0.6rem' }}>{e.ago || ''}</span>
                </div>
              ))}
              {!activity.length && !BUILD.builtAt && (
                <div className="text-xs py-2" style={{ color: 'var(--jv-muted)' }}>
                  Sin telemetría de despliegue en esta build.
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* ── Claude uplink console ─────────────────────────────────────── */}
      <section className="jv-panel mt-4">
        <div className="jv-panel-head justify-between">
          <span className="flex items-center gap-2"><Bot size={12} /> Enlace Claude</span>
          <span style={{ color: 'var(--jv-faint)', fontWeight: 400 }}>
            {claudeLinked
              ? `Canal en vivo · ${settings?.claudeModel || 'claude-opus-4-8'} responde al instante`
              : pendingCount
                ? `${pendingCount} directiva${pendingCount > 1 ? 's' : ''} en cola — Claude Code las atiende en su próxima sesión`
                : 'Canal asíncrono — Claude Code atiende las directivas con tu cuenta actual, sin llave API'}
          </span>
        </div>
        <div className="jv-console p-4 max-h-80 overflow-y-auto">
          {thread.length === 0 && (
            <div className="row">
              <span className="who claude">claude</span>
              <span className="body" style={{ color: 'var(--jv-muted)' }}>
                {claudeLinked
                  ? 'Canal en vivo. Pregunta lo que necesites — respondo al instante.'
                  : 'Canal establecido. Transmite una directiva — queda registrada aquí y Claude Code la recoge en su próxima sesión, con tu cuenta actual. No requiere llave API.'}
              </span>
            </div>
          )}
          {thread.map((m) => (
            <div key={m.id} className="row">
              <span className={`who ${m.role === 'claude' ? 'claude' : 'user'}`}>
                {m.role === 'claude' ? 'claude' : 'tú'}
              </span>
              {m.role === 'claude' && m.id === lastClaudeId
                ? <TypeLine text={m.content} />
                : <span className="body">{m.content}</span>}
              {m.role === 'user' && (
                <span className="ml-auto flex-none">
                  <StatusChip
                    status={m.status === 'done' ? 'online' : m.status === 'seen' ? 'scanning' : 'standby'}
                    label={m.status === 'done' ? 'Hecho' : m.status === 'seen' ? 'En curso' : 'En cola'}
                  />
                </span>
              )}
            </div>
          ))}
          {sending && claudeLinked && (
            <div className="row">
              <span className="who claude">claude</span>
              <span className="body" style={{ color: 'var(--jv-muted)' }}>
                procesando<span className="jv-caret" />
              </span>
            </div>
          )}
          <div ref={consoleEndRef} />
        </div>
        {!claudeLinked && (
          <div className="p-3 border-t" style={{ borderColor: 'var(--jv-border)' }}>
            {!showKeyForm ? (
              <button
                type="button"
                className="jv-btn"
                style={{ minHeight: '1.8rem', fontSize: '0.72rem' }}
                onClick={() => setShowKeyForm(true)}
              >
                <KeyRound size={12} /> Respuestas al instante (opcional, llave API)
              </button>
            ) : (
              <>
                <div className="jv-kicker mb-2">Enlace en vivo — opcional</div>
                <p className="text-xs mb-2" style={{ color: 'var(--jv-muted)' }}>
                  Tu suscripción de Claude no incluye acceso a la API: las respuestas al
                  instante dentro de la app requieren una llave API de Anthropic (pago por
                  uso). Sin llave, el canal funciona igual como cola de directivas.
                </p>
                <div className="flex gap-2">
                  <input
                    className="jv-input"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-ant-…  (llave API de Anthropic)"
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  <button type="button" className="jv-btn jv-btn-primary flex-none" onClick={linkClaude} disabled={!apiKey.trim() || linking}>
                    {linking ? <RefreshCw size={12} className="animate-spin" /> : <Zap size={12} />} Vincular
                  </button>
                </div>
                {linkError && (
                  <div className="text-xs mt-2" style={{ color: 'var(--jv-danger)' }}>{linkError}</div>
                )}
                <p className="text-xs mt-2" style={{ color: 'var(--jv-muted)' }}>
                  La llave se guarda en una tabla de solo escritura (como WhatsApp y Shopify) y nunca llega al navegador.
                </p>
              </>
            )}
          </div>
        )}
        <div className="p-3 border-t" style={{ borderColor: 'var(--jv-border)' }}>
          <div className="flex gap-2">
            <input
              className="jv-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') transmit(); }}
              placeholder={claudeLinked
                ? 'Transmitir a Claude — p. ej. «¿cómo va la tasa hoy?» o «registra: filtro por marca en el catálogo»'
                : 'Transmitir directiva — p. ej. «agrega filtro por marca al catálogo»; Claude Code la atiende'}
              maxLength={2000}
            />
            <button type="button" className="jv-btn jv-btn-primary flex-none" onClick={transmit} disabled={!draft.trim() || sending}>
              <Send size={12} /> Transmitir
            </button>
          </div>
          {uplinkError && (
            <div className="text-xs mt-2" style={{ color: 'var(--jv-danger)' }}>{uplinkError}</div>
          )}
        </div>
      </section>
    </div>
  );
}
