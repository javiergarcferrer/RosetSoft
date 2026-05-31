# Handoff: make the editor "Vista cliente" pane identical to the public client link

Status: **planned, not implemented.** Resume here in a fresh session.
Branch: `claude/designer-features-brainstorm-mFI0t`.

## Goal
The editor's "Vista cliente" preview pane must render **identically** to the
public client-link page (`#/q/:token`) — same prices AND same interactivity.

## Key finding (de-risks the whole task)
**Line/component prices and totals ALREADY match** between the two surfaces, so
there is **no Edge Function change and no client-side bundle rebuild needed**.
Proof (corroborated by direct reads):

- Public link bundle — `supabase/functions/quote-share/index.ts`,
  `buildBundle` (L254) / `clientLine` (L105): bakes margin into `unitPrice`
  (`× marginFactor`, where `marginFactor = (1+quote.margin_pct/100)·(1+line_margin_pct/100)`,
  L255-256, L286) and **zeroes** `marginPct`/`lineMarginPct` (L146, L342).
- Editor — feeds raw `unitPrice` + real `marginPct`/`lineMarginPct`;
  `ClientPreview` → `resolveQuoteView` (`src/core/quote/views/quoteView.js`) →
  `src/lib/pricing.ts applyLineAdjustments` (L133) applies `[marginPct, lineMarginPct]`.
- Both arrive at `unitPrice_raw × marginFactor`. Same VM (`resolveQuoteView`) →
  same content tree. **Identical.**

> NOTE: there is NO `supabase/functions/quote-share/bundle.ts`. An earlier
> session hallucinated it. The bundle is assembled in `index.ts`. quote-share
> has only `index.ts` + `pick.ts`.

## The 3 real gaps (all client-side: QuoteBuilder + ClientPreview)

### Gap 1 — fabric-picker grade prices don't bake margin
- Link: each line's `gradePrices[g] = priceUsd × marginFactor` (index.ts
  `gradePricesFor` L91-101, per-line factor L286). Components inherit the line's
  factor (L111-113).
- Editor: `editorGradePricesFor(reference)` (`QuoteBuilder.jsx` L270-277) returns
  **raw `priceUsd`** — no margin, not per-line.
- FIX: make it margin-aware per line. Add a `marginFactor` arg:
  `editorGradePricesFor(reference, marginFactor=1)` → `out[g]=priceUsd*marginFactor`.
  In `ClientPreview` the FabricPicker gate (the IIFE computing
  `gp = line.gradePrices || picker.gradePricesFor?.(line.reference)`) must pass
  the line's `marginFactor` for both the line AND its components (components use
  the PARENT line's factor). Factor EXCLUDES discount (link bakes margin only).
  Helper: `marginFactor(quote, line) = (1+ (quote.marginPct||0)/100) * (1+ (line.lineMarginPct||0)/100)`.

### Gap 2 — editor wires only `onPickMaterial`; link wires all four
- Link (`PublicQuoteView.jsx` L147-150): `onSelectMaterial=pickMaterial(id,grade)`,
  `onPickMaterial=pickMaterialFree(id,sel)`, `onToggleOptional=toggleOptional(lineId,on)`,
  `onSelectAlternative=pickAlternative(group,lineId)`.
- Editor (`QuoteBuilder.jsx` L456-471): only `onPickMaterial=pickMaterialInEditor`.
- FIX: also pass (mapping to the existing controller mutations from
  `useQuoteController`, destructured at L257-263 — `toggleOptional`,
  `selectAlternative`, `updateLine`):
  - `onToggleOptional` → adapter over controller `toggleOptional` (confirm its
    signature; ClientPreview calls `(lineId, on)`).
  - `onSelectAlternative` → adapter over controller `selectAlternative`
    (ClientPreview calls `(group, lineId)`).
  - `onSelectMaterial(id, grade)` → grade-only reprice: reuse
    `editorMaterialPatch` (L279) keeping the current fabric label, changing only
    grade→SKU→priceUsd (mirrors link `materials:{[id]:grade}`). This drives the
    `MaterialOptionsStrip` offered-material pick.
  - Wrap with `hx(...)` to join undo/redo (see how QuoteActionsContext does it at
    L488-500).

### Gap 3 — materialOptions delta parity
- Link: `withDeltas` (index.ts L66-85) bakes `delta=(p-basePrice)×marginFactor`
  into each option; ClientPreview renders the baked `option.delta`.
- Editor: lines carry raw `materialOptions` (no `delta`); ClientPreview/
  `MaterialOptionsStrip` recomputes deltas from `families`. **VERIFY** that path
  applies the same `marginFactor`; fix if it doesn't, so chip deltas match.

## Must re-verify in the fresh session (couldn't due to tooling glitches)
1. `useQuoteController` exact signatures: `toggleOptional`, `selectAlternative`.
2. `ClientPreview` handler arg shapes for `onSelectMaterial`/`onToggleOptional`/
   `onSelectAlternative` (cross-check vs `PublicQuoteView` usage above).
3. `MaterialOptionsStrip` delta computation — does it bake `marginFactor`?

## Files to touch
- `src/pages/QuoteBuilder.jsx` — editorGradePricesFor(+marginFactor); new
  onSelectMaterial/onToggleOptional/onSelectAlternative handlers; pass them in the
  ClientPreview block (L456-471).
- `src/components/quote-builder/ClientPreview.jsx` — pass per-line marginFactor to
  `picker.gradePricesFor`; add a small marginFactor helper; verify delta path.

## Verify
- `npm run typecheck` + `npm run build` (UI change; no tested module touched).
- Manual sanity: one upholstered line, non-zero quote margin + line margin →
  editor picker grade prices == link picker grade prices; option-chip deltas match.

## Do NOT
- Touch `supabase/functions/quote-share/*` (not needed; prices already match).
- Rebuild a client-side bundle / extract a shared bundle Model (unnecessary).
