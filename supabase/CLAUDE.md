# Database reference (Supabase Postgres)

Fast-path schema notes so a session doesn't re-derive the DB from 30+
migrations. Authoritative sources: the camelCase shapes in
`src/types/domain.ts`, the live table list in `src/db/database.ts` (`TABLES`),
and the SQL in `supabase/migrations/`.

## How the DB works here
- **Access:** the app never uses raw SQL. `src/db/database.ts` exposes a
  Dexie-shaped API (`db.<table>.where('col').equals(v).toArray()`,
  `.get(id)`, `.put(row)`, `.update(id, patch)`, `.delete(id)`, `.bulkPut(...)`)
  over Supabase. `db/rowMapping.ts` auto-converts **camelCase ↔ snake_case**
  and **JS-ms-timestamp ↔ ISO `timestamptz`** (any field ending in `At`). So a
  new field works end-to-end once its column exists — no other wiring.
- **PKs are app-generated `text`** (`newId()`), NOT uuid. `settings`'s PK is
  `profile_id`.
- **Single tenant:** every row is scoped to one shared profile
  `TEAM_PROFILE_ID = 'team'`; all team members share the same data.
- **Migrations:** additive, idempotent (`add column if not exists`, drop+add
  constraints). Name `YYYYMMDDHHMMSS_desc.sql`, timestamp later than every
  existing file. End with `notify pgrst, 'reload schema';`. **Pushing to
  `main` auto-applies them** (see root CLAUDE.md) — never ask the user to run
  them.

## Live tables (10)
`profiles · settings · images · customers · professionals · orders · quotes ·
quote_lines · containers · materials`. Field-by-field shapes are in
`src/types/domain.ts`; below are the DB facts that file doesn't carry.

- **profiles** `id` (= auth.uid()). `role` CHECK `('admin','employee','accounting','team')`;
  `commission_pct` CHECK 0–50. Triggers: `prevent_self_privilege_escalation`
  (can't change own role/active), `profiles_touch_updated_at`. RLS: read all;
  write self-or-admin. `handle_auth_user_deleted` cleans up on auth delete.
- **settings** PK `profile_id`. One row per profile. The USD↔DOP rate lives in
  `exchange_rate` (written by the **`bpd-rate` Edge Function**, Banco Popular
  venta); `currency_rates`/`bsc`/`bpd`/`dop_rate_mode` are legacy read-fallbacks.
- **customers / professionals** profile-scoped. `professionals.default_commission_pct`
  default 10, CHECK 0–20. `professionals` has a per-`(profile_id, number)` unique.
- **quotes** `status` CHECK `('draft','sent','accepted','declined','archived')`.
  FKs (all `on delete set null`): `customer_id`, `professional_id`, `order_id`,
  `created_by_user_id`. Accepted-quote milestones live HERE not on the order:
  `deposit_received_at`, `balance_paid_at`, `delivered_at`. Unique `(profile_id, number)`.
- **quote_lines** scoped via `quote_id` (`on delete cascade`). `kind` ∈ `item|section`.
  Two JSONB columns: **`components`** (compound article parts — each a
  `LineComponent`; non-empty array ⇒ compound) and the line carries `image_id`
  + `swatch_image_id` (→ `images.id`, set null). Grouping flags:
  - `is_optional` — excluded from total.
  - `alternative_group` + `is_selected_alternative` — pick-one; only the
    selected member is priced. Index `(quote_id, alternative_group)`.
  - `set_group` — "Conjunto" / take-all; **every** member priced (sum-only).
    Index `(quote_id, set_group)`.
  - CHECKs: `not (is_optional and alternative_group is not null)` and
    `not (set_group is not null and (is_optional or alternative_group is not null))`.
  Pricing predicate `isPricedLine` (lib/constants) encodes these. Index
  `(quote_id, sort_order)`.
- **orders** `status` CHECK `('draft','placed','confirmed','in_transit','in_customs','received','cancelled')`.
  Stage timestamps `placed_at … cancelled_at`. Unique `(profile_id, number)`.
- **containers** `order_id` FK; `filled_at` non-null ⇒ packed. Unique `(profile_id, number)`.
- **materials** `category` CHECK `('fabric','leather','outdoor')`;
  `measure_unit` ∈ `in|mm|null`; `price_unit` ∈ `yard|sm|null`. **Colors are a
  JSONB `colors` column** (`MaterialColor[]` = `{name, code, imageId?}`), NOT a
  separate table. The material's hero thumbnail = first color with an `imageId`.
- **images** metadata for objects in Storage; `kind` + `owner_id` tag the owner
  (e.g. `quote-line-swatch`/`material-color`). Bytes via `saveImage` /
  `downloadImageBytes`.

## Cross-cutting
- **RLS:** single-tenant "team can write" — most tables: `for all to
  authenticated using (true) with check (true)`. `profiles` is the exception
  (self-or-admin writes, role-escalation trigger). `is_admin(uid)` helper.
- **Numbering:** human-facing `number` per table is per-`(profile_id, number)`
  UNIQUE; the app's `assignSequenceNumber()` computes the next value and retries
  on 23505 (unique_violation) under concurrency.
- **No PG enums** — every "enum" is a `text` column + CHECK (values listed above).
- **Storage buckets:** `images` (all app images) and `pricelist` (the team's
  current Ligne Roset price-list PDF). Both team-readable/writable.
- **Stripped/legacy:** early migrations created `products`, `product_variants`,
  `categories`, and a `material_colors` table; the `strip_catalog_quote_only`
  migration removed the product catalog and colors moved to `materials.colors`
  JSONB. Ignore those table names — they're not in the live schema.
