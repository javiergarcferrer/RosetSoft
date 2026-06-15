# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# RosetSoft — agent bootstrap

React/Vite back-office for a Ligne Roset dealer (Dominican Republic): quoting,
orders + container tracking, full accounting (ledger, DGII 606/607, e-CF,
payroll, imports), WhatsApp CRM (inbox + campaigns), Instagram/Meta marketing
(Studio + post scheduling + social pulse), a public storefront, and the JARVIS
ops dashboard. Prices in USD, displayed in DOP via a live exchange rate.
Single-tenant Supabase backend.
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
- **Money/parsing/data-integrity tests**: ~55 files in `tests/` — nearly every
  `lib`/`core` module has a same-named test (pricing, commissions, ledger,
  payroll, ecf, imports, inventory, whatsapp, store, jarvisPulse, igStudio,
  scheduler, socialPulse, …); match the module by name and run just that one.
  Special pins worth knowing:
  `lsgCatalogBook` pins the client catalog PDF's in-stock gate (only
  stockQty > 0 prints; all-null stock flags `hasStockData` instead of
  rendering an empty book).
  `catalog` also pins the quote builder's LSG stock gate (a TRACKED product
  with qty ≤ 0 is unquotable; untracked LR is never gated) and `lsgCatalog`
  pins the full Shopify gallery mapping — LSG photos are CDN POINTER rows
  (`images.external_url`), never bytes in our bucket.
  `ogImage` pins the link-preview image as a BASELINE jpeg — WhatsApp renders
  progressive JPEGs as garbled noise; fixing it also requires a NEW filename
  (WhatsApp caches the card per-URL for weeks).
  `dgiiFormats` pins the OFFICIAL DGII 606/607 TXT layouts (header + 23 pipe
  fields, code tables) — never relax it to match the app; fix the builder.
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
  - `tests/credentialDurability.test.js` scans every migration: any NEW
    migration that UPDATEs/DELETEs/TRUNCATEs/DROPs a credential table
    (`shopify_config`, `whatsapp_config`, `ecf_credentials`) fails — a deploy
    must never erase what the dealer pasted into Configuración. Evolve those
    schemas additively; need to migrate credential DATA? Don't — add a column.
  - `tests/migrationOrder.test.js` walks git history and FAILS if any migration
    is back-dated — a file added later must carry a filename timestamp ≥ every
    migration added before it (an out-of-order name jams `db push` and aborts
    the whole pending chain). A red means RENAME your new file later than the
    current max; never relax it or join the single grandfathered entry.

## Architecture = MVVM (Model → ViewModel → View; the View derives NOTHING)
- **Model** — pure logic+data, no React/Supabase/pdf-lib. `src/lib/*` (pricing,
  commissions, exchangeRate, containerTracking, subtype, catalog,
  `lib/accounting/*`, …), surfaced via `src/core/*` barrels. Import the Model
  from the barrel, never the file: `core/quote`, `core/tracking`, `core/crm`
  (WhatsApp inbox/campaigns), `core/store` (public storefront), `core/catalog`
  (brand catalog books), `core/search` (⌘K palette), `core/jarvis` (ops
  dashboard + Instagram Studio, post scheduler, social pulse),
  `core/accounting`.
- **Two cores, one bridge** — the CRM core (`core/{quote,tracking,store,crm}`)
  and the Accounting core (`core/accounting` + `lib/accounting`) NEVER import
  each other; every cross-core translation lives in `core/bridge`
  (`quoteToSale`: USD quote → DOP sale figures + e-CF type; `quoteFloorSaleRows`:
  priced lines → LR sell-through rows). Accounting never prices a quote line
  itself. Enforced by `tests/architecture.test.js`.
- **ViewModel** — pure projection `resolveX(rows, params)` → exactly what one
  surface renders. No React/`db`/`supabase` inside a `resolveX`. Lives in
  `core/*/views/*` and the modules each `core/*` barrel re-exports. Lone
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
- Per-page VMs: every other surface has its own `resolveX` — quote
  editor/lists/detail/registration in `core/quote/views/*`; the Contabilidad
  pages via `core/accounting` (sales/commissions, ledger, expenses+606,
  imports, inventory, payments, payroll, reconciliation, analytics, lrSales);
  WhatsApp via `core/crm` (inbox/threads, broadcast campaigns, AI draft turns);
  storefront via `core/store`; JARVIS + Instagram Studio + scheduler + social
  pulse via `core/jarvis`. Grep the barrel's exports to find a page's resolver.

