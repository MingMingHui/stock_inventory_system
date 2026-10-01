# Enhancement analysis (October 2026)

This document records how the existing application works **before** the enhancement, where each new feature plugs in, and the root causes of the issues being fixed. The analysis covers the repository at commit `508255e` and the hosted database `sywmicrngyvojjdayhhc` (PostgreSQL 17, timezone UTC) on 2026-10-01.

## 1. Existing architecture

```text
Browser (React 19 + Vite, GitHub Pages, HashRouter)
   │  supabase-js: PostgREST queries + RPC, anon key + user JWT (Google OAuth, PKCE)
   ▼
Supabase PostgreSQL
   ├─ RLS on all 16 tables, default deny, column-level grants
   ├─ SECURITY DEFINER functions for every multi-step write
   └─ audit triggers on business tables
Python (local only): import_excel.py, validate_import.py, manage_users.py
GitHub Actions: ci.yml (PR) → deploy.yml (main: CI → build → Pages)
```

The project has no backend server, no Edge Functions and no Telegram code.

## 2. Relevant files

| Area | Files |
|---|---|
| Migrations | `supabase/migrations/20260930000001…007` |
| Auth helpers | `001_foundation.sql`: `private.current_email()`, `current_app_role()`, `is_authorized()`, `is_admin()`, `require_*()`, `actor_label()` |
| Stock functions | `002_catalog_and_stock.sql`: `add_stock_item`, `adjust_stock`, `set_stock_min_quantity`, `set_stock_obsolete`, `stock_items_view` |
| Sales functions | `003_sales.sql`: `calculate_sale_line`, `price_drop_check`, `preview_sale_line`, `create_sale`, `void_sale`, `sales_log_view` |
| Reporting | `004_settlement.sql`: `partner_summary_by_category`, `settlement_summary`, `dashboard_stats`, `finalize_settlement`… |
| RLS / grants | `005_security.sql` |
| Frontend services | `src/services/{stock,sales,summary,reference,rules,inventory,admin}.ts` |
| Stock UI | `src/features/stock/{StockMasterPage,StockForms,StockHistory}.tsx` |
| Sales UI | `src/features/sales/{SalesLogPage,SaleForm}.tsx` |
| Navigation | `src/lib/navigation.ts`, `src/components/Layout.tsx`, `src/App.tsx` |
| Tests | `python/tests/*` (DB, RLS, calculations, import), `src/**/*.test.tsx` |

## 3. Functions responsible for each operation

| Operation | Function | Notes |
|---|---|---|
| Stock creation | `public.add_stock_item()` | creates the product if needed, inserts the batch, records an `initial` adjustment |
| Stock adjustment / quantity update | `public.adjust_stock()` | receive / stock_check / amendment; row lock; lost-update guard (`p_expected_quantity`); history row |
| Stock "duplication" | none | a new batch of an existing product (same code + description + brand + category) is created by `add_stock_item`; batches are never merged |
| Stock obsolete status | `public.set_stock_obsolete()` | manual flag + `obsolete_at`; obsolete batches cannot be sold |
| Sales creation | `public.create_sale(date, jsonb, text)` | one header + 1–50 lines, row locks in id order, stock decrement, history |
| Bulk sales creation | the same `create_sale()`, with many lines in one call (the SaleForm "cart"); the Excel import inserts one header with 14 lines | |
| Void sale | `public.void_sale(sale_id, reason)` | admin only; voids the **whole header**; restores stock for `source = 'app'` |
| Partner calculation | `public.calculate_sale_line()` | single source of truth; `preview_sale_line()` and `create_sale()` call it |
| User authorization | `private.is_authorized()` | verified email (`auth.users.email_confirmed_at`) on the active allow-list |
| Admin authorization | `private.is_admin()` / `require_admin()` | |

## 4. Existing business rules relevant to the enhancement

