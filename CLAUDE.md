# RosetSoft — notes for Claude

## Shipping is fully automated — never ask the user to deploy or migrate

This repo has a **complete, circular GitHub ↔ Supabase ↔ Vercel integration**.
All three are connected to each other; pushing to `main` ships a change
end-to-end. The three links:

- **GitHub → Vercel:** every push to `main` auto-builds and deploys the app.
- **GitHub → Supabase:** every push to `main` auto-applies any new migration in
  `supabase/migrations/` to the production database — **no** manual
  `supabase db push`, SQL-console step, or schema reload. (`notify pgrst,
  'reload schema'` at the end of a migration is still good practice.)
- **Supabase → Vercel:** Supabase provides `SUPABASE_URL` / `SUPABASE_ANON_KEY`
  as Vercel env vars; `vite.config.js` forwards them into the `VITE_` slots at
  build time so the client connects.

So once changes are on `main`, the feature is live — including new tables,
columns, and constraints. **Do not** tell the user to deploy, run migrations,
apply SQL, reload the schema, or take any manual step. Claude ships everything
by pushing to `main`. (Default to pushing every change to `main`.)

The working sandbox has **no database credentials** (no `SUPABASE_*` /
`POSTGRES_*` env vars, no connection string) — Claude can only push code, never
reach the DB directly. The push-to-`main` migration path is the mechanism; rely
on it.

### Migration ordering is load-bearing — NEVER back-date a migration

Migrations apply in **timestamp (filename) order**, and Supabase tracks a
migration history. A new migration file MUST be named
`YYYYMMDDHHMMSS_desc.sql` with a timestamp **later than every existing
migration**. A back-dated / out-of-order file is catastrophic: it triggers a
migration-history mismatch (or runs an `ALTER` before the `CREATE` it depends
on) that **aborts the whole pending chain**, so that migration *and every
later one* silently fail to apply — the table/column never appears and the app
shows "Could not find the table … in the schema cache". (This exact bug — a
back-dated `products` migration from a parallel branch — blocked the catalog.)

Therefore: when a freshly-added table/column "isn't found" in production, the
cause is almost always a **migration-ordering/history problem in the repo**, not
a broken integration or an unreachable DB. Fix the migration ordering (give it
the latest timestamp; never edit/backdate an already-applied one) and push —
don't conclude the DB is unreachable or ask the user to run SQL by hand.
Migrations must be additive + idempotent (`if not exists`, drop-then-add
constraints) so a re-run is always safe.

**Parallel sessions share ONE production database.** Other Claude branches push
migrations to the same `main`/Supabase. Before adding a migration, `git fetch`
and check the latest migration timestamp on `origin/main` so yours sorts after
it.

## Data layer — it's the cloud, not local storage
Data lives in the cloud: **Supabase Postgres + Storage**, shared across all
users via a single `'team'` profile (`TEAM_PROFILE_ID`) with row-level
security. `src/db/database.ts` exposes a **Dexie-shaped API backed by
Supabase** — `db.<table>.where().equals().toArray()` reads/writes Postgres and
images go to Supabase Storage. It is NOT browser IndexedDB and is NOT siloed
per user. `db/rowMapping.ts` auto-converts camelCase ↔ snake_case, so a new
field persists once its column exists (add a migration).

**Database schema reference:** see `supabase/CLAUDE.md` for the live tables,
constraints, RLS, numbering, and migration conventions.

## Verifying before pushing
Run all three; they must pass:
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — Vite production build
- `npm test` — node:test via tsx (`tests/*.test.js`)
