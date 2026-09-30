-- =============================================================================
-- 003 Sales: sales, sale lines, the central calculation, create / preview / void
-- =============================================================================

create table public.sales (
  id                uuid primary key default gen_random_uuid(),
  sale_date         date not null,
  source            public.sale_source not null default 'app',
  notes             text check (char_length(notes) <= 1000),
  legacy_ref        text unique,
  is_void           boolean not null default false,
  voided_at         timestamptz,
  voided_by         uuid,
  void_reason       text check (char_length(void_reason) <= 500),
  created_at        timestamptz not null default now(),
  created_by        uuid,
  created_by_label  text not null,
  check (is_void = (voided_at is not null)),
  check (not is_void or char_length(btrim(void_reason)) > 0)
);

create index sales_sale_date_idx on public.sales (sale_date desc);
create index sales_created_by_idx on public.sales (created_by);

-- Every calculated value is stored with the inputs, rule and rates that produced
-- it, so any figure can be traced back ("where did this number come from?").
create table public.sale_items (
  id                          uuid primary key default gen_random_uuid(),
  sale_id                     uuid not null references public.sales (id) on delete restrict,
  line_no                     smallint not null check (line_no > 0),
  stock_item_id               uuid references public.stock_items (id) on delete restrict,
  product_id                  uuid not null references public.products (id) on delete restrict,
  category_id                 uuid not null references public.product_categories (id) on delete restrict,
  quantity                    integer not null check (quantity > 0),
  stock_before                integer,
  stock_after                 integer,
  agreed_price                numeric(12, 2) not null check (agreed_price >= 0),
  actual_price                numeric(12, 2) not null check (actual_price >= 0),
  unit_cost                   numeric(12, 2) not null check (unit_cost >= 0),
  revenue                     numeric(12, 2) not null,
  total_cost                  numeric(12, 2) not null,
  gross_profit                numeric(12, 2) not null,
  partner_rule_id             uuid references public.partner_rules (id) on delete restrict,
  rule_type                   public.rule_type not null,
  partner_a_rate              numeric(12, 4),
  partner_a_rate_is_leftover  boolean not null,
  partner_b_rate              numeric(12, 4) not null,
  partner_a_share             numeric(12, 2) not null,
  partner_b_share             numeric(12, 2) not null,
  price_drop_ratio            numeric(9, 4),
  price_alert                 boolean not null default false,
  price_alert_threshold       numeric(6, 4) not null,
  calc_version                smallint not null default 1,
  legacy_ref                  text unique,
  created_at                  timestamptz not null default now(),
  unique (sale_id, line_no),
  check (revenue = round(actual_price * quantity, 2)),
  check (total_cost = round(unit_cost * quantity, 2)),
  check (gross_profit = revenue - total_cost),
  check (partner_a_share + partner_b_share = revenue)
);

create index sale_items_sale_idx on public.sale_items (sale_id);
create index sale_items_stock_item_idx on public.sale_items (stock_item_id);
create index sale_items_product_idx on public.sale_items (product_id);
create index sale_items_category_idx on public.sale_items (category_id);
create index sale_items_rule_idx on public.sale_items (partner_rule_id);
create index sale_items_price_alert_idx on public.sale_items (price_alert) where price_alert;

alter table public.stock_adjustments
  add constraint stock_adjustments_sale_item_fk
  foreign key (sale_item_id) references public.sale_items (id) on delete restrict;

create trigger sales_audit after insert or update or delete on public.sales
  for each row execute function private.audit_row();
