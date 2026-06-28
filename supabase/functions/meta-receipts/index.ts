// meta-receipts — Meta Ads billing → the books, automatically.
//
// Pulls one BILLING RECORD per closed cycle from the Marketing API and parks it
// as a PENDING draft in `meta_receipts`. The dealer reviews it in Compras y
// gastos and posts it → a real gasto (exterior "Meta" supplier, ITBIS 0, 606
// tipo 02) with the receipt pre-attached. Human-in-the-loop by design: a foreign
// charge is never silently booked.
//
// Billing figure ("billed amount per cycle"), best source first:
//   • Gmail receipts (card / PayPal threshold billing) → when Google is
//     connected WITH gmail.readonly, search the inbox for Meta's per-charge
//     payment-receipt emails, sum the month's charges (exactly what hit the
//     card) and keep the receipts themselves as the attached document. This is
//     the only place the receipt PDF/HTML exists on threshold billing.
//   • Net-30 / monthly-invoicing accounts → the real invoice (amount + PDF
//     download link) via business_invoices, when reachable. Best-effort.
//   • Fallback (no Gmail, no invoice) → the cycle's account-level spend, with a
//     deep link to the billing hub so the dealer can grab the receipt manually.
//
// Auth: invoked by the monthly pg_cron ({cron:true}, service-role bearer) and by
// the in-app "Sincronizar" button ({sync:true}, an authenticated team user).
// The Business/system-user token (reused from whatsapp_config when
// meta_social_config has none) is the same one the Instagram ads manager uses —
// the IG-Login token can't read ads. Tokens stay server-side.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

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

const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86400000;
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const gdate = (ms: number) => isoDay(new Date(ms)).replace(/-/g, '/'); // Gmail q wants YYYY/MM/DD

