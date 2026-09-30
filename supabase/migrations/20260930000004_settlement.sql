-- =============================================================================
-- 004 Settlement: expense categories, monthly operating expenses/adjustments,
--     partner summary, monthly settlement snapshots
-- =============================================================================
-- Excel Partner_Summary:
--   Total Payment to KALI = SUM(KALI_Share) + Gaji Anol (-100) + Bil Api (=32.65*0.6) + Rental (500)
-- Generalised: payable to partner = SUM(partner share) + SUM(signed adjustments for that partner).

create table public.expense_categories (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null check (name = btrim(name) and char_length(name) between 1 and 80),
  description          text check (char_length(description) <= 500),
  default_partner_id   uuid references public.partners (id) on delete restrict,
  default_amount       numeric(12, 2),
  default_share_ratio  numeric(6, 4) check (default_share_ratio is null or default_share_ratio between 0 and 1),
  is_recurring         boolean not null default false,
  is_active            boolean not null default true,
  sort_order           integer not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid,
  updated_by           uuid,
  -- A recurring item is added automatically every month with its fixed amount.
  check (not is_recurring or (default_amount is not null and default_amount <> 0 and default_partner_id is not null))
);

comment on column public.expense_categories.is_recurring is
  'Fixed monthly item (e.g. wages -100) added automatically to every month by apply_recurring_expenses().';
comment on column public.expense_categories.default_share_ratio is
  'For variable bills: the partner share of the entered bill (e.g. electricity 0.6). amount = bill x ratio.';

create unique index expense_categories_name_ci_key on public.expense_categories (lower(name));

create trigger expense_categories_updated_at before update on public.expense_categories
  for each row execute function private.set_updated_at();
create trigger expense_categories_actor before insert or update on public.expense_categories
  for each row execute function private.set_actor();

-- Signed adjustment to a partner's payable for a month.
-- Positive = increases what is paid to that partner; negative = decreases it.
create table public.operating_expenses (
  id                   uuid primary key default gen_random_uuid(),
  period_month         date not null check (period_month = date_trunc('month', period_month)::date),
  expense_category_id  uuid not null references public.expense_categories (id) on delete restrict,
  partner_id           uuid not null references public.partners (id) on delete restrict,
  base_amount          numeric(12, 2),
  share_ratio          numeric(6, 4) check (share_ratio is null or share_ratio between 0 and 1),
  amount               numeric(12, 2) not null check (amount <> 0),
  description          text check (char_length(description) <= 500),
  legacy_ref           text unique,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid,
  updated_by           uuid,
  check ((base_amount is null) = (share_ratio is null)),
  check (base_amount is null or amount = round(base_amount * share_ratio, 2))
);

comment on column public.operating_expenses.amount is
  'Signed adjustment to the partner payable. Excel example: Gaji Anol -100, Bil Api +19.59 (32.65 x 0.6), Rental +500. '
  'When base_amount/share_ratio are given the database computes amount = round(base_amount x share_ratio, 2).';

create index operating_expenses_period_idx on public.operating_expenses (period_month);

-- Money is computed in the database, never trusted from the client.
create function private.compute_expense_amount()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.base_amount is not null and new.share_ratio is not null then
    new.amount := round(new.base_amount * new.share_ratio, 2);
  end if;
  return new;
end;
$$;

create trigger operating_expenses_compute_amount before insert or update on public.operating_expenses
  for each row execute function private.compute_expense_amount();

create trigger operating_expenses_updated_at before update on public.operating_expenses
  for each row execute function private.set_updated_at();
create trigger operating_expenses_actor before insert or update on public.operating_expenses
  for each row execute function private.set_actor();

-- Finalized monthly settlement snapshot. Row present = month is closed.
create table public.monthly_settlements (
  id                     uuid primary key default gen_random_uuid(),
  period_month           date not null unique check (period_month = date_trunc('month', period_month)::date),
  sale_line_count        integer not null,
  total_revenue          numeric(12, 2) not null,
  total_cost             numeric(12, 2) not null,
  gross_profit           numeric(12, 2) not null,
  partner_a_share        numeric(12, 2) not null,
  partner_b_share        numeric(12, 2) not null,
  partner_a_adjustments  numeric(12, 2) not null,
  partner_b_adjustments  numeric(12, 2) not null,
  partner_a_payable      numeric(12, 2) not null,
  partner_b_payable      numeric(12, 2) not null,
  notes                  text check (char_length(notes) <= 1000),
  finalized_at           timestamptz not null default now(),
  finalized_by           uuid,
  finalized_by_label     text not null
);

create function private.guard_expense_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform private.assert_period_open(old.period_month);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform private.assert_period_open(new.period_month);
  end if;
  return coalesce(new, old);
end;
$$;

create trigger operating_expenses_period_guard
  before insert or update or delete on public.operating_expenses
  for each row execute function private.guard_expense_period();

create trigger expense_categories_audit after insert or update or delete on public.expense_categories
  for each row execute function private.audit_row();
create trigger operating_expenses_audit after insert or update or delete on public.operating_expenses
  for each row execute function private.audit_row();
create trigger monthly_settlements_audit after insert or update or delete on public.monthly_settlements
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Reporting functions (security invoker: base-table RLS applies)
-- -----------------------------------------------------------------------------

-- Per-category partner summary (Excel Partner_Summary pivot) for a date range.
create function public.partner_summary_by_category(
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
    and (p_category_id is null or si.category_id = p_category_id)
    and (p_product_id is null or si.product_id = p_product_id)
  group by c.id, c.name
  order by c.name
$$;

-- Monthly settlement figures for every month overlapping [p_from, p_to].
create function public.settlement_summary(p_from date, p_to date)
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

-- Stock and sales headline figures for the dashboard cards.
create function public.dashboard_stats(p_from date, p_to date)
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
-- Recurring monthly items (admin). Idempotent: a category already present in the
-- month is not added again.
-- -----------------------------------------------------------------------------
create function public.apply_recurring_expenses(p_period_month date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_period_month)::date;
  v_count integer;
begin
  perform private.require_admin();
  perform private.assert_period_open(v_month);

  insert into public.operating_expenses (period_month, expense_category_id, partner_id, amount, description)
  select v_month, ec.id, ec.default_partner_id, ec.default_amount, 'Recurring monthly item'
  from public.expense_categories ec
  where ec.is_recurring
    and ec.is_active
    and not exists (
      select 1 from public.operating_expenses oe
      where oe.period_month = v_month and oe.expense_category_id = ec.id
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Finalize / reopen (admin)
-- -----------------------------------------------------------------------------
create function public.finalize_settlement(p_period_month date, p_notes text default null)
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
  if v_month >= date_trunc('month', current_date)::date then
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

create function public.reopen_settlement(p_period_month date, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin();
  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  -- Record the reason in the audit trail (UPDATE row) before removing the snapshot.
  update public.monthly_settlements
  set notes = left(concat_ws(' | ', notes, 'Reopened: ' || btrim(p_reason)), 1000)
  where period_month = date_trunc('month', p_period_month)::date;
  if not found then
    raise exception 'That month is not finalized' using errcode = 'P0002';
  end if;
  delete from public.monthly_settlements where period_month = date_trunc('month', p_period_month)::date;
end;
$$;