create trigger sale_items_audit after insert or update or delete on public.sale_items
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Central calculation — reproduces the Excel Sales_Log formulas (see docs/business-rules.md)
--
--   Revenue_Per_Sales = Actual_Selling_Price * Quantity_Sold
--   Cost_Per_Sale     = Cost (RM) * Quantity_Sold
--   Gross_Profit      = Revenue_Per_Sales - Cost_Per_Sale
--   A.L_Share (B)     = IF(Actual<=0, 0,
--                         Fixed_Per_Unit|Fixed_Per_Job|Fixed_Per_Service -> A.L_Rate * Qty,
--                         Shared_50 -> Revenue * 0.5)
--   KALI_Share (A)    = IF(Qty=0, 0, Shared_50 -> Revenue * 0.5, else Revenue - A.L_Share)
--
-- Partner shares split REVENUE (not gross profit), exactly as the workbook does.
-- For Shared_50 the B share is rounded to cents and A receives the remainder so
-- that A + B always equals revenue.
-- -----------------------------------------------------------------------------
create function public.calculate_sale_line(
  p_rule_type public.rule_type,
  p_partner_b_rate numeric,
  p_quantity integer,
  p_actual_price numeric,
  p_unit_cost numeric
)
returns table (
  revenue numeric,
  total_cost numeric,
  gross_profit numeric,
  partner_a_share numeric,
  partner_b_share numeric
)
language sql
immutable
set search_path = ''
as $$
  with base as (
    select round(p_actual_price * p_quantity, 2) as revenue,
           round(p_unit_cost * p_quantity, 2) as total_cost
  ),
  shares as (
    select base.*,
           case
             when p_actual_price <= 0 then 0::numeric
             when p_rule_type in ('Fixed_Per_Unit', 'Fixed_Per_Job', 'Fixed_Per_Service')
               then round(p_partner_b_rate * p_quantity, 2)
             when p_rule_type = 'Shared_50' then round(base.revenue * 0.5, 2)
             else 0::numeric
           end as b_share
    from base
  )
  select revenue,
         total_cost,
         revenue - total_cost,
         case when p_quantity = 0 then 0::numeric else revenue - b_share end,
         case when p_quantity = 0 then 0::numeric else b_share end
  from shares
$$;

-- Price-drop alert: actual <= agreed * (1 - threshold).
create function public.price_drop_check(p_agreed_price numeric, p_actual_price numeric, p_threshold numeric)
returns table (drop_ratio numeric, is_alert boolean)
language sql
immutable
set search_path = ''
as $$
  select
    case when p_agreed_price > 0 then round((p_agreed_price - p_actual_price) / p_agreed_price, 4) end,
    coalesce(p_agreed_price > 0 and p_actual_price <= p_agreed_price * (1 - p_threshold), false)
$$;

-- Months that have a finalized settlement may not receive new or voided sales.
create function private.assert_period_open(p_date date)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if to_regclass('public.monthly_settlements') is not null and exists (
    select 1 from public.monthly_settlements
    where period_month = date_trunc('month', p_date)::date
  ) then
    raise exception 'The settlement for % is finalized. Reopen it before changing its sales or expenses.',
      to_char(p_date, 'Mon YYYY') using errcode = '55000';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Preview (no writes) — used by the UI so rules are never re-implemented client side
