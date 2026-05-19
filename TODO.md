# TODO

State after the May 2026 watertight passes + TypeScript migration
kick-off. The bias: **make wrong states unrepresentable** at the
boundary, via types and validators. Tests aren't required — if the
shape is right, the bad state can't reach the code that would
mis-handle it.

---

## What's already in main

Watertight logic:
- HIGH list-view total bugs in Quotes / Orders / OrderDetail
  (compound rows showing $0, adjustments ignored)
- `displayRatesFor(quote, settings)` so list views match the workspace
  on active drafts
- Race-safe sequence numbering: `UNIQUE(profile_id, number)` on
  quotes / orders / containers / professionals + the
  `assignSequenceNumber()` helper, applied to every direct caller
- `newId()` → `crypto.randomUUID()` (122-bit collision floor)
- `src/lib/constants` (`LINE_KIND_*`, `QUOTE_STATUS_*`, `isPricedLine`,
  `isActiveQuoteStatus`) wired into ~25 call sites
- `src/db/rowMapping` extracted from `database` so the camel ↔ snake +
  `*At` timestamp converter is its own module
- Commission read/write fix in admin/Users + client-side cap at 50%
  matching the DB CHECK
- Status CHECK constraints on `quotes.status` and `orders.status`
- SVG logo: white-tinted wordmark over "Roset Soft" eyebrow
- QuoteStatusStepper bottom row: stack on mobile
- Boundary hardening:
    – `saveImage()` rejects zero-byte, non-image MIME, and >10 MB
    – `Query` rejects trailing `where()` without `equals()`, empty
      field names, non-function `filter()`, non-positive `limit()`
    – `bulkPut()` validates `chunkSize` / `retries`
    – `assignSequenceNumber()` validates every parameter at the
      boundary instead of burning round-trips on bad input

TypeScript migration (incremental, `allowJs: true`):
- `tsconfig.json`, `vite-env.d.ts`, vite alias for `.js` → `.ts` and
  `.jsx` → `.tsx` resolution so existing imports don't need
  rewriting
- `src/types/domain.ts` — Profile, Settings, Customer, Professional,
  Quote, QuoteLine, LineComponent, Order, Container, ImageRecord +
  the discriminator union types + pricing input/output shapes
- `src/lib/**` converted (12 files): pricing, commissions,
  exchangeRate, subtype, quoteStages, orderStages, quoteMilestones,
  commissionCycle, useKeyboardShortcut, dynamicImport, errorMessages,
  invite. Plus the earlier-converted constants + format
- `src/db/**` converted (3 files): database (with generic
  `Table<T>` / `Query<T>`), hooks, supabaseClient. rowMapping already
  was TS
- `src/components/primitives/**` + DebouncedInput + ImageView (10
  files): props interfaces, correct `forwardRef` generics

---

## Principle for what follows

Make-wrong-states-unrepresentable over test-them-after-the-fact.
Each task tightens an invariant — types, validators, exhaustive
switches, DB constraints. Tests stay only where they pin the shape
of pure math that types can't express (the existing pricing /
numbering / quoteMilestones / commissions / subtype suites — 76
tests total, the pre-session baseline).

---

## In-flight

### PDF agent migration   (background)
`src/pdf/**` agent is still running in its worktree. When it lands:
typed `PdfCtx` + pdf-lib type imports + converted constants, util,
embed, header, lines, totals, quotePdf. Will merge into main when
done.

---

## Next — TypeScript completion

### 1. Migrate `src/components/quote-builder/**`   ~half day
The big quote-builder folder (QuoteLineItem ~37 KB, ClientPreview,
TotalsRail, QuoteHeader, QuickActions, FamilyPicker, CustomerPicker,
ProfessionalPicker, etc.). Props interfaces; the line-editor + the
quote-line state shape map directly to the `QuoteLine` /
`LineComponent` types in `src/types/domain.ts`.

### 2. Migrate `src/components/**` remainder   ~couple of hours
CustomerModal, ProfessionalModal, ImageDrop, EmptyState,
ErrorBoundary, ListLoading, Modal, PageHeader, ProfileMenu,
StatCard, Layout. Smaller than quote-builder; mostly props passes.

