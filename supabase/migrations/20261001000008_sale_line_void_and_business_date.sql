-- =============================================================================
-- 008 Line-level void + Malaysian business date
-- =============================================================================
-- 1. Every sale line can be voided on its own (void_sale_item). Previously only a
--    whole sale header could be voided, so a multi-line ("bulk") sale showed one
--    Void button that voided every line. See docs/enhancement-analysis.md §6.
-- 2. "Today" for business rules is the Malaysian calendar date. The database runs
--    in UTC, so current_date was yesterday between 00:00 and 07:59 MYT.
-- Calculations (calculate_sale_line, price_drop_check) are NOT changed.

-- -----------------------------------------------------------------------------
-- Business date
-- -----------------------------------------------------------------------------
create function private.business_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Kuala_Lumpur')::date
$$;

grant execute on function private.business_today() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Line-level void columns
-- -----------------------------------------------------------------------------
alter table public.sale_items
  add column is_void boolean not null default false,
  add column voided_at timestamptz,
  add column voided_by uuid,
  add column voided_by_label text,
  add column void_reason text check (char_length(void_reason) <= 500),
  add constraint sale_items_void_consistency check (is_void = (voided_at is not null)),
  add constraint sale_items_void_reason_required check (not is_void or char_length(btrim(void_reason)) > 0);

-- Lines of sales that were already voided as a whole become void lines too.
update public.sale_items si
set is_void = true,
    voided_at = s.voided_at,
    voided_by = s.voided_by,
    voided_by_label = 'whole sale void',
    void_reason = s.void_reason
from public.sales s
where s.id = si.sale_id and s.is_void and not si.is_void;

create index sale_items_active_sale_idx on public.sale_items (sale_id) where not is_void;

