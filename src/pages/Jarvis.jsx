import { userMessageFor } from '../lib/errorMessages.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity, Bot, Command, Cpu, FileText, KeyRound, LayoutDashboard, Megaphone,
  Package, RefreshCw, Satellite, Send, Share2, ShieldAlert, TrendingUp,
  Users, X, Zap,
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
  resolveSocialPulse,
  resolveAdsSalesWeeks,
  resolveWaBrief,
  resolveFollowUps,
  resolveShipments,
  systemIntegrity,
  sparkPoints,
  agoLabel,
} from '../core/jarvis/index.js';
import { formatMoney } from '../lib/format.js';
import { useKeyboardShortcut } from '../lib/useKeyboardShortcut.js';
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

/** Shimmering placeholder block in the final layout's shape (no spinners). */
function Skeleton({ w = '100%', h = '0.8rem', className = '' }) {
  return <span className={`jv-skeleton ${className}`} style={{ width: w, height: h }} aria-hidden="true" />;
}

/** ⌘K command palette — fuzzy-less filter over the page's actions. */
function CommandPalette({ open, onClose, actions }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => {
    if (open) {
      setQuery('');
      setSel(0);
      // Focus after the dialog mounts.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);
  if (!open) return null;

  const q = query.trim().toLowerCase();
  const list = actions.filter((a) => !q
    || a.label.toLowerCase().includes(q)
    || (a.hint || '').toLowerCase().includes(q));
  const cur = Math.min(sel, Math.max(0, list.length - 1));
  const run = (a) => { onClose(); a.run(); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(list.length - 1, cur + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, cur - 1)); }
    else if (e.key === 'Enter' && list[cur]) { e.preventDefault(); run(list[cur]); }
    else if (e.key === 'Escape') onClose();
  };

  return (
    <div className="jv-palette-scrim" onClick={onClose} role="presentation">
      <div className="jv-palette" role="dialog" aria-label="Comandos" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="pin"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSel(0); }}
          onKeyDown={onKey}
          placeholder="Comando o destino…"
          spellCheck={false}
        />
        <div className="plist">
          {list.map((a, i) => {
            const Icon = a.icon;
            return (
              <button
                type="button"
                key={a.id}
                className={`pitem ${i === cur ? 'is-sel' : ''}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => run(a)}
              >
                <Icon size={13} />
                <span className="plabel">{a.label}</span>
                {a.hint && <span className="phint jv-mono">{a.hint}</span>}
              </button>
            );
          })}
          {!list.length && <div className="pempty">Sin coincidencias</div>}
        </div>
        <div className="pfoot jv-mono">↑↓ navegar · ↵ ejecutar · esc cerrar</div>
      </div>
    </div>
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
  const { data: biz, loaded: bizLoaded } = useLiveQueryStatus(
    async () => {
      const [quotes, orders, customers, products, quoteLines, waMessages] = await Promise.all([
        db.quotes.where('profileId').equals(profileId || '').toArray(),
        db.orders.where('profileId').equals(profileId || '').toArray(),
        db.customers.where('profileId').equals(profileId || '').toArray(),
        db.products.where('profileId').equals(profileId || '').toArray(),
        db.quoteLines.toArray(),
        db.waMessages.where('profileId').equals(profileId || '').toArray(),
      ]);
      return { quotes, orders, customers, products, quoteLines, waMessages };
    },
    [profileId, tick],
    { quotes: [], orders: [], customers: [], products: [], quoteLines: [], waMessages: [] },
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
      ['metaSocial', () => timed(async () => {
        const data = await invoke('meta-social', { test: true });
        if (data?.configured === false) return { soft: true, note: 'Sin token de Meta' };
        if (!data?.ok) throw new Error(data?.error || 'token rechazado');
        return { note: data.page || 'Graph responde' };
      })],
    ];

    await Promise.all(checks.map(async ([key, run]) => {
      setProbe(key, { state: 'scanning' });
      try {
        const r = await run();
        setProbe(key, { state: 'ok', ...r });
      } catch (e) {
        setProbe(key, { state: 'fail', note: userMessageFor(e) });
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
  const draftInputRef = useRef(null);

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
      setUplinkError(userMessageFor(e));
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
      setLinkError(userMessageFor(e));
    } finally {
      setLinking(false);
    }
  }, [apiKey, linking, refreshSettings]);

  // ── Meta social (Instagram + Facebook + Ads) ─────────────────────────
  // Linked via the meta-social Edge Function (the token never reaches the
  // browser); once linked, the panel pulls one consolidated snapshot.
  const socialLinked = !!settings?.metaSocialConnectedAt;
  const [socialRaw, setSocialRaw] = useState(null);
  const [socialLoading, setSocialLoading] = useState(false);
  const [socialError, setSocialError] = useState(null);
  const socialBusy = useRef(false);
  const loadSocial = useCallback(async () => {
    if (socialBusy.current) return;
    socialBusy.current = true;
    setSocialLoading(true);
    setSocialError(null);
    try {
      const { data, error } = await supabase.functions.invoke('meta-social', {
        body: { snapshot: true },
      });
      if (error) throw new Error(error.message || 'sin respuesta');
      if (data?.configured === false || data?.error) throw new Error(data?.error || 'sin respuesta');
      setSocialRaw(data);
    } catch (e) {
      setSocialError(userMessageFor(e));
    } finally {
      socialBusy.current = false;
      setSocialLoading(false);
    }
  }, []);
  useEffect(() => {
    if (socialLinked) loadSocial();
  }, [socialLinked, loadSocial]);

  // Connecting Instagram is done from Configuración → Instagram (the OAuth
  // consent flow); this panel just reads the snapshot once linked.

  // ── ⌘K command palette ───────────────────────────────────────────────
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  useKeyboardShortcut('mod+k', () => setPaletteOpen((v) => !v), { ignoreInInput: false });
  const paletteActions = useMemo(() => [
    { id: 'diag', icon: Zap, label: 'Ejecutar diagnóstico', hint: 'integraciones', run: runDiagnostics },
    {
      id: 'transmit',
      icon: Send,
      label: 'Transmitir directiva a Claude',
      hint: 'enlace',
      run: () => draftInputRef.current?.focus(),
    },
    ...(!claudeLinked ? [{
      id: 'key',
      icon: KeyRound,
      label: 'Vincular llave API (respuestas al instante)',
      hint: 'opcional',
      run: () => setShowKeyForm(true),
    }] : []),
    { id: 'dash', icon: LayoutDashboard, label: 'Ir al Dashboard', hint: '/', run: () => navigate('/') },
    { id: 'quotes', icon: FileText, label: 'Ir a Cotizaciones', hint: '/quotes', run: () => navigate('/quotes') },
    { id: 'orders', icon: Package, label: 'Ir a Pedidos', hint: '/orders', run: () => navigate('/orders') },
    { id: 'customers', icon: Users, label: 'Ir a Clientes', hint: '/customers', run: () => navigate('/customers') },
    { id: 'exit', icon: X, label: 'Salir de JARVIS', hint: 'esc', run: () => navigate('/') },
  ], [claudeLinked, navigate, runDiagnostics]);

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
  const waBrief = useMemo(() => resolveWaBrief(biz.waMessages, nowMin), [biz, nowMin]);
  const followUps = useMemo(
    () => resolveFollowUps({
      quotes: biz.quotes, lines: biz.quoteLines, customers: biz.customers,
      messages: biz.waMessages, now: nowMin,
    }),
    [biz, nowMin],
  );
  const shipments = useMemo(
    () => resolveShipments({ orders: biz.orders, now: nowMin }),
    [biz, nowMin],
  );
  const social = useMemo(
    () => (socialRaw ? resolveSocialPulse(socialRaw, { now: nowMin }) : null),
    [socialRaw, nowMin],
  );
  // Ads ↔ sales bridge — only meaningful once the ad rows are in.
  const adsSales = useMemo(
    () => (socialRaw?.adsDaily?.length
      ? resolveAdsSalesWeeks({ adsDaily: socialRaw.adsDaily, quotes: biz.quotes, now: nowMin })
      : null),
    [socialRaw, biz, nowMin],
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
      {/* ── HUD header — centered wordmark, controls on their own row ─── */}
      <header className="jv-header px-1 pb-4">
        <div className="jv-wordmark">
          <h1 className="jv-title">JARVIS</h1>
        </div>
        <div className="jv-header-bar flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="jv-mono text-xs" style={{ color: 'var(--jv-muted)' }}>
            <div className="flex items-center gap-2">
              <span style={{ color: 'var(--jv-fg)', fontSize: '1.05rem' }}>
                {clock.toLocaleTimeString('es-DO', { hour12: false })}
              </span>
              <StatusChip
                status={navigator.onLine ? 'online' : 'fail'}
                label={navigator.onLine ? 'Enlace' : 'Sin red'}
              />
            </div>
            <div className="hidden sm:block">
              {clock.toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long' })}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="jv-btn flex-none"
              onClick={() => setPaletteOpen(true)}
              aria-label="Abrir paleta de comandos"
            >
              <Command size={13} /> <span className="jv-mono" style={{ fontSize: '0.7rem' }}>K</span>
            </button>
            <Link to="/" className="jv-btn flex-none" aria-label="Salir de JARVIS">
              <X size={14} /> Salir
            </Link>
          </div>
        </div>
      </header>

      <div className="jv-grid grid gap-3 xl:grid-cols-[280px_1fr_300px]">
        {/* ── left rail: reactor + stats + integration status list ──── */}
        <div className="jv-col-left flex flex-col gap-3 min-h-0">
          <section className="jv-panel p-3">
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
            <p className="jv-mono text-center text-xs mt-2" style={{ color: 'var(--jv-muted)' }}>
              {board.filter((c) => c.status === 'online').length} sistemas en línea ·{' '}
              {board.filter((c) => c.status === 'fail' || c.status === 'offline').length} fuera
            </p>
          </section>

          <section className="jv-panel">
            <div className="jv-panel-head"><Activity size={12} /> Telemetría</div>
            <div className="grid grid-cols-2 gap-2 p-3">
              <div className="jv-stat"><b>{nQuotes}</b><span>Cotizaciones</span></div>
              <div className="jv-stat"><b>{nOrders}</b><span>Pedidos</span></div>
              <div className="jv-stat"><b>{nCustomers}</b><span>Clientes</span></div>
              <div className="jv-stat"><b>{nProducts}</b><span>Productos</span></div>
            </div>
          </section>

          <section className="jv-panel">
            <div className="jv-panel-head"><Send size={12} /> WhatsApp · 7 días</div>
            <div className="grid grid-cols-2 gap-2 p-3">
              <div className="jv-stat"><b>{waBrief.in7}</b><span>Recibidos</span></div>
              <div className="jv-stat"><b>{waBrief.out7}</b><span>Enviados</span></div>
              <div className="jv-stat">
                <b style={{ color: waBrief.unread > 0 ? 'var(--jv-warning)' : undefined }}>{waBrief.unread}</b>
                <span>Sin leer</span>
              </div>
              <div className="jv-stat">
                <b style={{ fontSize: '0.85rem', lineHeight: '1.9rem' }}>{waBrief.lastInAgo || '—'}</b>
                <span>Último entrante</span>
              </div>
            </div>
          </section>

          {/* Dense status rail — one row per integration; the panel grows to
              the column's full height so nothing trails ragged below it. */}
          <section className="jv-panel flex-1 flex flex-col min-h-0">
            <div className="jv-panel-head justify-between">
              <span className="flex items-center gap-2"><Satellite size={12} /> Integraciones</span>
              <button
                type="button"
                className="jv-btn"
                style={{ minHeight: '1.7rem', fontSize: '0.7rem' }}
                onClick={runDiagnostics}
                disabled={scanning}
              >
                {scanning ? <RefreshCw size={12} className="animate-spin" /> : <Zap size={12} />}
                {scanning ? 'Escaneando' : 'Diagnóstico'}
              </button>
            </div>
            <div className="jv-int-list flex-1 min-h-0 overflow-y-auto">
              {board.map((c) => (
                <div
                  key={c.id}
                  className={`jv-int-row ${c.status === 'scanning' ? 'is-scanning' : ''}`}
                  title={`${c.name} — ${c.statusLabel} · ${c.desc}`}
                >
                  <span className={`idot jv-${c.status}`} aria-label={c.statusLabel} />
                  <span className="iname jv-mono">{c.name}</span>
                  <span className="imeta jv-mono">
                    {c.latencyMs != null ? `${c.latencyMs} ms` : c.ago || c.statusLabel}
                  </span>
                  {c.detail ? <span className="idetail">{c.detail}</span> : null}
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* ── center: business pulse + social ──────────────────────── */}
        <div className="jv-col-center flex flex-col gap-3 min-h-0">
        <section className="jv-panel">
          <div className="jv-panel-head justify-between">
            <span className="flex items-center gap-2"><TrendingUp size={12} /> Pulso comercial</span>
            <span style={{ color: 'var(--jv-faint)', fontWeight: 400 }}>USD · datos reales en vivo</span>
          </div>
          {!bizLoaded ? (
            // Skeleton in the final layout's shape — no spinners, no jumps.
            <div className="p-4 space-y-4">
              <div className="grid gap-2.5 sm:grid-cols-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="jv-kpi" style={{ gap: '0.4rem' }}>
                    <Skeleton w="55%" h="0.6rem" />
                    <Skeleton w="70%" h="1.3rem" />
                    <Skeleton w="85%" h="0.6rem" />
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                {[0, 1, 2].map((i) => <Skeleton key={i} h="0.55rem" />)}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Skeleton h="72px" />
                <Skeleton h="72px" />
              </div>
            </div>
          ) : (
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
                <Link key={f.key} to={f.to} className="jv-funnel-row" title={`Abrir ${f.label.toLowerCase()} en Cotizaciones`}>
                  <span className="name">{f.label}</span>
                  <span className="n jv-mono">{f.count}</span>
                  <div className="bar">
                    <i className={f.key} style={{ width: `${Math.max(f.totalUsd > 0 ? 2 : 0, f.share * 100)}%` }} />
                  </div>
                  <span className="money jv-mono">{formatMoney(f.totalUsd)}</span>
                </Link>
              ))}
            </div>

            {/* follow-ups — which sent quotes have gone quiet, biggest money
                first, deep-linked to chase. Hidden when nothing is stale. */}
            {followUps.count > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="jv-kicker">Seguimientos · {followUps.count} en silencio</span>
                  <span className="jv-mono jv-stale" title="Total en cotizaciones enviadas sin respuesta">
                    {formatMoney(followUps.atRiskUsd)} en riesgo
                  </span>
                </div>
                <div className="space-y-0.5">
                  {followUps.items.map((f) => (
                    <Link key={f.id} to={f.to} className="jv-followup-row" title={`Abrir ${f.name}`}>
                      <span className="name truncate">{f.name}</span>
                      <span className="quiet">{f.quietDays} d sin contacto</span>
                      <span className="money jv-mono">{formatMoney(f.valueUsd)}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* logistics — LR shipments in motion, longest-in-stage first;
                customs dwell is flagged. Hidden when nothing's open. */}
            {shipments.count > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="jv-kicker">En tránsito · {shipments.count} pedidos en ruta</span>
                  {shipments.alerts > 0 && (
                    <span className="jv-mono jv-stale" title="Pedidos detenidos en aduanas">
                      {shipments.alerts} en aduanas +7 d
                    </span>
                  )}
                </div>
                <div className="space-y-0.5">
                  {shipments.items.map((s) => (
                    <Link key={s.id} to={s.to} className={`jv-followup-row${s.alert ? ' is-alert' : ''}`} title={`Abrir pedido ${s.name}`}>
                      <span className="name truncate">{s.name}</span>
                      <span className="quiet">{s.stageLabel} · {s.days} d</span>
                      <span className="money jv-mono">{s.ago}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}

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

              {/* ads ↔ sales: spend next to what the pipeline did, by week */}
              {adsSales && (
                <div>
                  <div className="jv-kicker mb-1.5">Ads ↔ ventas · por semana</div>
                  <div className="jv-bridge jv-mono">
                    <div className="brow head">
                      <span>Semana</span><span>Inversión</span><span>Cotiz.</span><span>Acept.</span>
                    </div>
                    {adsSales.map((w) => (
                      <div key={w.start} className="brow">
                        <span>{w.label}</span>
                        <span>{w.spend > 0 ? `${w.spend.toLocaleString('en-US', { maximumFractionDigits: 0 })}${social?.adCurrency ? ` ${social.adCurrency}` : ''}` : '—'}</span>
                        <span>{w.created}</span>
                        <span style={{ color: w.accepted > 0 ? 'var(--jv-success)' : undefined }}>{w.accepted}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

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
          )}
        </section>

        {/* ── social: Instagram + Facebook + Ads (Meta Graph) ──────── */}
        <section className="jv-panel flex-1">
          <div className="jv-panel-head justify-between">
            <span className="flex items-center gap-2"><Share2 size={12} /> Social · Meta</span>
            {socialLinked ? (
              <button
                type="button"
                className="jv-btn"
                style={{ minHeight: '1.8rem', fontSize: '0.72rem' }}
                onClick={loadSocial}
                disabled={socialLoading}
              >
                <RefreshCw size={12} className={socialLoading ? 'animate-spin' : ''} />
                {socialLoading ? 'Leyendo' : 'Actualizar'}
              </button>
            ) : (
              <span style={{ color: 'var(--jv-faint)', fontWeight: 400 }}>Sin conectar</span>
            )}
          </div>

          {!socialLinked ? (
            <div className="p-4">
              <p className="text-xs" style={{ color: 'var(--jv-muted)' }}>
                Conecta tu cuenta de Instagram en Configuración para ver aquí seguidores, alcance y publicaciones.
              </p>
              <button type="button" className="jv-btn mt-3" onClick={() => navigate('/settings')}>
                <Share2 size={12} /> Conectar Instagram
              </button>
            </div>
          ) : socialError ? (
            <div className="p-4">
              <div className="text-xs" style={{ color: 'var(--jv-danger)' }}>{socialError}</div>
              <button type="button" className="jv-btn mt-3" onClick={loadSocial}>
                <RefreshCw size={12} /> Reintentar
              </button>
            </div>
          ) : !social ? (
            <div className="p-4 grid gap-2.5 grid-cols-2 sm:grid-cols-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="jv-kpi" style={{ gap: '0.4rem' }}>
                  <Skeleton w="55%" h="0.6rem" />
                  <Skeleton w="70%" h="1.3rem" />
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 space-y-4">
              <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3">
                <div className="jv-kpi">
                  <span className="label">Seguidores IG</span>
                  <b className="jv-mono">{social.kpis.igFollowers != null ? social.kpis.igFollowers.toLocaleString('en-US') : '—'}</b>
                  <span className="sub">{social.igUsername ? `@${social.igUsername}` : 'sin IG vinculado'}</span>
                </div>
                <div className="jv-kpi">
                  <span className="label">Alcance IG · 7d</span>
                  <b className="jv-mono">{social.kpis.reach7.toLocaleString('en-US')}</b>
                  <span className="sub">
                    {social.kpis.reachDeltaPct != null
                      ? (
                        <span className={`jv-delta ${social.kpis.reachDeltaPct >= 0 ? 'up' : 'down'}`}>
                          {social.kpis.reachDeltaPct >= 0 ? '+' : ''}{social.kpis.reachDeltaPct}% vs 7d ant.
                        </span>
                      )
                      : 'cuentas alcanzadas'}
                  </span>
                </div>
                <div className="jv-kpi">
                  <span className="label">Inversión ads · 7d</span>
                  <b className="jv-mono">
                    {social.kpis.spend7.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    {social.adCurrency ? ` ${social.adCurrency}` : ''}
                  </b>
                  <span className="sub">
                    {social.kpis.spendDeltaPct != null
                      ? `${social.kpis.spendDeltaPct >= 0 ? '+' : ''}${social.kpis.spendDeltaPct}% vs 7d ant.`
                      : social.hasAds ? `28d: ${social.kpis.spend28.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : 'sin cuenta de ads'}
                  </span>
                </div>
                <div className="jv-kpi">
                  <span className="label">Clics ads · 7d</span>
                  <b className="jv-mono">{social.kpis.clicks7.toLocaleString('en-US')}</b>
                  <span className="sub">
                    {social.kpis.cpc7 != null
                      ? `CPC ${social.kpis.cpc7.toFixed(2)}${social.adCurrency ? ` ${social.adCurrency}` : ''}`
                      : 'sin clics aún'}
                  </span>
                </div>
                {social.kpis.resultsLabel ? (
                  <div className="jv-kpi">
                    <span className="label">Resultados ads · 7d</span>
                    <b className="jv-mono">{social.kpis.results7.toLocaleString('en-US')}</b>
                    <span className="sub">
                      {social.kpis.resultsLabel}
                      {social.kpis.costPerResult7 != null
                        ? ` · ${social.kpis.costPerResult7.toFixed(2)}${social.adCurrency ? ` ${social.adCurrency}` : ''} c/u`
                        : ''}
                    </span>
                  </div>
                ) : (
                  <div className="jv-kpi">
                    <span className="label">CTR · 7d</span>
                    <b className="jv-mono">{social.kpis.ctr7Pct != null ? `${social.kpis.ctr7Pct.toFixed(2)}%` : '—'}</b>
                    <span className="sub">clics / impresiones</span>
                  </div>
                )}
                {social.hasIg && (
                  <div className="jv-kpi">
                    <span className="label">Perfil IG · 7d</span>
                    <b className="jv-mono">{social.kpis.profileActions7.toLocaleString('en-US')}</b>
                    <span className="sub">
                      acciones · {social.kpis.newFollowers7 >= 0 ? '+' : ''}{social.kpis.newFollowers7} seguidores
                    </span>
                  </div>
                )}
              </div>

              {(social.spendSeries.length > 1 || social.reachSeries.length > 1) && (
                <div className="grid gap-4 sm:grid-cols-2">
                  {social.reachSeries.length > 1 && (
                    <div>
                      <div className="jv-kicker mb-1.5">Alcance IG · 28 días</div>
                      <svg viewBox="0 0 100 28" className="jv-spark" preserveAspectRatio="none" aria-hidden="true">
                        <defs>
                          <linearGradient id="jvReachFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="var(--jv-success)" stopOpacity="0.3" />
                            <stop offset="100%" stopColor="var(--jv-success)" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        <polygon fill="url(#jvReachFill)" points={`2,26 ${sparkPoints(social.reachSeries)} 98,26`} />
                        <polyline className="accepted" points={sparkPoints(social.reachSeries)} />
                      </svg>
                    </div>
                  )}
                  {social.spendSeries.length > 1 && (
                    <div>
                      <div className="jv-kicker mb-1.5">Inversión ads · 28 días</div>
                      <svg viewBox="0 0 100 28" className="jv-spark" preserveAspectRatio="none" aria-hidden="true">
                        <defs>
                          <linearGradient id="jvSpendFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="var(--jv-accent)" stopOpacity="0.3" />
                            <stop offset="100%" stopColor="var(--jv-accent)" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        <polygon fill="url(#jvSpendFill)" points={`2,26 ${sparkPoints(social.spendSeries)} 98,26`} />
                        <polyline className="created" points={sparkPoints(social.spendSeries)} />
                      </svg>
                    </div>
                  )}
                </div>
              )}

              {Object.keys(social.errors).length > 0 && (
                <div className="text-xs" style={{ color: 'var(--jv-warning)' }}>
                  Secciones sin respuesta: {Object.keys(social.errors).join(', ')} — el resto es dato real.
                </div>
              )}

              {/* JARVIS briefs; acting on Meta lives in /marketing */}
              <Link to="/marketing" className="jv-btn" style={{ alignSelf: 'flex-start' }}>
                <Megaphone size={12} /> Abrir Marketing — publicar, responder, campañas
              </Link>
            </div>
          )}
        </section>
        </div>

        {/* ── right column: live feeds ─────────────────────────────── */}
        <div className="jv-col-right flex flex-col gap-3 min-h-0">
          <section className="jv-panel">
            <div className="jv-panel-head"><Activity size={12} /> Actividad comercial</div>
            <div className="jv-timeline p-3 max-h-64 overflow-y-auto">
              {!bizLoaded && [0, 1, 2, 3].map((i) => (
                <div key={i} className="trow">
                  <span className="tdot" />
                  <Skeleton w={`${85 - i * 12}%`} h="0.65rem" />
                </div>
              ))}
              {opsFeed.map((e) => {
                const Row = e.to ? Link : 'div';
                return (
                  <Row key={e.id} className="trow" {...(e.to ? { to: e.to } : {})}>
                    <span className={`tdot ${e.tone}`} />
                    <span className="ttext">{e.text}</span>
                    <span className="tago jv-mono">{e.ago || ''}</span>
                  </Row>
                );
              })}
              {bizLoaded && !opsFeed.length && (
                <div className="text-xs py-2" style={{ color: 'var(--jv-muted)' }}>
                  Sin actividad registrada todavía.
                </div>
              )}
            </div>
          </section>

          <section className="jv-panel flex-1 flex flex-col min-h-0">
            <div className="jv-panel-head"><Cpu size={12} /> Cambios en vigor</div>
            <div className="jv-feed jv-mono p-3 flex-1 min-h-0 overflow-y-auto" style={{ maxHeight: '20rem' }}>
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
      <section className="jv-panel mt-3">
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
              ref={draftInputRef}
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

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
      />
    </div>
  );
}
