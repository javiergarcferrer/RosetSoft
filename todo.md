# todo.md — commission trail + quote-builder findings

Context for whoever picks this up: a recent change made **client discounts come
out of the assigned professional's commission** (floor orders = 15% base, special
orders = 20%, chosen via the Piso/Especial toggle = `quotes.order_type`). The math
lives in `src/lib/commissions.ts` (`baseCommissionPct`, `effectiveCommissionPct`,
`commissionAmount`) and is fed by `computeTotals` in `src/lib/pricing.ts`
(`taxableBase`, `discountAmt`; note `preDiscountBase = taxableBase + discountAmt =
afterMargin`). `commissionAmount(totals, pct) = max(0, preDiscountBase*pct − discountAmt)`.

Verify gate for every change: `npm run typecheck && npm test && npm run build`.

---

## P0 — confirmed defect (fix first)

- [ ] **Accounting commission detail string is arithmetically wrong when a discount is present.**
  - Where: `src/pages/accounting/Workspace.jsx:756` (the `Profesional` `CommissionLine` `detail`).
  - Problem: it renders `Base {base} · {proPct}% = {proAmount}` where `base = t.taxableBase`
    (post-discount, L173) but `proAmount` now nets out the client discount. With a discount it
    reads e.g. "Base 900 · 20% = 100" (900×20% = 180, not 100). Rollup totals are correct — this
    is display-only. The seller line above (`:737`) is fine (seller commission really is base×pct).
  - Action: make the equation honest. When `t.discountAmt > 0`, show the breakdown, e.g.
    `Base {preDiscountBase} · {proPct}% = {gross} − desc. {discountAmt} = {proAmount}`
    (mirror the builder's `CommissionCard` in `TotalsRail.jsx`); when no discount, keep the
    current `Base · % = amount` form. `preDiscountBase = t.taxableBase + t.discountAmt`.
  - Verify: open Contabilidad on a quote with an assigned professional + a quote-level discount;
    the printed numbers must compute.

---

## P1 — inconsistencies / latent correctness risks

- [ ] **Two discount mechanics with different commission semantics.**
  - Per-line discount (`lineDiscountPct`) silently shrinks the commission base; the quote-level
    discount (`discountPct`) is explicitly drawn from commission. The trail is only fully
    consistent once per-line discounts are removed (planned in another workstream). Confirm that
    removal lands; until then, decide whether a per-line discount should also come out of commission.

- [ ] **`ClientPreview` recomputes line math without the lib's clamp.**
  - Where: `src/components/quote-builder/ClientPreview.jsx:492,499` (`Number(line.lineDiscountPct)`
    then `listUnit*(1-discount/100)`).
  - Problem: equals `applyLineAdjustments` for in-range data, but skips `clampPct` (0–100), so it
    diverges if `lineDiscountPct` is ever out of range. Latent (inputs currently clamp).
  - Action: route through `applyLineAdjustments` / `lineListUnit` from `src/lib/pricing.ts`.

- [ ] **Duplicated math that should come from a lib (drift risk; currently equivalent).**
  - DOP conversion: `TotalsRail.jsx:88` vs `ClientPreview.jsx:447` — both hand-roll
    `Math.round(total*dopRate)`; consider a `formatMoney`/helper.
  - "N of M" group position: hand-written in `LineItemList.jsx` and `ClientPreview.jsx` instead of
    a shared helper (`setGroupInfo` exists in `pricing.ts`).
  - `resolveOptionDeltas` in `QuoteLineItem.jsx` (~L42) re-implements `materialOptionDeltas` (`pricing.ts`).
  - Action: make the libs authoritative; delete the inline copies.

- [ ] **Gross-commission formula duplicated outside the lib.**
  - Where: `src/components/quote-builder/TotalsRail.jsx:58` recomputes `(taxableBase+discountAmt)*pct/100`.
  - Action: expose `grossCommissionAmount(totals, pct)` (or a `{gross, discount, net}` breakdown)
    from `src/lib/commissions.ts` and consume it here.

- [ ] **Editor/preview twin components can drift.**
  - `GroupCard` (`LineItemList.jsx`) vs `ClientGroupCard` (`ClientPreview.jsx`); `ClientLine` /
    `CompoundClientLine` carry parallel layout/logic. Action: extract one shared group/line block.

- [ ] **Commission is recomputed live — no frozen paid amount.**
  - Toggling `order_type`, or ever changing `FLOOR_COMMISSION_PCT`/`SPECIAL_COMMISSION_PCT`,
    retroactively changes already-paid quotes' displayed commission; `commissionPaidAt` records
    *that* it paid, not *how much*. Action (if audit history matters): snapshot the paid amount at
    payout time, or freeze via an explicit `commission_pct` override.

---

## P2 — leftovers / hygiene

- [ ] **Vestigial per-professional default commission.**
  - `professionals.default_commission_pct` no longer drives the quote rate (the order-type toggle
    replaced it) but is still editable/shown: `ProfessionalModal.jsx:48,150-151`,
    `ProfessionalPicker.jsx:178,182` ("X% por defecto"), `Professionals.jsx:20,182,217`.
  - Action: remove it or relabel as a non-binding note. (Already cleaned in `ProfessionalChip`
    placeholder and `ProfessionalDetail` subtitle.) Dropping the column is optional/non-urgent.

- [ ] **Side-effect inside a presentation component.**
  - `QuoteLineItem.jsx` `GradeFabricRow` does a fire-and-forget DB write (`rememberSwatchInCatalog`,
    ~L626). Action: lift the persistence out of render into a handler/hook.

---

## P3 — structural (architecture; larger refactors, no rush)

- [ ] **Thin out the god orchestrator.** `Workspace` (~L184–1105 in `src/pages/QuoteBuilder.jsx`,
  ~920 LOC) owns all state + ~18 mutations (writing directly to `db.*`) + grouping invariants +
  sequence-number healing + PDF export + render. Action: lift quote state + mutations + grouping/
  sequence rules into a `useQuoteActions` hook / domain module; expose `{quote, actions}` via
  context. This also removes the prop-drilling below.

- [ ] **Decompose oversized leaves.** `QuoteLineItem.jsx` (**1501 LOC**, 13 inline subcomponents,
  own `FamiliesContext`) and `ClientPreview.jsx` (**980 LOC**). Action: split the inline
  subcomponents into files; separate presentation from catalog lookup + persistence.

- [ ] **Kill the prop-drilling.** Line-mutation handlers thread `Workspace → LineItemsCard →
  LineItemList → renderRow → QuoteLineItem → bands`; `families` already had to escape via
  `FamiliesContext` because `LineItemList` won't thread it. Action: serve quote+actions from a
  context/store so blocks subscribe to what they need.

---

## Open business decisions (NOT bugs — confirm intent, then act if needed)

- [ ] **Seller commission also drops with the client discount** (it's computed on the post-discount
  `taxableBase`: `Workspace.jsx:161`, `admin/Commissions.jsx:137`). Decide: should the seller earn
  on the pre- or post-discount base?
- [ ] **Rate vs payout-timing are decoupled.** Rate ← `order_type` (toggle); payout timing ←
  `order_id` presence (`commissions.ts` `commissionOwedAt`, the `quote.orderId ? balancePaidAt :
  depositReceivedAt` line). A quote can be `special` (20%) yet pay on deposit, or `floor` (15%) yet
  pay on balance. Confirm acceptable, or make `commissionOwedAt` consider `order_type`.
- [ ] **`trade_discount` + a client discount combine** — in trade-discount mode the decorator's
  billed discount also shrinks by a client discount. Rare/murky. Decide: allow, or block
  `discountPct` when `decorator_billing = 'trade_discount'`.

## Notes (found, already resolved — no action)
- The `decorator_billing` migration comment said the trade-discount default was "15%" while
  `professionals.default_commission_pct` defaulted to 10%. The new floor rate (15%) reconciled this.