### 3. Migrate `src/context/**` + `src/pages/**`   ~1 day
The largest layer. Pages tend to mix `useApp()`, `useLiveQuery()`,
local state, and mutations — the typing pays back the most here
because the shapes flow end-to-end.

### 4. Once full migration lands: tighten strictness   ~half day
Flip on `strict: true`, fix any `any` remnants, add `noImplicitAny`.

---

## Watertight logic — concrete next-tasks

### 5. Auth Gate as exhaustive switch   ~half day
`App.jsx` Gate currently chains conditionals over profile
existence / active flag / `passwordSetAt`. Several edge cases land
you on post-login routes with partial state (profile but no
settings, active but `passwordSetAt` is null on a magic-link user).
Turn the Gate into an exhaustive `switch` over a discriminated
union (`'loading' | 'unauthenticated' | 'no-profile' |
'needs-password' | 'inactive' | 'ready'`); each branch returns a
single component; nothing falls through.

### 6. Move row-level DB mutations out of page files   ~1 day
`pages/QuoteBuilder.jsx` (~735 LoC), `pages/OrderDetail.jsx`
(~640 LoC), `components/CustomerModal.jsx`,
`components/ProfessionalModal.jsx` mix UI state with direct
`db.X.put/update/delete` calls. Extract into `useQuoteWorkspace()`
/ `useOrderDetail()` hooks named after the page; each mutation in
the hook stamps `updatedAt`, fires `invalidate()`, and routes
through `assignSequenceNumber` where applicable.

### 7. Centralize the inline money + status formatters   ~half day
`const fmt = (v) => formatMoney(v, currency, rates);` is redeclared
in `QuoteLineItem`, `TotalsRail`, `ClientPreview`, `Dashboard`.
`STATUS_PILL_CLASS` / `STATUS_LABELS` are declared in both
`pages/Quotes` and `pages/Orders` with different vocabularies —
easy to drift. Done when: `useMoneyFormatter(quote)` is the single
creation point; `src/lib/quoteStatusDisplay.ts` exports the
class/label maps used by every list view.

### 8. `safeNum(v, 0)` sweep   ~15 min
Replace remaining `Number(v) || 0` patterns in `src/pages/**` /
`src/components/**` with `safeNum`. The `|| 0` fallback silently
swallows a future legitimate `0`.

### 9. `QuickActions` `row.kind` namespace clash   ~10 min
`row.kind === 'item' | 'action' | 'customer'` in
`components/quote-builder/QuickActions.jsx` is a SEPARATE namespace
from `line.kind === 'item' | 'section'`. Rename `row.kind` →
`row.type` with an `ACTION_ROW_TYPES` constant.

### 10. PDF row-height + page-break invariants documented   ~1 hour
`measureLineRowHeight` and the page-break check in
`pdf/quotePdf.ts:generateQuotePdf` work but the math is implicit.
Add a `pdf/LAYOUT.md` (or block comment) pinning the row-height
formula, the `PAGE_BREAK_RESERVE` intent, and why compound rows
have their own measurer.

### 11. Compound article PDF spot-check   ~10 min
The compound row geometry in `pdf/lines.ts:drawCompoundLineRow`
was implemented but never visually verified. Export a quote with a
3-component compound + a line discount and eyeball the alignment.

### 12. Settings RateCard `saveSettings` dead prop   ~2 min
Passed from `Settings.jsx` into `RateCard` but never used. Drop.

---

## Out of scope until asked

- **Multi-tenant** — single-team model bakes `TEAM_PROFILE_ID = 'team'`.
  Needs a real `profile_id` propagation pass + RLS rewrite.
- **Background sync / offline writes** — `useLiveQuery` invalidates
  on every mutation but assumes online. Flaky LTE can silently lose
  writes.

---

## Process notes

- Migrations land in `supabase/migrations/` with a
  `YYYYMMDDHHMMSS_` prefix; the GitHub integration applies on push
  to `main`.
- Build: `npm run build`. Type-check: `npm run typecheck`. Tests:
  `npm test` (76 passing — original pure-math suite, pre-session
  baseline).
