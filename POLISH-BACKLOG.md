# Polish backlog — seamless mobile+desktop, data↔interaction friction

Driven by the 2026-06-12 whole-codebase review. The /loop works top-to-bottom:
each iteration takes the FIRST unchecked item, implements it, verifies with the
matching signal (UI → `npm run typecheck` + `npm run build`; logic → module
test + typecheck), pushes to `claude/bold-euler-sog0s5`, and checks it off.
One item per iteration unless items are trivially small (then batch ≤3).
Keep diffs small; follow existing patterns (cards mirror `Quotes.jsx:233-262`).

## Iteration 1 — quick wins (shipped with the loop setup)
- [x] Drop dead Inter font imports (`src/main.jsx`) — 4 unused woff2 chains off
      the mobile critical path (Tailwind sans = Lausanne; zero references).
- [x] Replace raw NUL bytes with `\u0000` escapes (`src/pages/QuoteBuilder.jsx`
      294/299, `src/core/crm/views/inbox.js:177`) — files were classified
      binary, silently breaking grep/diff tooling.
- [x] De-island `/accounting/statements`: add "Estados financieros" tab to the
      Informes section (`src/lib/accountingSections.js`) so AccountingSubnav
      renders there and back-navigation context is kept.

## Mobile/desktop (phone-first surfaces first)
- [x] Comisiones mobile cards: `src/pages/Comisiones.jsx` has 4 h-scroll
      tables and is THE employee surface. Add `md:hidden` per-sale card list
      mirroring the `Quotes.jsx` dual pattern; keep tables `hidden md:block`.
      (i2 — all 4 tables; payout pills unified in SellerStatus/ProStatus.)
- [x] Shared responsive row primitive: extract `RowCards`/`ResponsiveTable`
      (components/) from the Quotes/Orders card pattern, then apply to
      `accounting/Expenses.jsx`, `CuentasCobrarPagar.jsx`, `Importaciones.jsx`,
      `Compras.jsx`, `Inventario.jsx` (one page per iteration after the
      primitive lands).
      (i3-i4 — components/RowCards.jsx: title/right + sub + kv grid + totals
      footer, rows support to/onClick; applied to all 8 tables across the 5
      pages incl. 606, statement, histórico and kardex stock list.)
- [x] Ventas y comisiones workspace cards: `accounting/Workspace.jsx` 11-col
      table → card rows < md (keep desktop table). Pre-req: consider extracting
      the inline filter/sort into `resolveSales` first (see Consistency below).
      (i5 — filter/sort/tab-counts extracted to `resolveWorkspaceEntries`
      (core/accounting/sales.js, pinned in tests/commissions.test.js); the
      per-sale list was already responsive — the two SummaryTable payout
      rollups got RowCards inCard fallbacks.)
- [x] Facturación action row: `accounting/Facturacion.jsx:427-446` RNC/NCF
      inputs + button stack full-width < sm; pin 607 tfoot totals outside the
      scroll container (:471-545).
      (i6 — action row + 607 search stack < sm; 607 gets RowCards with a
      totals footer and a shared ecfActions renderer for cell + card.)
- [x] Ledger + accounting Dashboard read-mode: collapse to 2-line entry cards
      (fecha+memo / debe+haber) < md; desktop density unchanged.
      (i7 — Mayor + Balanza (tap → mayor) and the dashboard's segmented +
      comparativo tables; Diario and Asientos recientes already fit.)
- [x] Difusion composer 375px pass: `src/pages/Difusion.jsx` variable-mapping
      rows → stacked labels; verify audience picker at narrow widths.
      (i8 — audience pills wrap; fixed-text variable input drops to its own
      full-width line < sm. Rest of the composer was already sheet-modal OK.)
- [x] Nómina: payroll-run 13-col table → per-employee cards < md
      (`accounting/Nomina.jsx`); Empleados forms already grid OK.
      (i8 — already done in the codebase: both tables ship sm:hidden cards;
      review item was stale. No change.)
