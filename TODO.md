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
- `src/db/rowMapping.js` extracted from `database.js` so the camel ↔
  snake + `*At` timestamp converter is its own module
- Commission read/write fix in admin/Users (`commission_pct` →
  `commissionPct`) + client-side cap at 50% to match DB CHECK
- Status CHECK constraints on `quotes.status` and `orders.status`
- SVG logo treatment: white-tinted wordmark over "Roset Soft" eyebrow
  (no white box) on mobile topbar + sidebar
- QuoteStatusStepper bottom-row layout fix (description + actions
  stack on mobile instead of word-towers next to buttons)

---

## Principle for what follows

The bias is **make-wrong-states-unrepresentable** over test-them-after-
the-fact. Each task tightens an invariant at the boundary (DB
constraint, validator, narrowed type-shape, exhaustive switch) so the
faulty state can't reach the code paths that would mis-handle it.
Tests aren't required; if the logic is shaped right the wrong state
isn't reachable.

---

## Medium ROI (next-session candidates)

### 1. Move row-level DB mutations out of page files   ~1 day

`src/pages/QuoteBuilder.jsx` (~735 LoC), `src/pages/OrderDetail.jsx`
(~640 LoC), `src/components/CustomerModal.jsx`, and
`src/components/ProfessionalModal.jsx` mix UI state with direct
`db.X.put/update/delete` calls. The page files are big enough that
the mutations are hard to keep consistent (timestamp stamping, undo
toast wiring, optimistic state, etc.).

Done when: a page file has zero `db.X.{put,update,delete}` calls; the
mutations all live in a `useQuoteWorkspace()` / `useOrderDetail()`
hook named after the page; each mutation in the hook stamps
`updatedAt`, fires `invalidate()`, and routes through
`assignSequenceNumber` where applicable.

### 2. Centralize the inline money + status formatters   ~half day

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
class + label maps used by every list view; both pull from
`QUOTE_STATUSES` in `lib/constants.js` so adding a status is one
edit.

### 3. Replace remaining `Number(v) || 0` with `safeNum(v, 0)`   ~15 min

`safeNum` in `src/lib/pricing.js` is the canonical numeric coercion
(handles NaN, '', undefined). Patterns like `OrderDetail.jsx:375`
(`Math.max(0, Number(v) || 0)`) work today but silently swallow a
future legitimate `0` if a refactor changes the meaning of the
fallback. Mechanical sweep.

Done when: `grep -rn "Number(.*) || 0"` returns zero hits in
`src/pages/**` / `src/components/**`.

### 4. `QuickActions` `row.kind` namespace clash   ~10 min

`row.kind === 'item' | 'action' | 'customer'` in
`src/components/quote-builder/QuickActions.jsx` is a *separate*
namespace from `line.kind === 'item' | 'section'` (the quote_lines
discriminator). Sharing the string `'item'` across both is a footgun
— a typo migration could move one but not the other.

Done when: `QuickActions` rows use `row.type` instead of `row.kind`,
backed by an `ACTION_ROW_TYPES` constant in
`src/components/quote-builder/QuickActions.jsx` or a sibling file.

### 5. Tighten `Query` / `Table` boundary in `db/database.js`   ~half day

The chainable `Query` class accepts any field name through
`where(field)` and any value through `equals(value)`. Today a typo
in a field name (`whre`) becomes a no-op runtime call against an
empty filter. Add a fail-fast guard: pending `where` without
`equals` throws on `_execute`; `equals` without prior `where` already
throws — keep that.

Also harden `bulkPut`: `chunkSize` must be ≥ 1, retries ≥ 0; throw
on invalid. Today negative values silently bypass the loop.

Done when: invalid chain shape throws at the call site instead of
silently returning [] / nothing.

### 6. Image upload validation at the boundary   ~half day

`saveImage()` in `src/db/database.js` accepts any `File`/`Blob`. No
size cap, no MIME allowlist, no per-bucket policy. A 50MB upload
crashes the dealer's tab; a wrong content-type lands in storage and
ImageView can't render it.

Done when: `saveImage()` rejects (a) non-image MIME types with a
clear error, (b) files larger than a configurable max (default 10
MB), (c) zero-byte files. The error surfaces in `ImageDrop`'s
inline message instead of throwing.

---

## Lower ROI (schedule later)

### 7. Auth gate cannot be bypassed by missing data   ~half day

`App.jsx` gates pages on profile existence + active flag + password-
set timestamp. Several edge cases land you on the post-login routes
with partial state (profile row but no settings, active but
`passwordSetAt` is null on a magic-link user, etc.). Tighten each
gate so a missing piece routes to the correct setup screen rather
than rendering a half-populated page.

Done when: the Gate component is an exhaustive switch on the
profile-state union (loading / unauthenticated / no-profile /
needs-password / inactive / ready); each branch returns a single
component; nothing falls through.

### 8. PDF row-height + page-break invariants documented   ~1 hour

`measureLineRowHeight` and the page-break check in
`pdf/quotePdf.js:generateQuotePdf` work but the math is implicit. Add
a comment block (or `pdf/LAYOUT.md`) that pins: row-height formula,
the `PAGE_BREAK_RESERVE` constant's intent, why compound rows have
their own measurer. Future PDF tweaks will keep failing the same
geometric way unless the invariants are written down.

### 9. `DESIGN.md` at the repo root   ~half day

State diagrams for: quote lifecycle (`QUOTE_STAGES` in
`src/lib/quoteStages.js`), order lifecycle (`ORDER_STAGES` in
`src/lib/orderStages.js`), accepted-quote milestones
(`quoteMilestones.js`), and the rate-mode resolution path (`bsc-buy`
/ `bsc-sell` / `custom`, legacy `bpd-*` / `market`). Cross-link to
the lib files. Unblocks the next maintainer.

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
  on every mutation but assumes online. Flaky LTE can silently lose
  writes.

---

## Process notes

- All migrations land in `supabase/migrations/` with a
  `YYYYMMDDHHMMSS_` prefix; the GitHub integration applies them on
  push to `main`.
- Build with `npm run build`. Green at HEAD.
