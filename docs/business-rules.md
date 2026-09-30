# Business rules

Every financial figure is calculated **in PostgreSQL**, in one function, and stored with the inputs, rule and rates that produced it. The browser never does money arithmetic.

| Rule | Where it lives |
|---|---|
| Sale calculation | `public.calculate_sale_line()`, [003_sales.sql](../supabase/migrations/20260930000003_sales.sql) |
| Price-drop alert | `public.price_drop_check()`, same file |
| Rule lookup by date | `private.rule_for()`, [002_catalog_and_stock.sql](../supabase/migrations/20260930000002_catalog_and_stock.sql) |
| Settlement | `public.settlement_summary()`, [004_settlement.sql](../supabase/migrations/20260930000004_settlement.sql) |
| Electricity share | trigger `private.compute_expense_amount()`, same file |

## 1. Partners

| Partner | Who | Excel columns |
|---|---|---|
| **A** | KaLi Motor (workshop owner) | `Partner A Rate (KaLi Motor)`, `KALI_Rate`, `KALI_Share` |
| **B** | Amin | `Partner B Rate (Amin)`, `A.L_Rate`, `A.L_Share` |

## 2. Sale calculation (reproduces the Excel `Sales_Log` formulas)

```text
Revenue       = Actual selling price × Quantity sold
Total cost    = Unit cost × Quantity sold
Gross profit  = Revenue − Total cost

Partner B share (Amin):
  if Actual price ≤ 0                                   → 0
  Fixed_Per_Unit / Fixed_Per_Job / Fixed_Per_Service    → Partner B rate × Quantity
  Shared_50                                             → Revenue × 0.5

Partner A share (KaLi Motor):
  if Quantity = 0                                       → 0
  Shared_50                                             → Revenue − Partner B share   (= 50%)
  otherwise                                             → Revenue − Partner B share   ("LEFTOVER")
```

**The partners split revenue, not gross profit.** This is what the workbook does, and you confirmed it on 2026-09-30. The stock cost is therefore carried inside Partner A's share.

Original Excel formulas (Sales_Log_202606/202607; the same logic, with shifted columns, in Sales_Log_202608):

```text
A.L_Share  = IF(R="","", IF(L<=0, 0, IF(R="Fixed_Per_Unit", S*K, IF(R="Fixed_Per_Job", S*K,
             IF(R="Fixed_Per_Service", S*K, IF(R="Shared_50", O*0.5, 0))))))
KALI_Share = IF(R="","", IF(K=0, 0, IF(R="Shared_50", O*0.5, O-V)))
```

### Rounding

All amounts are `numeric(12,2)` and rounded half-up to the cent. For `Shared_50`, Partner B gets `round(revenue × 0.5, 2)` and Partner A gets the remainder, so **A + B always equals revenue exactly**. The database enforces this with a CHECK constraint.

### Rule types

| Rule type | Partner B (Amin) receives | Partner A (KaLi Motor) receives |
|---|---|---|
| `Fixed_Per_Unit` | rate × units sold | revenue − B |
| `Fixed_Per_Job` | rate × jobs | revenue − B |
| `Fixed_Per_Service` | rate × services | revenue − B |
| `Shared_50` | 50% of revenue | 50% of revenue |

`Partner A rate` is either `LEFTOVER` or a number, but it is informational only. As in Excel, no formula multiplies by it. A `Shared_50` rule must have both rates set to 0.5 (CHECK constraint).

### Worked examples (real rows from the workbook; these are also test cases)

| Excel row | Rule | Qty × Actual | Cost | Revenue | GP | A | B |
|---|---|---|---|---|---|---|---|
| Sales_Log_202608!R7 | Fixed_Per_Unit RM10 | 2 × 195 | 142.30 | 390.00 | 105.40 | 370.00 | 20.00 |
| Sales_Log_202608!R4 | Shared_50 | 3 × 8 | 0 | 24.00 | 24.00 | 12.00 | 12.00 |
| Sales_Log_202601!R86 | Fixed_Per_Job 0.5 | 15 × 12 | 1.60 | 180.00 | 156.00 | 172.50 | 7.50 |
| Sales_Log_202601!R84 | Fixed_Per_Service RM6 | 11 × 12 | 0 | 132.00 | 132.00 | 66.00 | 66.00 |
| Sales_Log_202607!R41 | Fixed_Per_Unit RM10 | 1 × 159 (agreed 168) | 100 | 159.00 | 59.00 | 149.00 | 10.00 |

## 3. Effective-dated rules

A rule applies to a sale when `effective_from ≤ sale date ≤ effective_to` (an empty end date means open-ended). At most one active rule may cover a category on any date. To change a rate, end the old rule and add a new one. **Past sales keep the rule and rates they were recorded with.**

### Decision: Car Tyre Strip (2026-09-30)

| Period | Rule | Effect |
|---|---|---|
| up to 2026-08-31 | `Fixed_Per_Job`, rate 0.5 (as in the workbook) | Amin receives RM0.50 per strip |
| from 2026-09-01 | `Shared_50` | Amin receives 50% of revenue |

