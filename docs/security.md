# Security

## Model

- **Anonymous visitors:** no table, view or function privileges at all.
- **Signed in (any Google account):** data only when `private.is_authorized()` is true. That means the verified email is on the active allow-list.
- **Row Level Security** is enabled on every table.
- **Column-level grants** restrict which columns a role may update. Nobody can set `stock_items.quantity` directly, for example.
- **Writes that must stay consistent** (sales, stock quantities, settlements) go only through `SECURITY DEFINER` functions. These:
  1. check the role
  2. validate input
  3. lock rows
  4. read prices, costs and rates from the database
  5. write history and an audit trail
- **SECURITY DEFINER functions** use `set search_path = ''` and fully qualified names.
- **Helper functions** live in a `private` schema that the REST API does not expose.

## Pre-completion security review

Each item was verified by an automated test in [`python/tests/test_security.py`](../python/tests/test_security.py) or [`test_stock_and_sales.py`](../python/tests/test_stock_and_sales.py). The tests run as the real `anon` and `authenticated` roles with Supabase-style JWT claims, against the actual migrations, in CI.

| # | Question | Result | Evidence |
|---|---|---|---|
| 1 | Can an unauthenticated user access data? | **No.** Permission denied on every table and function | `test_anonymous_cannot_read_anything`, `test_anonymous_cannot_call_functions` |
| 2 | Can an unauthorized Gmail account access the system? | **No.** Zero rows, every RPC refused; unverified and disabled accounts too | `test_unauthorized_logins_see_no_data_and_cannot_write` |
| 3 | Can a normal user modify admin-only data? | **No.** Rules, users, settings, inventory, prices and voids are all refused | `test_user_cannot_modify_partner_rules`, `test_inventory_is_admin_only_for_writes`, `test_settings_admin_only_and_validated`, `test_void_sale_admin_only…` |
| 4 | Can a user bypass the UI by calling Supabase directly? | **No.** The tests *are* direct API-level calls | all of the above |
| 5 | Can a user modify partner rules? | **No** (admin only) | `test_user_cannot_modify_partner_rules` |
| 6 | Can a user modify other users' records improperly? | **No.** Sales and history are immutable for everyone; `created_by` cannot be supplied | `test_clients_cannot_write_sales_or_history_directly`, `test_created_by_cannot_be_spoofed` |
| 7 | Can stock quantity become invalid? | **No.** Never negative (unless configured); only changed via functions with history; stale updates rejected; concurrent sales serialized | `test_nobody_can_set_stock_quantity_directly`, `test_stale_expected_quantity_is_rejected`, `test_concurrent_sales_do_not_lose_updates` |
| 8 | Can negative sales quantities be submitted? | **No** | `test_invalid_sales_rejected` |
| 9 | Can invalid prices be submitted? | **No.** Negative, non-numeric or out-of-range values are refused; agreed price, cost and rates always come from the database | `test_invalid_sales_rejected`, `test_client_supplied_prices_and_rates_are_ignored` |
| 10 | Can service-role credentials reach the browser? | **No.** The service-role key is not used anywhere; the frontend reads only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` | code search; `.env.example` |
| 11 | Are RLS policies enabled? | **Yes, on all 16 tables** | [005_security.sql](../supabase/migrations/20260930000005_security.sql) |
| 12 | Are RLS policies actually restrictive? | **Yes.** Default deny, explicit per-role policies and column grants | tests 1–9 |
| 13 | Can users access records they should not see? | **No.** The allow-list and audit log are admin-only | `test_user_cannot_read_or_change_the_allow_list`, `test_audit_log_visible_to_admin_only` |
| 14 | Can financial calculations be manipulated from the browser? | **No.** Computed in SQL from database values; CHECK constraints enforce revenue/cost/GP/share invariants | `test_client_supplied_prices_and_rates_are_ignored`, calculation tests |
| 15 | Are audit records protected? | **Yes.** No client write privileges; written only by triggers | `test_clients_cannot_write_sales_or_history_directly` |
| 16 | Are secrets excluded from Git? | **Yes.** `.gitignore` covers `.env*` and the workbook; no secrets in the repo; CI uses GitHub secrets | `.gitignore`, workflow files |

## Other threats considered

| Threat | Mitigation |
|---|---|
| SQL injection | Only parameterised PostgREST/RPC calls and psycopg parameters; no string-built SQL. Search text is stripped of PostgREST filter syntax (`lib/search.ts`, tested). |
| XSS | React escapes all output; no `dangerouslySetInnerHTML`; no HTML from the database. |
| CSRF | No cookies: the Supabase session is a bearer token sent by the client, so there is no ambient credential for a CSRF attack to use. |
| Mass assignment | Column-level grants plus triggers that overwrite `created_by` / `updated_by`; RPCs accept only named fields. |
| Privilege escalation | Role changes are admin-only (RLS); the last admin cannot be demoted; roles are read from the database, never from JWT metadata. |
| Unverified email claiming an allowed address | Access requires `email_confirmed_at`; email sign-ups are disabled (Google only). |
| Race conditions | Row locks in `create_sale`/`void_sale`; lost-update guard in `adjust_stock`; advisory lock for rule overlap checks. |
| Error leakage | `lib/errors.ts` shows only our own validation messages; technical details go to the console, never to users. |

## Residual risks and recommendations

- **Anon key:** public by design. Supabase rate limits apply; consider enabling CAPTCHA or Attack Protection in the Supabase dashboard.
- **Backups:** Free-tier projects pause after inactivity and have limited backups. Export periodically: `pg_dump` with `DATABASE_URL`.
- **Admin accounts:** protect them with Google 2-Step Verification.
