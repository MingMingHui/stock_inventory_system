# Excel data model and migration mapping

Source: `data/Workshop_Stocklist_2026.xlsx`. The file is git-ignored and is read only, never modified. The full sheet-by-sheet inspection is in [excel-inspection.md](excel-inspection.md). This document records **what is migrated and how**.

## Worksheet inventory and decisions

| Sheet | State | Classification | Migrated? |
|---|---|---|---|
| Partner_Rule_Table | visible | calculation configuration | **Yes**, into `product_categories`, `partner_rules` |
| Stock_Master | visible | required application data | **Yes**, into `products`, `stock_items`, `stock_adjustments` (opening), `stock_snapshots` (Aug count) |
| KALI_Inventory_List | visible | reference data (the spec's "Inventory_List") | **Yes**, into `inventory_items` |
| Sales_Log_202608 | visible | historical data (the spec's "Sales_Log") | **Yes**, into `sales` (1 monthly sale) and `sale_items` (14 lines) |
| Partner_Summary | visible | report (pasted pivot) + settlement adjustments | **Adjustments only**, into `expense_categories`, `operating_expenses`. Totals are recomputed and validated. |
| How-To | visible | documentation | No (content reflected in docs) |
| Sales_Log_202601 … 202607 | hidden | historical data | **No.** Decision 2026-09-30: only August is imported |
| Stock_Master_01, Stock_Master_Pricelist, KALI_Stock, Stock_Archiv | hidden | obsolete/legacy | **No.** Decision 2026-09-30 |

## Column mapping

### Partner_Rule_Table → `product_categories`, `partner_rules`

| Excel | Database | Notes |
|---|---|---|
| Product Type | `product_categories.name` | Exact spelling kept (e.g. `Car Engine OIl-L`) |
| Rule Type | `partner_rules.rule_type` | Enum with identical values |
| Partner B Rate (Amin) | `partner_b_rate numeric(12,4)` | |
| Partner A Rate (KaLi Motor) | `partner_a_rate` + `partner_a_rate_is_leftover` | `LEFTOVER` → NULL + true |
| Notes | `notes` | Malay notes preserved |
| — | `effective_from = 2025-01-01` | Excel has no date. Car Tyre Strip gets a second rule from 2026-09-01 (see business-rules §3) |

### Stock_Master → `products` + `stock_items`

Each Stock_Master row is a **purchase batch**. `Item_Code` repeats: there are 106 rows but only 48 codes.

| Excel | Database | Notes |
|---|---|---|
| Item_Code | `products.item_code` | Upper-cased, trimmed |
| Description | `products.description` | Whitespace collapsed |
| Brand | `products.brand` | `NIL` → NULL; trailing spaces trimmed |
| Category | `products.category_id` | Must exist in Partner_Rule_Table (all 20 do) |
| Current_Quantity | `stock_items.quantity` | `-1` → `products.is_non_stock = true`, quantity 0 |
| Cost (RM) | `stock_items.unit_cost numeric(12,2)` | `H21 = =320/2` → cached 160.00 (warning) |
| Selling_Price (RM) | `stock_items.agreed_price` | |
| Purchased_Date | `stock_items.purchased_date` | R97 blank (warning) |
| Obsolete (1) | `stock_items.is_obsolete` | 34 rows |
| Qty_29082026 | `stock_snapshots` (2026-08-29) | August month-end count; other snapshot columns not imported |
| ID | `stock_items.legacy_id` | Row-position formula, **not a key** |
| (row) | `stock_items.legacy_ref` | e.g. `Stock_Master!R42`, for traceability |

**Product identity** = (item code, description, brand, category). `BAT-CHARGE` is four products because the same code is used for four categories at four prices.

### KALI_Inventory_List → `inventory_items`

`Machine/Equipment` → `name`, `Brand/Color` → `brand`, `Quantity` → `quantity`, and `status` defaults to `ACTIVE`. `category` is empty because Excel has none.

### Sales_Log_202608 → `sales` + `sale_items`

| Excel | Database |
|---|---|
| Item_Code/Description/Brand/Category | `product_id` (+ `stock_item_id` when exactly one batch matches) |
| Current_Quantity | `stock_before` (NULL for service items) |
| Current_Sales | `quantity` (rows with 0 are not sales: 56 skipped and counted) |
| After_Sales_Quantity | `stock_after` |
| Selling_Price (RM) | `agreed_price` |
| Actual_Selling_Price | `actual_price` |
| Cost (RM) | `unit_cost` |
| Revenue_Per_Sales, Cost_Per_Sale, Gross_Profit, KALI_Share, A.L_Share | **Recomputed** by `calculate_sale_line()` and compared by `validate_import.py` |
| RuleType, A.L_Rate, KALI_Rate | Snapshot of the rule in force on 2026-08-31 |
| — | `sale_date = 2026-08-31`, `source = excel_import`, `legacy_ref = Sales_Log_202608!R7` |

Batch matching uses the purchase date when present (202608 has none), then cost + agreed price. When several batches still match, the line is linked to the **product only** and a warning names the candidate rows. No stock is decremented, because Stock_Master quantities already reflect these sales.

### Partner_Summary → `expense_categories` + `operating_expenses` (period 2026-08)

| Label | Category | Amount |
|---|---|---|
| Gaji Anol | Employee Salary (recurring −100) | −100.00 |
| Bil Api (`=32.65*0.6`) | Electricity (60% of bill) | bill 32.65 × 0.6 = 19.59 |
| Rental | Rental (default 500) | 500.00 |

## Relationships

```text
Partner_Rule_Table.Product Type ─1:N─ Stock_Master.Category
Partner_Rule_Table.Product Type ─1:N─ Sales_Log.Category (VLOOKUP A:D, columns 2–4)
Stock_Master row ─(copied monthly)─ Sales_Log_YYYYMM row
Sales_Log_YYYYMM.KALI_Share / A.L_Share ─(pivot by Category)─ Partner_Summary
```

## Migration assumptions

1. Rules apply from 2025-01-01; August is the only imported sales month.
2. Imported sales are aggregates dated at month end (2026-08-31).
3. Cached values are used for formula cells (e.g. `=320/2`).
4. `Unit` is not imported. Stock_Master has none; it only appears in earlier Sales_Log sheets, which are excluded. Users can set it when adding stock.
5. Expense label mapping: *Gaji Anol* → Employee Salary, *Bil Api* → Electricity, *Rental* → Rental.

## Validation results (local run, 2026-09-30)

```text
Partner rules 22 ✓ · Stock rows 106 ✓ · Inventory 6 ✓ · Sale lines 14 ✓ · Summary figures 20 ✓
Result: PASS (0 discrepancies)
Settlement Aug 2026: payable to KaLi Motor 1894.59 (Excel 1894.59), to Amin 140.00
```
