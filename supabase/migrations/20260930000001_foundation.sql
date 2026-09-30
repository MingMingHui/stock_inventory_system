-- =============================================================================
-- 001 Foundation: private schema, enums, authorized users, settings, auditing
-- =============================================================================
-- Objects in the `private` schema are NOT exposed through the Supabase REST API
-- (only `public` is). Helper functions used by RLS policies live there.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type public.app_role as enum ('admin', 'user');

-- Values are kept identical to the Excel Partner_Rule_Table "Rule Type" column.
create type public.rule_type as enum (
  'Fixed_Per_Unit',
  'Fixed_Per_Job',
  'Fixed_Per_Service',
  'Shared_50'
);

create type public.stock_adjustment_type as enum (
  'initial',       -- opening quantity when a stock item is created
  'receive',       -- new stock received
  'stock_check',   -- physical count at stock check
  'amendment',     -- correction of a previous figure
  'sale',          -- decrement caused by a sale
  'sale_void'      -- increment caused by voiding a sale
);

create type public.inventory_status as enum ('ACTIVE', 'UNDER_REPAIR', 'INACTIVE', 'DISPOSED');

create type public.sale_source as enum ('app', 'excel_import');

-- -----------------------------------------------------------------------------
-- Generic triggers
-- -----------------------------------------------------------------------------
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Sets created_by / updated_by from the JWT so clients cannot spoof them
-- (mass-assignment protection).
create function private.set_actor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  else
    new.created_by := old.created_by;
  end if;
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Authorized users (the allow-list; Google login alone grants nothing)
-- -----------------------------------------------------------------------------
create table public.authorized_users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique
                check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  display_name  text check (char_length(display_name) <= 120),
  role          public.app_role not null default 'user',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid,
  updated_by    uuid
);

comment on table public.authorized_users is
  'Allow-list of Google accounts permitted to use the application. Matched on verified email.';

create trigger authorized_users_updated_at before update on public.authorized_users
  for each row execute function private.set_updated_at();
create trigger authorized_users_actor before insert or update on public.authorized_users
  for each row execute function private.set_actor();

-- Canonical form used for allow-list matching. Gmail ignores dots in the local
-- part (kalimotor.malihah@gmail.com = kalimotormalihah@gmail.com), and Google may
-- report either spelling; other domains are compared exactly (lower-cased).
create function private.normalize_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(lower(btrim(p_email)), '@', 2) in ('gmail.com', 'googlemail.com')
      then replace(split_part(lower(btrim(p_email)), '@', 1), '.', '') || '@gmail.com'
    else lower(btrim(p_email))
  end
$$;

-- One allow-list entry per mailbox.
create unique index authorized_users_mailbox_key on public.authorized_users (private.normalize_email(email));

-- Verified email of the caller, read from auth.users (not from client-editable metadata).
create function private.current_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(u.email)
  from auth.users u
  where u.id = auth.uid()
    and u.email_confirmed_at is not null
$$;

create function private.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select au.role
  from public.authorized_users au
  where private.normalize_email(au.email) = private.normalize_email(private.current_email())
    and au.is_active
$$;

create function private.is_authorized()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_app_role() is not null
$$;

create function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.current_app_role() = 'admin', false)
$$;

create function private.require_authorized()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not private.is_authorized() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
end;
$$;

create function private.require_admin()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
end;
$$;

grant execute on function
  private.current_email(),
  private.current_app_role(),
  private.is_authorized(),
  private.is_admin()
to authenticated;

-- Actor label for audit rows: verified email, else a label set by maintenance
-- scripts (app.actor), else the database session user.
create function private.actor_label()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.current_email(),
    nullif(current_setting('app.actor', true), ''),
    'db:' || session_user
  )
$$;

-- Never allow the last active admin to be removed, demoted or disabled.
create function private.guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'admin' and old.is_active
     and (tg_op = 'DELETE' or new.role <> 'admin' or not new.is_active) then
    if not exists (
      select 1 from public.authorized_users
      where role = 'admin' and is_active and id <> old.id
    ) then
      raise exception 'Cannot remove, disable or demote the last active administrator'
        using errcode = '23514';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger authorized_users_last_admin
  before update or delete on public.authorized_users
  for each row execute function private.guard_last_admin();

-- Returns the caller's own access record (empty when not authorized).
create function public.get_my_access()
returns table (email text, display_name text, role public.app_role)
language sql
stable
security definer
set search_path = ''
as $$
  select au.email, au.display_name, au.role
  from public.authorized_users au
  where private.normalize_email(au.email) = private.normalize_email(private.current_email())
    and au.is_active
$$;

-- -----------------------------------------------------------------------------
-- Application settings (typed key/value configuration)
-- -----------------------------------------------------------------------------
create table public.app_settings (
  key          text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  value        text not null,
  value_type   text not null check (value_type in ('integer', 'numeric', 'boolean')),
  description  text not null,
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  check (
    (value_type = 'integer' and value ~ '^-?[0-9]+$')
    or (value_type = 'numeric' and value ~ '^-?[0-9]+(\.[0-9]+)?$')
    or (value_type = 'boolean' and value in ('true', 'false'))
  )
);

create trigger app_settings_updated_at before update on public.app_settings
  for each row execute function private.set_updated_at();

create function private.set_settings_actor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_by := auth.uid();
  new.value_type := old.value_type;  -- type is fixed by migrations
  new.key := old.key;
  return new;
end;
$$;

create trigger app_settings_actor before update on public.app_settings
  for each row execute function private.set_settings_actor();

insert into public.app_settings (key, value, value_type, description) values
  ('low_stock_default_threshold', '1', 'integer',
   'Default minimum quantity. A stock item is LOW_STOCK when quantity <= its minimum (item value, else this default).'),
  ('price_drop_alert_threshold', '0.10', 'numeric',
   'Raise a price alert when actual price <= agreed price x (1 - threshold). 0.10 = 10%.'),
  ('allow_negative_stock', 'false', 'boolean',
   'When false, sales and adjustments may not take a stock item below zero.');

create function private.setting_numeric(p_key text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select value::numeric from public.app_settings where key = p_key
$$;

create function private.setting_boolean(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select value::boolean from public.app_settings where key = p_key
$$;

grant execute on function private.setting_numeric(text), private.setting_boolean(text) to authenticated;

-- -----------------------------------------------------------------------------
-- Audit log (append-only; written only by triggers)
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id              bigint generated always as identity primary key,
  table_name      text not null,
  record_id       text,
  action          text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_data        jsonb,
  new_data        jsonb,
  changed_fields  text[],
  actor_id        uuid,
  actor_label     text not null,
  occurred_at     timestamptz not null default now()
);

create index audit_logs_table_record_idx on public.audit_logs (table_name, record_id);
create index audit_logs_occurred_at_idx on public.audit_logs (occurred_at desc);

create function private.audit_row()
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
      and n.key not in ('updated_at', 'updated_by');
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

create trigger authorized_users_audit after insert or update or delete on public.authorized_users
  for each row execute function private.audit_row();
create trigger app_settings_audit after insert or update or delete on public.app_settings
  for each row execute function private.audit_row();
