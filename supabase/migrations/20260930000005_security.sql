-- =============================================================================
-- 005 Security: Row Level Security, least-privilege grants
-- =============================================================================
-- Principles
--  * anon (not logged in) gets nothing.
--  * authenticated gets data only when its verified email is on the active
--    allow-list (private.is_authorized()).
--  * Quantities, sales and settlements can only change through SECURITY DEFINER
--    functions that validate input and write history. There are no direct
--    INSERT/UPDATE grants on those columns.
--  * Admin-only writes are enforced by RLS policies AND column-level grants.
--  * (select private.fn()) wrappers let Postgres evaluate the check once per query.

-- -----------------------------------------------------------------------------
-- Start from zero
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon;

grant usage on schema public to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- -----------------------------------------------------------------------------
-- Enable RLS everywhere
-- -----------------------------------------------------------------------------
alter table public.authorized_users   enable row level security;
alter table public.app_settings       enable row level security;
alter table public.audit_logs         enable row level security;
alter table public.partners           enable row level security;
alter table public.product_categories enable row level security;
alter table public.partner_rules      enable row level security;
alter table public.products           enable row level security;
alter table public.stock_items        enable row level security;
alter table public.stock_adjustments  enable row level security;
alter table public.stock_snapshots    enable row level security;
alter table public.inventory_items    enable row level security;
alter table public.sales              enable row level security;
alter table public.sale_items         enable row level security;
alter table public.expense_categories enable row level security;
alter table public.operating_expenses enable row level security;
alter table public.monthly_settlements enable row level security;

-- -----------------------------------------------------------------------------
-- Read access: every authorized user can read business data
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'app_settings', 'partners', 'product_categories', 'partner_rules', 'products',
    'stock_items', 'stock_adjustments', 'stock_snapshots', 'inventory_items',
    'sales', 'sale_items', 'expense_categories', 'operating_expenses', 'monthly_settlements'
  ] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select private.is_authorized()))',
      t || '_select_authorized', t);
  end loop;
end;
$$;

grant select on public.stock_items_view, public.sales_log_view to authenticated;

-- -----------------------------------------------------------------------------
-- Admin-only tables and writes
-- -----------------------------------------------------------------------------

-- authorized_users: admins manage; nobody else can read the list.
grant select, delete on public.authorized_users to authenticated;
grant insert (email, display_name, role, is_active) on public.authorized_users to authenticated;
grant update (email, display_name, role, is_active) on public.authorized_users to authenticated;
create policy authorized_users_admin_select on public.authorized_users
  for select to authenticated using ((select private.is_admin()));
create policy authorized_users_admin_insert on public.authorized_users
  for insert to authenticated with check ((select private.is_admin()));
create policy authorized_users_admin_update on public.authorized_users
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy authorized_users_admin_delete on public.authorized_users
  for delete to authenticated using ((select private.is_admin()));

-- audit_logs: admins read; nobody writes directly (triggers only).
grant select on public.audit_logs to authenticated;
create policy audit_logs_admin_select on public.audit_logs
  for select to authenticated using ((select private.is_admin()));

-- app_settings: admins change values.
grant update (value, description) on public.app_settings to authenticated;
create policy app_settings_admin_update on public.app_settings
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

-- partners: admins rename.
grant update (name, short_code, description) on public.partners to authenticated;
create policy partners_admin_update on public.partners
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

-- product_categories
grant insert (name, description), update (name, description), delete on public.product_categories to authenticated;
create policy product_categories_admin_insert on public.product_categories
  for insert to authenticated with check ((select private.is_admin()));
create policy product_categories_admin_update on public.product_categories
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy product_categories_admin_delete on public.product_categories
  for delete to authenticated using ((select private.is_admin()));

-- partner_rules
grant insert (category_id, rule_type, partner_b_rate, partner_a_rate, partner_a_rate_is_leftover,
              notes, effective_from, effective_to, is_active),
      update (category_id, rule_type, partner_b_rate, partner_a_rate, partner_a_rate_is_leftover,
              notes, effective_from, effective_to, is_active),
      delete
  on public.partner_rules to authenticated;
create policy partner_rules_admin_insert on public.partner_rules
  for insert to authenticated with check ((select private.is_admin()));
create policy partner_rules_admin_update on public.partner_rules
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy partner_rules_admin_delete on public.partner_rules
  for delete to authenticated using ((select private.is_admin()));

-- products: admins edit master data (users create products via add_stock_item()).
grant update (item_code, description, brand, category_id, unit, is_non_stock) on public.products to authenticated;
create policy products_admin_update on public.products
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

-- stock_items: admins edit price/cost/date/notes. Quantity is NOT granted to
-- anyone — it only changes via adjust_stock() / create_sale() / void_sale().
grant update (purchased_date, unit_cost, agreed_price, notes) on public.stock_items to authenticated;
create policy stock_items_admin_update on public.stock_items
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

-- inventory_items (KALI inventory list): admins only.
grant insert (name, brand, category, quantity, status, notes),
      update (name, brand, category, quantity, status, notes),
      delete
  on public.inventory_items to authenticated;
create policy inventory_items_admin_insert on public.inventory_items
  for insert to authenticated with check ((select private.is_admin()));
create policy inventory_items_admin_update on public.inventory_items
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy inventory_items_admin_delete on public.inventory_items
  for delete to authenticated using ((select private.is_admin()));

-- expense_categories
grant insert (name, description, default_partner_id, default_amount, default_share_ratio, is_recurring, is_active, sort_order),
      update (name, description, default_partner_id, default_amount, default_share_ratio, is_recurring, is_active, sort_order),
      delete
  on public.expense_categories to authenticated;
create policy expense_categories_admin_insert on public.expense_categories
  for insert to authenticated with check ((select private.is_admin()));
create policy expense_categories_admin_update on public.expense_categories
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy expense_categories_admin_delete on public.expense_categories
  for delete to authenticated using ((select private.is_admin()));

-- operating_expenses
grant insert (period_month, expense_category_id, partner_id, base_amount, share_ratio, amount, description),
      update (period_month, expense_category_id, partner_id, base_amount, share_ratio, amount, description),
      delete
  on public.operating_expenses to authenticated;
create policy operating_expenses_admin_insert on public.operating_expenses
  for insert to authenticated with check ((select private.is_admin()));
create policy operating_expenses_admin_update on public.operating_expenses
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy operating_expenses_admin_delete on public.operating_expenses
  for delete to authenticated using ((select private.is_admin()));

-- sales, sale_items, stock_adjustments, stock_snapshots, monthly_settlements:
-- read-only for clients (select policy above); writes only via functions.

-- -----------------------------------------------------------------------------
-- Callable functions (each checks authorization internally)
-- -----------------------------------------------------------------------------
grant execute on function
  public.get_my_access(),
  public.add_stock_item(uuid, text, text, text, text, boolean, date, numeric, numeric, integer, integer, text),
  public.adjust_stock(uuid, public.stock_adjustment_type, integer, text, integer),
  public.set_stock_min_quantity(uuid, integer),
  public.set_stock_obsolete(uuid, boolean),
  public.calculate_sale_line(public.rule_type, numeric, integer, numeric, numeric),
  public.price_drop_check(numeric, numeric, numeric),
  public.preview_sale_line(uuid, integer, numeric, date),
  public.create_sale(date, jsonb, text),
  public.void_sale(uuid, text),
  public.partner_summary_by_category(date, date, uuid, uuid),
  public.settlement_summary(date, date),
  public.dashboard_stats(date, date),
  public.apply_recurring_expenses(date),
  public.finalize_settlement(date, text),
  public.reopen_settlement(date, text)
to authenticated;
