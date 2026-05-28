# RosetSoft — notes for Claude

## Shipping is fully automated — never ask the user to deploy or migrate
This repo has a fully wired **GitHub ↔ Vercel ↔ Supabase** integration (all
three connected to each other). Pushing to the `main` branch is the only
action needed to ship a change end-to-end:

- **Vercel** auto-builds and deploys the app on every push to `main`.
- **Supabase** migrations in `supabase/migrations/` are applied automatically,
  **AND Edge Functions in `supabase/functions/` are deployed automatically**,
  via the integration's "Deploy to production" step on push to `main` — there is
  **no** manual `supabase db push`, `supabase functions deploy`, SQL console
  step, schema reload, or dashboard paste to perform.
  - **Gotcha: a function only auto-deploys if it's declared in
    `supabase/config.toml`** with a `[functions.<name>]` block. A brand-new
    function won't ship until that block exists. The current functions
    (`invite-user`, `delete-user`, `bpd-rate`) are already declared.
  - The integration deploys **changed** functions on a push; if you need to
    force a redeploy without a code change, make a trivial edit to the
    function's file.

Therefore, once changes are pushed to `main`, the feature is live including any
new DB columns/constraints **and edge-function code**. **Do not** tell the user
to deploy, run migrations, apply SQL, push to Supabase, deploy functions, paste
code into the dashboard, restart, or take any other manual step. Claude does
everything by pushing to `main`. (Default to pushing every change to `main`.)

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