- Partner shares split **revenue** (see business-rules.md). This is unchanged by the enhancement.
- A stock row is a purchase batch. Product identity is (item code, description, brand, category).
- `products.is_non_stock` marks service items (Excel `-1`), whose quantity is never tracked.
- An obsolete batch cannot be sold; obsolete is a flag, never a deletion.
- A sale cannot be dated in the future or fall in a finalized month.

## 5. Existing RLS policies (summary)

- Authorized users can SELECT all business tables.
- Admin-only writes: users, settings, rules, categories, inventory, expenses, product master data, and stock price/cost.
- Nobody (not even admins) can write `stock_items.quantity`, `sales`, `sale_items`, `stock_adjustments`, `audit_logs` or `monthly_settlements` directly.
- `audit_logs` and `authorized_users` are readable by admins only.

## 6. Root cause: "Void Sale only on the first item of a bulk sale"

Checked against production data. Sale `64160b10…` (2026-10-01 03:22 UTC) has **15 lines in one sales header**, and the imported August log has 14 lines in one header.

- **UI:** `SalesLogPage.tsx` renders the button only when `r.line_no === 1`.
- **Database:** `void_sale(p_sale_id)` voids the entire header, and `sales_log_view.is_void` comes from the header.

The single button was deliberate under the old model ("void the whole sale"), but it means **one click voids every line** and no line can be voided on its own. It is not caused by React keys (`sale_items.id` is unique), by the insert result, or by shared state.

**Fix:** line-level void.
- Add `sale_items.is_void / voided_at / voided_by / voided_by_label / void_reason`.
- Add a new `void_sale_item(p_sale_item_id, p_reason)` that locks the line and restores **only that line's** stock.
- Exclude voided lines from every report.
- Keep `void_sale()` working for whole sales, so it never restores a line that was already voided.

## 7. Root cause: business dates use the database's UTC date

`create_sale`, `add_stock_item` and `finalize_settlement` compare against `current_date`, which is UTC on Supabase. From 00:00 to 07:59 Malaysian time, today's sales are rejected as "in the future", and the "completed month" boundary is 8 hours late.

**Fix:** a single `private.business_today()` that returns `(now() at time zone 'Asia/Kuala_Lumpur')::date`, used by every rule that needs "today". Business dates (`sale_date`, `purchased_date`) are `date` values in Malaysian time, so aggregation by `date_trunc('month', sale_date)` needs no conversion.

## 8. Integration points for the new functionality

| Feature | Integration point |
|---|---|
| Line-level void | new columns on `sale_items`; `void_sale_item()`; replace the reporting functions and `sales_log_view` (columns appended, never removed, so the deployed frontend keeps working) |
| Auto-obsolete | new `stock_items.obsolete_remarks`; trigger on `stock_items` (insert, or update of quantity / purchase date) calling `private.apply_auto_obsolete(product_id)`; audit trigger already records the change |
| FIFO | ordering `purchased_date ASC NULLS LAST, created_at`; `stock_items_view.fifo_rank`; sale search and Telegram lists use it |
| Telegram | Supabase Edge Function `telegram-webhook` (Deno), called by Telegram over HTTPS with a secret header. It talks to the database through new `tg_*` SECURITY DEFINER functions, callable by `service_role` only, which map the Telegram user to an allow-listed user and then call the **existing** `add_stock_item` / `adjust_stock` / `preview_sale_line` / `create_sale` under that user's identity. `private.current_email()` gains a service-role-only "acting user", so all existing authorization and calculations are reused unchanged |
| Analytics | new SQL functions `analytics_monthly`, `analytics_items`, `analytics_categories` (GROUP BY in PostgreSQL); admin-only; new admin-only tab |

## 9. Constraints

- Deployed frontend compatibility: the migrations only **add** columns, functions and views. Existing function signatures are kept.
- Calculations: `calculate_sale_line()` and `price_drop_check()` are not modified.
- No new frontend dependencies (charts are plain SVG/CSS).
