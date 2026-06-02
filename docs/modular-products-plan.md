# Handoff: modular products — a catalog-agnostic Element → Component product → Modular hierarchy

Status: **implemented** on `claude/adoring-curie-z0pFL`. The hardcoded EXCLUSIF
kit map is gone; modular grouping is now a catalog-agnostic, dealer-authored
abstraction (`src/lib/modules.ts`). This doc is the design of record.
Branch: `claude/adoring-curie-z0pFL` (rides on the multi-add work already on this
branch — see "What changes on this branch" below).

## Goal
Give the quote builder a first-class, **catalog-agnostic** composition hierarchy
so a dealer can assemble a modular sofa the way Ligne Roset describes it, with a
single image and per-module pricing — without the set-hack and without any
model-specific code.

## Vocabulary (Ligne Roset's own terms — lock these)
Three tiers, recursive, dealer-authored:

| Tier | LR term | What it is | In the app |
|---|---|---|---|
| **Element** | element / part SKU | atomic catalog item (frame, seat, back & scatter cushion, base, bolster) | a `Product` / one priced component |
| **Component product** | *complete element* | a product **made of elements** | a compound line: `components[]` = elements, **one image** |
| **Modular product** | modular | made of **complete-element products** | a compound line whose components are **grouped into modules**, each module = one component product |

It is **one uniform structure**: a component product is a modular with a single
module; a modular is a component product whose elements are grouped into named
sub-modules. Same pricing (Σ of priced elements), same one-image rendering —
only the *grouping depth* differs.

## The problem this solves
Today "components" (`components[]`, a compound line) is overloaded for BOTH a
single component-product AND a modular. With no first-class "modular", quote
#1016 faked one by **joining component-products into a `setGroup`** — which gives
every member its own image and a "Conjunto N de M" header (the opposite of the
single-image modular look). The set is the wrong tool because it *splits* into
separate visual lines.

## Key finding — composition is NOT in the catalog (de-risks the design)
Composition **cannot** be derived from catalog data and **must not** be
hardcoded. Evidence (direct reads):

- Price-list columns (`tests/priceListCsv.test.js:12`): `SKU, Description 1/2,
  Sales Code (+Desc/Divisor), Retail, Cost, Category Code/Desc, Item Style
  Code/Desc`. **No** parent-SKU / parts / "complete element" / BOM column.
- `Product` type (`src/types/domain.ts:752-767`) and the `products` table
  (`supabase/migrations/20260527160000_products_reload_schema.sql:13-27`): no
  parent/parts/composition field. Grouping is purely SKU-root + grade-letter
  (`splitSkuGrade`, `groupFamilies` in `src/lib/catalog.ts`) — fabric variants of
  ONE model, not part→whole.
- The only "accessory" handling (`src/lib/priceListCsv.ts:227-242`) is
  name-healing for bolster/cushion SKUs, **not** a composition link.

⇒ The complete-element ↔ parts map can only come from the dealer **at assembly
time**. The current `ELEMENT_KITS` constant (EXCLUSIF SKU roots) is exactly the
trap that breaks the moment the price list changes. **It must go.**

## Decisions locked (from design review)
1. **Manual assembly only.** The dealer assembles a component product by picking
   its elements and grouping them, then names it. No catalog lookup. A generic
   **group / ungroup** replaces "explode / recompose". No dealer-maintained
   compositions table for now (can come later as editable data — never code).
2. **Presentation = group by module.** One image; each module is a sub-row (the
   complete element) with its elements nested beneath and a per-module subtotal;
   modular grand total at the bottom.

## The model (additive, JSONB, NO migration)
`db/rowMapping.ts` auto-maps camelCase↔snake_case and JSONB stays as-is, so these
ship in the bundle the moment the code lands — no schema change.

1. **Line discriminator** — `QuoteLine.compoundKind?: 'item' | 'componentProduct'
   | 'modular'` in `src/types/domain.ts`. Absent ⇒ today's behavior (back-compat:
   existing compound lines read as `'componentProduct'`, plain lines as `'item'`).
2. **One dealer-stamped grouping field per component** — generalize the branch's
   `kitGroup` into **`moduleGroup`** (id) + **`moduleName`** (label) on
   `LineComponent`. Components sharing a `moduleGroup` = one component product
   (one "complete element") inside the modular. **Drop `kitCompleteRoot`** — there
   is no canonical complete SKU to fold back to.

## Pricing — reuse, do not duplicate (`src/lib/pricing.ts`)
- Modular grand total = existing `compoundSubtotal(line)` (Σ of priced
  components). **No new total math.**
- Add pure helpers (catalog-agnostic, range-aware, mirror
  `compoundSubtotalRange`):
  - `modulesOf(line)` → ordered modules `[{ moduleGroup, name, components[] }]`,
    partitioning `components[]` by `moduleGroup` (an ungrouped component is its
    own single-element module).
  - `moduleSubtotal(components, moduleGroup)` → Σ of that group's priced elements.
- `isPricedLine`/`isPricedComponent` unchanged.

## ViewModel (`src/core/quote/views/`) — single shared VM, no drift
- `resolveLineItem` + `resolveQuoteView`: when `compoundKind === 'modular'`, emit
  `modules[]` (each = name, subtotal, range, element rows) instead of a flat
  component list. Same VM feeds editor preview + public client link + PDF, so
  screen/paper/list can't diverge (per `core/quote/views/quoteView.js`).

## Editor UI (`src/components/quote-builder/`)
- `MultiAddPicker.jsx`: each ticked element seeds a component; stamp a fresh
  `moduleGroup` + `moduleName` so a multi-add run becomes one named module. Set
  the resulting line's `compoundKind = 'modular'` (or expose a "Modular" toggle).
- `QuoteLineItem.jsx`: render grouped-by-module (module header + nested elements +
  per-module subtotal), a "Modular" badge, keep the single `imageId`. Add generic
  **Agrupar / Desagrupar** actions over selected components (purely structural —
  no catalog lookup).

## PDF (`src/pdf/react/QuoteDocument.tsx`)
- One image + module sub-rows with per-module subtotals; modular grand total at
  the bottom. Reuse `modulesOf`.

## What changes on this branch (elementKits.ts)
`src/lib/elementKits.ts` becomes catalog-agnostic. **Remove**: `ELEMENT_KITS`
(EXCLUSIF seed), `KIT_BY_ROOT`, `kitForReference`, `hasKit`,
`separationDeltaUsd`, `buildCompleteComponent` (recompose-from-known-SKU),
`kitCompleteRoot`. **Keep / repurpose**: the generic structural grouping
(group selected components → a named module; ungroup) over `moduleGroup`.
Update `tests/elementKits.test.js` accordingly (rename to `modular.test.js`),
covering `modulesOf` / `moduleSubtotal` and the parity that
`Σ moduleSubtotal == compoundSubtotal`. Re-point `MultiAddPicker` / the
`QuoteLineItem` explode/recompose UI at the generic group/ungroup.

## Verify
- Logic: `node --import tsx --test tests/modular.test.js` + `npm run typecheck`.
- Every `main`/preview push: `npm run build` must pass (Vercel builds with it).

## Open for a future iteration (not now)
A dealer-maintained `compositions` table (editable in-app) could let a named
component product be reused across quotes — but that is **dealer-authored data**,
never hardcoded app constants, and is out of scope for this pass.
