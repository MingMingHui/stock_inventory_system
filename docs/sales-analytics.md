# Sales analytics

The **Sales Analytics** tab is for administrators only. All figures are aggregated **in PostgreSQL** with `GROUP BY` / `SUM` / `COUNT` / `date_trunc`. The browser receives one row per month, category or item, never individual sales. The functions are in [`…011_sales_analytics.sql`](../supabase/migrations/20261001000011_sales_analytics.sql), and every rule below is plain SQL that can be read there.

Only non-voided lines of non-voided sales count. Sales imported from the Excel August log count like any other sale; they are dated 31 Aug 2026.

## Dates and timezone

- `sale_date` and `purchased_date` are **Malaysian calendar dates** (`date` type, no time).
- Months are `date_trunc('month', sale_date)`, so there is no timezone conversion and no shift across month or year boundaries.
- "Today" and "this month" come from `private.business_today()` = `(now() at time zone 'Asia/Kuala_Lumpur')::date`. The database server runs in UTC, so this is never left to the browser or to `current_date`.
- The observation window is whole calendar months ending with the selected month, and works across years (e.g. Nov 2025 → Apr 2026).

## Metrics

| Metric | Definition |
|---|---|
| Units sold | `SUM(quantity)` |
| Revenue | `SUM(revenue)` (actual price × quantity, as stored on each sale line) |
| Gross profit | `SUM(gross_profit)` |
| Number of sales / transactions | number of sale **lines**. The imported Excel log is one aggregate line per item per month. |
| Average selling price | revenue ÷ units |
| Average sale value (monthly) | revenue ÷ sale lines |
| Months with sales | months in the window with units > 0 |
| Units recent | units in the last **3** months of the window |
| Current stock | sum of quantities of the item's active (non-obsolete) batches |
| Inventory age | purchase date of the oldest active batch that still has stock |

## Classification

Window: **W** months (3, 6 or 12; default 6). An item is included when it sold in the window or has stock now.

| Class | Rule (all conditions) |
|---|---|
| **BEST SELLER** | in the **top 20%** of items that sold, **by units or by revenue** (rank ≤ max(1, ⌈0.2 × items that sold⌉); ties at the cut-off are included) **and** sold in at least **⌈W/2⌉ months** (consistency) |
| **LOW SELLER** | current stock **> 0**, **and** ≤ **1 unit** sold in the last 3 months, **and** at least **⌈W/2⌉ months without sales** in the window, **and** the oldest stocked batch was bought **≥ 90 days** before the end of the window (new stock is never flagged) |
| **NORMAL** | everything else |

A single month without sales never makes an item a low seller. It needs at least half the window without sales plus almost no recent sales.

## Patterns

Rules are evaluated top to bottom; the first that matches wins.

| Pattern | Rule |
|---|---|
| **NO RECENT SALES** | 0 units in the last 3 months |
| **SEASONAL** | in the last 24 months, split into two 12-month years: each year has ≥ 3 units, its best month holds ≥ 40% of that year's units, and the best month is the same calendar month in both years (± 1 month) |
| **SPORADIC** | sold in fewer than ⌈W/2⌉ months |
| **GROWING** | average monthly units in the newer half of the window ≥ 1.25 × the older half (and higher) |
| **DECLINING** | newer half ≤ 0.75 × older half |
| **STABLE** | otherwise |

The halves are the first ⌊W/2⌋ and the last ⌊W/2⌋ months; the middle month is ignored when W is odd.

## Thresholds

| Threshold | Value | Where |
|---|---|---|
| Observation window | 3 / 6 / 12 months (default 6; the function accepts 3–24) | page selector → `p_months` |
| Recent period | 3 months | `p_recent_months` |
| Best seller share | top 20% | SQL |
| Consistency | sold in ≥ ⌈W/2⌉ months | SQL |
| Low-seller recent sales | ≤ 1 unit | SQL |
| Inventory age | ≥ 90 days | SQL |
| Growing / declining | ×1.25 / ×0.75 | SQL |
| Seasonal | ≥ 3 units per year, peak ≥ 40%, ± 1 month | SQL |

## Charts

The charts are plain SVG/CSS (no charting library), each with a text alternative, and the figures also appear in tables:

1. Monthly revenue
2. Top-selling items (revenue)
3. Low sellers
4. Sales by category

## Performance

- `analytics_*` functions aggregate in the database and return at most one row per month, category or item.
- They use the existing indexes `sales(sale_date)`, `sale_items(sale_id)`, `sale_items(product_id)`, `sale_items(category_id)`, plus the partial index `sale_items(sale_id) WHERE NOT is_void` (migration 008).
- No materialized views are needed at the current volume (hundreds of lines per month). Revisit if sale lines reach several hundred thousand.

## Limitations

- History starts with the imported August 2026 log (earlier months were not imported), so patterns and the best-seller consistency rule become meaningful after **3–6 months** of app data. **SEASONAL** needs about 2 years.
- The imported August log stores one aggregate line per item, so its "number of sales" understates the real number of customer transactions.
- Services (battery charging, tyre change) are analysed by units like products, but never become low sellers because they have no stock.
- Classifications describe sales **activity**, not profitability. Check gross profit alongside them.
