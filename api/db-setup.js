import pg from 'pg';

/**
 * One-time DB bootstrap endpoint — creates the `products` catalog table (and
 * `quote_lines.unit_cost`) directly against Postgres, bypassing the migration
 * pipeline.
 *
 * Why this exists: the GitHub→Supabase migration integration stopped applying
 * migrations (a parallel branch corrupted the shared migration history), so
 * `products` never got created and the Catálogo import fails with "Could not
 * find the table 'public.products' in the schema cache". This endpoint uses
 * the Postgres connection string the Supabase↔Vercel integration already
 * injects server-side (POSTGRES_URL*) to run the idempotent DDL once.
 *
 * Secured: requires the Supabase service-role key as `?token=` (or
 * `Authorization: Bearer <key>`). Idempotent — safe to call repeatedly. Remove
 * this file once the migration pipeline is healthy again.
 */
export const config = { maxDuration: 30 };

const DDL = `
create table if not exists public.products (
  id          text primary key,
  profile_id  text not null,
  reference   text not null,
  name        text,
  subtype     text,
  dimensions  text,
  family      text,
  family_code text,
  category    text,
  price_usd   numeric,
  cost        numeric,
  important   text default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists products_profile_reference_idx on public.products(profile_id, reference);
create index if not exists products_profile_family_idx on public.products(profile_id, family_code);
alter table public.products enable row level security;
drop policy if exists products_team_all on public.products;
create policy products_team_all on public.products for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.products to anon, authenticated;
alter table public.quote_lines add column if not exists unit_cost numeric;
notify pgrst, 'reload schema';
`;

const CONN_VARS = [
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_URL',
  'SUPABASE_DB_URL',
  'DATABASE_URL',
  'POSTGRES_PRISMA_URL',
];

function resolveConn() {
  for (const name of CONN_VARS) {
    const url = process.env[name];
    if (url) return { name, url };
  }
  return null;
}

export default async function handler(req, res) {
  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const provided =
    (req.query && req.query.token) ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!expected) {
    res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is not set in this environment; cannot authorize.' });
    return;
  }
  if (provided !== expected) {
    res.status(401).json({ ok: false, error: 'Unauthorized. Pass ?token=<service_role_key>.' });
    return;
  }

  const conn = resolveConn();
  if (!conn) {
    res.status(500).json({ ok: false, error: 'No Postgres connection string found in env.', tried: CONN_VARS });
    return;
  }

  const client = new pg.Client({ connectionString: conn.url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query(DDL);
    const r = await client.query('select count(*)::int as n from public.products');
    res.status(200).json({ ok: true, via: conn.name, message: 'products table ensured + schema reloaded', rows: r.rows[0].n });
  } catch (e) {
    console.error('[db-setup] failed:', e);
    res.status(500).json({ ok: false, via: conn.name, error: e?.message || String(e) });
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}
