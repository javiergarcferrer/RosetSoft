import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Bot, Cpu, Radar, RefreshCw, Satellite, Send, ShieldAlert, Zap,
} from 'lucide-react';
import { useApp } from '../context/AppContext.jsx';
import { db, newId } from '../db/database.js';
import { supabase } from '../db/supabaseClient.js';
import { useLiveQueryStatus } from '../db/hooks.js';
import {
  resolveIntegrationBoard,
  resolveUplinkFeed,
  resolveActivityFeed,
  systemIntegrity,
  radarPoints,
  agoLabel,
} from '../core/jarvis/index.js';
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

  const { data: counts } = useLiveQueryStatus(
    async () => {
      const [quotes, orders, customers, products] = await Promise.all([
        db.quotes.where('profileId').equals(profileId || '').toArray(),
        db.orders.where('profileId').equals(profileId || '').toArray(),
        db.customers.where('profileId').equals(profileId || '').toArray(),
        db.products.where('profileId').equals(profileId || '').toArray(),
      ]);
      return {
        quotes: quotes.length,
        orders: orders.length,
        customers: customers.length,
        products: products.length,
      };
    },
    [profileId],
    { quotes: 0, orders: 0, customers: 0, products: 0 },
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
  // stamps settings.claudeConnectedAt (the UI mirror).
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

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.length]);

  const pendingCount = thread.filter((m) => m.role === 'user' && m.status === 'pending').length;
  const lastClaudeId = [...thread].reverse().find((m) => m.role === 'claude')?.id;
  const integrityShown = useCountUp(integrity);
  const nQuotes = useCountUp(counts.quotes);
  const nOrders = useCountUp(counts.orders);
  const nCustomers = useCountUp(counts.customers);
  const nProducts = useCountUp(counts.products);

  if (!isAdmin) {
    return (
      <div className="jarvis flex items-center justify-center">
        <div className="jv-panel jv-rise p-8 text-center max-w-sm">
          <ShieldAlert size={28} className="mx-auto mb-3 jv-fail" />
          <div className="jv-title" style={{ fontSize: '1rem' }}>ACCESO RESTRINGIDO</div>
          <p className="text-sm mt-2" style={{ color: 'var(--jv-dim)' }}>
            El núcleo JARVIS solo responde al administrador.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="jarvis">
      {/* ── HUD header ─────────────────────────────────────────────── */}
      <header className="jv-rise flex flex-wrap items-end justify-between gap-3 px-1 pb-4">
        <div>
          <div className="jv-kicker">Roset Ops Core · v{String(BUILD.sha || '').slice(0, 7) || 'dev'}</div>
          <h1 className="jv-title">J.A.R.V.I.S</h1>
        </div>
        <div className="jv-mono text-right text-xs" style={{ color: 'var(--jv-dim)' }}>
          <div style={{ color: 'var(--jv-cyan)', fontSize: '1.05rem' }}>
            {clock.toLocaleTimeString('es-DO', { hour12: false })}
          </div>
          <div>{clock.toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <div className="mt-1">
            <StatusChip
              status={navigator.onLine ? 'online' : 'fail'}
              label={navigator.onLine ? 'ENLACE ACTIVO' : 'SIN RED'}
            />
          </div>
        </div>
      </header>

      <div className="grid gap-4 xl:grid-cols-[280px_1fr_300px]">
        {/* ── left column: reactor + stats ─────────────────────────── */}
        <div className="space-y-4">
          <section className="jv-panel jv-rise p-4">
            <div className="jv-reactor">
              <div className="ring" />
              <div className="ring r2" />
              <div className="ring r3" />
              <div className="core">
                <b>{integrityShown}%</b>
                <span className="jv-kicker">integridad</span>
              </div>
            </div>
            <p className="jv-mono text-center text-xs mt-3" style={{ color: 'var(--jv-dim)' }}>
              {board.filter((c) => c.status === 'online').length} sistemas en línea ·{' '}
              {board.filter((c) => c.status === 'fail' || c.status === 'offline').length} fuera
            </p>
          </section>

          <section className="jv-panel jv-rise" style={{ animationDelay: '60ms' }}>
            <div className="jv-panel-head"><Activity size={12} /> Telemetría</div>
            <div className="grid grid-cols-2 gap-3 p-4">
              <div className="jv-stat"><b>{nQuotes}</b><span>Cotizaciones</span></div>
              <div className="jv-stat"><b>{nOrders}</b><span>Pedidos</span></div>
              <div className="jv-stat"><b>{nCustomers}</b><span>Clientes</span></div>
              <div className="jv-stat"><b>{nProducts}</b><span>Productos</span></div>
            </div>
          </section>
        </div>

        {/* ── center: integration grid ─────────────────────────────── */}
        <section className="jv-panel jv-rise" style={{ animationDelay: '120ms' }}>
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
                    <div className="jv-mono text-sm" style={{ color: '#eafcff' }}>{c.name}</div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--jv-dim)' }}>{c.desc}</div>
                  </div>
                  <StatusChip status={c.status} label={c.statusLabel} />
                </div>
                <div className="jv-mono text-xs mt-2 flex items-center justify-between" style={{ color: 'var(--jv-cyan-soft)' }}>
                  <span>{c.detail}</span>
                  <span style={{ color: 'var(--jv-dim)' }}>
                    {c.latencyMs != null ? `${c.latencyMs} ms` : c.ago || ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── right column: radar + deploy feed ────────────────────── */}
        <div className="space-y-4">
          <section className="jv-panel jv-rise p-3" style={{ animationDelay: '180ms' }}>
            <div className="jv-panel-head -m-3 mb-2"><Radar size={12} /> Barrido orbital</div>
            <svg viewBox="0 0 100 100" className="jv-radar w-full">
              {[18, 30, 42].map((r) => (
                <circle key={r} cx="50" cy="50" r={r} fill="none" stroke="rgba(75,225,255,0.16)" strokeWidth="0.4" />
              ))}
              <line x1="5" y1="50" x2="95" y2="50" stroke="rgba(75,225,255,0.1)" strokeWidth="0.3" />
              <line x1="50" y1="5" x2="50" y2="95" stroke="rgba(75,225,255,0.1)" strokeWidth="0.3" />
              <path className="beam" d="M50 50 L50 5 A45 45 0 0 1 81.8 18.2 Z" fill="rgba(75,225,255,0.12)" />
              {blips.map((b) => (
                <circle
                  key={b.id}
                  className="blip"
                  cx={b.x}
                  cy={b.y}
                  r="1.8"
                  fill={
                    b.status === 'online' ? 'var(--jv-green)'
                      : b.status === 'fail' ? 'var(--jv-red)'
                        : b.status === 'stale' ? 'var(--jv-amber)'
                          : b.status === 'offline' ? '#3a5571'
                            : 'var(--jv-cyan)'
                  }
                >
                  <title>{b.name}</title>
                </circle>
              ))}
              <circle cx="50" cy="50" r="2.4" fill="var(--jv-cyan)" />
            </svg>
          </section>

          <section className="jv-panel jv-rise" style={{ animationDelay: '240ms' }}>
            <div className="jv-panel-head"><Cpu size={12} /> Cambios en vigor</div>
            <div className="jv-feed jv-mono p-3 max-h-72 overflow-y-auto">
              {BUILD.builtAt ? (
                <div className="item">
                  <span className="tag">deploy</span>
                  <span style={{ color: 'var(--jv-text)' }}>
                    Build {String(BUILD.sha || '').slice(0, 7)} · {BUILD.ref || 'main'} · {agoLabel(BUILD.builtAt, now)}
                  </span>
                </div>
              ) : null}
              {activity.map((e) => (
                <div key={e.id} className="item">
                  <span className={`tag ${e.type}`}>{e.type === 'commit' ? String(e.tag).slice(0, 7) : e.tag}</span>
                  <span style={{ color: 'var(--jv-text)' }}>{e.text}</span>
                  <span className="ml-auto flex-none" style={{ color: 'var(--jv-dim)', fontSize: '0.6rem' }}>{e.ago || ''}</span>
                </div>
              ))}
              {!activity.length && !BUILD.builtAt && (
                <div className="text-xs py-2" style={{ color: 'var(--jv-dim)' }}>
                  Sin telemetría de despliegue en esta build.
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* ── Claude uplink console ─────────────────────────────────────── */}
      <section className="jv-panel jv-rise mt-4" style={{ animationDelay: '300ms' }}>
        <div className="jv-panel-head justify-between">
          <span className="flex items-center gap-2"><Bot size={12} /> Enlace Claude</span>
          <span className="normal-case tracking-normal" style={{ color: 'var(--jv-dim)', letterSpacing: '0.05em' }}>
            {claudeLinked
              ? `Canal en vivo · ${settings?.claudeModel || 'claude-opus-4-8'} responde al instante`
              : pendingCount
                ? `${pendingCount} directiva${pendingCount > 1 ? 's' : ''} en cola — vincula la llave API para respuestas en vivo`
                : 'Canal en espera — vincula tu llave API de Anthropic para activar el enlace en vivo'}
          </span>
        </div>
        <div className="jv-console p-4 max-h-80 overflow-y-auto">
          {thread.length === 0 && (
            <div className="row">
              <span className="who claude">CLAUDE</span>
              <span className="body" style={{ color: 'var(--jv-dim)' }}>
                {claudeLinked
                  ? 'Canal en vivo. Pregunta lo que necesites — respondo al instante.'
                  : 'Canal de enlace establecido. Vincula tu llave API de Anthropic para activar respuestas en vivo.'}
              </span>
            </div>
          )}
          {thread.map((m) => (
            <div key={m.id} className="row">
              <span className={`who ${m.role === 'claude' ? 'claude' : 'user'}`}>
                {m.role === 'claude' ? 'CLAUDE' : '> TÚ'}
              </span>
              {m.role === 'claude' && m.id === lastClaudeId
                ? <TypeLine text={m.content} />
                : <span className="body">{m.content}</span>}
              {m.role === 'user' && (
                <span className="ml-auto flex-none">
                  <StatusChip
                    status={m.status === 'done' ? 'online' : m.status === 'seen' ? 'scanning' : 'standby'}
                    label={m.status === 'done' ? 'HECHO' : m.status === 'seen' ? 'EN CURSO' : 'EN COLA'}
                  />
                </span>
              )}
            </div>
          ))}
          {sending && claudeLinked && (
            <div className="row">
              <span className="who claude">CLAUDE</span>
              <span className="body" style={{ color: 'var(--jv-dim)' }}>
                procesando<span className="jv-caret" />
              </span>
            </div>
          )}
          <div ref={consoleEndRef} />
        </div>
        {!claudeLinked && (
          <div className="p-3 border-t" style={{ borderColor: 'var(--jv-line)' }}>
            <div className="jv-kicker mb-2">Vincular Claude API</div>
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
              <button type="button" className="jv-btn flex-none" onClick={linkClaude} disabled={!apiKey.trim() || linking}>
                {linking ? <RefreshCw size={12} className="animate-spin" /> : <Zap size={12} />} Vincular
              </button>
            </div>
            {linkError && (
              <div className="text-xs mt-2" style={{ color: 'var(--jv-red)' }}>{linkError}</div>
            )}
            <p className="text-xs mt-2" style={{ color: 'var(--jv-dim)' }}>
              La llave se guarda en una tabla de solo escritura (como WhatsApp y Shopify) y nunca llega al navegador.
            </p>
          </div>
        )}
        <div className="p-3 border-t" style={{ borderColor: 'var(--jv-line)' }}>
          <div className="flex gap-2">
            <input
              className="jv-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') transmit(); }}
              placeholder={claudeLinked
                ? 'Transmitir a Claude — p. ej. «¿cómo va la tasa hoy?» o «registra: filtro por marca en el catálogo»'
                : 'Transmitir directiva — quedará en cola hasta vincular la llave API'}
              maxLength={2000}
            />
            <button type="button" className="jv-btn flex-none" onClick={transmit} disabled={!draft.trim() || sending}>
              <Send size={12} /> Transmitir
            </button>
          </div>
          {uplinkError && (
            <div className="text-xs mt-2" style={{ color: 'var(--jv-red)' }}>{uplinkError}</div>
          )}
        </div>
      </section>
    </div>
  );
}
