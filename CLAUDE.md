# RosetSoft — agent bootstrap

React/Vite quoting app (Ligne Roset furniture, Dominican Republic). Prices in
USD, displayed in DOP via a live exchange rate. Single-tenant Supabase backend.
This file is the fast-start; trust it, don't re-derive what's here. Reply in the
user's language; keep code/comments/commits in English.

**This file is loop-engineered.** It doesn't just describe the codebase — it
defines the closed loops you run: every change type has ONE verification signal,
you iterate against that signal until green, and invariants worth keeping are
pinned in fitness tests (not in chat memory). Signals outrank judgement: "looks
right" never substitutes for a green check, and a red check is never resolved by
relaxing the verifier.

## The operating loop (every task runs this)
1. **Reconcile state** — `git fetch origin main` + `git log origin/main` +
   `git status` BEFORE anything. Parallel sessions share this repo and one prod
   DB; they can leave half-wired files (VM created, imports rewritten, never
   plugged in → undefined refs that fail the build) or a back-dated migration.
   Finish or reset that before building on top.
2. **Act** — find the root cause yourself (code, git history, pasted logs); make
   the smallest diff that can move the signal.
3. **Verify** — run the ONE signal matched to the change (next section). Red →
   fix and re-run the SAME signal; don't widen scope, don't flip-flop diagnoses,
   don't report done on red.
4. **Ship** — push `main` (the outer loop; prod closes it).
5. **Report** — outcome + signal state, crisply; skip the play-by-play.

Terminate only on: green signal shipped, or a genuine fork the user must own.
Never terminate by handing the user a manual step (see next section).

## Outer loop: ship = push to `main` (the only lever)
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

## Inner loops: the signal per change type
- Commands: build `npm run build` (`vite build`) · typecheck `npm run typecheck`
  (`tsc --noEmit`) · all tests `npm run test` (`node --import tsx --test
  tests/*.test.js`) · ONE test `node --import tsx --test tests/<name>.test.js` ·
  dev `npm run dev`.
- **Match the signal to the change — never run the full suite by reflex.** A
  signal only verifies what it can see; "N/N passed" on an unrelated change is
  noise, not verification.
  - UI only (jsx/tsx/css/pages/copy) → typecheck + build. No tests.
  - Logic module (`src/lib|db|pdf`) → that module's test if it exists + typecheck.
  - Every `main` push → build MUST pass (Vercel builds with it).

### Pinned invariants (the tests ARE the durable memory)
State worth keeping across sessions lives in a test or in this file — never in
conversation. Two kinds:
- **Money/parsing/data-integrity tests**:
  `tests/{pricing,commissions,containerTracking,catalog,catalogSync,lrCatalog,lsgCatalog,priceListCsv,quoteMilestones,exchangeRate,voyageGeometry,clientPick,subtype,modular,shopifySync}.test.js`.
  New money/data invariant worth keeping → pin it here so future loops inherit
  it. Don't pin presentational/getters/label maps — write obviously-correct code
  instead.
- **Fitness functions** (enforce structure, run in `npm run test`):
  - `tests/architecture.test.js` statically scans every import and FAILS on a
    layering or barrier breach: Model↛View, core↛View, lib↛core,
    CRM-core↔accounting-core, accounting↛`lib/pricing`/`subtype`, and the
    Deno↔Vite wall. A red means **re-route through the bridge / a barrel**, not
    relax the rule (sanctioned exceptions are listed at the top of the test).
  - `tests/quotePickParity.test.js` pins the two quote-pick reducers equivalent
    across the Deno↔Vite wall (see Traps) — edit one layer → edit the other;
    this test goes red if they drift.

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
  `accounting/sales.js: resolveSales`.

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
(`setGroup` — every member priced). A compound can be MODULAR — its components
grouped into named modules (`moduleGroup`/`moduleName`, `compoundKind:'modular'`);
Element→Component-product→Modular, `lib/modules.ts`. A module (a component product)
may itself be optional (`moduleOptional`) or pick-one (`moduleAlternativeGroup` +
`moduleSelected`), so optional/alternative live at the LINE + MODULE level while a
leaf component carries material options + optional add-ons (not alternatives).
`isPricedLine`/`isPricedComponent` (`lib/constants`) gate the totals
(`isPricedComponent` also drops an optional / non-selected-alternative MODULE);
ranges via `priceMin`/`priceMax`. USD→DOP rate locks at ACCEPT, single source
`quoteRateState` (keyed on `acceptedAt`). Engine = `lib/pricing.ts` (+
`lib/modules.ts` for the per-module roll-ups).

