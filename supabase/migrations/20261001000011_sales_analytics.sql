-- =============================================================================
-- 011 Sales analytics (admin only) — aggregation in PostgreSQL
-- =============================================================================
-- Rules are deterministic and documented in docs/sales-analytics.md.
-- Dates: sale_date is a Malaysian calendar date, so months are
-- date_trunc('month', sale_date) with no timezone conversion. "Current month"
-- comes from private.business_today() (Asia/Kuala_Lumpur).
-- Voided lines and voided sales are excluded everywhere.

-- Monthly totals for every month in the range (months without sales return 0).
create function public.analytics_monthly(p_from_month date, p_to_month date)
returns table (
  period_month date,
  units bigint,
  revenue numeric,
  gross_profit numeric,
  line_count bigint,
  avg_sale_value numeric,
  product_count bigint
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_from date := date_trunc('month', p_from_month)::date;
  v_to date := date_trunc('month', p_to_month)::date;
begin
  if not private.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if v_from > v_to or v_to > (v_from + interval '60 months')::date then
    raise exception 'Choose a range of up to 60 months' using errcode = '22023';
  end if;

  return query
  with months as (
    select g::date as m from generate_series(v_from, v_to, interval '1 month') g
  ),
  agg as (
    select date_trunc('month', s.sale_date)::date as m,
           sum(si.quantity)::bigint as units,
           sum(si.revenue) as revenue,
           sum(si.gross_profit) as gp,
           count(*)::bigint as lines,
           count(distinct si.product_id)::bigint as products
    from public.sale_items si
    join public.sales s on s.id = si.sale_id and not s.is_void
    where not si.is_void
      and s.sale_date >= v_from
      and s.sale_date < (v_to + interval '1 month')::date
    group by 1
  )
  select months.m,
         coalesce(agg.units, 0)::bigint,
         coalesce(agg.revenue, 0)::numeric,
         coalesce(agg.gp, 0)::numeric,
         coalesce(agg.lines, 0)::bigint,
         case when coalesce(agg.lines, 0) > 0 then round(agg.revenue / agg.lines, 2) else 0 end::numeric,
         coalesce(agg.products, 0)::bigint
  from months
  left join agg on agg.m = months.m
  order by months.m;
end;
$$;

-- Sales distribution by category for a date range.
create function public.analytics_categories(p_from date, p_to date)
returns table (
  category_id uuid,
  category_name text,
  units bigint,
  revenue numeric,
  gross_profit numeric,
  line_count bigint,
  revenue_share numeric
)
language plpgsql
stable
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  return query
  with agg as (
    select si.category_id,
           sum(si.quantity)::bigint as units,
           sum(si.revenue) as revenue,
           sum(si.gross_profit) as gp,
           count(*)::bigint as lines
    from public.sale_items si
    join public.sales s on s.id = si.sale_id and not s.is_void
    where not si.is_void and s.sale_date between p_from and p_to
    group by 1
  )
  select c.id, c.name, agg.units, agg.revenue, agg.gp, agg.lines,
         case when sum(agg.revenue) over () > 0
              then round(agg.revenue / sum(agg.revenue) over (), 4) else 0 end::numeric
  from agg
  join public.product_categories c on c.id = agg.category_id
  order by agg.revenue desc, c.name;
end;
$$;

-- Per-item analysis over an observation window of p_months months ending with the
-- month of p_as_of (default: current Malaysian month).
create function public.analytics_items(
  p_as_of date default null,
  p_months integer default 6,
  p_recent_months integer default 3
)
returns table (
  product_id uuid,
  item_code text,
  description text,
  brand text,
  category_name text,
  units bigint,
  revenue numeric,
  gross_profit numeric,
  avg_selling_price numeric,
  line_count bigint,
  months_with_sales integer,
  months_without_sales integer,
  units_recent bigint,
  monthly_units integer[],
  current_stock bigint,
  oldest_stock_date date,
  classification text,
  pattern text
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_end date := date_trunc('month', coalesce(p_as_of, private.business_today()))::date;
  v_start date;
  v_window_end date;
  v_half integer;
  v_need integer;
begin
  if not private.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_months is null or p_months < 3 or p_months > 24 then
    raise exception 'The observation period must be between 3 and 24 months' using errcode = '22023';
  end if;
  if p_recent_months is null or p_recent_months < 1 or p_recent_months > p_months then
    raise exception 'The recent period must be between 1 month and the observation period' using errcode = '22023';
  end if;

  v_start := (v_end - make_interval(months => p_months - 1))::date;
  v_window_end := ((v_end + interval '1 month')::date - 1);
  v_half := p_months / 2;
  v_need := ceil(p_months / 2.0)::integer;

  return query
  with months as (
    select g::date as m, row_number() over (order by g)::integer as idx
    from generate_series(v_start, v_end, interval '1 month') g
  ),
  monthly as (
    select si.product_id, date_trunc('month', s.sale_date)::date as m,
           sum(si.quantity)::bigint as units, sum(si.revenue) as revenue,
           sum(si.gross_profit) as gp, count(*)::bigint as lines
    from public.sale_items si
    join public.sales s on s.id = si.sale_id and not s.is_void
    where not si.is_void and s.sale_date >= v_start and s.sale_date <= v_window_end
    group by 1, 2
  ),
  stock as (
    select s.product_id,
           (sum(s.quantity) filter (where not s.is_obsolete))::bigint as current_stock,
           min(s.purchased_date) filter (where not s.is_obsolete and s.quantity > 0) as oldest_stock_date
    from public.stock_items s
    group by 1
  ),
  candidates as (
    select p.id from public.products p
    where exists (select 1 from monthly mo where mo.product_id = p.id)
       or exists (select 1 from stock st where st.product_id = p.id and coalesce(st.current_stock, 0) > 0)
  ),
  grid as (
    select c.id as product_id, mo.idx,
           coalesce(ms.units, 0)::bigint as units,
           coalesce(ms.revenue, 0) as revenue,
           coalesce(ms.gp, 0) as gp,
           coalesce(ms.lines, 0)::bigint as lines
    from candidates c
    cross join months mo
    left join monthly ms on ms.product_id = c.id and ms.m = mo.m
  ),
  agg as (
    select g.product_id,
           sum(g.units)::bigint as units,
           sum(g.revenue) as revenue,
           sum(g.gp) as gp,
           sum(g.lines)::bigint as lines,
           (count(*) filter (where g.units > 0))::integer as months_with_sales,
           coalesce(sum(g.units) filter (where g.idx > p_months - p_recent_months), 0)::bigint as units_recent,
           coalesce(avg(g.units) filter (where g.idx <= v_half), 0) as first_avg,
           coalesce(avg(g.units) filter (where g.idx > p_months - v_half), 0) as second_avg,
           array_agg(g.units::integer order by g.idx) as monthly_units
    from grid g
    group by g.product_id
  ),
  ranked as (
    -- Top 20% = rank (1 = highest) within the items that sold, by units or by revenue.
    select a.*,
           case when a.units > 0 then rank() over (partition by (a.units > 0) order by a.units desc) end as rank_units,
           case when a.units > 0 then rank() over (partition by (a.units > 0) order by a.revenue desc) end as rank_revenue,
           greatest(1, ceil(0.2 * count(*) filter (where a.units > 0) over ()))::integer as top_n
    from agg a
  ),
  -- Seasonal check over the last 24 months: two consecutive 12-month years.
  s24 as (
    select si.product_id, date_trunc('month', s.sale_date)::date as m, sum(si.quantity)::numeric as units
    from public.sale_items si
    join public.sales s on s.id = si.sale_id and not s.is_void
    where not si.is_void
      and s.sale_date >= (v_end - interval '23 months')::date
      and s.sale_date <= v_window_end
    group by 1, 2
  ),
  s24y as (
    select x.product_id,
           case when x.m < (v_end - interval '11 months')::date then 1 else 2 end as yr,
           extract(month from x.m)::integer as moy,
           x.units
    from s24 x
  ),
  peaks as (
    select distinct on (y.product_id, y.yr)
           y.product_id, y.yr, y.moy, y.units as peak_units,
           sum(y.units) over (partition by y.product_id, y.yr) as year_units
    from s24y y
    order by y.product_id, y.yr, y.units desc, y.moy
  ),
  seasonal as (
    select a.product_id
    from peaks a
    join peaks b on b.product_id = a.product_id and a.yr = 1 and b.yr = 2
    where a.year_units >= 3 and b.year_units >= 3
      and least(abs(a.moy - b.moy), 12 - abs(a.moy - b.moy)) <= 1
      and a.peak_units >= 0.4 * a.year_units
      and b.peak_units >= 0.4 * b.year_units
  )
  select p.id,
         p.item_code,
         p.description,
         p.brand,
         c.name,
         r.units,
         r.revenue,
         r.gp,
         case when r.units > 0 then round(r.revenue / r.units, 2) end,
         r.lines,
         r.months_with_sales,
         (p_months - r.months_with_sales)::integer,
         r.units_recent,
         r.monthly_units,
         coalesce(st.current_stock, 0)::bigint,
         st.oldest_stock_date,
         case
           when r.units > 0
                and (r.rank_units <= r.top_n or r.rank_revenue <= r.top_n)
                and r.months_with_sales >= v_need
             then 'BEST SELLER'
           when coalesce(st.current_stock, 0) > 0
                and r.units_recent <= 1
                and (p_months - r.months_with_sales) >= v_need
                and (st.oldest_stock_date is null or st.oldest_stock_date <= v_window_end - 90)
             then 'LOW SELLER'
           else 'NORMAL'
         end,
         case
           when r.units_recent = 0 then 'NO RECENT SALES'
           when exists (select 1 from seasonal se where se.product_id = p.id) then 'SEASONAL'
           when r.months_with_sales < v_need then 'SPORADIC'
           when r.second_avg > r.first_avg and r.second_avg >= r.first_avg * 1.25 then 'GROWING'
           when r.second_avg <= r.first_avg * 0.75 then 'DECLINING'
           else 'STABLE'
         end
  from ranked r
  join public.products p on p.id = r.product_id
  join public.product_categories c on c.id = p.category_id
  left join stock st on st.product_id = p.id
  order by r.revenue desc, p.item_code, p.description;
end;
$$;

revoke execute on function
  public.analytics_monthly(date, date),
  public.analytics_categories(date, date),
  public.analytics_items(date, integer, integer)
from public, anon;
grant execute on function
  public.analytics_monthly(date, date),
  public.analytics_categories(date, date),
  public.analytics_items(date, integer, integer)
to authenticated, service_role;
