-- =============================================================================
-- 006 Bootstrap the first administrator
-- =============================================================================
-- RLS only lets admins manage the allow-list, so the first admin must be created
-- outside the app. Further users are managed in the Admin page or with
-- python/scripts/manage_users.py. Idempotent: an existing entry is left as is.

insert into public.authorized_users (email, display_name, role, is_active)
values ('kalimotormalihah@gmail.com', 'KaLi Motor', 'admin', true)
on conflict do nothing;
