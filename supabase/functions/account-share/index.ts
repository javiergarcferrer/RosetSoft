// account-share — backs the public estado-de-cuenta link (#/cuenta/<token>).
//
//   GET ?token=… → a whitelisted, CLIENT-FACING statement: the company + client
//                  header, the chronological charges (facturas, net of deposit)
//                  and payments (cobros) with a running balance, and the total
//                  due.
//
// Why a function (mirrors quote-share / contract-share): the link is used
// logged-OUT but the DB is behind RLS. This runs with the service role and gates
// on the secret token, so the public only ever gets this whitelist — never raw
// table access, and never another customer's data.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

type Admin = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n: number): number => Math.round((n || 0) * 100) / 100;
const ms = (v: unknown): number => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? t : 0; };

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: 'server not configured' }, 500);

  const token = (new URL(req.url).searchParams.get('token') || '').trim();
  if (!token) return json({ error: 'missing token' }, 400);
  // A real statement token is a long random string; a short/garbage value can't
  // be one, so reject it before hitting the DB (cheap abuse/enumeration guard).
  if (token.length < 20) return json({ error: 'not found' }, 404);

  const admin: Admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Resolve the customer by its secret token; a bad/revoked token reads as 404.
  const { data: custData, error: cErr } = await admin
    .from('customers').select('*').eq('statement_token', token).maybeSingle();
  if (cErr) return json({ error: 'lookup failed' }, 500);
  if (!custData) return json({ error: 'not found' }, 404);
  const customer = custData as Row;

  const [salesRes, paysRes, settingsRes] = await Promise.all([
    admin.from('sales_postings').select('*').eq('customer_id', customer.id),
    // party_id alone can collide with a supplier sharing the same id space, so
    // pin party_type='customer' at the query — a supplier's cobro can never leak
    // onto a customer statement.
    admin.from('payments').select('*').eq('party_id', customer.id).eq('party_type', 'customer').eq('direction', 'in'),
    admin.from('settings').select('*').eq('profile_id', customer.profile_id).maybeSingle(),
  ]);
  const sales = (salesRes.data as Row[]) || [];
  const pays = (paysRes.data as Row[]) || [];
  const settings = (settingsRes.data as Row) || {};

  // Charges = each factura's receivable (total − deposit applied); payments = cobros.
  const charges = sales
    .map((s) => ({ at: ms(s.posted_at), label: 'Factura', ref: (s.ncf as string) || '', charge: round2(num(s.total) - num(s.deposit_applied)), payment: 0 }))
    .filter((c) => c.charge > 0.001);
  const payments = pays
    .filter((p) => p.party_type === 'customer' || p.party_type == null)
    .map((p) => ({ at: ms(p.paid_at), label: 'Cobro', ref: (p.reference as string) || '', charge: 0, payment: round2(num(p.amount)) }));

  const rows = [...charges, ...payments].sort((a, b) => a.at - b.at);
  let bal = 0;
  const out = rows.map((r) => { bal = round2(bal + r.charge - r.payment); return { at: r.at, label: r.label, ref: r.ref, charge: r.charge, payment: r.payment, balance: bal }; });

  return json({
    company: {
      name: settings.company_name || '',
      rnc: settings.company_rnc || '',
      phone: settings.company_phone || '',
      email: settings.company_email || '',
    },
    customer: { name: customer.name || 'Cliente', rnc: customer.rnc || customer.cedula || '' },
    rows: out,
    balance: bal,
    asOf: Date.now(),
  });
});