- [x] Materials admin card fallback: `src/pages/admin/Materials.jsx` (zero
      responsive classes today; reuse the shared primitive).
      (i8 — bespoke md:hidden cards (thumbnail + pills + actions don't fit
      RowCards' shape); table at md+.)
- [x] JARVIS phone pass: verify 3-pane HUD panel heights + radar SVG at 375px
      (`src/pages/Jarvis.jsx`, `jarvis.css`); admin-only, last.
      (i8 — verified clean by inspection: grid stacks < xl, panels are
      responsive grids, radar scales by viewBox, feeds scroll internally,
      fonts clamp. No change needed.)

## Data ↔ interaction seams (bridge-shaped; tests + typecheck)
- [x] Quote invoice status into CRM: `resolveQuoteInvoiceStatus(postings)` in
      `core/bridge`, NCF/Facturada pill on quote list row, QuoteBuilder header,
      CustomerDetail. Pin in `tests/bridge.test.js`.
      (i9 — bridge resolver (latest posting wins) + shared InvoiceChip on the
      quote table rows, mobile cards, builder header (with NCF) and the
      customer's quote history. e-CF rechazado shows as a red chip.)
- [x] Deposit handoff: marking "Depósito" milestone offers a prefilled cobro
      (USD→DOP at the locked `quoteRateState`); allocating a cobro to a
      quote's posting offers stamping `balancePaidAt` (`OrderDetail.jsx`,
      `CuentasCobrarPagar.jsx`).
      (i10 — "Registrar cobro" link on the deposit milestone (admin/
      accounting, locked rate, ?party&amount&ref) + PaymentForm seeds from
      those params. The reverse stamp (cobro → balancePaidAt) NOT done:
      payments carry no quote linkage today — would need an allocations→
      posting→quote hop; revisit if wanted.)
- [x] Commission payout → books: mark-paid in `accounting/Workspace.jsx` offers
      "Registrar gasto de comisión" prefilled from resolved figures.
      (i11 — once a stream is marked paid, a "Gasto" link opens Gastos with
      monto (USD→DOP at today's rate), ITBIS 0 and the description seeded;
      NewExpenseForm accepts ?amount&itbis&desc.)
- [x] HL arrival nudge: suggestion chip on OrderDetail when the voyage summary
      reports arrival ("¿marcar En aduanas/Recibido?") — human confirms, no
      auto-advance (`core/tracking/voyage.js` summary already computes it).
      (i12 — arrivalAction slot in ContainerTracking's summary band, only
      rendered when voyage.arrived; OrderDetail supplies the stage-advance
      button gated by the existing canAdvance rules.)
- [x] Inventory link: stamp `inventoryItemId` on lines inserted from
      `InventoryPicker`; on invoice/delivery offer prefilled kardex salida +
      COGS (uses existing `registerSalida` path in `Inventario.jsx`).
      (i13 — migration 20260718130000 adds quote_lines.inventory_item_id;
      picker stamps it; Facturación deliverable cards link "Salida de
      inventario" → Inventario ?item&qty preselects kardex + out qty.)
- [x] Expediente seed: "Sembrar desde el pedido" prefills embarque lines from
      `resolveOrderRegistration` rows (`accounting/ExpedienteForm.jsx`).
      (i14 — button under the Pedido select; reference/name/qty seeded, FOB
      left for the invoice; confirm before replacing non-empty lines.)
- [x] JARVIS deep links: ops-feed entries + funnel rows become `Link`s with row
      id / status-filtered list URLs (`src/pages/Jarvis.jsx`).
      (i15 — resolvers emit `to`; view renders Links; pinned shapes intact.)
- [x] Global search groups: conversations (reuse `resolveConversations` →
      `/chats?chat=`), containers by number → `/orders/:id`; role-gated
      suppliers/NCF for accounting (`core/search`, `GlobalSearch.jsx`).
      (i16 — containers + role-gated suppliers groups added. Conversations
      SKIPPED on purpose: would need the whole wa_messages table client-side;
      customers/professionals results already deep-link into their chat.)
- [x] Customer 360: role-gated "Cuenta" card on CustomerDetail (receivable
      balance + link to prefiltered statement) via a bridge resolver.
      (i17 — `resolveCustomerAccount` in core/bridge (pinned in
      tests/bridge.test.js); StatCard links to Banca, and CxC now honors
      ?statement=<partyId> to auto-open the estado de cuenta.)
- [x] e-CF: auto-transmit after posting when cert+sequence configured (manual
      button stays as fallback); pending-transmission badge on the 607 tab
      (`accounting/Facturacion.jsx`).
      (i18 — postSale fire-and-forgets transmitPosting (refactored to take
      the posting object) when an e-NCF was assigned and cert+RNC exist; a
      failure stays 'pending' (same e-NCF retried via the button) and the
      607 tab badges "N por transmitir".)
- [x] Cross-core dashboard tiles: "N por facturar" on CRM Dashboard (admins) ↔
      quote links in accounting panels (bridge-shaped data only).
      (i19 — readyToInvoice/invoiceReadyAt promoted to lib/quoteMilestones
      (one rule for Facturación's queue + the tile); CRM Dashboard shows a
      role-gated "Por facturar" StatCard → /accounting/facturacion. The
      accounting→CRM direction already exists via CardHead links.)
- [x] Tienda availability: cross-check store cards against `inventory_items`
      by SKU in `resolveStore`/`store` function; qty ≤ 0 → "Bajo pedido". Add
      "Ver tienda" external link in Settings' Tienda header.
      (i20 — store Edge Function ships sku+qtyOnHand (no costs cross);
      resolveStore demotes a tracked sold-out sku from Disponible to Bajo
      pedido (pinned in tests/store.test.js); Ver tienda → link added.)

## Consistency / structure debt (from the structure review)
- [x] Route all error catches through `userMessageFor` (`lib/errorMessages.ts`)
      — 22 files render raw `e?.message`; batch by area (accounting, CRM,
      admin), one area per iteration.
      (i24 — every direct render site (setErr/alert/inline) across accounting
      (10 files), CRM, admin and components now calls userMessageFor;
      `{ ok, error: e?.message }` RESULT payloads (Chats/Difusion send
      results) intentionally untouched — they're data shapes, not renders.)
- [~] Extract View-inlined money derivations into resolvers (one per
      iteration): party statements (`CuentasCobrarPagar.jsx:53-69` →
      `core/accounting/receivables`) ✓ i25, workspace filter/sort/commission
      comparator (`Workspace.jsx:239-279` → `resolveSales`) ✓ i5,
      client-preview
      priced shapes (`ClientPreview.jsx:560-589` → `resolveQuoteView`)
      ✓ i27 — linePriced/componentPriced now live in
      core/quote/views/quoteView.js (exported via the barrel); ClientPreview
      imports them. Follow-up idea: have src/pdf/quotePdf consume the same
      shapes (today it formats off the same primitives),
      compound repricing (`QuoteLineItem.jsx:217-241` → pure
      `repriceComponentsAtGrade` in `lib/catalog`) ✓ i26 (pinned in
      tests/catalog.test.js), COGS click-handler math
      (`Inventario.jsx:68-100` → `planSalida` beside `buildCogsEntry`) ✓ i25.
- [~] Wrap raw RPC/invoke calls in lib (pattern: `ecfSequence.js`):
      `Facturacion.jsx` ecf-send ×3 + `post_sale`, `Jarvis.jsx` ×5,
      `Materials.jsx:711`.
      (i23 — lib/ecfSend.js (sendEcf/checkEcfStatus) + lib/salePosting.js
      (postSaleTx) replace all four raw calls in Facturación; the page no
      longer touches supabase directly. REMAINING: Jarvis ×5 + Materials ×1
      — lower-stakes status/one-shot invokes; wrap opportunistically.)
- [x] Pin missing money tests: `tests/commissionCycle.test.js` (16th→15th
      window + year wrap), small direct test for `lib/quoteGroups.ts`.
      (i22 — 8 new pins: day-15/16 rollover, year wrap, cycle contiguity,
      ISO helpers; pick-one/heal invariants + lone-set collapse.)
- [x] Migration-ordering fitness test (style of credentialDurability): fail any
      migration filename timestamp older than the repo's current maximum.
      (i21 — tests/migrationOrder.test.js: per-file git addition time
      (--no-renames so a rename re-enters as an add) must be monotonic with
      the filename timestamps; uncommitted files count as added now; the one
      historical repair is grandfathered. Full suite 568/568.)
- [x] Shared RNC cleaning (`cleanRnc` everywhere; `CuentasCobrarPagar.jsx:81`)
      + shared `isDepositIn(quote)` selector (Workspace vs Facturación drift).
      (i23 — statement emisor now uses cleanRnc. The deposit-predicate drift
      was already dissolved by i5 (tab filter lives in
      resolveWorkspaceEntries) + i19 (readyToInvoice in quoteMilestones) —
      one encoding each, no extra selector needed.)

## Out of scope for the loop (user decision needed — from the security review)
- Admin gate (`is_admin`) on `save_*` credential RPCs + `meta-social` link
  mode; in-code JWT check for `lr-catalog`. Changes who on the team can
  (re)configure integrations — confirm before shipping.
- Server-side role enforcement (RLS) for accounting/payroll tables if role
  separation is intended beyond UX.
