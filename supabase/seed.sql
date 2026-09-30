-- =============================================================================
-- DEVELOPMENT SEED DATA — for `supabase start` / `supabase db reset` only.
-- NOT production data. Production data comes from the Excel import:
--   python python/scripts/import_excel.py   (see docs/data-import.md)
-- Every seeded name starts with "DEV" so it cannot be mistaken for real stock.
-- =============================================================================

insert into public.authorized_users (email, display_name, role, is_active) values
  ('dev-user@example.com', 'DEV normal user', 'user', true)
on conflict do nothing;

insert into public.product_categories (name, description) values
  ('DEV Car Tyre', 'Development category'),
  ('DEV Car Battery Charge', 'Development category');

insert into public.partner_rules (category_id, rule_type, partner_b_rate, partner_a_rate, partner_a_rate_is_leftover, notes, effective_from)
select id, 'Fixed_Per_Unit', 10, null, true, 'DEV rule: RM10 per unit to Partner B', date '2025-01-01'
from public.product_categories where name = 'DEV Car Tyre';

insert into public.partner_rules (category_id, rule_type, partner_b_rate, partner_a_rate, partner_a_rate_is_leftover, notes, effective_from)
select id, 'Shared_50', 0.5, 0.5, false, 'DEV rule: 50/50', date '2025-01-01'
from public.product_categories where name = 'DEV Car Battery Charge';

insert into public.products (item_code, description, brand, category_id, unit, is_non_stock)
select 'DEV-TYRE-001', 'DEV Car Tyre 175/65R14', 'DEV Brand', id, 'pcs', false
from public.product_categories where name = 'DEV Car Tyre';

insert into public.products (item_code, description, category_id, unit, is_non_stock)
select 'DEV-CHARGE', 'DEV Battery charging (service)', id, 'pcs', true
from public.product_categories where name = 'DEV Car Battery Charge';

insert into public.stock_items (product_id, purchased_date, unit_cost, agreed_price, quantity, min_quantity)
select id, date '2026-09-01', 110.00, 170.00, 3, 2 from public.products where item_code = 'DEV-TYRE-001';

insert into public.stock_items (product_id, purchased_date, unit_cost, agreed_price, quantity)
select id, date '2026-09-01', 0, 8.00, 0 from public.products where item_code = 'DEV-CHARGE';

insert into public.stock_adjustments (stock_item_id, adjustment_type, previous_quantity, new_quantity, reason, created_by_label)
select s.id, 'initial', 0, s.quantity, 'DEV seed', 'seed.sql'
from public.stock_items s join public.products p on p.id = s.product_id where p.item_code like 'DEV-%';

insert into public.inventory_items (name, brand, category, quantity) values
  ('DEV Tyre Changer Machine', 'DEV', 'Machinery', 1);

insert into public.expense_categories (name, description, default_partner_id, default_amount, default_share_ratio, is_recurring, sort_order)
select 'DEV Employee Salary', 'DEV recurring wages', id, -100, null, true, 1 from public.partners where code = 'A';
insert into public.expense_categories (name, description, default_partner_id, default_amount, default_share_ratio, is_recurring, sort_order)
select 'DEV Electricity', 'DEV 60% of the bill', id, null, 0.6, false, 2 from public.partners where code = 'A';
