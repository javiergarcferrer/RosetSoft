# TODO

Outstanding work after the May 2026 watertight pass. Findings that
weren't shipped, ranked by ROI inside each tier. Every item has a
rough time estimate and a concrete "done when" so the next session
can pick one up without re-discovering scope.

Done in the same pass (for reference, not to redo):

- HIGH list-view total bugs in Quotes / Orders / OrderDetail (compound
  rows showing $0, adjustments ignored)
- `displayRatesFor(quote, settings)` so list views match the workspace
  on active drafts
- Race-safe sequence numbering: `UNIQUE(profile_id, number)` + the
  `assignSequenceNumber()` helper, applied to every direct caller
- `newId()` → `crypto.randomUUID()` (122-bit collision floor)
- `src/lib/constants.js` (`LINE_KIND_*`, `QUOTE_STATUS_*`,
  `isPricedLine`, `isActiveQuoteStatus`) with the call sites migrated
- `src/db/rowMapping.js` extracted + unit-tested (24 cases) so the
  camel ↔ snake + `*At` timestamp contract can't regress silently
- Commission read/write fix in admin/Users (`commission_pct` →
  `commissionPct`) + client-side cap at 50% to match DB CHECK
- Status CHECK constraints on `quotes.status` and `orders.status`
- SVG logo treatment: white-tinted wordmark over "Roset Soft" eyebrow
  (no white box) on mobile topbar + sidebar
- QuoteStatusStepper bottom-row layout fix (description + actions
  stack on mobile instead of word-towers next to buttons)

---

## Medium ROI (next-session candidates)

### 1. Database access layer — Query/Table class tests   ~1 day

`src/db/database.js` has `Query` (chainable `where().equals().sortBy()`
etc.) and `Table` (`get` / `put` / `update` / `delete` / `bulkPut` /
`bulkDelete`). The pure converters are now covered by
`tests/rowMapping.test.js`, but the chainable surface and the
invalidation bus are not. A bug in `Query.equals()` or in the
`bulkPut` chunk loop would silently corrupt every fetch.

Done when: a `tests/database.test.js` runs against a minimal
`@supabase/supabase-js` stub (mocked `from().select()/eq()/order()/
limit()`) and verifies: chain accumulates filters; `bulkPut` chunks
respect `chunkSize`; `bulkPut` retries `retries` times before
giving up; `delete()` fires `invalidate()`; `get(null)` returns null
without a round-trip; the thenable `await Query` shape works.

### 2. Move row-level DB mutations out of page files   ~1 day

`src/pages/QuoteBuilder.jsx` (~735 LoC), `src/pages/OrderDetail.jsx`
(~640 LoC), `src/components/CustomerModal.jsx`, and
`src/components/ProfessionalModal.jsx` mix UI state with direct
`db.X.put/update/delete` calls. Extracting these into
`useQuoteWorkspace()` / `useOrderDetail()` hooks shrinks the page
files and unblocks integration testing.

Done when: a page file has zero `db.X.{put,update,delete}` calls; the
mutations all live in a hook named after the page; the hook's tests
verify each mutation's effect on the Supabase stub.

### 3. Centralize the inline money + status formatters   ~half day

Same pattern repeated in 4–5 places:
```js
const fmt = (v) => formatMoney(v, currency, rates);
```
(see `QuoteLineItem.jsx`, `TotalsRail.jsx`, `ClientPreview.jsx`,
`Dashboard.jsx`). Also `STATUS_PILL_CLASS` / `STATUS_LABELS` are
declared in both `pages/Quotes.jsx` and `pages/Orders.jsx` with
different vocabularies — easy to drift.

Done when: a `useMoneyFormatter(quote)` hook is the single creation
point of `fmt`; `src/lib/quoteStatusDisplay.js` exports the pill
class + label maps used by every list view.

### 4. Replace remaining `Number(v) || 0` with `safeNum(v, 0)`   ~15 min

`safeNum` in `src/lib/pricing.js` is the canonical numeric coercion.
Currently used inside `pricing.js` only. Patterns like
`OrderDetail.jsx:375` (`Math.max(0, Number(v) || 0)`) work today but
silently swallow a future legitimate `0`. Mechanical sweep.

Done when: `grep -rn "Number(.*) || 0"` returns zero hits in
`src/pages/**` / `src/components/**`.

### 5. `QuickActions` `row.kind` namespace clash   ~10 min

`row.kind === 'item' | 'action' | 'customer'` in
`src/components/quote-builder/QuickActions.jsx` is a *separate*
namespace from `line.kind === 'item' | 'section'` (the quote_lines
discriminator). Sharing the string `'item'` across both is a footgun
— a typo migration could move one but not the other.

Done when: `QuickActions` rows use `row.type` instead of `row.kind`,
backed by an `ACTION_ROW_TYPES` constant in
`src/components/quote-builder/QuickActions.jsx` or a sibling file.

---

## Lower ROI (schedule later)

### 6. Auth + RLS integration tests   ~1 day

The `App.jsx` Gate, the admin-only RLS policies, the role-escalation
trigger (`prevent_self_role_escalation` from migration
`20260518160000`), and the deleted-while-signed-in flow are dense
and untested.

Done when: `tests/auth-rls.test.js` verifies — non-admin can't
promote themselves; non-admin can't read another user's
`commission_pct`; inactive user is signed out on session refresh; a
fresh user whose row is missing falls through to SetPassword.

### 7. PDF rendering correctness tests   ~1 day

`tests/pdf-export.test.js` currently only asserts "didn't throw". No
coverage for: line wrapping at page boundaries, compound article
layout, the `TOTAL COMPUESTO` callout position, the discount strike-
through math, the font fallback when Inter fetch fails.

Done when: tests render with stubbed fonts and assert measured row
heights / column positions against expected values.

### 8. Image upload tests   ~half day

`ImageDrop`, `saveImage`, the Supabase Storage bucket path, the
deletion + cascade behavior. No current coverage.

### 9. `DESIGN.md` at the repo root   ~half day

State diagrams for: quote lifecycle (`QUOTE_STAGES` in
`src/lib/quoteStages.js`), order lifecycle (`ORDER_STAGES` in
`src/lib/orderStages.js`), accepted-quote milestones
(`quoteMilestones.js`), and the rate-mode resolution path (`bsc-buy`
/ `bsc-sell` / `custom`, legacy `bpd-*` / `market`). Cross-link to
the lib files.

### 10. Settings RateCard `saveSettings` dead prop   ~2 min

Passed from `Settings.jsx` into `RateCard` but never used inside.
Drop the prop.

### 11. Compound article PDF spot-check   ~10 min

The compound row geometry in `src/pdf/lines.js:drawCompoundLineRow`
was written and unit-bounded but never visually inspected. Worth
running an export with a 3-component compound + a line discount and
eyeballing the alignment.

---

## Out of scope until asked

- **Multi-tenant** — the single-team model bakes `TEAM_PROFILE_ID =
  'team'` throughout. Needs a real `profile_id` propagation pass and
  RLS rewrite.
- **TypeScript migration** — the codebase is JS with JSDoc. Would
  surface many of the issues above for free but is a multi-week
  project.
- **Background sync / offline writes** — `useLiveQuery` invalidates
  on every mutation but assumes online. Flaky LTE (the screenshot
  context from May 19) can silently lose writes.

---

## Process notes

- All migrations land in `supabase/migrations/` with a
  `YYYYMMDDHHMMSS_` prefix; the GitHub integration applies them on
  push to `main`.
- Tests run with `npm test` (Node's `node:test`). Build with `npm
  run build`. Both are green at HEAD.
