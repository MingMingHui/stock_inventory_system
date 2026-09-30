-- =============================================================================
-- 007 Indexes for foreign keys flagged by the Supabase performance advisor
-- =============================================================================

create index if not exists expense_categories_default_partner_idx on public.expense_categories (default_partner_id);
create index if not exists operating_expenses_category_idx on public.operating_expenses (expense_category_id);
create index if not exists operating_expenses_partner_idx on public.operating_expenses (partner_id);
create index if not exists stock_adjustments_sale_item_idx on public.stock_adjustments (sale_item_id);