-- -----------------------------------------------------------------------------
create function public.preview_sale_line(
  p_stock_item_id uuid,
  p_quantity integer,
  p_actual_price numeric,
  p_sale_date date default current_date
)
returns table (
  stock_item_id uuid,
  category_name text,
  stock_before integer,
  stock_after integer,
  is_non_stock boolean,
  agreed_price numeric,
  actual_price numeric,
  unit_cost numeric,
  quantity integer,
  revenue numeric,
  total_cost numeric,
  gross_profit numeric,
  rule_type public.rule_type,
  partner_a_rate numeric,
  partner_a_rate_is_leftover boolean,
  partner_b_rate numeric,
  partner_a_share numeric,
  partner_b_share numeric,
  price_drop_ratio numeric,
  price_alert boolean,
  price_alert_threshold numeric,
  insufficient_stock boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item public.stock_items;
  v_product public.products;
  v_rule public.partner_rules;
  v_threshold numeric := private.setting_numeric('price_drop_alert_threshold');
begin
  perform private.require_authorized();
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero' using errcode = '22023';
  end if;
  if p_actual_price is null or p_actual_price < 0 then
    raise exception 'Actual price must be zero or more' using errcode = '22023';
  end if;

  select * into v_item from public.stock_items where id = p_stock_item_id;
  if not found then
    raise exception 'Stock item not found' using errcode = 'P0002';
  end if;
  select * into v_product from public.products where id = v_item.product_id;
  v_rule := private.rule_for(v_product.category_id, p_sale_date);
  if v_rule.id is null then
    raise exception 'No active partner rule for this product category on %', p_sale_date using errcode = 'P0002';
  end if;

  return query
  select
    v_item.id,
    (select c.name from public.product_categories c where c.id = v_product.category_id),
    case when v_product.is_non_stock then null else v_item.quantity end,
    case when v_product.is_non_stock then null else v_item.quantity - p_quantity end,
    v_product.is_non_stock,
    v_item.agreed_price,
    round(p_actual_price, 2),
    v_item.unit_cost,
    p_quantity,
    calc.revenue, calc.total_cost, calc.gross_profit,
    v_rule.rule_type, v_rule.partner_a_rate, v_rule.partner_a_rate_is_leftover, v_rule.partner_b_rate,
    calc.partner_a_share, calc.partner_b_share,
    pd.drop_ratio, pd.is_alert, v_threshold,
    (not v_product.is_non_stock and v_item.quantity < p_quantity)
  from public.calculate_sale_line(v_rule.rule_type, v_rule.partner_b_rate, p_quantity,
                                  round(p_actual_price, 2), v_item.unit_cost) calc
  cross join public.price_drop_check(v_item.agreed_price, round(p_actual_price, 2), v_threshold) pd;
end;
$$;

-- -----------------------------------------------------------------------------
-- create_sale: validates, calculates, records the sale, decrements stock and
-- writes stock history — all in one transaction with row locks.
-- p_items: [{"stock_item_id": uuid, "quantity": int, "actual_price": number}, ...]
-- Agreed price, cost and partner rates are always read from the database.
-- -----------------------------------------------------------------------------
create function public.create_sale(p_sale_date date, p_items jsonb, p_notes text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale_id uuid;
  v_line record;
  v_item public.stock_items;
  v_product public.products;
  v_rule public.partner_rules;
  v_calc record;
  v_pd record;
  v_threshold numeric := private.setting_numeric('price_drop_alert_threshold');
  v_allow_negative boolean := coalesce(private.setting_boolean('allow_negative_stock'), false);
  v_sale_item_id uuid;
  v_line_no smallint := 0;
  v_new_qty integer;
begin
  perform private.require_authorized();

  if p_sale_date is null or p_sale_date > current_date then
    raise exception 'Sale date is required and cannot be in the future' using errcode = '22023';
  end if;
  perform private.assert_period_open(p_sale_date);

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'A sale needs between 1 and 50 lines' using errcode = '22023';
  end if;

  -- Lock all affected stock rows in a consistent order to avoid deadlocks.
  perform 1
  from public.stock_items s
  where s.id in (select (e ->> 'stock_item_id')::uuid from jsonb_array_elements(p_items) e)
  order by s.id
  for update;

  insert into public.sales (sale_date, source, notes, created_by, created_by_label)
  values (p_sale_date, 'app', nullif(btrim(coalesce(p_notes, '')), ''), auth.uid(), private.actor_label())
  returning id into v_sale_id;

  for v_line in
    select * from jsonb_to_recordset(p_items) as x(stock_item_id uuid, quantity integer, actual_price numeric)
  loop
    v_line_no := v_line_no + 1;

    if v_line.stock_item_id is null or v_line.quantity is null or v_line.quantity <= 0 then
      raise exception 'Line %: quantity must be greater than zero', v_line_no using errcode = '22023';
    end if;
    if v_line.actual_price is null or v_line.actual_price < 0 or v_line.actual_price > 1000000 then
      raise exception 'Line %: actual price is invalid', v_line_no using errcode = '22023';
    end if;

    select * into v_item from public.stock_items where id = v_line.stock_item_id;
    if not found then
      raise exception 'Line %: stock item not found', v_line_no using errcode = 'P0002';
    end if;
    if v_item.is_obsolete then
      raise exception 'Line %: stock item is obsolete and cannot be sold', v_line_no using errcode = '22023';
    end if;
    select * into v_product from public.products where id = v_item.product_id;

    v_rule := private.rule_for(v_product.category_id, p_sale_date);
    if v_rule.id is null then
      raise exception 'Line %: no active partner rule for this product category on %', v_line_no, p_sale_date
        using errcode = 'P0002';
    end if;

    if not v_product.is_non_stock and not v_allow_negative and v_item.quantity < v_line.quantity then
      raise exception 'Line %: only % in stock', v_line_no, v_item.quantity using errcode = '23514';
    end if;

    select * into v_calc from public.calculate_sale_line(
      v_rule.rule_type, v_rule.partner_b_rate, v_line.quantity, round(v_line.actual_price, 2), v_item.unit_cost);
    select * into v_pd from public.price_drop_check(v_item.agreed_price, round(v_line.actual_price, 2), v_threshold);

    v_new_qty := case when v_product.is_non_stock then v_item.quantity else v_item.quantity - v_line.quantity end;

    insert into public.sale_items (
      sale_id, line_no, stock_item_id, product_id, category_id, quantity,
      stock_before, stock_after, agreed_price, actual_price, unit_cost,
      revenue, total_cost, gross_profit,
      partner_rule_id, rule_type, partner_a_rate, partner_a_rate_is_leftover, partner_b_rate,
      partner_a_share, partner_b_share, price_drop_ratio, price_alert, price_alert_threshold
    ) values (
      v_sale_id, v_line_no, v_item.id, v_product.id, v_product.category_id, v_line.quantity,
      case when v_product.is_non_stock then null else v_item.quantity end,
      case when v_product.is_non_stock then null else v_new_qty end,
      v_item.agreed_price, round(v_line.actual_price, 2), v_item.unit_cost,
      v_calc.revenue, v_calc.total_cost, v_calc.gross_profit,
      v_rule.id, v_rule.rule_type, v_rule.partner_a_rate, v_rule.partner_a_rate_is_leftover, v_rule.partner_b_rate,
      v_calc.partner_a_share, v_calc.partner_b_share, v_pd.drop_ratio, v_pd.is_alert, v_threshold
    ) returning id into v_sale_item_id;

    if not v_product.is_non_stock then
      update public.stock_items set quantity = v_new_qty where id = v_item.id;
      perform private.record_adjustment(v_item.id, 'sale', v_item.quantity, v_new_qty,
                                        'Sale ' || v_sale_id::text, v_sale_item_id);
    end if;
  end loop;

  return v_sale_id;
end;
$$;

-- Admin only. Sales are never edited or deleted; a wrong sale is voided (stock is
-- restored for app-entered sales) and re-entered.
create function public.void_sale(p_sale_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale public.sales;
  v_line record;
  v_qty integer;
begin
  perform private.require_admin();
  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required' using errcode = '22023';
  end if;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found' using errcode = 'P0002';
  end if;
  if v_sale.is_void then
    raise exception 'Sale is already void' using errcode = '22023';
  end if;
  perform private.assert_period_open(v_sale.sale_date);

  if v_sale.source = 'app' then
    for v_line in
      select si.id, si.stock_item_id, si.quantity
      from public.sale_items si
      join public.products p on p.id = si.product_id
      where si.sale_id = p_sale_id and si.stock_item_id is not null and not p.is_non_stock
      order by si.stock_item_id
    loop
      select quantity into v_qty from public.stock_items where id = v_line.stock_item_id for update;
      update public.stock_items set quantity = v_qty + v_line.quantity where id = v_line.stock_item_id;
      perform private.record_adjustment(v_line.stock_item_id, 'sale_void', v_qty, v_qty + v_line.quantity,
                                        'Void of sale ' || p_sale_id::text || ': ' || btrim(p_reason), v_line.id);
    end loop;
  end if;

  update public.sales
  set is_void = true, voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
  where id = p_sale_id;
end;
$$;

-- Flat, filterable sales log (one row per sale line).
create view public.sales_log_view
with (security_invoker = true)
as
select
  si.id,
  si.sale_id,
  s.sale_date,
  s.source,
  s.is_void,
  s.created_by_label as seller,
  s.notes,
  si.line_no,
  si.stock_item_id,
  si.product_id,
  p.item_code,
  p.description,
  p.brand,
  si.category_id,
  c.name as category_name,
  si.stock_before,
  si.quantity,
  si.stock_after,
  si.agreed_price,
  si.actual_price,
  si.unit_cost,
  si.revenue,
  si.total_cost,
  si.gross_profit,
  si.rule_type,
  si.partner_a_rate,
  si.partner_a_rate_is_leftover,
  si.partner_b_rate,
  si.partner_a_share,
  si.partner_b_share,
  si.price_drop_ratio,
  si.price_alert,
  si.legacy_ref,
  si.created_at
from public.sale_items si
join public.sales s on s.id = si.sale_id
join public.products p on p.id = si.product_id
join public.product_categories c on c.id = si.category_id;
