// Integration health probes — the Model behind JARVIS's "Diagnóstico" sweep.
// Each probe pings ONE Edge Function (tokens never leave the server — we only
// read the {ok, configured, ...} envelope it returns) and resolves to a uniform
// { ok, soft, note, ms } verdict the View renders as a status dot:
//   ok=true            → green ("online")
//   ok=true, soft=true → amber ("not configured yet" — expected, not a failure)
//   ok=false           → red   (note carries the human-readable reason)
// Keeping the probe LOGIC here (vs inline in Jarvis.jsx) means the View just
// maps verdicts to dots; the rules for what counts as healthy live in one place.
import { userMessageFor } from './errorMessages.js';

// Invoke an Edge Function and surface the server's own error body when it 4xx/5xx
// (Supabase wraps a non-2xx as a generic FunctionsHttpError; the real reason is
// in the JSON body behind error.context).
async function invoke(supabase, name, body) {
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
}

// Wrap a probe fn so it always resolves to a verdict (never throws) and carries
// its round-trip latency. A thrown error becomes a red verdict with a friendly note.
async function verdict(fn) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  try {
    const out = (await fn()) || {};
    return { ok: true, soft: false, ...out, ms: Math.round(now() - t0) };
  } catch (e) {
    return { ok: false, soft: false, note: userMessageFor(e), ms: Math.round(now() - t0) };
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// The probe set — one entry per integration JARVIS monitors. Each returns
// { soft?, note? } on success (the latency + ok:true are added by verdict()); a
// `throw` marks it down. `ctx` carries the live supabase client + helpers the
// probes need (profileId for the Postgres ping, refreshSettings after a rate read).
export function integrationProbes({ supabase, db, profileId, refreshSettings }) {
  return [
    ['supabase', () => verdict(async () => {
      await db.settings.get(profileId || '');
      return { note: 'Postgres responde' };
    })],
    ['claude', () => verdict(async () => {
      const data = await invoke(supabase, 'claude-chat', { test: true });
      if (data?.configured === false) return { soft: true, note: 'Sin llave API' };
      if (!data?.ok) throw new Error(data?.error || 'llave rechazada');
      return { note: data.model };
    })],
    ['bpd', () => verdict(async () => {
      const data = await invoke(supabase, 'bpd-rate');
      if (!data?.usd || (!data.usd.compra && !data.usd.venta)) {
        throw new Error(data?.error || 'el banco no devolvió tasa');
      }
      await refreshSettings?.();
      const dop = Number(data.usd.venta) || Number(data.usd.compra);
      return { note: `1 USD ≈ RD$ ${dop.toFixed(2)}` };
    })],
    ['shopify', () => verdict(async () => {
      const data = await invoke(supabase, 'shopify-sync', { test: true, store: 'alcover' });
      if (data?.configured === false) return { soft: true, note: 'Sin credenciales' };
      if (!data?.ok) throw new Error(data?.error || (data?.missingScopes?.length ? `faltan scopes: ${data.missingScopes.join(', ')}` : 'token rechazado'));
      return { note: data.shop || data.domain || 'Token válido' };
    })],
    ['shopifyLsg', () => verdict(async () => {
      const data = await invoke(supabase, 'shopify-sync', { test: true, store: 'lifestylegarden' });
      if (data?.configured === false) return { soft: true, note: 'Sin credenciales' };
      if (!data?.ok) throw new Error(data?.error || 'token rechazado');
      return { note: data.shop || data.domain || 'Token válido' };
    })],
    ['whatsapp', () => verdict(async () => {
      const data = await invoke(supabase, 'wa-send', { test: true });
      if (data?.configured === false) return { soft: true, note: 'Sin credenciales' };
      if (!data?.ok) throw new Error(data?.error || 'token rechazado');
      return { note: 'Meta Graph responde' };
    })],
    ['metaSocial', () => verdict(async () => {
      const data = await invoke(supabase, 'meta-social', { test: true });
      if (data?.configured === false) return { soft: true, note: 'Sin token de Meta' };
      if (!data?.ok) throw new Error(data?.error || 'token rechazado');
      return { note: data.page || 'Graph responde' };
    })],
  ];
}

// Read ONE consolidated Meta snapshot (the Social·Meta panel's payload). Returns
// the raw snapshot body or throws a friendly error — the View resolves it through
// resolveSocialPulse. Tokens stay on the server; we only get the JSON snapshot.
export async function readSocialSnapshot(supabase) {
  const { data, error } = await supabase.functions.invoke('meta-social', { body: { snapshot: true } });
  if (error) throw new Error(error.message || 'sin respuesta');
  if (data?.configured === false || data?.error) throw new Error(data?.error || 'sin respuesta');
  return data;
}
