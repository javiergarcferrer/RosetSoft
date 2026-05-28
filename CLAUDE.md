# RosetSoft — notes for Claude

## How we work
- **Ship by pushing to `main`. Never hand the user a manual step** — no SQL,
  CLI, dashboards, secrets, endpoints, or schema reloads. The repo is the only
  lever; if you think you need a manual step, you've misdiagnosed.
- **Trust the integration (below) — it's complete and has always worked.**
  "Could not find the table … in the schema cache" = a migration
  ordering/history bug in the repo (usually a back-dated migration from a
  parallel session), **not** an unreachable DB or a broken integration. Fix
  the migration and push.
- **Be decisive.** Find the root cause yourself (code, git history, logs the
  user pastes); act, then report. Ask only on a real fork the user must own —
  never to confirm the obvious or offload a decision. Diagnose once, act once
  (don't flip-flop).
- **Verify before every push:** `npm run typecheck`, `npm run build`, `npm test`.
- Match the user's language; keep code, comments, and commits in English.

## The integration — GitHub ↔ Supabase ↔ Vercel (circular)
Pushing to `main` ships everything end-to-end:
- **→ Vercel:** auto-builds and deploys the app.
- **→ Supabase:** auto-applies any new `supabase/migrations/*.sql` — no manual
  `db push`, SQL console, or schema reload. End migrations with
  `notify pgrst, 'reload schema';`.
- **Supabase → Vercel:** supplies `SUPABASE_URL`/`ANON_KEY`; `vite.config.js`
  forwards them to the `VITE_` slots at build time.

The sandbox has **no DB credentials** — only code pushes reach production.
That's the mechanism; rely on it.

## Migrations — ordering is load-bearing
- Name `YYYYMMDDHHMMSS_desc.sql` with a timestamp **later than every existing
  migration**. **Never back-date** — an out-of-order file jams `supabase db
  push` and aborts the whole pending chain, so the table/column never appears.
- Keep them additive + idempotent (`if not exists`, drop-then-add constraints).
- **Parallel sessions share ONE production DB.** `git fetch` and check the
  latest migration on `origin/main` before adding yours.

## Data layer
Cloud **Supabase Postgres + Storage**, shared via one `'team'` profile
(`TEAM_PROFILE_ID`) with RLS. `src/db/database.ts` is a **Dexie-shaped API over
Supabase** (`db.<table>.where().equals().toArray()`), not browser IndexedDB.
`db/rowMapping.ts` auto-converts camelCase ↔ snake_case, so a new field works
once its column exists (add a migration). Live schema: `supabase/CLAUDE.md`.
