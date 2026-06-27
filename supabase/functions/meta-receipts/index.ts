// meta-receipts — Meta Ads billing → the books, automatically.
//
// Pulls one BILLING RECORD per closed cycle from the Marketing API and parks it
// as a PENDING draft in `meta_receipts`. The dealer reviews it in Compras y
// gastos and posts it → a real gasto (exterior "Meta" supplier, ITBIS 0, 606
// tipo 02) with the receipt pre-attached. Human-in-the-loop by design: a foreign
// charge is never silently booked.
//
// Billing figure ("billed amount per cycle"):
//   • Net-30 / monthly-invoicing accounts → the real invoice (amount + PDF
//     download link) via business_invoices, when reachable. Best-effort.
//   • Everyone else (card / PayPal — no invoice PDF on the API) → the cycle's
//     account-level spend, with a deep link to the billing hub so the dealer can
//     grab the emailed receipt in one click.
//
// Auth: invoked by the monthly pg_cron ({cron:true}, service-role bearer) and by
// the in-app "Sincronizar" button ({sync:true}, an authenticated team user).
// The Business/system-user token (reused from whatsapp_config when
// meta_social_config has none) is the same one the Instagram ads manager uses —
// the IG-Login token can't read ads. Tokens stay server-side.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (b: unknown, s = 200): Response =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const GRAPH_VERSION = 'v23.0';
const FB_API = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TEAM = 'team';

// How many closed months to (re)scan each run. Upserts are idempotent and a
// missed cron run self-heals, so we sweep a small trailing window rather than a
// single month — same robustness philosophy as the rate poller.
const LOOKBACK_MONTHS = 3;

