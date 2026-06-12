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
- [ ] Ledger + accounting Dashboard read-mode: collapse to 2-line entry cards
      (fecha+memo / debe+haber) < md; desktop density unchanged.
- [ ] Difusion composer 375px pass: `src/pages/Difusion.jsx` variable-mapping
      rows → stacked labels; verify audience picker at narrow widths.
- [ ] Nómina: payroll-run 13-col table → per-employee cards < md
      (`accounting/Nomina.jsx`); Empleados forms already grid OK.
- [ ] Materials admin card fallback: `src/pages/admin/Materials.jsx` (zero
      responsive classes today; reuse the shared primitive).
- [ ] JARVIS phone pass: verify 3-pane HUD panel heights + radar SVG at 375px
      (`src/pages/Jarvis.jsx`, `jarvis.css`); admin-only, last.

## Data ↔ interaction seams (bridge-shaped; tests + typecheck)
- [ ] Quote invoice status into CRM: `resolveQuoteInvoiceStatus(postings)` in
      `core/bridge`, NCF/Facturada pill on quote list row, QuoteBuilder header,
      CustomerDetail. Pin in `tests/bridge.test.js`.
- [ ] Deposit handoff: marking "Depósito" milestone offers a prefilled cobro
      (USD→DOP at the locked `quoteRateState`); allocating a cobro to a
      quote's posting offers stamping `balancePaidAt` (`OrderDetail.jsx`,
      `CuentasCobrarPagar.jsx`).
- [ ] Commission payout → books: mark-paid in `accounting/Workspace.jsx` offers
      "Registrar gasto de comisión" prefilled from resolved figures.
- [ ] HL arrival nudge: suggestion chip on OrderDetail when the voyage summary
      reports arrival ("¿marcar En aduanas/Recibido?") — human confirms, no
      auto-advance (`core/tracking/voyage.js` summary already computes it).
- [ ] Inventory link: stamp `inventoryItemId` on lines inserted from
      `InventoryPicker`; on invoice/delivery offer prefilled kardex salida +
      COGS (uses existing `registerSalida` path in `Inventario.jsx`).
- [ ] Expediente seed: "Sembrar desde el pedido" prefills embarque lines from
      `resolveOrderRegistration` rows (`accounting/ExpedienteForm.jsx`).
- [ ] JARVIS deep links: ops-feed entries + funnel rows become `Link`s with row
      id / status-filtered list URLs (`src/pages/Jarvis.jsx`).
- [ ] Global search groups: conversations (reuse `resolveConversations` →
      `/chats?chat=`), containers by number → `/orders/:id`; role-gated
      suppliers/NCF for accounting (`core/search`, `GlobalSearch.jsx`).
- [ ] Customer 360: role-gated "Cuenta" card on CustomerDetail (receivable
      balance + link to prefiltered statement) via a bridge resolver.
- [ ] e-CF: auto-transmit after posting when cert+sequence configured (manual
      button stays as fallback); pending-transmission badge on the 607 tab
      (`accounting/Facturacion.jsx`).
- [ ] Cross-core dashboard tiles: "N por facturar" on CRM Dashboard (admins) ↔
      quote links in accounting panels (bridge-shaped data only).
- [ ] Tienda availability: cross-check store cards against `inventory_items`
      by SKU in `resolveStore`/`store` function; qty ≤ 0 → "Bajo pedido". Add
      "Ver tienda" external link in Settings' Tienda header.

## Consistency / structure debt (from the structure review)
- [ ] Route all error catches through `userMessageFor` (`lib/errorMessages.ts`)
      — 22 files render raw `e?.message`; batch by area (accounting, CRM,
      admin), one area per iteration.
- [ ] Extract View-inlined money derivations into resolvers (one per
      iteration): party statements (`CuentasCobrarPagar.jsx:53-69` →
      `core/accounting/receivables`), workspace filter/sort/commission
      comparator (`Workspace.jsx:239-279` → `resolveSales`) ✓ done in i5,
      client-preview
      priced shapes (`ClientPreview.jsx:560-589` → `resolveQuoteView`),
      compound repricing (`QuoteLineItem.jsx:217-241` → pure
      `repriceComponentsAtGrade` in `lib/pricing`), COGS click-handler math
      (`Inventario.jsx:68-100` → helper beside `buildCogsEntry`).
- [ ] Wrap raw RPC/invoke calls in lib (pattern: `ecfSequence.js`):
      `Facturacion.jsx` ecf-send ×3 + `post_sale`, `Jarvis.jsx` ×5,
      `Materials.jsx:711`.
- [ ] Pin missing money tests: `tests/commissionCycle.test.js` (16th→15th
      window + year wrap), small direct test for `lib/quoteGroups.ts`.
- [ ] Migration-ordering fitness test (style of credentialDurability): fail any
      migration filename timestamp older than the repo's current maximum.
- [ ] Shared RNC cleaning (`cleanRnc` everywhere; `CuentasCobrarPagar.jsx:81`)
      + shared `isDepositIn(quote)` selector (Workspace vs Facturación drift).

## Out of scope for the loop (user decision needed — from the security review)
- Admin gate (`is_admin`) on `save_*` credential RPCs + `meta-social` link
  mode; in-code JWT check for `lr-catalog`. Changes who on the team can
  (re)configure integrations — confirm before shipping.
- Server-side role enforcement (RLS) for accounting/payroll tables if role
  separation is intended beyond UX.
