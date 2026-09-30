# Authentication and authorization

## Flow

1. The user clicks **Sign in with Google**, which calls `supabase.auth.signInWithOAuth({ provider: 'google' })` with the **PKCE** flow.
2. Google authenticates the user; Supabase creates or updates `auth.users` and returns to the app with `?code=`, which supabase-js exchanges for a session.
3. The app calls `get_my_access()`. The database looks up the caller's **verified** email (`auth.users.email_confirmed_at` is set) in `authorized_users` where `is_active`.
4. No entry means the app shows *Access denied* and offers sign-out. The Google login grants nothing on its own: every table and function checks the allow-list, so the account would read zero rows and every write or RPC would fail.

**Authentication ≠ authorization.** Any Google account can authenticate; only allow-listed accounts are authorized.

## Gmail addresses

Gmail ignores dots, so `kalimotor.malihah@gmail.com` and `kalimotormalihah@gmail.com` are the same mailbox, and Google may report either spelling. `private.normalize_email()` removes dots in the local part of `gmail.com` / `googlemail.com` addresses when matching, and the allow-list allows only one entry per mailbox. Other domains match exactly (case-insensitive).

## Roles

| Capability | user | admin |
|---|---|---|
| View rules, inventory, stock, sales, summary | ✓ | ✓ |
| Add stock, receive, stock check, amend quantity, set minimum, mark obsolete | ✓ | ✓ |
| Record sales | ✓ | ✓ |
| Edit stock cost / agreed price / purchase date | | ✓ |
| Edit partner rules, categories, inventory list | | ✓ |
| Void sales | | ✓ |
| Manage expenses, finalize or reopen months | | ✓ |
| Manage users, settings; view audit log and price alerts | | ✓ |

These are enforced in the database (see [security.md](security.md)); the UI only hides what a role cannot do.

## Initial administrator

Migration `20260930000006_bootstrap_admin.sql` adds **kalimotormalihah@gmail.com** as the first admin. More users are added in **Admin → Users** or with [`manage_users.py`](user-management.md).

## Google OAuth setup

1. **Google Cloud Console** → APIs & Services → OAuth consent screen: External; app name; support email.
2. Credentials → **Create OAuth client ID** → *Web application*.
   - Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`
3. **Supabase Dashboard** → Authentication → Providers → **Google**: enable and paste the client ID and secret.
4. Supabase → Authentication → **URL Configuration**:
   - Site URL: `https://mingminghui.github.io/stock_inventory_system/`
   - Redirect URLs: the site URL and `http://localhost:5173/` (development).
5. Supabase → Authentication → Providers → **Email**: **disable sign-ups**, so Google is the only sign-in method.

The Google client secret is stored only in Supabase. It never appears in this repository or the frontend.
