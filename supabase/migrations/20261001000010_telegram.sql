-- =============================================================================
-- 010 Telegram integration: account linking, acting-user authorization,
--     conversation state, idempotency, and service-role-only bot functions
-- =============================================================================
-- Flow:  Telegram → Edge Function "telegram-webhook" (holds the bot token) →
--        public.tg_* functions (service_role only) → existing functions.
-- A tg_* function first maps the stable Telegram user ID to an ACTIVE linked,
-- ACTIVE allow-listed user, then sets a transaction-local acting email. The
-- existing authorization helpers honour that acting email ONLY for requests made
-- with the service role, so browser users cannot use it. Every stock and sale
-- operation then runs through the same functions, checks and calculations as the
-- web app (single source of truth).

-- -----------------------------------------------------------------------------
-- Settings: allow text values (bot username / alias)
-- -----------------------------------------------------------------------------
alter table public.app_settings drop constraint if exists app_settings_value_type_check;
alter table public.app_settings drop constraint if exists app_settings_check;
alter table public.app_settings
  add constraint app_settings_value_type_valid check (value_type in ('integer', 'numeric', 'boolean', 'text')),
  add constraint app_settings_value_matches_type check (
    (value_type = 'integer' and value ~ '^-?[0-9]+$')
    or (value_type = 'numeric' and value ~ '^-?[0-9]+(\.[0-9]+)?$')
    or (value_type = 'boolean' and value in ('true', 'false'))
    or (value_type = 'text' and char_length(value) <= 200)
  );

insert into public.app_settings (key, value, value_type, description) values
  ('telegram_bot_username', '', 'text',
   'Telegram bot username without @ (e.g. KaliWorkshopBot). Used for the account-linking link. Empty = Telegram not configured.')
on conflict (key) do nothing;

create function private.setting_text(p_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select value from public.app_settings where key = p_key
$$;

-- -----------------------------------------------------------------------------
-- Acting user (service role only)
-- -----------------------------------------------------------------------------
create or replace function private.current_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null),
    case
      when auth.uid() is null and coalesce(auth.jwt() ->> 'role', '') = 'service_role'
        then nullif(current_setting('app.acting_email', true), '')
    end
  )
$$;

create or replace function private.actor_label()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    case when auth.uid() is null and private.current_email() is not null
      then private.current_email() || ' (Telegram)'
      else private.current_email()
    end,
    nullif(current_setting('app.actor', true), ''),
    'db:' || session_user
  )
