# RosetSoft — agent bootstrap

React/Vite quoting app (Ligne Roset furniture, Dominican Republic). Prices in
USD, displayed in DOP via a live exchange rate. Single-tenant Supabase backend.
This file is the fast-start; trust it, don't re-derive what's here. Reply in the
user's language; keep code/comments/commits in English.

## Ship = push to `main` (the only lever)
Pushing `main` deploys end-to-end. **Never hand the user a manual step** — no SQL,
CLI, dashboard, secret, endpoint, or schema reload. Need one? You misdiagnosed.
- `main` → **Vercel**: auto build+deploy.
- `main` → **Supabase**: auto-applies new `supabase/migrations/*.sql` AND
  auto-deploys CHANGED Edge Functions in `supabase/functions/*` ("Deploy to
  production" is on). No `db push`, no `functions deploy`, no dashboard paste.
- **Supabase → Vercel**: supplies `SUPABASE_URL`/`ANON_KEY` → `vite.config.js`
  forwards to `VITE_*` at build.
- Sandbox has **no DB creds** — only code pushes reach prod. So "Could not find
  the table … in the schema cache" = a migration-ordering bug in the repo (a
  back-dated file), NOT a broken DB/integration → fix the migration, push.
- Git ship: branch off, `git push -u origin HEAD:main` (retry 2/4/8/16s on network
  fail). No PRs unless asked.

## Commands + verify policy
- build `npm run build` (`vite build`) · typecheck `npm run typecheck`
  (`tsc --noEmit`) · all tests `npm run test` (`node --import tsx --test
  tests/*.test.js`) · ONE test `node --import tsx --test tests/<name>.test.js` ·
  dev `npm run dev`.
- **Match the check to the change — never run the full suite by reflex:**
  - UI only (jsx/tsx/css/pages/copy) → typecheck + build. No tests.
  - Logic module (`src/lib|db|pdf`) → that module's test if it exists + typecheck.
  - Every `main` push → build MUST pass (Vercel builds with it).
- Tests cover ONLY money/parsing/data-integrity:
  `tests/{pricing,commissions,containerTracking,catalog,catalogSync,lrCatalog,priceListCsv,quoteMilestones,exchangeRate,voyageGeometry,clientPick,subtype}.test.js`.
  Don't add tests for presentational/getters/label maps — write obviously-correct
  code instead. "N/N passed" on an unrelated change is noise, not verification.

## Architecture = MVVM (Model → ViewModel → View; the View derives NOTHING)
- **Model** — pure logic+data, no React/Supabase/pdf-lib. `src/lib/*` (pricing,
  commissions, exchangeRate, containerTracking, subtype, catalog, …), surfaced via
  `src/core/*` barrels. Import the Model from the barrel: `core/quote`,
  `core/tracking`, `core/accounting`.
- **ViewModel** — pure projection `resolveX(rows, params)` → exactly what one
  surface renders. No React/`db`/`supabase` inside a `resolveX`. Lives in
  `src/core/quote/views/*`, `core/accounting/sales.js`, `core/tracking/*`. Lone
  exception: hook VM `useContainerTracking` owns its (effectful) fetch.
- **View** — `src/pages/*`, `src/components/*`, `src/pdf/*`. Fetches via `db`
  hooks, holds UI state (search/tab/sort), calls a `resolveX` in `useMemo`,
  renders. Leaf Model-selector calls may stay at the render site (`formatMoney`,
  `displayRatesFor`, status-pill maps); multi-step derivation may NOT.
- **New derivation** → write a `resolveX`, render it from the View, export it from
  the `core/*` barrel. Don't recompute in a component what a VM can own.

### Shared VMs (reuse — this is why screen/paper/list never drift)
- `resolveQuoteView` (`core/quote/views/quoteView.js`) = THE content tree for the
  editor preview + public client link (both `ClientPreview`) + PDF
  (`src/pdf/quotePdf.ts`).
- `core/quote/totals.js` (`quoteTotals`/`quoteGrandTotal`/`linesByQuoteId`) = the
  single per-quote sum for every list/detail page.
- `resolveVoyageHud` (`core/tracking/voyage.js`) = map HUD + summary band.
  `useContainerTracking` = all tracking surfaces (quote list, client link, order).
- `applyAction` (`core/quote/actions.js`) = optimistic client pick reducer (see
  Deno↔Vite trap).
