# RosetSoft — notes for Claude

## Shipping is fully automated — never ask the user to deploy or migrate
This repo has a fully wired **GitHub ↔ Vercel ↔ Supabase** integration (all
three connected to each other). Pushing to the `main` branch is the only
action needed to ship a change end-to-end:

- **Vercel** auto-builds and deploys the app on every push to `main`.
- **Supabase** migrations in `supabase/migrations/` are applied automatically
  through the integration — there is **no** manual `supabase db push`, SQL
  console step, or schema reload to perform.

Therefore, once changes are pushed to `main`, the feature is live including any
new DB columns/constraints. **Do not** tell the user to deploy, run migrations,
apply SQL, push to Supabase, restart, or take any other manual step. Claude does
everything by pushing to `main`. (Default to pushing every change to `main`.)

## Data layer — it's the cloud, not local storage
Data lives in the cloud: **Supabase Postgres + Storage**, shared across all
users via a single `'team'` profile (`TEAM_PROFILE_ID`) with row-level
security. `src/db/database.ts` exposes a **Dexie-shaped API backed by
Supabase** — `db.<table>.where().equals().toArray()` reads/writes Postgres and
images go to Supabase Storage. It is NOT browser IndexedDB and is NOT siloed
per user. `db/rowMapping.ts` auto-converts camelCase ↔ snake_case, so a new
field persists once its column exists (add a migration).

## Verifying before pushing
Run all three; they must pass:
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — Vite production build
- `npm test` — node:test via tsx (`tests/*.test.js`)
