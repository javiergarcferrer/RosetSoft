# todo.md — commission trail + quote-builder findings

Context for whoever picks this up: a recent change made **client discounts come
out of the assigned professional's commission** (floor orders = 15% base, special
orders = 20%, chosen via the Piso/Especial toggle = `quotes.order_type`). The math
lives in `src/lib/commissions.ts` (`baseCommissionPct`, `effectiveCommissionPct`,
`commissionAmount`) and is fed by `computeTotals` in `src/lib/pricing.ts`
(`taxableBase`, `discountAmt`; note `preDiscountBase = taxableBase + discountAmt =
afterMargin`). `commissionAmount(totals, pct) = max(0, preDiscountBase*pct − discountAmt)`.

Verify gate for every change: `npm run typecheck && npm test && npm run build`.

> **Status (this pass):** P0 fixed; all clear-cut P1 dedup/correctness items done; P2 vestigial
> default-commission relabeled. New lib surface: `commissionBreakdown` / `grossCommissionAmount`
> (`commissions.ts`) and `alternativeGroupInfo` (`pricing.ts`), both covered by tests
> (typecheck + 200 tests + build all green). **Deferred** (marked inline below): the editor/preview
> component extraction, the frozen-paid-amount change, all P3 structural refactors (large, "no rush",
> high regression risk to ship blind), and the open business decisions (need an owner's call).

---

## P0 — confirmed defect (fix first)

- [x] **Accounting commission detail string is arithmetically wrong when a discount is present.**
  - DONE — `SaleCard` (`Workspace.jsx`) now builds the `Profesional` detail from
    `commissionBreakdown(totals, proPct)`: with a discount it prints
    `Base {preDiscountBase} · {proPct}% = {gross} − desc. {discountAmt} = {net}`, and the
    no-discount path keeps the compact `Base · % = amount` form. Mirrors the builder's
    `CommissionCard`. (Seller line left as-is — it was already honest.)

---

## P1 — inconsistencies / latent correctness risks

- [x] **Two discount mechanics with different commission semantics.** (RESOLVED by removal.)
  - The per-line discount removal has landed: there is NO UI control that sets `lineDiscountPct`
    (new lines initialize it to 0 at `QuoteBuilder.jsx:163,546`; duplication only carries a legacy
    value). So the inconsistency can't arise on new quotes — it's frozen to legacy data. Restating
    legacy per-line discounts as "drawn from commission" would rewrite historical commission
    figures (same reason we now freeze paid amounts), so legacy is intentionally left as-is.

- [x] **`ClientPreview` recomputes line math without the lib's clamp.**
  - DONE — `ClientLine` now derives `qty`/`listUnit`/`unit`/`total` from `lineQty`,
    `lineListUnit`, `applyLineAdjustments`, `lineTotal`, and `clampPct(line.lineDiscountPct)`
    (so an out-of-range pct can no longer invert/balloon the unit). `CompoundClientLine`'s
    displayed `−Y%` now clamps via `clampPct` too.

- [x] **Duplicated math that should come from a lib (drift risk; currently equivalent).**
  - DONE — DOP conversion in `ClientPreview` now goes through `formatMoney(total, 'DOP', rates)`
    (the helper already does `Math.round(total*rate)`); "N of M" position now uses the new shared
    `alternativeGroupInfo` + existing `setGroupInfo` in `pricing.ts` (the three inline scans in
    `LineItemList`/`ClientPreview` are gone); `resolveOptionDeltas` in `QuoteLineItem` is deleted
    in favor of `materialOptionDeltas` from `pricing.ts`.

- [x] **Gross-commission formula duplicated outside the lib.**
  - DONE — added `commissionBreakdown(totals, pct) -> {gross, discount, net}` and
    `grossCommissionAmount` to `commissions.ts` (with `commissionAmount` now delegating to the
    breakdown). `TotalsRail` consumes the breakdown; the accounting line (P0) consumes it too.

- [ ] **Editor/preview twin components can drift.** (DEFERRED — large refactor; currently works.)
  - `GroupCard` (`LineItemList.jsx`) vs `ClientGroupCard` (`ClientPreview.jsx`); `ClientLine` /
    `CompoundClientLine` carry parallel layout/logic. Action: extract one shared group/line block.
    Belongs with the P3 decomposition below; out of scope for this correctness/dedup pass.

- [x] **Commission is recomputed live — no frozen paid amount.** DONE — snapshot route.
  - New nullable `numeric` columns `commission_paid_amount` / `seller_commission_paid_amount`
    (migration `20260530120000`). Marking a commission paid in Contabilidad now snapshots the live
    amount; unmarking clears it. New `reportedCommission(paidAt, frozen, live)` returns the frozen
    snapshot once paid (else live), so a later `order_type` toggle or a `FLOOR/SPECIAL_COMMISSION_PCT`
    / seller-rate change can't restate a PAID commission. Applied across the Contabilidad rollups,
    sale-card detail (collapses to "Pagada · $X" when paid), and both CSV exports, plus
    `ProfessionalDetail`. Legacy paid rows (null snapshot) fall back to live. Tests added.

---

## P2 — leftovers / hygiene

- [x] **Vestigial per-professional default commission.**
  - DONE (relabel route) — copy no longer implies the value drives the quote rate:
    `ProfessionalModal` field is now "Comisión de referencia" with honest help text
    (rate comes from the order type, Piso 15% / Especial 20%); `ProfessionalPicker` shows
    "ref. X%"; `Professionals` list header is "Comisión ref.". The editable field/column is kept
    (dropping the column is optional/non-urgent, per the note) — no data/migration change.

- [ ] **Side-effect inside a presentation component.** (DEFERRED — the literal "in render" bug
    isn't present; the remaining concern is architectural, belongs with P3.)
  - `rememberSwatchInCatalog` (`QuoteLineItem.jsx`) is already called from the `setSwatch` event
    handler, not during render, so it doesn't fire on re-render. The deeper cleanup — moving
    persistence out of the presentation component entirely — is part of the P3 god-orchestrator /
    prop-drilling work below; doing it standalone has no behavioral payoff and touches a 1.5k-LOC file.

---

## P3 — structural (architecture; larger refactors, no rush)

> DEFERRED this pass — these are large, cross-cutting refactors (god-object decomposition, splitting
> 1.5k-LOC leaves, introducing a quote context/store). Shipping them blind to production `main` in a
> single autonomous pass is high-risk and they're explicitly "no rush"; better as a focused,
> reviewable change set. Listed here so they're not lost.

- [x] **Thin out the god orchestrator.** DONE — `Workspace` (`src/pages/QuoteBuilder.jsx`) went
  from ~1258 LOC to ~580 and is now live-queries + UI-panel state + view-model + JSX wiring; the
  logic moved out in four slices:
    1. **Grouping invariants** → pure, tested `lib/quoteGroups.ts` helpers (`selectAlternativePatches`,
       `healAlternativeOnRemove`, `healSetOnRemove`); the four mutations consume them instead of
       re-deriving the same singleton/selection healing four times.
    2. **Prop-drilling killed** (item below, done) — editor actions flow via `QuoteActionsContext`.
    3. **Export/share logic** → `useQuoteExport.js` (PDF generation + share-link minting + their UI
       status/effects), so the export UI stays thin.
    4. **The mutation + undo/redo state machine** → `useQuoteController.js` (the ~14 db-writing
       mutations, the whole-quote-snapshot history with its ⌘Z/⌘Y binding + per-quote reset, and the
       save-status indicator). `Workspace` destructures the controller's return into the same local
       names the JSX already used, so only the SOURCE of the handlers moved — behavior is identical
       (verified with a scoped `checkJs` pass for missing inputs/return keys, plus typecheck + tests
       + build). The remaining sequence-number heal effect stays on the page (it's tied to the live
       query); the catalog-families escape hatch is unchanged.

- [ ] **Decompose oversized leaves.** `QuoteLineItem.jsx` (**1501 LOC**, 13 inline subcomponents,
  own `FamiliesContext`) and `ClientPreview.jsx` (**980 LOC**). Action: split the inline
  subcomponents into files; separate presentation from catalog lookup + persistence.
  - PARTIAL — `ClientPreview` (966 → 821 LOC): extracted the two reusable, self-contained leaves
    `ImageZoom.jsx` + `MaterialOptionsStrip.jsx` into files (and dropped `MaterialOptionsStrip`'s
    now-dead `pricing.materialOptionDeltas` namespace fallback for the direct named import).
    Remaining: the entangled line/group components (`ClientLine`/`CompoundClientLine`/
    `ClientGroupCard`) and all of `QuoteLineItem.jsx` (under active parallel churn — risky to split
    blind without UI tests).

- [x] **Kill the prop-drilling.** DONE — editor actions now flow via `QuoteActionsContext`
  (`src/components/quote-builder/QuoteActionsContext.js`), mirroring the `FamiliesContext` escape
  hatch. `Workspace` provides the 13-handler bundle once; `LineItemsCard` and `LineItemList` read
  what they use from context instead of threading them through. History-wrapping (`hx`) stays at the
  source (and `onToggleGroupOptional` stays un-wrapped, as before); per-line binding stays local in
  `LineItemList`. Quote/lines/groups stay as data props by design. Behavior identical; typecheck +
  218 tests + build green.

---

## Open business decisions (RESOLVED by the owner — now implemented)

- [x] **Seller commission base → POST-discount.** Owner: "post discount base." Current behavior
  already computes the seller cut on the post-discount `taxableBase` (`Workspace.jsx:161`,
  `admin/Commissions.jsx:137`) — confirmed correct, no change.
- [x] **Payout timing follows `order_type` (not `order_id`).** Owner: "floor pays on deposit;
  special must be tied to a container and requires a balance payment." `commissionOwedAt` now keys
  off `order_type`: floor → `depositReceivedAt`; special → `balancePaidAt` AND requires an
  order/container (`orderId`), so a special quote with no order never owes. The Contabilidad
  per-line hint and the `devengada_via` CSV column follow the same rule. Tests updated.
- [x] **`trade_discount` + a client discount → discount comes from the decorator amount.** Owner:
  "discount percent must come from decorator amount." The math already drew it from there
  (`tradeDiscount = commissionAmount = gross − client discount`); the Contabilidad trade-discount
  detail is now honest about it: with a discount it prints
  `−{pct}% = {gross} − desc. cliente {discount} = {net} (sin comisión)`.

## Notes (found, already resolved — no action)
- The `decorator_billing` migration comment said the trade-discount default was "15%" while
  `professionals.default_commission_pct` defaulted to 10%. The new floor rate (15%) reconciled this.