- Per-page VMs: `views/{editor:resolveLineList, lineItem:resolveLineItem,
  dashboard:resolveDashboard, lists:resolveQuotesList+resolveOrdersList,
  detail:resolveOrderDetail+resolveCustomerDetail+resolveProfessionalDetail}`;
  `accounting/sales.js: resolveSales + resolveCommissionPayout`.

## Data layer
Supabase Postgres + Storage, one shared `'team'` profile (`TEAM_PROFILE_ID`) + RLS.
`src/db/database.ts` is a **Dexie-shaped API over Supabase**
(`db.<table>.where(c).equals(v).toArray()`, `.get/.put/.update/.delete/.bulkPut`),
NOT browser IndexedDB. `db/rowMapping.ts` auto-converts camelCase↔snake_case and
JS-ms↔ISO `timestamptz` (any `*At` field) — a new field works end-to-end once its
column exists. Types: `src/types/domain.ts` (camelCase). **Full schema + domain
facts: `supabase/CLAUDE.md` — read it before DB work.**

Pricing model (the complex part): a `quote_line` may be compound (`components[]`),
optional (`isOptional`, excluded from total), pick-one (`alternativeGroup` +
`isSelectedAlternative` — only the selected member priced), or take-all set
(`setGroup` — every member priced). `isPricedLine`/`isPricedComponent`
(`lib/constants`) gate the totals; ranges via `priceMin`/`priceMax`. USD→DOP rate
locks at ACCEPT, single source `quoteRateState` (keyed on `acceptedAt`). Engine =
`lib/pricing.ts`.

## Migrations (ordering is load-bearing)
- `YYYYMMDDHHMMSS_desc.sql`, timestamp **later than every existing** file. **Never
  back-date** — an out-of-order file jams `supabase db push` and aborts the whole
  pending chain, so the table/column never appears.
- Additive + idempotent (`add column if not exists`, drop-then-add constraints).
  End with `notify pgrst, 'reload schema';`.
- Parallel sessions share ONE prod DB → `git fetch origin main` + check the latest
  migration timestamp before adding yours.

## Conventions
- **Decisive**: find the root cause yourself (code, git history, pasted logs), act,
  then report. Ask only on a real fork the user must own. Diagnose once, act once —
  no flip-flop.
- **Stay in your diff**: don't fix pre-existing bugs / dead imports / type errors in
  files your task doesn't touch — surface them, don't fold them in. (Genuinely
  blocks you? say so before touching.)
- **Momentum**: drive a clear task to done (code → verify → commit → push → report).
  Report crisply at the end; skip the play-by-play.
- **Parallelize**: batch independent tool calls in one turn; fan out agents for big
  sweeps (see Traps).

## Traps (symptom → cause → fix)
- **Reconcile parallel-session state FIRST**: start with `git fetch origin main` +
  `git log origin/main` + `git status`. A parallel session can leave half-wired
  files (VM created, imports rewritten, never plugged in → undefined refs that fail
  the build) or a back-dated migration. Finish or reset it before building on top.
- **Deno ↔ Vite is a hard wall**: app `src/*` (Vite, browser) and Edge Functions
  `supabase/functions/*` (Deno, server: URL imports, `Deno.env`, service-role key)
  are separate dependency graphs + deploys. Neither imports the other — **only data
  crosses (HTTP/JSON), never code.** Logic that must run both client-optimistic AND
  server-authoritative is TWO hand-kept copies on purpose: client
  `core/quote/actions.js` (`applyAction`) ↔ server `quote-share`. Edit one → edit
  the other. Never "DRY" across the wall (impossible + breaks the deploy).
- **Code-split imports go through `safeDynamicImport`** (`src/lib/dynamicImport.js`)
  always — PDF, Leaflet, etc. A raw `import()` strands stale-deploy users on
  "failed to fetch dynamically imported module"; the helper reloads once and recovers.
- **New Edge Function won't deploy** until declared in `supabase/config.toml`
  (`[functions.<name>]`); the integration only ships CHANGED functions → a trivial
  edit forces a redeploy.
- **Big sweep → orchestrate parallel agents on DISJOINT files**: partition by file
  ownership so they can't collide; the orchestrator owns the shared barrels and runs
  the SINGLE final typecheck + targeted tests + build; agents don't commit/push/build.