-- -----------------------------------------------------------------------------
-- Shared helper: give a voided line's quantity back to its stock batch
-- -----------------------------------------------------------------------------
create function private.restore_line_stock(p_sale_item_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
  v_qty integer;
begin
  select si.id, si.stock_item_id, si.quantity, s.source, p.is_non_stock
  into v_line
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  join public.products p on p.id = si.product_id
  where si.id = p_sale_item_id;

  -- Imported Excel sales never reduced Stock_Master quantities, so nothing to return.
  if v_line.source <> 'app' or v_line.stock_item_id is null or v_line.is_non_stock then
    return;
  end if;

  select quantity into v_qty from public.stock_items where id = v_line.stock_item_id for update;
  update public.stock_items set quantity = v_qty + v_line.quantity where id = v_line.stock_item_id;
  perform private.record_adjustment(v_line.stock_item_id, 'sale_void', v_qty, v_qty + v_line.quantity,
                                    p_reason, v_line.id);
end;
$$;

-- -----------------------------------------------------------------------------
-- void_sale_item: void ONE line (admin). Transactional and idempotent-safe:
-- the line row is locked, so a double click cannot restore stock twice.
-- -----------------------------------------------------------------------------
create function public.void_sale_item(p_sale_item_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
begin
  perform private.require_admin();
  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required' using errcode = '22023';
  end if;

  select si.id, si.sale_id, si.is_void, s.is_void as sale_is_void, s.sale_date
  into v_line
  from public.sale_items si
  join public.sales s on s.id = si.sale_id
  where si.id = p_sale_item_id
  for update of si;
  if not found then
    raise exception 'Sale line not found' using errcode = 'P0002';
  end if;
  if v_line.is_void or v_line.sale_is_void then
    raise exception 'This sale line is already void' using errcode = '22023';
  end if;
  perform private.assert_period_open(v_line.sale_date);

  perform private.restore_line_stock(
    p_sale_item_id,
    'Void of sale line ' || p_sale_item_id::text || ' (sale ' || v_line.sale_id::text || '): ' || btrim(p_reason));

  update public.sale_items
  set is_void = true,
      voided_at = now(),
      voided_by = auth.uid(),
      voided_by_label = private.actor_label(),
      void_reason = btrim(p_reason)
  where id = p_sale_item_id;
end;
$$;

-- Whole-sale void keeps working; lines voided earlier are not restored twice.
create or replace function public.void_sale(p_sale_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale public.sales;
  v_line record;
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

  for v_line in
    select si.id
    from public.sale_items si
    where si.sale_id = p_sale_id and not si.is_void
    order by si.stock_item_id, si.id
    for update of si
  loop
    perform private.restore_line_stock(
      v_line.id, 'Void of sale ' || p_sale_id::text || ': ' || btrim(p_reason));
  end loop;

  update public.sale_items
  set is_void = true, voided_at = now(), voided_by = auth.uid(),
      voided_by_label = private.actor_label(), void_reason = btrim(p_reason)
  where sale_id = p_sale_id and not is_void;

  update public.sales
  set is_void = true, voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
  where id = p_sale_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Sales log view: a line is void when the line or its whole sale is void.
-- Existing columns keep their names, types and order; new columns are appended.
-- -----------------------------------------------------------------------------
create or replace view public.sales_log_view
with (security_invoker = true)
as
select
  si.id,
  si.sale_id,
  s.sale_date,
  s.source,
  (s.is_void or si.is_void) as is_void,
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
  si.created_at,
  coalesce(si.void_reason, s.void_reason) as void_reason,
  coalesce(si.voided_at, s.voided_at) as voided_at,
  si.voided_by_label
from public.sale_items si
join public.sales s on s.id = si.sale_id
join public.products p on p.id = si.product_id
join public.product_categories c on c.id = si.category_id;

-- -----------------------------------------------------------------------------
-- Reports exclude voided lines (bodies otherwise unchanged)
-- -----------------------------------------------------------------------------
create or replace function public.partner_summary_by_category(
  p_from date,
  p_to date,
  p_category_id uuid default null,
  p_product_id uuid default null
)
returns table (
  category_id uuid,
  category_name text,
  line_count bigint,
  quantity bigint,
  revenue numeric,
  total_cost numeric,
  gross_profit numeric,
  partner_a_share numeric,
  partner_b_share numeric
)
language sql
stable
set search_path = ''
as $$
  select c.id, c.name,
         count(*),
         sum(si.quantity),
         sum(si.revenue),
         sum(si.total_cost),
         sum(si.gross_profit),
         sum(si.partner_a_share),
         sum(si.partner_b_share)
  from public.sale_items si
  join public.sales s on s.id = si.sale_id and not s.is_void
  join public.product_categories c on c.id = si.category_id
  where s.sale_date between p_from and p_to
    and not si.is_void
    and (p_category_id is null or si.category_id = p_category_id)
    and (p_product_id is null or si.product_id = p_product_id)
  group by c.id, c.name
  order by c.name
$$;

create or replace function public.settlement_summary(p_from date, p_to date)
returns table (
  period_month date,
  sale_line_count bigint,
  total_revenue numeric,
  total_cost numeric,
  gross_profit numeric,
  partner_a_share numeric,
  partner_b_share numeric,
  partner_a_adjustments numeric,
  partner_b_adjustments numeric,
  partner_a_payable numeric,
  partner_b_payable numeric,
  is_finalized boolean
)
language sql
stable
set search_path = ''
as $$
  with months as (
    select generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month')::date as m
  ),
  sales as (
    select date_trunc('month', s.sale_date)::date as m,
           count(*) as n,
           sum(si.revenue) as revenue,
           sum(si.total_cost) as cost,
           sum(si.gross_profit) as gp,
           sum(si.partner_a_share) as a_share,
           sum(si.partner_b_share) as b_share
    from public.sale_items si
    join public.sales s on s.id = si.sale_id and not s.is_void
    where s.sale_date >= date_trunc('month', p_from)
      and s.sale_date < date_trunc('month', p_to) + interval '1 month'
      and not si.is_void
    group by 1
  ),
  adj as (
    select e.period_month as m,
           sum(e.amount) filter (where pa.code = 'A') as a_adj,
           sum(e.amount) filter (where pa.code = 'B') as b_adj
    from public.operating_expenses e
    join public.partners pa on pa.id = e.partner_id
    where e.period_month between date_trunc('month', p_from)::date and date_trunc('month', p_to)::date
    group by 1
  )
  select months.m,
         coalesce(sales.n, 0),
         coalesce(sales.revenue, 0),
         coalesce(sales.cost, 0),
         coalesce(sales.gp, 0),
         coalesce(sales.a_share, 0),
         coalesce(sales.b_share, 0),
         coalesce(adj.a_adj, 0),
         coalesce(adj.b_adj, 0),
         coalesce(sales.a_share, 0) + coalesce(adj.a_adj, 0),
         coalesce(sales.b_share, 0) + coalesce(adj.b_adj, 0),
         exists (select 1 from public.monthly_settlements ms where ms.period_month = months.m)
  from months
  left join sales on sales.m = months.m
  left join adj on adj.m = months.m
  order by months.m
$$;

create or replace function public.dashboard_stats(p_from date, p_to date)
returns table (
  sale_line_count bigint,
  total_quantity bigint,
  total_revenue numeric,
  gross_profit numeric,
  partner_a_share numeric,
  partner_b_share numeric,
  price_alert_count bigint,
  low_stock_count bigint,
  out_of_stock_count bigint,
  obsolete_count bigint
)
language sql
stable
set search_path = ''
as $$
  with s as (
    select count(*) as n,
           coalesce(sum(si.quantity), 0) as qty,
           coalesce(sum(si.revenue), 0) as revenue,
           coalesce(sum(si.gross_profit), 0) as gp,
           coalesce(sum(si.partner_a_share), 0) as a_share,
           coalesce(sum(si.partner_b_share), 0) as b_share,
           count(*) filter (where si.price_alert) as alerts
    from public.sale_items si
    join public.sales sa on sa.id = si.sale_id and not sa.is_void
    where sa.sale_date between p_from and p_to
      and not si.is_void
  ),
  st as (
    select count(*) filter (where status = 'LOW_STOCK') as low,
           count(*) filter (where status = 'OUT_OF_STOCK') as out_of_stock,
           count(*) filter (where status = 'OBSOLETE') as obsolete
    from public.stock_items_view
  )
  select s.n, s.qty, s.revenue, s.gp, s.a_share, s.b_share, s.alerts, st.low, st.out_of_stock, st.obsolete
  from s cross join st
$$;

-- -----------------------------------------------------------------------------
-- Business date in the existing write functions (only the date checks change)
-- -----------------------------------------------------------------------------
create or replace function public.create_sale(p_sale_date date, p_items jsonb, p_notes text default null)
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

  if p_sale_date is null or p_sale_date > private.business_today() then
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

create or replace function public.add_stock_item(
  p_category_id uuid,
  p_item_code text,
  p_description text,
  p_brand text,
  p_unit text,
  p_is_non_stock boolean,
  p_purchased_date date,
  p_unit_cost numeric,
  p_agreed_price numeric,
  p_quantity integer,
  p_min_quantity integer default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product_id uuid;
  v_stock_id uuid;
  v_code text := upper(btrim(p_item_code));
  v_desc text := regexp_replace(btrim(p_description), '\s+', ' ', 'g');
  v_brand text := nullif(regexp_replace(btrim(coalesce(p_brand, '')), '\s+', ' ', 'g'), '');
begin
  perform private.require_authorized();

  if p_quantity is null or p_quantity < 0 then
    raise exception 'Quantity must be zero or more' using errcode = '22023';
  end if;
  if p_unit_cost is null or p_unit_cost < 0 or p_agreed_price is null or p_agreed_price < 0 then
    raise exception 'Cost and agreed price must be zero or more' using errcode = '22023';
  end if;
  if p_purchased_date is not null and p_purchased_date > private.business_today() then
    raise exception 'Purchased date cannot be in the future' using errcode = '22023';
  end if;

  select id into v_product_id
  from public.products
  where item_code = v_code
    and lower(description) = lower(v_desc)
    and coalesce(lower(brand), '') = coalesce(lower(v_brand), '')
    and category_id = p_category_id;

  if v_product_id is null then
    insert into public.products (item_code, description, brand, category_id, unit, is_non_stock)
    values (v_code, v_desc, v_brand, p_category_id, nullif(btrim(coalesce(p_unit, '')), ''), coalesce(p_is_non_stock, false))
    returning id into v_product_id;
  end if;

  insert into public.stock_items (product_id, purchased_date, unit_cost, agreed_price, quantity, min_quantity, notes)
  values (v_product_id, p_purchased_date, round(p_unit_cost, 2), round(p_agreed_price, 2),
          p_quantity, p_min_quantity, nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_stock_id;

  perform private.record_adjustment(v_stock_id, 'initial', 0, p_quantity, 'New stock item');
  return v_stock_id;
end;
$$;

create or replace function public.finalize_settlement(p_period_month date, p_notes text default null)
returns public.monthly_settlements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_period_month)::date;
  v_sum record;
  v_row public.monthly_settlements;
begin
  perform private.require_admin();
  if v_month >= date_trunc('month', private.business_today())::date then
    raise exception 'Only completed months can be finalized' using errcode = '22023';
  end if;
  perform private.assert_period_open(v_month);
  perform public.apply_recurring_expenses(v_month);

  select * into v_sum from public.settlement_summary(v_month, v_month);

  insert into public.monthly_settlements (
    period_month, sale_line_count, total_revenue, total_cost, gross_profit,
    partner_a_share, partner_b_share, partner_a_adjustments, partner_b_adjustments,
    partner_a_payable, partner_b_payable, notes, finalized_by, finalized_by_label
  ) values (
    v_month, v_sum.sale_line_count, v_sum.total_revenue, v_sum.total_cost, v_sum.gross_profit,
    v_sum.partner_a_share, v_sum.partner_b_share, v_sum.partner_a_adjustments, v_sum.partner_b_adjustments,
    v_sum.partner_a_payable, v_sum.partner_b_payable, nullif(btrim(coalesce(p_notes, '')), ''),
    auth.uid(), private.actor_label()
  ) returning * into v_row;
  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- Privileges (CREATE OR REPLACE keeps existing grants; new objects need them)
-- -----------------------------------------------------------------------------
revoke execute on function public.void_sale_item(uuid, text) from public, anon;
grant execute on function public.void_sale_item(uuid, text) to authenticated, service_role;
revoke execute on function private.restore_line_stock(uuid, text) from public, anon, authenticated;
grant select on public.sales_log_view to authenticated;