/** GET a Marketing-API (Graph) endpoint with the Business token. */
async function fb(path: string, token: string, params: Record<string, string> = {}) {
  const url = new URL(`${FB_API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throw new Error(String(data?.error?.message || `Graph ${res.status}`).slice(0, 200));
  return data;
}

const bareAccount = (id: string) => String(id || '').replace(/^act_/, '');
const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/**
 * The N most recent CLOSED calendar months (UTC), newest first. The current
 * (still-open) month is excluded — its cycle hasn't been billed yet.
 */
function closedMonths(now: number, n: number) {
  const base = new Date(now);
  const out: { period: string; since: string; until: string; startMs: number; endMs: number }[] = [];
  for (let i = 1; i <= n; i++) {
    const y = base.getUTCFullYear();
    const m = base.getUTCMonth() - i;
    const start = new Date(Date.UTC(y, m, 1));
    const end = new Date(Date.UTC(y, m + 1, 0)); // last day of that month
    out.push({
      period: `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}`,
      since: isoDay(start),
      until: isoDay(end),
      startMs: start.getTime(),
      endMs: end.getTime(),
    });
  }
  return out;
}

/** Canonical (account, cycle) id — mirrors lib/accounting/metaReceipts'
 *  `metaReceiptKey` (the wall forbids importing it; the format is the contract). */
const receiptId = (adAccountId: string, period: string) => `metarcpt-${bareAccount(adAccountId)}-${period}`;

/** Account-level spend for one window, in account major units. */
async function periodSpend(accountId: string, token: string, since: string, until: string): Promise<number> {
  const r = await fb(`${accountId}/insights`, token, {
    level: 'account',
    time_range: JSON.stringify({ since, until }),
    fields: 'spend',
  });
  return Number(r?.data?.[0]?.spend || 0);
}

/**
 * Best-effort monthly invoice (amount + PDF link) for a window. Only Net-30 /
 * extended-credit accounts expose `business_invoices`; any failure (no business,
 * not on invoicing, restricted) just yields null and the caller falls back to
 * spend. Never throws to the caller.
 */
async function findInvoice(accountId: string, businessId: string | null, token: string, period: string):
  Promise<{ amount: number; url: string | null; number: string | null } | null> {
  if (!businessId) return null;
  try {
    const r = await fb(`${businessId}/business_invoices`, token, {
      fields: 'id,invoice_id,billing_period,amount,download_uri,currency_amount',
      limit: '50',
    });
    const rows = (r?.data || []) as Array<Record<string, unknown>>;
    // billing_period comes back like "2026-06" or "Jun 2026"; match on the YYYY-MM.
    const hit = rows.find((x) => String(x.billing_period || '').includes(period));
    if (!hit) return null;
    const amt = Number(hit.amount ?? (hit.currency_amount as Record<string, unknown>)?.amount ?? 0);
    return { amount: amt, url: (hit.download_uri as string) || null, number: (hit.invoice_id || hit.id) as string || null };
  } catch (_) {
    return null;
  }
}

/** A one-click link to the account's billing hub (where the emailed receipt /
 *  per-charge PDFs live for card accounts). */
const billingLink = (accountId: string) =>
  `https://business.facebook.com/billing_hub/accounts/details?asset_id=${bareAccount(accountId)}`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'Server misconfigured' }, 500);

  const authHeader = req.headers.get('Authorization') || '';
  const isService = authHeader === `Bearer ${SERVICE_ROLE_KEY}`;
  // Browser callers must be an authenticated team user; the cron is the service
  // role. Anything else is rejected (this writes draft rows).
  if (!isService) {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token || !SUPABASE_ANON_KEY) return json({ error: 'forbidden' }, 403);
    const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: u } = await caller.auth.getUser(token);
    if (!u?.user) return json({ error: 'forbidden' }, 403);
  }

  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Self-heal the monthly schedule (idempotent; driven off our own URL + key so
  // it survives a project restore — same idiom as bpd-rate / the IG scheduler).
  admin.rpc('ensure_meta_receipts_cron', {
    p_url: `${SUPABASE_URL}/functions/v1/meta-receipts`,
    p_secret: SERVICE_ROLE_KEY,
  }).then(({ error }) => { if (error) console.error('meta-receipts: cron arm failed:', error.message); });

  // Resolve the Business token (meta_social_config, else whatsapp_config).
  const { data: cfg } = await admin.from('meta_social_config')
    .select('access_token, ad_account_id').eq('profile_id', TEAM).maybeSingle();
  let bizToken = cfg?.access_token || '';
  if (!bizToken) {
    const { data: wa } = await admin.from('whatsapp_config').select('access_token').eq('profile_id', TEAM).maybeSingle();
    bizToken = wa?.access_token || '';
  }
  if (!bizToken) return json({ configured: false, error: 'Sin token de Meta Business — conecta WhatsApp o asigna el token al sistema.' });

  // USD→DOP snapshot (settings.exchange_rate.sell) — the books are DOP.
  const { data: settings } = await admin.from('settings').select('exchange_rate').eq('profile_id', TEAM).maybeSingle();
  const dopRate = Number((settings?.exchange_rate as Record<string, unknown>)?.sell || 0);

  const now = Date.now();
  const months = closedMonths(now, LOOKBACK_MONTHS);

  let accounts: Array<{ id: string; currency?: string; business?: { id?: string } | null }> = [];
  try {
    const r = await fb('me/adaccounts', bizToken, { fields: 'id,name,currency,account_status,business', limit: '100' });
    accounts = (r?.data || []) as typeof accounts;
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e).slice(0, 200) });
  }
  if (!accounts.length) return json({ ok: true, created: 0, updated: 0, accounts: 0 });

  // Periods already posted/dismissed must never be overwritten by a re-sync.
  const ids = accounts.flatMap((a) => months.map((m) => receiptId(a.id, m.period)));
  const { data: locked } = await admin.from('meta_receipts')
    .select('id, status').in('id', ids);
  const lockedIds = new Set((locked || []).filter((r) => r.status !== 'pending').map((r) => r.id));

  const rows: Record<string, unknown>[] = [];
  for (const acc of accounts) {
    const currency = String(acc.currency || 'USD').toUpperCase();
    const businessId = acc.business?.id || null;
    for (const m of months) {
      const id = receiptId(acc.id, m.period);
      if (lockedIds.has(id)) continue;

      let amount = 0;
      let source = 'spend';
      let invoiceUrl: string | null = billingLink(acc.id);
      let invoiceNumber: string | null = null;

      const inv = await findInvoice(acc.id, businessId, bizToken, m.period);
      if (inv && inv.amount > 0) {
        amount = inv.amount; source = 'invoice';
        invoiceUrl = inv.url || invoiceUrl; invoiceNumber = inv.number;
      } else {
        try { amount = await periodSpend(acc.id, bizToken, m.since, m.until); }
        catch (e) { console.error('meta-receipts: spend pull failed', acc.id, m.period, String((e as Error)?.message || e)); continue; }
      }
      if (!(amount > 0)) continue; // a zero-spend month is not a receipt

      const amountDop = currency === 'DOP' ? amount : (dopRate > 0 ? Math.round(amount * dopRate * 100) / 100 : null);
      rows.push({
        id,
        profile_id: TEAM,
        ad_account_id: bareAccount(acc.id),
        period: m.period,
        period_start_at: new Date(m.startMs).toISOString(),
        period_end_at: new Date(m.endMs).toISOString(),
        currency,
        amount,
        amount_dop: amountDop,
        dop_rate: dopRate || null,
        source,
        invoice_url: invoiceUrl,
        invoice_number: invoiceNumber,
        status: 'pending',
        raw: { accountId: acc.id, period: m.period, source },
        updated_at: new Date().toISOString(),
      });
    }
  }

  let created = 0;
  if (rows.length) {
    // Upsert on the (account, cycle) key — re-syncing a still-pending cycle just
    // refreshes its amount; locked (posted/dismissed) cycles were filtered out.
    const { error } = await admin.from('meta_receipts')
      .upsert(rows, { onConflict: 'profile_id,ad_account_id,period' });
    if (error) return json({ ok: false, error: error.message });
    created = rows.length;
  }

  return json({ ok: true, accounts: accounts.length, synced: created, months: months.map((m) => m.period) });
});
