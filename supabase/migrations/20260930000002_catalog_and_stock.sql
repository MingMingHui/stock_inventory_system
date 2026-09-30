-- =============================================================================
-- 002 Catalog and stock: partners, categories, partner rules, products,
--     stock items (Excel Stock_Master rows), stock history, shared inventory
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Partners (Excel: Partner A = KaLi Motor "KALI_*", Partner B = Amin "A.L_*")
-- -----------------------------------------------------------------------------
create table public.partners (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique check (code in ('A', 'B')),
  name         text not null check (char_length(btrim(name)) between 1 and 120),
  short_code   text not null unique check (char_length(btrim(short_code)) between 1 and 20),
  description  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger partners_updated_at before update on public.partners
  for each row execute function private.set_updated_at();

insert into public.partners (code, name, short_code, description) values
  ('A', 'KaLi Motor', 'KALI',
   'Partner A (Excel "Partner A Rate (KaLi Motor)", KALI_Rate / KALI_Share). Receives the LEFTOVER share.'),
  ('B', 'Amin', 'A.L',
   'Partner B (Excel "Partner B Rate (Amin)", A.L_Rate / A.L_Share). Receives the fixed fee or 50% share.');

-- -----------------------------------------------------------------------------
-- Product categories (Excel Partner_Rule_Table "Product Type" / Stock_Master "Category")
-- Names are preserved exactly as in Excel (e.g. "Car Engine OIl-L").
-- -----------------------------------------------------------------------------
create table public.product_categories (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (name = btrim(name) and char_length(name) between 1 and 80),
  description  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid,
  updated_by   uuid
);

create unique index product_categories_name_ci_key on public.product_categories (lower(name));

create trigger product_categories_updated_at before update on public.product_categories
  for each row execute function private.set_updated_at();
create trigger product_categories_actor before insert or update on public.product_categories
  for each row execute function private.set_actor();

-- -----------------------------------------------------------------------------
-- Partner rules (Excel Partner_Rule_Table), effective-dated
-- -----------------------------------------------------------------------------
create table public.partner_rules (
  id                          uuid primary key default gen_random_uuid(),
  category_id                 uuid not null references public.product_categories (id) on delete restrict,
  rule_type                   public.rule_type not null,
  partner_b_rate              numeric(12, 4) not null check (partner_b_rate >= 0),
  partner_a_rate              numeric(12, 4) check (partner_a_rate is null or partner_a_rate >= 0),
  partner_a_rate_is_leftover  boolean not null default false,
  notes                       text check (char_length(notes) <= 500),
  effective_from              date not null default date '2026-01-01',
  effective_to                date,
  is_active                   boolean not null default true,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by                  uuid,
  updated_by                  uuid,
  check (effective_to is null or effective_to >= effective_from),
  -- Excel column D holds either the word LEFTOVER or a number.
  check (partner_a_rate_is_leftover = (partner_a_rate is null)),
  -- The Excel Shared_50 formula hard-codes 0.5; keep the table consistent with it.
  check (rule_type <> 'Shared_50' or (partner_b_rate = 0.5 and partner_a_rate = 0.5))
);

comment on column public.partner_rules.partner_b_rate is
  'Excel "Partner B Rate (Amin)". Fixed_* rules: RM per unit/job/service. Shared_50: 0.5.';
comment on column public.partner_rules.partner_a_rate is
  'Excel "Partner A Rate (KaLi Motor)". NULL when the Excel value is LEFTOVER. Informational: the Excel formulas never multiply by it.';

create index partner_rules_category_idx on public.partner_rules (category_id, effective_from desc);

create trigger partner_rules_updated_at before update on public.partner_rules
  for each row execute function private.set_updated_at();
create trigger partner_rules_actor before insert or update on public.partner_rules
  for each row execute function private.set_actor();

-- At most one active rule per category for any given date.
create function private.guard_rule_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- BEFORE triggers run ahead of RLS WITH CHECK; authorize first so non-admins
  -- always get a permission error. (auth.uid() is null for maintenance scripts.)
  if auth.uid() is not null and not private.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if new.is_active then
    perform pg_advisory_xact_lock(hashtext('partner_rules:' || new.category_id::text));
    if exists (
      select 1 from public.partner_rules r
      where r.category_id = new.category_id
        and r.is_active
        and r.id <> new.id
        and daterange(r.effective_from, r.effective_to, '[]')
            && daterange(new.effective_from, new.effective_to, '[]')
    ) then
      raise exception 'Another active partner rule already covers this category for an overlapping date range'
        using errcode = '23P01';
    end if;
  end if;
  return new;
end;
$$;

create trigger partner_rules_no_overlap before insert or update on public.partner_rules
  for each row execute function private.guard_rule_overlap();

create function private.rule_for(p_category_id uuid, p_on date)
returns public.partner_rules
language sql
stable
security definer
set search_path = ''
as $$
  select r.*
  from public.partner_rules r
  where r.category_id = p_category_id
    and r.is_active
    and r.effective_from <= p_on
    and (r.effective_to is null or r.effective_to >= p_on)
  order by r.effective_from desc
  limit 1
$$;

-- -----------------------------------------------------------------------------
-- Products (a SKU within a category; Excel Item_Code + Description + Brand + Category)
-- -----------------------------------------------------------------------------
create table public.products (
  id            uuid primary key default gen_random_uuid(),
  item_code     text not null check (item_code = btrim(item_code) and char_length(item_code) between 1 and 60),
  description   text not null check (description = btrim(description) and char_length(description) between 1 and 200),
  brand         text check (brand is null or (brand = btrim(brand) and char_length(brand) between 1 and 80)),
  category_id   uuid not null references public.product_categories (id) on delete restrict,
  unit          text check (unit is null or char_length(unit) <= 20),
  is_non_stock  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  updated_by    uuid
);

comment on column public.products.is_non_stock is
  'Service / non-stock item (Excel Current_Quantity = -1, e.g. battery charging, tyre change). Stock is not tracked or decremented.';

create unique index products_identity_key
  on public.products (item_code, lower(description), coalesce(lower(brand), ''), category_id);
create index products_category_idx on public.products (category_id);
create index products_item_code_idx on public.products (item_code);

create trigger products_updated_at before update on public.products
  for each row execute function private.set_updated_at();
create trigger products_actor before insert or update on public.products
  for each row execute function private.set_actor();

-- -----------------------------------------------------------------------------
-- Stock items (one row per Excel Stock_Master row = a purchase batch of a product)
-- -----------------------------------------------------------------------------
create table public.stock_items (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null references public.products (id) on delete restrict,
  purchased_date   date,
  unit_cost        numeric(12, 2) not null default 0 check (unit_cost >= 0),
  agreed_price     numeric(12, 2) not null default 0 check (agreed_price >= 0),
  quantity         integer not null default 0,
  min_quantity     integer check (min_quantity is null or min_quantity >= 0),
  is_obsolete      boolean not null default false,
  obsolete_at      timestamptz,
  last_checked_at  timestamptz,
  last_checked_by  uuid,
  notes            text check (char_length(notes) <= 1000),
  legacy_ref       text unique,
  legacy_id        integer,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid,
  updated_by       uuid,
  check (is_obsolete = (obsolete_at is not null))
);

comment on column public.stock_items.agreed_price is 'Excel "Selling_Price (RM)" — the agreed selling price.';
comment on column public.stock_items.legacy_ref is 'Source location of imported rows, e.g. Stock_Master!R42.';

create index stock_items_product_idx on public.stock_items (product_id);
create index stock_items_obsolete_idx on public.stock_items (is_obsolete);

create trigger stock_items_updated_at before update on public.stock_items
  for each row execute function private.set_updated_at();
create trigger stock_items_actor before insert or update on public.stock_items
  for each row execute function private.set_actor();

create function private.guard_stock_quantity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.quantity < 0 and not coalesce(private.setting_boolean('allow_negative_stock'), false) then
    raise exception 'Stock quantity cannot be negative' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger stock_items_quantity_guard before insert or update of quantity on public.stock_items
  for each row execute function private.guard_stock_quantity();

-- Immutable history of every quantity change.
create table public.stock_adjustments (
  id                 uuid primary key default gen_random_uuid(),
  stock_item_id      uuid not null references public.stock_items (id) on delete restrict,
  adjustment_type    public.stock_adjustment_type not null,
  previous_quantity  integer not null,
  new_quantity       integer not null,
  quantity_change    integer generated always as (new_quantity - previous_quantity) stored,
  reason             text not null check (char_length(btrim(reason)) between 1 and 500),
  sale_item_id       uuid,
  created_by         uuid,
  created_by_label   text not null,
  created_at         timestamptz not null default now()
);

create index stock_adjustments_item_idx on public.stock_adjustments (stock_item_id, created_at desc);
create index stock_adjustments_created_at_idx on public.stock_adjustments (created_at desc);

-- Historical month-end counts imported from the Stock_Master snapshot columns.
create table public.stock_snapshots (
  id              uuid primary key default gen_random_uuid(),
  stock_item_id   uuid not null references public.stock_items (id) on delete restrict,
  snapshot_date   date not null,
  source_column   text not null,
  quantity        integer not null,
  created_at      timestamptz not null default now(),
  unique (stock_item_id, snapshot_date)
);

-- Status view (security_invoker so RLS of the base tables applies).
create view public.stock_items_view
with (security_invoker = true)
as
select
  s.id,
  s.product_id,
  p.item_code,
  p.description,
  p.brand,
  p.unit,
  p.is_non_stock,
  p.category_id,
  c.name as category_name,
  s.purchased_date,
  s.unit_cost,
  s.agreed_price,
  s.quantity,
  s.min_quantity,
  coalesce(s.min_quantity, private.setting_numeric('low_stock_default_threshold')::integer) as effective_min_quantity,
  case
    when s.is_obsolete then 'OBSOLETE'
    when p.is_non_stock then 'ACTIVE'
    when s.quantity <= 0 then 'OUT_OF_STOCK'
    when s.quantity <= coalesce(s.min_quantity, private.setting_numeric('low_stock_default_threshold')::integer)
      then 'LOW_STOCK'
    else 'ACTIVE'
  end as status,
  s.is_obsolete,
  s.obsolete_at,
  s.last_checked_at,
  s.notes,
  s.legacy_ref,
  s.created_at,
  s.updated_at
from public.stock_items s
join public.products p on p.id = s.product_id
join public.product_categories c on c.id = p.category_id;

-- -----------------------------------------------------------------------------
-- Shared workshop inventory (Excel KALI_Inventory_List) — equipment, not for sale
-- -----------------------------------------------------------------------------
create table public.inventory_items (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (name = btrim(name) and char_length(name) between 1 and 120),
  brand        text check (brand is null or char_length(brand) <= 80),
  category     text check (category is null or char_length(category) <= 80),
  quantity     integer not null default 0 check (quantity >= 0),
  status       public.inventory_status not null default 'ACTIVE',
  notes        text check (char_length(notes) <= 500),
  legacy_ref   text unique,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid,
  updated_by   uuid
);

create trigger inventory_items_updated_at before update on public.inventory_items
  for each row execute function private.set_updated_at();
create trigger inventory_items_actor before insert or update on public.inventory_items
  for each row execute function private.set_actor();

-- -----------------------------------------------------------------------------
-- Audit triggers
-- -----------------------------------------------------------------------------
create trigger partners_audit after insert or update or delete on public.partners
  for each row execute function private.audit_row();
create trigger product_categories_audit after insert or update or delete on public.product_categories
  for each row execute function private.audit_row();
create trigger partner_rules_audit after insert or update or delete on public.partner_rules
  for each row execute function private.audit_row();
create trigger products_audit after insert or update or delete on public.products
  for each row execute function private.audit_row();
create trigger stock_items_audit after insert or update or delete on public.stock_items
  for each row execute function private.audit_row();
create trigger inventory_items_audit after insert or update or delete on public.inventory_items
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Stock operations (the only way quantities change)
-- -----------------------------------------------------------------------------
create function private.record_adjustment(
  p_stock_item_id uuid,
  p_type public.stock_adjustment_type,
  p_previous integer,
  p_new integer,
  p_reason text,
  p_sale_item_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.stock_adjustments
    (stock_item_id, adjustment_type, previous_quantity, new_quantity, reason, sale_item_id, created_by, created_by_label)
  values
    (p_stock_item_id, p_type, p_previous, p_new, btrim(p_reason), p_sale_item_id, auth.uid(), private.actor_label())
  returning id into v_id;
  return v_id;
end;
$$;

-- Create a new stock item (and its product when it does not exist yet).
create function public.add_stock_item(
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
  if p_purchased_date is not null and p_purchased_date > current_date then
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

-- Receive (add), stock check (set counted qty) or amend (set corrected qty).
-- p_expected_quantity guards against lost updates: pass the quantity the user
-- was looking at; the call fails if someone else changed it meanwhile.
create function public.adjust_stock(
  p_stock_item_id uuid,
  p_type public.stock_adjustment_type,
  p_quantity integer,
  p_reason text,
  p_expected_quantity integer default null
)
returns public.stock_adjustments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.stock_items;
  v_new integer;
  v_row public.stock_adjustments;
  v_adj_id uuid;
begin
  perform private.require_authorized();

  if p_type not in ('receive', 'stock_check', 'amendment') then
    raise exception 'Unsupported adjustment type' using errcode = '22023';
  end if;
  if p_quantity is null or (p_type = 'receive' and p_quantity <= 0) or p_quantity < 0 then
    raise exception 'Invalid quantity' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required' using errcode = '22023';
  end if;

  select * into v_item from public.stock_items where id = p_stock_item_id for update;
  if not found then
    raise exception 'Stock item not found' using errcode = 'P0002';
  end if;
  if p_expected_quantity is not null and p_expected_quantity <> v_item.quantity then
    raise exception 'Stock quantity changed from % to % since it was loaded. Refresh and try again.',
      p_expected_quantity, v_item.quantity using errcode = '40001';
  end if;

  v_new := case when p_type = 'receive' then v_item.quantity + p_quantity else p_quantity end;

  update public.stock_items
  set quantity = v_new,
      last_checked_at = case when p_type = 'stock_check' then now() else last_checked_at end,
      last_checked_by = case when p_type = 'stock_check' then auth.uid() else last_checked_by end
  where id = p_stock_item_id;

  v_adj_id := private.record_adjustment(p_stock_item_id, p_type, v_item.quantity, v_new, p_reason);
  select * into v_row from public.stock_adjustments where id = v_adj_id;
  return v_row;
end;
$$;

create function public.set_stock_min_quantity(p_stock_item_id uuid, p_min_quantity integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_authorized();
  if p_min_quantity is not null and p_min_quantity < 0 then
    raise exception 'Minimum quantity must be zero or more' using errcode = '22023';
  end if;
  update public.stock_items set min_quantity = p_min_quantity where id = p_stock_item_id;
  if not found then
    raise exception 'Stock item not found' using errcode = 'P0002';
  end if;
end;
$$;

create function public.set_stock_obsolete(p_stock_item_id uuid, p_is_obsolete boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_authorized();
  update public.stock_items
  set is_obsolete = p_is_obsolete,
      obsolete_at = case when p_is_obsolete then coalesce(obsolete_at, now()) end
  where id = p_stock_item_id;
  if not found then
    raise exception 'Stock item not found' using errcode = 'P0002';
  end if;
end;
$$;