## Data layer
Supabase Postgres + Storage, one shared `'team'` profile (`TEAM_PROFILE_ID`) + RLS.
`src/db/database.ts` is a **Dexie-shaped API over Supabase**
(`db.<table>.where(c).equals(v).toArray()`, `.get/.put/.update/.delete/.bulkPut`),
NOT browser IndexedDB. `db/rowMapping.ts` auto-converts camelCase↔snake_case and
JS-ms↔ISO `timestamptz` (any `*At` field) — a new field works end-to-end once its
column exists. Types: `src/types/domain.ts` (camelCase). **Full schema + domain
facts: `supabase/CLAUDE.md` — read it before DB work.**

Server side = Deno Edge Functions (`supabase/functions/*`): public surfaces
`quote-share` (client quote link + picks) and `store` (storefront data);
integrations `shopify-sync` (inventory mirror + LSG catalog import),
`wa-send`/`wa-webhook` (WhatsApp send + inbound), `wa-draft` (Claude reply
suggestions — never sends, human-in-the-loop), `meta-social` (Instagram
publish/insights/comments/Direct via Instagram-Login OAuth + Instagram ads via the
Marketing API/Business token — no Facebook Page),
`meta-webhook` (IG Direct messages → `ig_messages`; comments/mentions →
`ig_events`), `ig-publish-worker` (IG scheduler worker — pg_cron fires due
`scheduled_posts`, since IG has no native scheduling), `ecf-send` (DGII e-CF),
`bpd-rate` (USD→DOP rate), `hl-track` (container tracking), `lr-catalog`,
`rnc-lookup`, `swatch-proxy`, `claude-chat` (JARVIS chat), `invite-user`,
`delete-user`. See the Deno↔Vite wall in Traps before touching them.

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
- **Never auto-send AI-drafted customer messages**: AI features over the inbox
  (`wa-draft` reply suggestions, ES⇄EN translate, thread summary) are
  human-in-the-loop by design — they SUGGEST, the dealer reviews/edits/sends.
  Don't wire an AI draft straight to `wa-send`; keep the human in the loop.

## Theming (light/dark — variable-driven, light is FROZEN)
One toggle re-skins the whole app; the mechanism is CSS variables, not a
per-component `dark:` sweep.
- **Source of truth**: `src/index.css` `:root` (light) vs `.dark` (dark) define
  `--ink-50..900`, `--brand-50..900`, `--canvas`, `--surface`, `--surface-2`,
  `--card-sheen`, `--card-hi`. `tailwind.config.js` maps `ink/brand/surface/
  canvas` to `rgb(var(--…) / <alpha-value>)` (bare channel triplets — never wrap
  in `rgb()` or add commas, it breaks the alpha modifier). So `text-ink-900`,
  `bg-surface`, `border-ink-100`, etc. flip for free.
- **Light values are FROZEN** = the exact hexes the app always shipped. NEVER
  edit a `:root` light value to "fix" a dark-mode problem — that regresses light
  mode. Fix it in the `.dark` block (or with a `dark:` variant) instead. A new
  color = add the var to BOTH `:root` and `.dark`.
- **Always-dark chrome** (sidebar, mobile topbar, the ProfileMenu inside it) is
  wrapped in `.theme-chrome`, which re-pins `--ink-*`/`--brand-*`/`--surface` to
  the LIGHT ramp locally so it stays dark in both themes. Don't strip that class
  or the sidebar inverts to light in dark mode.
- **`bg-white` can't flip** (literal). Manually-built panels use `bg-surface`
  (light value `#fff`); the only remaining literal whites are intentional
  knockouts (logo plates, fabric-swatch backings, transparent-image mattes,
  white-on-colored chips) and the client/PDF "paper".
- **Anti-FOUC**: an inline `<head>` script in `index.html` stamps `.dark` before
  first paint; it MUST mirror `lib/theme.js` exactly (key `rs.theme`,
  light/dark/system, public routes forced light). `lib/theme.js` owns the live
  toggle + OS-follow; the `theme-color` meta stays the dark chrome ink in both.
- **Public client surfaces stay light** (`/#/q/…`, `/#/tienda`, `ClientPreview`):
  they're the dealer's paper on a customer's device — must match the PDF.

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
- **Code-split imports go through `safeDynamicImport`** (`src/lib/dynamicImport.ts`)
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
