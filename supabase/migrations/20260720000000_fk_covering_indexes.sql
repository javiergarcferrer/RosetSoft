-- Covering indexes for the foreign keys flagged by the Supabase performance
-- advisor (lint 0001_unindexed_foreign_keys). A foreign key with no covering
-- index forces a sequential scan of the child table every time the parent row
-- is updated or deleted, and slows the parent->child joins the accounting and
-- quote views run on every page (e.g. quote_lines by quote_id, journal_lines by
-- entry_id).
--
-- profile_id foreign keys are intentionally omitted: this is a single-tenant
-- deployment (one shared 'team' profile), so profile_id has exactly one distinct
-- value and an index on it can never improve a scan — it would only add write
-- overhead. Credential/config tables (claude_config, ecf_credentials,
-- meta_social_config, shopify_config, whatsapp_config) carry only a profile_id
-- FK and are therefore untouched here.
--
-- Additive + idempotent.

create index if not exists idx_accounts_parent_code              on public.accounts             (parent_code);
create index if not exists idx_containers_order_id               on public.containers           (order_id);
create index if not exists idx_expenses_account_code             on public.expenses             (account_code);
create index if not exists idx_expenses_journal_entry_id         on public.expenses             (journal_entry_id);
create index if not exists idx_expenses_supplier_id              on public.expenses             (supplier_id);
create index if not exists idx_import_expedientes_container_id   on public.import_expedientes   (container_id);
create index if not exists idx_import_expedientes_journal_entry  on public.import_expedientes   (journal_entry_id);
create index if not exists idx_import_expedientes_order_id       on public.import_expedientes   (order_id);
create index if not exists idx_import_expedientes_supplier_id    on public.import_expedientes   (supplier_id);
create index if not exists idx_import_liquidations_item_id       on public.import_liquidations  (item_id);
create index if not exists idx_import_liquidations_journal_entry on public.import_liquidations  (journal_entry_id);
create index if not exists idx_import_liquidations_order_id      on public.import_liquidations  (order_id);
create index if not exists idx_import_liquidations_supplier_id   on public.import_liquidations  (supplier_id);
create index if not exists idx_inventory_items_image_id          on public.inventory_items      (image_id);
create index if not exists idx_inventory_movements_item_id       on public.inventory_movements  (item_id);
create index if not exists idx_inventory_movements_journal_entry on public.inventory_movements  (journal_entry_id);
create index if not exists idx_journal_entries_reversed_by_id    on public.journal_entries      (reversed_by_id);
create index if not exists idx_journal_entries_reverses_id       on public.journal_entries      (reverses_id);
create index if not exists idx_journal_lines_account_code        on public.journal_lines        (account_code);
create index if not exists idx_journal_lines_entry_id            on public.journal_lines        (entry_id);
create index if not exists idx_materials_image_id                on public.materials            (image_id);
create index if not exists idx_orders_customer_id                on public.orders               (customer_id);
create index if not exists idx_payments_journal_entry_id         on public.payments             (journal_entry_id);
create index if not exists idx_payroll_runs_journal_entry_id     on public.payroll_runs         (journal_entry_id);
create index if not exists idx_products_image_id                 on public.products             (image_id);
create index if not exists idx_profiles_invited_by               on public.profiles             (invited_by);
create index if not exists idx_purchases_account_code            on public.purchases            (account_code);
create index if not exists idx_purchases_item_id                 on public.purchases            (item_id);
create index if not exists idx_purchases_journal_entry_id        on public.purchases            (journal_entry_id);
create index if not exists idx_purchases_supplier_id             on public.purchases            (supplier_id);
create index if not exists idx_quote_groups_quote_id             on public.quote_groups         (quote_id);
create index if not exists idx_quote_lines_quote_id              on public.quote_lines          (quote_id);
create index if not exists idx_quote_lines_swatch_image_id       on public.quote_lines          (swatch_image_id);
create index if not exists idx_quotes_created_by_user_id         on public.quotes               (created_by_user_id);
create index if not exists idx_quotes_customer_id                on public.quotes               (customer_id);
create index if not exists idx_quotes_order_id                   on public.quotes               (order_id);
create index if not exists idx_quotes_professional_id            on public.quotes               (professional_id);
create index if not exists idx_quotes_promotion_id               on public.quotes               (promotion_id);
create index if not exists idx_sales_postings_customer_id        on public.sales_postings       (customer_id);
create index if not exists idx_sales_postings_journal_entry_id   on public.sales_postings       (journal_entry_id);
create index if not exists idx_sales_postings_quote_id           on public.sales_postings       (quote_id);
create index if not exists idx_settings_store_customer_id        on public.settings             (store_customer_id);
create index if not exists idx_suppliers_default_account_code    on public.suppliers            (default_account_code);
create index if not exists idx_wa_messages_customer_id           on public.wa_messages          (customer_id);
create index if not exists idx_wa_messages_professional_id       on public.wa_messages          (professional_id);
create index if not exists idx_wa_messages_quote_id              on public.wa_messages          (quote_id);

notify pgrst, 'reload schema';