// ── Google token (the SAME refresh token google-api stores; we just need
// gmail.readonly granted on it) ─────────────────────────────────────────────
async function resolveGoogleToken(admin: SupabaseClient): Promise<{ token: string; scopes: string }> {
  const { data: g } = await admin.from('google_oauth_config')
    .select('client_id, client_secret, access_token, refresh_token, token_expires_at, scopes')
    .eq('profile_id', TEAM).maybeSingle();
  if (!g?.refresh_token) return { token: '', scopes: '' };
  const scopes = String(g.scopes || '');
  const exp = g.token_expires_at ? Date.parse(g.token_expires_at) : 0;
  if (g.access_token && exp && exp - Date.now() > 120_000) return { token: g.access_token, scopes };
  if (!g.client_id || !g.client_secret) return { token: g.access_token || '', scopes };
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: g.client_id, client_secret: g.client_secret, grant_type: 'refresh_token', refresh_token: g.refresh_token }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d?.access_token) return { token: g.access_token || '', scopes };
    const token = String(d.access_token);
    await admin.from('google_oauth_config').update({
      access_token: token,
      token_expires_at: new Date(Date.now() + (Number(d.expires_in) || 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('profile_id', TEAM);
    return { token, scopes };
  } catch (_) {
    return { token: g.access_token || '', scopes };
  }
}

// ── Gmail read ──────────────────────────────────────────────────────────────
function b64urlDecode(s: string): string {
  try {
    const bin = atob(String(s || '').replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return ''; }
}
async function gmailSearch(token: string, q: string): Promise<string[]> {
  const url = new URL(`${GMAIL}/messages`);
  url.searchParams.set('q', q);
  url.searchParams.set('maxResults', '50');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Gmail ${r.status}`);
  return ((d.messages || []) as Array<{ id: string }>).map((m) => m.id);
}
type GmailMsg = { subject: string; from: string; text: string; html: string; dateMs: number; messageId: string };
function extractBodies(payload: Record<string, unknown> | undefined): { text: string; html: string } {
  let text = '', html = '';
  const walk = (p: Record<string, unknown> | undefined) => {
    if (!p) return;
    const mt = String(p.mimeType || '');
    const data = (p.body as Record<string, unknown> | undefined)?.data as string | undefined;
    if (data) {
      if (mt === 'text/plain') text += b64urlDecode(data);
      else if (mt === 'text/html') html += b64urlDecode(data);
    }
    for (const part of (p.parts as Array<Record<string, unknown>>) || []) walk(part);
  };
  walk(payload);
  return { text, html };
}
async function gmailGet(token: string, id: string): Promise<GmailMsg> {
  const r = await fetch(`${GMAIL}/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Gmail ${r.status}`);
  const headers = (d.payload?.headers || []) as Array<{ name: string; value: string }>;
  const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n)?.value || '';
  const { text, html } = extractBodies(d.payload);
  return { subject: h('subject'), from: h('from'), dateMs: Number(d.internalDate) || 0, text, html, messageId: id };
}

// ── Meta receipt parser — BYTE-FOR-BYTE MIRROR of
// src/lib/accounting/metaReceiptEmail.ts (the Deno↔Vite wall forbids importing
// it). Canonical copy is pinned by tests/metaReceiptEmail.test.js; edit both. ─
const _lc = (s: unknown) => String(s || '').toLowerCase();
const _stripHtml = (h: unknown) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
function _currencyOf(token: string): string {
  const t = String(token || '').toUpperCase();
  if (t === 'RD$' || t === 'DOP' || t === 'RD') return 'DOP';
  if (t === 'US$' || t === 'USD' || t === '$') return 'USD';
  return 'USD';
}
function _parseAmount(raw: string): number {
  const n = Number(String(raw || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}
function isMetaReceiptEmail(m: GmailMsg): boolean {
  const from = _lc(m.from);
  const fromMeta = /facebookmail\.com|facebook\.com|meta\.com|metaplatforms/.test(from);
  const body = `${_lc(m.subject)} ${_lc(m.text) || _lc(_stripHtml(m.html))}`;
  const aboutPayment = /(payment|receipt|amount billed|amount paid|you paid|recibo|pago|importe facturado|factura)/.test(body);
  const aboutAds = /(ad|ads|anuncio|campaign|campaña|meta|facebook|instagram)/.test(body);
  return fromMeta && aboutPayment && aboutAds;
}
const _AMOUNT_LABELS = [
  'amount billed', 'amount paid', 'amount charged', 'you paid', 'total amount', 'total charged',
  'importe facturado', 'importe pagado', 'monto pagado', 'monto facturado', 'total pagado', 'total',
];
const _MONEY = '(US\\$|RD\\$|\\$)\\s?([0-9][0-9.,]*)|([0-9][0-9.,]*)\\s?(USD|DOP|RD\\$)';
function _extractAmount(body: string): { amount: number; currency: string } | null {
  for (const label of _AMOUNT_LABELS) {
    const re = new RegExp(`${label}[^0-9A-Za-z]{0,24}(?:${_MONEY})`, 'i');
    const m = body.match(re);
    if (m) {
      const sym = m[1] || m[4] || '$';
      const amt = _parseAmount(m[2] || m[3]);
      if (amt > 0) return { amount: amt, currency: _currencyOf(sym) };
    }
  }
  let best: { amount: number; currency: string } | null = null;
  const re = new RegExp(_MONEY, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const sym = m[1] || m[4] || '$';
    const amt = _parseAmount(m[2] || m[3]);
    if (amt > 0 && (!best || amt > best.amount)) best = { amount: amt, currency: _currencyOf(sym) };
  }
  return best;
}
const _REF_RE = /(?:reference number|payment reference|transaction id|transaction number|n[úu]mero de referencia|referencia)[:#\s]*([A-Z0-9][A-Z0-9-]{5,})/i;
type ParsedReceipt = { amount: number; currency: string; chargedAt: number; receiptId: string };
function parseMetaReceiptEmail(m: GmailMsg): ParsedReceipt | null {
  if (!isMetaReceiptEmail(m)) return null;
  const body = `${m.subject || ''}\n${m.text || _stripHtml(m.html)}`;
  const found = _extractAmount(body);
  if (!found || !(found.amount > 0)) return null;
  const ref = body.match(_REF_RE)?.[1] || m.messageId || '';
  return { amount: found.amount, currency: found.currency, chargedAt: Number(m.dateMs) || 0, receiptId: String(ref) };
}
function sumReceipts(parsed: Array<ParsedReceipt | null>) {
  const list = parsed.filter((p): p is ParsedReceipt => !!p && p.amount > 0);
  if (!list.length) return null;
  const amount = round2(list.reduce((s, p) => s + p.amount, 0));
  return { amount, currency: list[0].currency || 'USD', chargedAt: Math.max(...list.map((p) => p.chargedAt || 0)), count: list.length, receiptIds: list.map((p) => p.receiptId).filter(Boolean) };
}

// ── Receipt document — a clean PDF summary of the month's charges.
// We can't host renderable HTML: Supabase serves public-bucket HTML as
// text/plain + nosniff (anti-XSS), so a browser shows source, not the receipt.
// PDF is served as application/pdf and renders inline, so the dealer opens a
// real, legible document built from the parsed charges. ─────────────────────
const fmt2 = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function buildReceiptPdf(period: string, accountId: string, parsed: ParsedReceipt[], dopRate: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.11, 0.10, 0.09);
  const muted = rgb(0.45, 0.43, 0.40);
  const line = rgb(0.82, 0.80, 0.78);
  let page = pdf.addPage([595, 842]); // A4
  const top = 800;
  let y = top;
  const L = 56, R = 539;
  page.drawText('Recibo - Meta Ads', { x: L, y, size: 20, font: bold, color: ink }); y -= 28;
  page.drawText(`Periodo: ${period}`, { x: L, y, size: 11, font, color: muted }); y -= 15;
  page.drawText(`Cuenta publicitaria: ${bareAccount(accountId)}`, { x: L, y, size: 11, font, color: muted }); y -= 26;

  const cur = parsed[0]?.currency || 'USD';
  const total = round2(parsed.reduce((s, p) => s + p.amount, 0));
  const totalDop = cur === 'DOP' ? total : (dopRate > 0 ? round2(total * dopRate) : null);
  page.drawText(`Total: ${cur} ${fmt2(total)}`, { x: L, y, size: 14, font: bold, color: ink });
  if (totalDop != null) page.drawText(`RD$ ${fmt2(totalDop)}  (tasa ${dopRate})`, { x: L + 200, y, size: 10, font, color: muted });
  y -= 30;

  page.drawText('FECHA', { x: L, y, size: 9, font: bold, color: muted });
  page.drawText('REFERENCIA', { x: L + 90, y, size: 9, font: bold, color: muted });
  page.drawText('MONTO', { x: R - 90, y, size: 9, font: bold, color: muted });
  y -= 6;
  page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: 0.7, color: line }); y -= 16;

  for (const p of parsed.slice().sort((a, b) => a.chargedAt - b.chargedAt)) {
    if (y < 70) { page = pdf.addPage([595, 842]); y = top; }
    page.drawText(isoDay(new Date(p.chargedAt)), { x: L, y, size: 10, font, color: ink });
    page.drawText(String(p.receiptId || '-').slice(0, 34), { x: L + 90, y, size: 10, font, color: ink });
    page.drawText(`${p.currency} ${fmt2(p.amount)}`, { x: R - 90, y, size: 10, font, color: ink });
    y -= 16;
  }
  page.drawText('Generado de los correos de recibo de Meta (un cargo por linea).', { x: L, y: 44, size: 8, font, color: muted });
  return await pdf.save();
}
async function uploadReceiptPdf(admin: SupabaseClient, accountId: string, period: string, bytes: Uint8Array): Promise<string | null> {
  const path = `comprobantes/meta-${bareAccount(accountId)}-${period}.pdf`;
  const { error } = await admin.storage.from('documents')
    .upload(path, new Blob([bytes], { type: 'application/pdf' }), { contentType: 'application/pdf', upsert: true });
  if (error) { console.error('meta-receipts: receipt upload failed', error.message); return null; }
  return admin.storage.from('documents').getPublicUrl(path).data.publicUrl;
}

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

  // The primary account — the consolidated payment method's receipts attach
  // here (Meta's emailed receipts don't name an ad account; one card = one bill).
  const primaryId = bareAccount(
    cfg?.ad_account_id || (accounts.find((a) => (a as { account_status?: number }).account_status === 1) || accounts[0])?.id || '',
  );

  const rows: Record<string, unknown>[] = [];
  // Months whose charge was sourced from Gmail receipts — the spend pass skips
  // them so the same money isn't booked twice (email figure is authoritative:
  // it's exactly what hit the card, with the receipt document attached).
  const coveredMonths = new Set<string>();

  // ── Gmail receipt pass (only if Google is connected WITH gmail.readonly) ──
  const { token: gToken, scopes: gScopes } = await resolveGoogleToken(admin);
  const gmailReady = !!gToken && /gmail\.readonly/.test(gScopes);
  let emailRows = 0;
  if (gmailReady && primaryId) {
    for (const m of months) {
      const id = receiptId(primaryId, m.period);
      if (lockedIds.has(id)) { coveredMonths.add(m.period); continue; }
      const q = `from:(facebookmail.com OR facebook.com OR meta.com) (receipt OR payment OR recibo OR pago OR "amount billed" OR "importe facturado") after:${gdate(m.startMs)} before:${gdate(m.endMs + DAY)}`;
      let msgIds: string[] = [];
      try { msgIds = await gmailSearch(gToken, q); }
      catch (e) { console.error('meta-receipts: gmail search failed', m.period, String((e as Error)?.message || e)); continue; }
      const parsed: ParsedReceipt[] = [];
      for (const mid of msgIds.slice(0, 50)) {
        try {
          const em = await gmailGet(gToken, mid);
          const p = parseMetaReceiptEmail(em);
          if (p) parsed.push(p);
        } catch (_) { /* one bad message never sinks the month */ }
      }
      const sum = sumReceipts(parsed);
      if (!sum) continue; // no receipts this month → leave it to the spend pass
      coveredMonths.add(m.period);
      let docUrl = billingLink(primaryId);
      try {
        const bytes = await buildReceiptPdf(m.period, primaryId, parsed, dopRate);
        docUrl = (await uploadReceiptPdf(admin, primaryId, m.period, bytes)) || docUrl;
      } catch (e) { console.error('meta-receipts: pdf build failed', m.period, String((e as Error)?.message || e)); }
      const amountDop = sum.currency === 'DOP' ? sum.amount : (dopRate > 0 ? round2(sum.amount * dopRate) : null);
      rows.push({
        id,
        profile_id: TEAM,
        ad_account_id: primaryId,
        period: m.period,
        period_start_at: new Date(m.startMs).toISOString(),
        period_end_at: new Date(m.endMs).toISOString(),
        currency: sum.currency,
        amount: sum.amount,
        amount_dop: amountDop,
        dop_rate: dopRate || null,
        source: 'email',
        invoice_url: docUrl,
        invoice_number: sum.count > 1 ? `${sum.count} cargos` : (sum.receiptIds[0] || null),
        status: 'pending',
        raw: { period: m.period, source: 'email', charges: sum.count, receiptIds: sum.receiptIds },
        updated_at: new Date().toISOString(),
      });
      emailRows++;
    }
  }

  // ── Spend / invoice fallback pass (months Gmail didn't cover) ──
  for (const acc of accounts) {
    const currency = String(acc.currency || 'USD').toUpperCase();
    const businessId = acc.business?.id || null;
    for (const m of months) {
      if (coveredMonths.has(m.period)) continue;
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

  return json({ ok: true, accounts: accounts.length, synced: created, fromEmail: emailRows, gmail: gmailReady, months: months.map((m) => m.period) });
});
