-- =============================================================================
-- 009 Automatic obsolete rule + FIFO ordering of stock batches
-- =============================================================================
-- Duplicated stock = several batches (stock_items) of the same product
-- (item code + description + brand + category) with different purchase dates.
--
-- Rule (applied by the database after every insert / quantity / date change):
--   Take the EARLIEST active dated batch of the product. If its quantity is 0 AND
--   a newer active batch (later purchase date) exists, mark it OBSOLETE with
--   obsolete_remarks = 'auto-rule obsolete'. Repeat for the next earliest batch.
-- So depleted older batches retire in FIFO order, a batch with stock is never
-- retired, and the newest batch is never retired because an older one is empty.
-- Service items and batches without a purchase date are ignored by the rule.
-- History is preserved: nothing is deleted, quantities are untouched, and the
-- audit trigger records who/what caused the change.
--
-- FIFO: batches are ordered purchase_date ASC (undated last), then creation time.

alter table public.stock_items
  add column obsolete_remarks text check (char_length(obsolete_remarks) <= 200);

comment on column public.stock_items.obsolete_remarks is
  'Why the batch is obsolete: ''auto-rule obsolete'' (database rule), ''manual'' (set by a user), or NULL (imported from Excel).';

create index stock_items_product_fifo_idx on public.stock_items (product_id, purchased_date, created_at);

-- -----------------------------------------------------------------------------
-- The rule
-- -----------------------------------------------------------------------------
create function private.apply_auto_obsolete(p_product_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_batch record;
begin
  if p_product_id is null or exists (
    select 1 from public.products where id = p_product_id and is_non_stock
  ) then
    return 0;
  end if;

  loop
    select s.id, s.quantity, s.purchased_date
    into v_batch
    from public.stock_items s
    where s.product_id = p_product_id
      and not s.is_obsolete
      and s.purchased_date is not null
    order by s.purchased_date, s.created_at, s.id
    limit 1;

    exit when not found;
    exit when v_batch.quantity <> 0;
    exit when not exists (
      select 1 from public.stock_items n
      where n.product_id = p_product_id
        and not n.is_obsolete
        and n.purchased_date > v_batch.purchased_date
    );

    update public.stock_items
    set is_obsolete = true,
        obsolete_at = now(),
        obsolete_remarks = 'auto-rule obsolete'
    where id = v_batch.id and not is_obsolete and quantity = 0;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- A batch retired by the rule comes back automatically if stock is returned to it
-- (e.g. a voided sale). Manually obsoleted batches are never changed.
create function private.reactivate_auto_obsolete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.quantity > 0 and old.is_obsolete and new.is_obsolete
     and old.obsolete_remarks = 'auto-rule obsolete' then
    new.is_obsolete := false;
    new.obsolete_at := null;
    new.obsolete_remarks := null;
  end if;
  return new;
end;
$$;

create trigger stock_items_reactivate_auto_obsolete
  before update of quantity on public.stock_items
  for each row execute function private.reactivate_auto_obsolete();

create function private.trg_apply_auto_obsolete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.apply_auto_obsolete(new.product_id);
  if tg_op = 'UPDATE' and old.product_id is distinct from new.product_id then
    perform private.apply_auto_obsolete(old.product_id);
  end if;
  return null;
end;
$$;

-- Fires on the columns the rule depends on. The rule's own UPDATE only touches
-- is_obsolete / obsolete_at / obsolete_remarks, so it does not re-trigger itself.
create trigger stock_items_auto_obsolete
  after insert or update of quantity, purchased_date, product_id on public.stock_items
  for each row execute function private.trg_apply_auto_obsolete();

-- Manual obsolete records its reason; restoring clears it.
create or replace function public.set_stock_obsolete(p_stock_item_id uuid, p_is_obsolete boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_authorized();
  update public.stock_items
  set is_obsolete = p_is_obsolete,
      obsolete_at = case when p_is_obsolete then coalesce(obsolete_at, now()) end,
      obsolete_remarks = case when p_is_obsolete then coalesce(obsolete_remarks, 'manual') end
  where id = p_stock_item_id;
  if not found then
    raise exception 'Stock item not found' using errcode = 'P0002';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Stock view: + obsolete_remarks, + fifo_rank (1 = sell / adjust first).
-- Existing columns unchanged and in the same order.
-- -----------------------------------------------------------------------------
create or replace view public.stock_items_view
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
  s.updated_at,
  s.obsolete_remarks,
  case when not s.is_obsolete then
    row_number() over (
      partition by s.product_id, s.is_obsolete
      order by s.purchased_date asc nulls last, s.created_at, s.id)
  end as fifo_rank,
  count(*) filter (where not s.is_obsolete) over (partition by s.product_id) as active_batch_count
from public.stock_items s
join public.products p on p.id = s.product_id
join public.product_categories c on c.id = p.category_id;

grant select on public.stock_items_view to authenticated;

revoke execute on function private.apply_auto_obsolete(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Apply the rule to existing data once
-- -----------------------------------------------------------------------------
do $$
declare
  v_product uuid;
begin
  for v_product in select id from public.products order by id loop
    perform private.apply_auto_obsolete(v_product);
  end loop;
end;
$$;