$$;

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table public.telegram_user_links (
  id                  uuid primary key default gen_random_uuid(),
  authorized_user_id  uuid not null references public.authorized_users (id) on delete cascade,
  telegram_user_id    bigint not null unique,           -- stable identity (usernames can change)
  telegram_username   text check (char_length(telegram_username) <= 64),
  telegram_chat_id    bigint not null,
  is_active           boolean not null default true,
  linked_at           timestamptz not null default now(),
  last_seen_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.telegram_user_links is
  'Telegram account ↔ allow-listed user. Identity is the numeric Telegram user ID, never the username.';

create unique index telegram_user_links_one_active_per_user
  on public.telegram_user_links (authorized_user_id) where is_active;

create trigger telegram_user_links_updated_at before update on public.telegram_user_links
  for each row execute function private.set_updated_at();
create trigger telegram_user_links_audit after insert or update or delete on public.telegram_user_links
  for each row execute function private.audit_row();

-- Single-use, short-lived link codes. Only a SHA-256 hash is stored.
create table public.telegram_link_codes (
  id                        uuid primary key default gen_random_uuid(),
  authorized_user_id        uuid not null references public.authorized_users (id) on delete cascade,
  code_hash                 text not null unique,
  expires_at                timestamptz not null,
  used_at                   timestamptz,
  used_by_telegram_user_id  bigint,
  created_at                timestamptz not null default now()
);

create index telegram_link_codes_user_idx on public.telegram_link_codes (authorized_user_id);

-- Conversation state (server-side; callback buttons only carry an index + nonce).
create table public.telegram_sessions (
  telegram_user_id  bigint primary key,
  state             jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now()
);

-- Telegram retries deliveries; each update is processed once.
create table public.telegram_processed_updates (
  update_id         bigint primary key,
  telegram_user_id  bigint,
  processed_at      timestamptz not null default now()
);

create index telegram_processed_updates_at_idx on public.telegram_processed_updates (processed_at);

alter table public.telegram_user_links        enable row level security;
alter table public.telegram_link_codes        enable row level security;
alter table public.telegram_sessions          enable row level security;
alter table public.telegram_processed_updates enable row level security;

-- Supabase grants new public tables to anon/authenticated by default; start from zero.
revoke all on public.telegram_user_links, public.telegram_link_codes, public.telegram_sessions,
              public.telegram_processed_updates from anon, authenticated;

-- Admins can see and deactivate links; everything else is service-role only.
grant select, update (is_active) on public.telegram_user_links to authenticated;
create policy telegram_user_links_admin_select on public.telegram_user_links
  for select to authenticated using ((select private.is_admin()));
create policy telegram_user_links_admin_update on public.telegram_user_links
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

grant all on public.telegram_user_links, public.telegram_link_codes, public.telegram_sessions,
             public.telegram_processed_updates to service_role;

-- -----------------------------------------------------------------------------
-- Web functions (signed-in, allow-listed users)
-- -----------------------------------------------------------------------------
create function private.my_authorized_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select au.id from public.authorized_users au
  where private.normalize_email(au.email) = private.normalize_email(private.current_email())
    and au.is_active
$$;

-- Returns a one-time code valid for 10 minutes. Any previous unused code is revoked.
create function public.create_telegram_link_code()
returns table (code text, expires_at timestamptz, bot_username text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_code text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_expires timestamptz := now() + interval '10 minutes';
begin
  perform private.require_authorized();
  v_user := private.my_authorized_user_id();
  -- An administrator's deactivation must stick: no new codes until an admin reactivates.
  if exists (select 1 from public.telegram_user_links l where l.authorized_user_id = v_user and not l.is_active) then
    raise exception 'Your Telegram access was deactivated by an administrator. Ask an administrator to reactivate it'
      using errcode = '42501';
  end if;
  -- 64 hex chars from two random UUIDs (244 random bits); Telegram /start accepts up to 64 characters.
  delete from public.telegram_link_codes where authorized_user_id = v_user and used_at is null;
  insert into public.telegram_link_codes (authorized_user_id, code_hash, expires_at)
  values (v_user, encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), v_expires);
  return query select v_code, v_expires, nullif(private.setting_text('telegram_bot_username'), '');
end;
$$;

create function public.get_my_telegram_link()
returns table (telegram_username text, linked_at timestamptz, last_seen_at timestamptz, is_active boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select l.telegram_username, l.linked_at, l.last_seen_at, l.is_active
  from public.telegram_user_links l
  where l.authorized_user_id = private.my_authorized_user_id()
  order by l.is_active desc, l.linked_at desc
  limit 1
$$;

create function public.unlink_my_telegram()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_authorized();
  -- Only an active link can be removed by its owner; a deactivated one stays as a block.
  delete from public.telegram_user_links
  where authorized_user_id = private.my_authorized_user_id() and is_active;
end;
$$;

-- -----------------------------------------------------------------------------
-- Bot functions (service_role only)
-- -----------------------------------------------------------------------------

-- Resolve the Telegram user and act as the linked allow-listed user for the rest
-- of this transaction. Raises TG_NOT_LINKED when the account is unknown, unlinked,
-- deactivated, or the allow-list entry is disabled.
create function private.tg_act(p_telegram_user_id bigint)
returns table (authorized_user_id uuid, email text, display_name text, role public.app_role)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select au.id, au.email, au.display_name, au.role into v
  from public.telegram_user_links l
  join public.authorized_users au on au.id = l.authorized_user_id
  where l.telegram_user_id = p_telegram_user_id and l.is_active and au.is_active;
  if not found then
    raise exception 'TG_NOT_LINKED' using errcode = '42501';
  end if;
  perform set_config('app.acting_email', v.email, true);
  update public.telegram_user_links set last_seen_at = now() where telegram_user_id = p_telegram_user_id;
  return query select v.id, v.email, v.display_name, v.role;
end;
$$;

create function public.tg_claim_update(p_update_id bigint, p_telegram_user_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new boolean;
begin
  insert into public.telegram_processed_updates (update_id, telegram_user_id)
  values (p_update_id, p_telegram_user_id)
  on conflict (update_id) do nothing;
  v_new := found;
  delete from public.telegram_processed_updates where processed_at < now() - interval '7 days';
  return v_new;
end;
$$;

create function public.tg_link_account(p_code text, p_telegram_user_id bigint, p_telegram_username text, p_chat_id bigint)
returns table (display_name text, email text, role public.app_role)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code public.telegram_link_codes;
  v_user public.authorized_users;
begin
  if p_code is null or p_code !~ '^[0-9a-f]{64}$' then
    raise exception 'TG_CODE_INVALID' using errcode = '22023';
  end if;
  select * into v_code from public.telegram_link_codes
  where code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex')
  for update;
  if not found then
    raise exception 'TG_CODE_INVALID' using errcode = '22023';
  end if;
  if v_code.used_at is not null then
    raise exception 'TG_CODE_USED' using errcode = '22023';
  end if;
  if v_code.expires_at < now() then
    raise exception 'TG_CODE_EXPIRED' using errcode = '22023';
  end if;
  select * into v_user from public.authorized_users where id = v_code.authorized_user_id;
  if not v_user.is_active then
    raise exception 'TG_USER_INACTIVE' using errcode = '42501';
  end if;
  -- Links deactivated by an administrator (for this user or this Telegram account) block relinking.
  if exists (
    select 1 from public.telegram_user_links l
    where not l.is_active and (l.authorized_user_id = v_user.id or l.telegram_user_id = p_telegram_user_id)
  ) then
    raise exception 'TG_LINK_DEACTIVATED' using errcode = '42501';
  end if;

  update public.telegram_link_codes
  set used_at = now(), used_by_telegram_user_id = p_telegram_user_id
  where id = v_code.id;

  -- One Telegram account per user and one user per Telegram account.
  delete from public.telegram_user_links
  where telegram_user_id = p_telegram_user_id or authorized_user_id = v_user.id;
  insert into public.telegram_user_links (authorized_user_id, telegram_user_id, telegram_username, telegram_chat_id)
  values (v_user.id, p_telegram_user_id, left(p_telegram_username, 64), p_chat_id);

  return query select v_user.display_name, v_user.email, v_user.role;
end;
$$;

create function public.tg_whoami(p_telegram_user_id bigint)
returns table (email text, display_name text, role public.app_role)
language sql
security definer
set search_path = ''
as $$
  select a.email, a.display_name, a.role from private.tg_act(p_telegram_user_id) a
$$;

create function public.tg_list_categories(p_telegram_user_id bigint)
returns table (id uuid, name text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.tg_act(p_telegram_user_id);
  perform private.require_authorized();
  return query
    select c.id, c.name from public.product_categories c
    where exists (select 1 from public.products p where p.category_id = c.id and not p.is_non_stock)
       or exists (select 1 from public.products p
                  join public.stock_items s on s.product_id = p.id and not s.is_obsolete
                  where p.category_id = c.id)
    order by c.name;
end;
$$;

-- p_mode: 'add' (stock products in the category), 'adjust' (products with active
-- batches), 'sale' (products that can be sold now). Search matches code/description/brand.
create function public.tg_list_products(
  p_telegram_user_id bigint,
  p_mode text,
  p_category_id uuid default null,
  p_search text default null
)
returns table (
  product_id uuid, item_code text, description text, brand text, category_name text,
  unit text, is_non_stock boolean, available bigint, batch_count bigint,
  last_unit_cost numeric, last_agreed_price numeric
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pattern text;
begin
  perform private.tg_act(p_telegram_user_id);
  perform private.require_authorized();
  if p_mode not in ('add', 'adjust', 'sale') then
    raise exception 'Invalid mode' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_search, '')), '') is not null then
    v_pattern := '%' || replace(replace(replace(left(btrim(p_search), 60), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  with batches as (
    select s.product_id,
           sum(s.quantity) filter (where not s.is_obsolete) as available,
           count(*) filter (where not s.is_obsolete) as batch_count
    from public.stock_items s
    group by s.product_id
  ),
  latest as (
    select distinct on (s.product_id) s.product_id, s.unit_cost, s.agreed_price
    from public.stock_items s
    order by s.product_id, s.purchased_date desc nulls last, s.created_at desc
  )
  select p.id, p.item_code, p.description, p.brand, c.name, p.unit, p.is_non_stock,
         coalesce(b.available, 0)::bigint, coalesce(b.batch_count, 0)::bigint,
         l.unit_cost, l.agreed_price
  from public.products p
  join public.product_categories c on c.id = p.category_id
  left join batches b on b.product_id = p.id
  left join latest l on l.product_id = p.id
  where (p_category_id is null or p.category_id = p_category_id)
    and (v_pattern is null or p.item_code ilike v_pattern or p.description ilike v_pattern or p.brand ilike v_pattern)
    and case p_mode
          when 'add' then not p.is_non_stock
          when 'adjust' then not p.is_non_stock and coalesce(b.batch_count, 0) > 0
          else coalesce(b.batch_count, 0) > 0 and (p.is_non_stock or coalesce(b.available, 0) > 0)
        end
  order by p.item_code, p.description, p.brand nulls first
  limit 20;
end;
$$;

-- Active batches of a product in FIFO order (earliest purchase first).
create function public.tg_list_batches(p_telegram_user_id bigint, p_product_id uuid)
returns table (
  stock_item_id uuid, purchased_date date, quantity integer, unit_cost numeric, agreed_price numeric,
  fifo_rank bigint, item_code text, description text, is_non_stock boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.tg_act(p_telegram_user_id);
  perform private.require_authorized();
  return query
    select s.id, s.purchased_date, s.quantity, s.unit_cost, s.agreed_price,
           row_number() over (order by s.purchased_date asc nulls last, s.created_at, s.id),
           p.item_code, p.description, p.is_non_stock
    from public.stock_items s
    join public.products p on p.id = s.product_id
    where s.product_id = p_product_id and not s.is_obsolete
    order by s.purchased_date asc nulls last, s.created_at, s.id
    limit 20;
end;
$$;

-- Preview via the web app's own preview_sale_line() (same calculation).
create function public.tg_preview_sale(
  p_telegram_user_id bigint, p_stock_item_id uuid, p_quantity integer, p_actual_price numeric, p_sale_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
begin
  perform private.tg_act(p_telegram_user_id);
  select to_jsonb(p) into v_row
  from public.preview_sale_line(p_stock_item_id, p_quantity, p_actual_price, p_sale_date) p;
  return v_row;
end;
$$;

-- Execute the pending action stored in the user's session. The nonce must match
-- the confirmation button, so a repeated tap or an old button cannot run it twice.
-- Runs in one transaction: if the operation fails, the session is not consumed.
create function public.tg_execute(p_telegram_user_id bigint, p_nonce text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state jsonb;
  v_pending jsonb;
  v_p jsonb;
  v_result jsonb;
  v_product public.products;
  v_stock_id uuid;
  v_sale_id uuid;
  v_adj public.stock_adjustments;
  v_line record;
begin
  perform private.tg_act(p_telegram_user_id);

  select state into v_state from public.telegram_sessions where telegram_user_id = p_telegram_user_id for update;
  if v_state is null then
    return jsonb_build_object('status', 'expired');
  end if;
  if v_state ->> 'last_nonce' = p_nonce then
    return jsonb_build_object('status', 'already_done', 'result', v_state -> 'last_result');
  end if;
  v_pending := v_state -> 'pending';
  if v_pending is null or v_state ->> 'nonce' is distinct from p_nonce then
    return jsonb_build_object('status', 'expired');
  end if;
  if (v_state ->> 'expires_at')::timestamptz < now() then
    return jsonb_build_object('status', 'expired');
  end if;
  v_p := v_pending -> 'payload';

  case v_pending ->> 'action'
    when 'add_stock' then
      select * into v_product from public.products where id = (v_p ->> 'product_id')::uuid;
      if not found then
        raise exception 'Item not found' using errcode = 'P0002';
      end if;
      v_stock_id := public.add_stock_item(
        v_product.category_id, v_product.item_code, v_product.description, v_product.brand, v_product.unit,
        v_product.is_non_stock, (v_p ->> 'purchased_date')::date, (v_p ->> 'unit_cost')::numeric,
        (v_p ->> 'agreed_price')::numeric, (v_p ->> 'quantity')::integer, null, 'Added via Telegram');
      v_result := jsonb_build_object('status', 'ok', 'action', 'add_stock', 'quantity', (v_p ->> 'quantity')::integer);

    when 'adjust_stock' then
      select * into v_adj from public.adjust_stock(
        (v_p ->> 'stock_item_id')::uuid, (v_p ->> 'adjustment_type')::public.stock_adjustment_type,
        (v_p ->> 'quantity')::integer, v_p ->> 'reason', (v_p ->> 'expected_quantity')::integer);
      v_result := jsonb_build_object('status', 'ok', 'action', 'adjust_stock',
                                     'previous_quantity', v_adj.previous_quantity, 'new_quantity', v_adj.new_quantity);

    when 'sale' then
      v_sale_id := public.create_sale(
        (v_p ->> 'sale_date')::date,
        jsonb_build_array(jsonb_build_object(
          'stock_item_id', v_p ->> 'stock_item_id',
          'quantity', (v_p ->> 'quantity')::integer,
          'actual_price', (v_p ->> 'actual_price')::numeric)),
        'Recorded via Telegram');
      select si.stock_after, si.revenue, si.gross_profit, si.partner_a_share, si.partner_b_share, si.price_alert
      into v_line from public.sale_items si where si.sale_id = v_sale_id;
      v_result := jsonb_build_object('status', 'ok', 'action', 'sale', 'sale_id', v_sale_id,
                                     'stock_after', v_line.stock_after, 'revenue', v_line.revenue,
                                     'price_alert', v_line.price_alert);
    else
      raise exception 'Unknown action' using errcode = '22023';
  end case;

  update public.telegram_sessions
  set state = jsonb_build_object('last_nonce', p_nonce, 'last_result', v_result), updated_at = now()
  where telegram_user_id = p_telegram_user_id;
  return v_result;
end;
$$;

-- -----------------------------------------------------------------------------
-- Audit: ignore the per-message last_seen_at heartbeat (otherwise unchanged)
-- -----------------------------------------------------------------------------
create or replace function private.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_changed text[];
begin
  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key) into v_changed
    from jsonb_each(v_new) n
    where n.value is distinct from v_old -> n.key
      and n.key not in ('updated_at', 'updated_by', 'last_seen_at');
    if v_changed is null then
      return new;  -- nothing meaningful changed
    end if;
  end if;

  insert into public.audit_logs (table_name, record_id, action, old_data, new_data, changed_fields, actor_id, actor_label)
  values (
    tg_table_name,
    coalesce(v_new ->> 'id', v_new ->> 'key', v_old ->> 'id', v_old ->> 'key'),
    tg_op,
    v_old,
    v_new,
    v_changed,
    auth.uid(),
    private.actor_label()
  );
  return coalesce(new, old);
end;
$$;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
revoke execute on function
  public.tg_claim_update(bigint, bigint),
  public.tg_link_account(text, bigint, text, bigint),
  public.tg_whoami(bigint),
  public.tg_list_categories(bigint),
  public.tg_list_products(bigint, text, uuid, text),
  public.tg_list_batches(bigint, uuid),
  public.tg_preview_sale(bigint, uuid, integer, numeric, date),
  public.tg_execute(bigint, text)
from public, anon, authenticated;

grant execute on function
  public.tg_claim_update(bigint, bigint),
  public.tg_link_account(text, bigint, text, bigint),
  public.tg_whoami(bigint),
  public.tg_list_categories(bigint),
  public.tg_list_products(bigint, text, uuid, text),
  public.tg_list_batches(bigint, uuid),
  public.tg_preview_sale(bigint, uuid, integer, numeric, date),
  public.tg_execute(bigint, text)
to service_role;

revoke execute on function private.tg_act(bigint) from public, anon, authenticated;
revoke execute on function private.my_authorized_user_id(), private.setting_text(text) from public, anon;

revoke execute on function
  public.create_telegram_link_code(), public.get_my_telegram_link(), public.unlink_my_telegram()
from public, anon;
grant execute on function
  public.create_telegram_link_code(), public.get_my_telegram_link(), public.unlink_my_telegram()
to authenticated;