## Migrations (ordering is load-bearing)
- `YYYYMMDDHHMMSS_desc.sql`, timestamp **later than every existing** file. **Never
  back-date** — an out-of-order file jams `supabase db push` and aborts the whole
  pending chain, so the table/column never appears.
- Additive + idempotent (`add column if not exists`, drop-then-add constraints).
  End with `notify pgrst, 'reload schema';`.
- Parallel sessions share ONE prod DB → the reconcile step (operating loop, step 1)
  includes checking the latest migration timestamp before adding yours.

## Conventions
- **Decisive**: diagnose once, act once — no flip-flop. Ask only on a real fork
  the user must own.
- **"It's a cache issue" is a BANNED diagnosis**: never blame a cache / stale deploy /
  "reinstall the PWA" for a layout or behavior bug. It's a non-answer that pushes a
  manual step onto the user (which `main` deploys are supposed to make unnecessary)
  and it's almost always wrong — the real cause is in the repo (CSS, shell height,
  migration order, …). Find it in the code and fix it so the next `main` push lands
  it with zero user action.
- **Stay in your diff**: don't fix pre-existing bugs / dead imports / type errors in
  files your task doesn't touch — surface them, don't fold them in. (Genuinely
  blocks you? say so before touching.)
- **Parallelize**: batch independent tool calls in one turn; fan out agents for big
  sweeps (see Traps).

## Traps (symptom → cause → fix)
- **Deno ↔ Vite is a hard wall**: app `src/*` (Vite, browser) and Edge Functions
  `supabase/functions/*` (Deno, server: URL imports, `Deno.env`, service-role key)
  are separate dependency graphs + deploys. Neither imports the other — **only data
  crosses (HTTP/JSON), never code.** A rule needed both client-optimistic AND
  server-authoritative therefore lives at TWO layers on purpose (can't share the
  module): the quote-pick reducer is client `core/quote/actions.js` (`applyAction`,
  over the bundle) ↔ server `quote-share/pick.ts` (`applyPicks`, over the rows;
  `index.ts` is the thin shell). Both are pure Models, pinned equivalent by
  `tests/quotePickParity.test.js`. Don't "DRY" by importing across the wall
  (impossible + breaks the deploy).
- **Code-split imports go through `safeDynamicImport`** (`src/lib/dynamicImport.js`)
  always — PDF, Leaflet, etc. A raw `import()` strands stale-deploy users on
  "failed to fetch dynamically imported module"; the helper reloads once and recovers.
- **New Edge Function won't deploy** until declared in `supabase/config.toml`
  (`[functions.<name>]`); the integration only ships CHANGED functions → a trivial
  edit forces a redeploy.
- **Big sweep → orchestrate parallel agents on DISJOINT files**: partition by file
  ownership so they can't collide. Agents act only — they don't commit/push/build;
  the orchestrator owns the shared barrels and closes the loop alone with the
  SINGLE final typecheck + targeted tests + build.
- **iOS PWA "dead strip at the bottom" = shell height, NOT cache**: the app shell is
  pinned full-viewport in `src/index.css` (`html,body,#root`). In an installed iOS
  PWA, `100dvh` resolves ONE home-indicator inset SHORT of the window, so the shell
  ends above the physical edge and the manifest background leaks as a grey band on
  EVERY page. Fix is shell-level: `html.is-standalone {…} { height: 100vh }` (no
  dynamic chrome in standalone → `100vh` = full window, no `dvh` rounding), gated on
  the reliable `is-standalone` class `main.jsx` sets from `navigator.standalone`
  (never the flaky `@media (display-mode: standalone)`). Do NOT band-aid it per-page
  with white "aprons" under fixed bars (`TotalsDock`) — that only masks the symptom
  where that bar renders and leaves every other page bare. Fix the shell once.
