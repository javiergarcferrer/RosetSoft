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
- **Don't fix errors in files you didn't edit.** Stay in the diff your task
  needs. A pre-existing bug, dead import, type error, or stray warning in a file
  your change doesn't touch is out of scope — leave it and surface it in your
  report instead of folding unrelated fixes into the diff. (If it genuinely
  blocks your change, say so before touching it.)
- **Verify proportionately — never run the whole suite by reflex.** Match the
  check to the change:
  - **UI only** (JSX/TSX, CSS, components, pages, copy): no tests. `npm run
    typecheck`, and `npm run build` before a `main` push. That's it.
  - **A logic module** (`src/lib/*`, `src/db/*`, `src/pdf/*`): run ONLY that
    module's test if one exists (e.g. `node --import tsx --test
    tests/pricing.test.js`) plus `npm run typecheck`. Don't run unrelated suites.
  - `npm run build` must pass before any push to `main` (Vercel builds with it).
  The suite is deliberately small — it covers ONLY money, complex parsing, and
  data-integrity logic (pricing, commissions, containerTracking, catalog/
  lrCatalog merge, priceListCsv, quoteMilestones, exchangeRate, voyageGeometry,
  clientPick, subtype). **Don't add tests** for presentational maps, one-line
  getters, label/colour mappings, or trivial helpers — write the code so it is
  obviously correct instead. Reporting "N/N tests passed" for an unrelated
  change is noise, not verification.
- Match the user's language; keep code, comments, and commits in English.
- **Keep momentum.** On a clear task, drive it to done — code, verify, commit,
  push, report — without stopping to ask permission for the obvious. Report
  crisply at the end (what shipped, what was verified); skip the play-by-play.

## Architecture — MVVM is the backbone
The app is **Model → ViewModel → View**, and staying on-pattern is what keeps it
fast to change. The View renders and **derives nothing**.
- **Model** — pure logic + data, no React/Supabase/pdf-lib. Lives in `src/lib/*`
  (pricing, commissions, exchangeRate, containerTracking, …) and is surfaced as a
  clean API through `src/core/*` barrels (`core/quote`, `core/tracking`,
  `core/accounting`).
- **ViewModel** — pure projections named `resolveX(...)`, one per view, in
  `src/core/quote/views/*` (+ `core/accounting/sales.js`, `core/tracking/*`). They
  take already-fetched rows + params and return exactly what a surface renders. No
  React, no `db`, no `supabase` inside a `resolveX`. The lone exception is a hook
  VM (`useContainerTracking`) that owns inherently-effectful data-access.
- **View** — `src/pages/*`, `src/components/*`, `src/pdf/*`. Fetches via `db`
  hooks, holds UI state (search/tab/sort), calls a `resolveX` in a `useMemo`,
  renders the result. Leaf Model-selector calls (`formatMoney`, `displayRatesFor`,
  status-pill maps) may stay at the render site; multi-step derivation may not.

**One ViewModel, many surfaces** is the whole point — it's why screen and paper
can't drift: `resolveQuoteView` is THE content tree for the editor preview, the
public client link (both `ClientPreview`) **and** the PDF (`src/pdf/quotePdf.ts`);
`resolveVoyageHud` feeds both the map HUD and the summary band; `core/quote/
totals.js` is the single per-quote sum for every list/detail page. New code: put
the derivation in a `resolveX`, render it from the View, export it from the
relevant `core/*` barrel. Don't recompute in a component what a ViewModel can own.

## The integration — GitHub ↔ Supabase ↔ Vercel (circular)
Pushing to `main` ships everything end-to-end:
- **→ Vercel:** auto-builds and deploys the app.
- **→ Supabase:** auto-applies any new `supabase/migrations/*.sql` — no manual
  `db push`, SQL console, or schema reload. End migrations with
  `notify pgrst, 'reload schema';`. **Also auto-deploys Edge Functions in
  `supabase/functions/`** ("Deploy to production" is enabled) — no `supabase
  functions deploy`, no dashboard paste. Gotcha: a function only deploys if it's
  declared in `supabase/config.toml` (`[functions.<name>]`); a brand-new
  function won't ship until that block exists. The integration deploys
  **changed** functions — to force a redeploy, make a trivial edit to the
  function's file.
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

## Gotchas & hard-won lessons
- **Reconcile parallel-session state FIRST.** Sessions share this branch + one DB.
  Starting a real task, `git fetch origin main`, check `git log origin/main`, and
  scan `git status` — a parallel session can leave half-wired files (VM created,
  imports rewritten, never plugged in → undefined refs that fail the build) or a
  back-dated migration. Finish or reset it before building on top; don't assume a
  clean slate.
- **Deno ↔ Vite is a hard wall.** Two separate programs with separate dependency
  graphs and deploys: the app (`src/*`) is bundled by Vite for the browser; Edge
  Functions (`supabase/functions/*`) run on Deno server-side (URL imports,
  `Deno.env`, the service-role key). Neither can `import` the other — **only data
  crosses the wall (HTTP/JSON), never code.** So logic that must run both
  optimistically on the client AND authoritatively on the server is TWO
  hand-maintained copies on purpose — e.g. the quote-pick mutation: client
  `core/quote/actions.js` (`applyAction`) ↔ server `quote-share` (the client copy
  literally says "mirrors the server"). Change one, change the other; don't try to
  "DRY" it by sharing a module — impossible across the wall, and it breaks the deploy.
- **Code-split imports go through `safeDynamicImport`** (`src/lib/dynamicImport.js`),
  always — PDF, Leaflet, etc. A raw `import()` strands users on a stale deploy with
  "failed to fetch dynamically imported module"; the helper reloads once and recovers.
- **Big sweeps → orchestrate parallel agents on DISJOINT files.** Partition by file
  ownership so they can't collide; the orchestrator owns the shared barrels and runs
  the SINGLE final `typecheck` + targeted tests + `build`. Agents don't commit, push,
  or build. (This is how the MVVM sweep shipped fast and clean.)
