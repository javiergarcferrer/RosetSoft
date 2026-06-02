# RosetSoft architecture — two cores, one brain

The app is **one system** with two distinct cores that meet through a single,
defined membrane. The mental model (the owner's):

```
            ┌──────────────────────── LIMBIC SYSTEM ────────────────────────┐
            │  Identity & Access — who we are. One profile + role governs    │
            │  BOTH cores. Same login; the role reveals its slice.           │
            │  → src/lib/access.js  (navForRole, CORE_ACCESS, canUseCore)     │
            └────────────────────────────────┬──────────────────────────────┘
                                              │
     ┌──────────────── CRM CORE ─────────────┤────────── ACCOUNTING CORE ──────────────┐
     │  sales & flexibility (mutable)        │        security & data integrity         │
     │  cotizaciones, pedidos, clientes,     │        double-entry ledger, impuestos,   │
     │  profesionales, tienda                │        nómina, inventario, banca          │
     │  → src/core/quote, src/pages/*        │        → src/core/accounting,             │
     │                                       │          src/lib/accounting, pages/accounting
     └───────────────────────┬───────────────┴───────────────┬──────────────────────────┘
                             │      THE BRIDGE (pineal)       │
                             └──────────────┬─────────────────┘
                                  src/core/bridge/index.js
                       the osmotic barrier — the ONLY crossing point
```

## The osmotic barrier (rules)

1. **The CRM core and the Accounting core never import each other.** Neither
   reaches into the other's modules. They only ever meet in `src/core/bridge`.
2. **Crossings are named processes, one-directional.** CRM facts flow *into*
   accounting through explicit functions; accounting reads what crosses and
   produces ledger facts. Accounting never reaches back to mutate CRM data.
   - `quoteToSale(...)` — a CRM quote → the DOP figures + e-CF type the sale
     posting needs. (Venta @ entrega.)
   - `resolveSales(...)` — commissions owed on a sale (the seller/professional
     payout) — a CRM event producing an accounting payout, so it lives on the
     bridge.
3. **To audit everything that passes between sales and the books, read one
   file** (`core/bridge/index.js`). New cross-core flow → add a named process
   there, never a direct import across the wall.
4. **Security posture differs by core, on purpose.** Accounting tables are
   RLS-locked and append-mostly (asientos are *reversed*, never edited;
   `ecf_credentials` is write-only via a SECURITY DEFINER RPC). CRM tables are
   team-writable and freely mutable. The barrier keeps the rigid core rigid
   without slowing the flexible one.

## The limbic system (identity & access)

`src/lib/access.js` is the single source of truth for who touches what:

- **One identity:** a `profiles` row (role: `admin | employee | accounting |
  team`). The signed-in user is the same person in both cores.
- **`navForRole(role)`** builds the unified sidebar — the role reveals its
  slice:
  - **employee** → Inicio + Ventas (CRM) + Comisiones (their own).
  - **accounting** → the Contabilidad centers (QuickBooks-style).
  - **admin** → everything, both cores, in one sidebar.
- **`canUseCore(role, core)`** + `CORE_ACCESS` declare core participation for
  page-level gates and future scaling (add a role → set its core access).

Because identity is shared and the data is one Supabase database, a customer, a
quote, and a commission are the *same* record everywhere — there are not two
systems, only two cores of one.

## Where commissions live

Commissions are intrinsically a bridge concern (a CRM sale → an accounting
payout), so:
- **`/comisiones`** (`src/pages/Comisiones.jsx`) is the shared, role-adaptive
  surface: an employee sees only their own; admins/accounting see every seller
  and professional. Read-only.
- **Marking payouts + CSV export** stays in the accounting workspace
  (`/accounting`, "Ventas y comisiones") — the secured side.

## Scaling guidance

- **New CRM feature** → `src/core/quote` + a page; no accounting import.
- **New accounting feature** → `src/lib/accounting` (pure) + `src/core/accounting`
  (ViewModel) + a page; posts only through the ledger Model.
- **New cross-core flow** (a CRM event that must hit the books) → a named
  process in `src/core/bridge`, consumed by the relevant page. Keep it pure and
  one-directional.
- **New role / permission** → `src/lib/access.js` (CORE_ACCESS + navForRole).