August figures therefore still match the workbook. Admins can move the date on the Partner Rule Table page.

## 4. Price-drop alert

```text
drop ratio = (agreed price − actual price) / agreed price
alert      = actual price ≤ agreed price × (1 − threshold)       threshold = 0.10 by default
```

- The alert **warns and never blocks** a sale. Example message: *PRICE ALERT: Actual selling price is 12.5% below agreed price.*
- The ratio, flag and threshold are stored on each sale line. Administrators see all alerts under **Admin → Price alerts** and on the summary cards.
- An agreed price of 0 never raises an alert.
- Admins set the threshold (`price_drop_alert_threshold`).
- A sale never changes the agreed price.

## 5. Stock rules

- **Status** (in order):
  - `OBSOLETE` if marked obsolete
  - `ACTIVE` for service items
  - `OUT_OF_STOCK` if quantity ≤ 0
  - `LOW_STOCK` if quantity ≤ minimum
  - otherwise `ACTIVE`
- **Minimum:** the item's own value, else the setting `low_stock_default_threshold`, which is 1 by default.
- **Service items:** the workbook's `Current_Quantity = -1` means a service or non-stock item, such as battery charging or a tyre change. These are stored as `products.is_non_stock` and their stock is never decremented.
- **Negative stock:** refused unless an admin enables `allow_negative_stock`.
- **Quantity changes** happen only through database functions:
  - `adjust_stock` for receive, stock check and amendment
  - `create_sale` and `void_sale`

  Each change writes an immutable `stock_adjustments` row with previous quantity, new quantity, change, reason, user and time.
- **Lost updates:** an adjustment carries the quantity the user saw. If it changed meanwhile, the database refuses the adjustment and asks the user to refresh. Concurrent sales lock the stock row, so `10 − 3 − 4` always gives 3.
- **Obsolete** is a flag, never a deletion. Obsolete items cannot be sold, and their history and sales remain.

## 6. Sales

- Sales are recorded per transaction: one sale can have one or more lines. The imported August log is stored as one monthly aggregate sale (`source = excel_import`).
- The client sends only stock item, quantity and actual price. Agreed price, cost, rule and rates are read by the database.
- A sale cannot be dated in the future or fall in a finalized month.
- Sales are never edited or deleted.
  - An admin can **void** a sale with a reason. Voided sales stay visible, crossed out, and are excluded from totals.
  - Voiding an app-entered sale returns its stock.
  - Voiding the imported August log does not change stock, because its sales were never deducted from Stock_Master quantities.

## 7. Monthly settlement

```text
Payable to partner = Σ partner share (non-void sales in the month) + Σ that partner's adjustments for the month
```

The workbook's `Partner_Summary` (August 2026):

```text
Total Payment to KALI = SUM(KALI_Share) + Gaji Anol (−100) + Bil Api (=32.65*0.6) + Rental (500)
                      = 1475 − 100 + 19.59 + 500 = 1894.59
```

Adjustments are records, not hard-coded values (`expense_categories` + `operating_expenses`):

| Item | Rule (decided 2026-09-30) | How it is entered |
|---|---|---|
| Employee Salary (Excel "Gaji Anol") | **Fixed −RM100 every month**, deducted from Partner A | Recurring: added automatically by "Add recurring items" and always before a month is finalized |
| Electricity (Excel "Bil Api") | **60% of the monthly bill**, added to Partner A | Admin enters the bill each month; the database computes the amount |
| Rental | RM500 in Excel; not specified | Entered monthly, pre-filled with RM500. *Assumption — confirm whether it should be recurring.* |

A positive amount increases what is paid to the partner; a negative amount decreases it.

**Finalizing a month** (admin, completed months only):
1. Recurring items are added.
2. The totals are snapshotted into `monthly_settlements`.
3. The month is locked: no sales, voids or expense changes. Reopening needs a reason and is audited.

## 8. Resolved and open questions

| # | Question | Status |
|---|---|---|
| 1 | Split revenue or gross profit? | **Resolved:** revenue, as in the workbook |
| 2 | Car Tyre Strip | **Resolved:** 50% from 2026-09-01 |
| 3 | Wages / electricity | **Resolved:** wages fixed −100 monthly; electricity 60% of the bill, entered monthly |
| 4 | Sales_Log naming | **Resolved:** monthly `Sales_Log_YYYYMM`; only 202608 imported |
| 5 | Legacy sheets and earlier months | **Resolved:** not imported |
| 6 | Rental recurring? | **Open.** Treated as a monthly entry with a RM500 default |
| 7 | Should a fixed fee larger than revenue give Partner A a negative share? | **Open.** The workbook allows it and so does the app (e.g. RM10 fee on a RM5 sale → A = −5). |
| 8 | Earlier months' Excel defects (cost based on selling price in Feb/Mar, missing gross profit in Jun/Jul) | Not applicable now: those months are not imported. See [excel-inspection.md](excel-inspection.md) §5. |
