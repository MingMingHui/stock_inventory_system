# Excel Inspection Report — `data/Workshop_Stocklist_2026.xlsx`

Inspected: 2026-09-30, read-only, with `openpyxl 3.1.5`. The workbook was opened twice: once for formulas (`data_only=False`) and once for cached values (`data_only=True`). The original file was not modified.

> **Decisions taken after this inspection (2026-09-30).** The open questions in §6 were answered:
> - The partner split stays on revenue.
> - Car Tyre Strip becomes 50% from 2026-09-01.
> - Wages are a fixed −RM100 every month.
> - Electricity is 60% of the monthly bill, entered each month.
> - `Sales_Log` means the monthly `Sales_Log_YYYYMM` sheets, and only `Sales_Log_202608` is imported.
> - The legacy sheets are not imported.
>
> See [business-rules.md](business-rules.md) and [excel-data-model.md](excel-data-model.md).

---

## 1. Summary

| Check | Result |
|---|---|
| Excel file found | **YES** |
| Sheets in workbook | **17** (4 visible, 13 hidden) |
| Expected sheets found (exact name) | **3 / 5** |
| Defined names (named ranges) | none |
| Pivot tables / external links / connections | none (no pivot parts in the package) |
| Excel tables (ListObjects) | `Table2` (Partner_Rule_Table), `Machinery_Equipments` (KALI_Inventory_List), `Table3` (Stock_Master), `Table3_2` (Stock_Master_01), `Stock_Master_01` (KALI_Stock), `Stock` (Stock_Archiv) |

### Expected sheet verification

| Expected sheet | Status | Closest actual sheet(s) | Note |
|---|---|---|---|
| `Stock_Master` | **FOUND** | `Stock_Master` | Also hidden legacy copies `Stock_Master_01`, `Stock_Master_Pricelist` |
| `Sales_Log` | **MISSING (exact name)** | `Sales_Log_202601` … `Sales_Log_202608` (8 monthly sheets) | The `How-To` sheet names it `Sales_Log`. In practice there is one sheet per month; only `Sales_Log_202608` is visible |
| `Partner_Summary` | **FOUND** | `Partner_Summary` | Holds static values, not live formulas (see §3.5) |
| `Inventory_List` | **MISSING (exact name)** | `KALI_Inventory_List` | The `How-To` sheet names it `Inventory_List`. The actual sheet lists shared machinery/equipment |
| `Partner_Rule_Table` | **FOUND** | `Partner_Rule_Table` | |

> No replacement sheets were created. You need to confirm the mapping `Sales_Log` → `Sales_Log_YYYYMM` and `Inventory_List` → `KALI_Inventory_List` (see §6).

---

## 2. Workbook

| # | Sheet | State | Dimensions | Header row | Data rows (approx.) |
|---|---|---|---|---|---|
| 1 | How-To | visible | A1:Z986 | 1 | 4 |
| 2 | Sales_Log_202603 | hidden | A1:Z1056 | 3 | ~120 |
| 3 | Sales_Log_202604 | hidden | A1:V1059 | 3 | ~105 |
| 4 | Sales_Log_202605 | hidden | A2:Z1000 | 2 | ~103 |
| 5 | Sales_Log_202606 | hidden | A1:V1001 | 1 | ~70 |
| 6 | Partner_Rule_Table | visible | A1:E23 | 1 | 22 |
| 7 | KALI_Inventory_List | visible | A1:C7 | 1 | 6 |
| 8 | Stock_Master | visible | A1:V961 | 2 | 106 (table `Table3` = A2:V108) |
| 9 | Sales_Log_202608 | **visible** | A1:T1000 | 1 | 70 |
| 10 | Sales_Log_202607 | hidden | A1:V1001 | 1 | 69 |
| 11 | Stock_Master_01 | hidden | A1:P968 | 2 | 103 |
| 12 | Sales_Log_202602 | hidden | A1:V1029 | 1 | ~121 |
| 13 | Partner_Summary | visible | A1:S98 | 72 (block at I71:L98) | 20 categories + settlement |
| 14 | Stock_Master_Pricelist | hidden | A1:G67 | 1 | 66 |
| 15 | Sales_Log_202601 | hidden | A1:X1000 | 1 | ~87 |
| 16 | KALI_Stock | hidden | A1:U997 | 1 | ~94 |
| 17 | Stock_Archiv | hidden | A1:M1012 | 1 | ~59 |

Dimensions are inflated by array formulas that extend to about row 1000. Real data ends much earlier.

---

## 3. Sheets

### 3.1 How-To (visible)

**Purpose:** documentation in Malay, one row per logical sheet.

| Sheet_Name | Description | Cara Guna (how to use) |
|---|---|---|
| Stock_Master | Data Entry for Stock Keeping | Data for stock currently in the shop. KaLi Motor adds stock once it is placed in the workshop. |
| Sales_Log | Track actual sold goods | Enter quantity sold and actual selling price in `quantity_sold` / `actual_selling_price`. Can only be changed during the end-of-month stock check. |
| Partner_Summary | Profit Sharing Summary | Computes the partner split from the Sales_Log sheet. |
| Inventory_List | List of Inventory shared | List of shared inventory. |

**Business process implied:** stock is counted at month end, and sales are recorded **monthly in aggregate**, not per transaction.

---

### 3.2 Stock_Master (visible) — product and stock batch master

**Purpose:** the current stock position. Each row is a **stock batch/lot** (same SKU, possibly a different brand, cost or purchase date). It also holds one quantity snapshot column per month.

Table `Table3` = A2:V108. Header on row 2, data on rows 3–108. Freeze pane A3.
Hidden columns: D, E, K, N, P, Q. There are 34 hidden rows, and these match rows flagged `Obsolete = 1`.
Data validation: `J3:J108` must be a date. `I3:I108` must be a number and not a date.

| Col | Header | Type | Sample values | Formula |
|---|---|---|---|---|
| A | ID | int (formula) | 1, 2, 3 | `=ROW()-3` (73 rows), `=ROW()-2` (32 rows), `=ROW()-1` (A3) — **inconsistent, produces duplicate IDs** |
| B | Item_Code | str | `BAT-1L`, `TYRE-1757013`, `FILTER-01` | — |
| C | Description | str | `Fujiya Battery Water (1 litre)` | — |
| D | Brand | str | `Fujiya`, `Motorlite`, `NIL` | — |
| E | Category | str | `Battery Water`, `Car Tyre` | — (joins to `Partner_Rule_Table.Product Type`) |
| F | Current_Quantity | int | 0, 25, **-1** | — (`-1` = non-stock service item, see §4.6) |
| G | Current_Sales | int | 0, 1, 2 | `=T{r}-F{r}` (66 rows); others typed in |
| H | Cost (RM) | float/int | 1.8, 142.3, 0 | one cell `H21 = =320/2` |
| I | Selling_Price (RM) | int | 4, 195, 215 | — |
| J | Purchased_Date | date | 2025-10-21 | — (R97 blank) |
| K | Quantity_As_Per_202512 | int | 8, 24 | snapshot |
| L | Quantity_As_Per_202601 | int | | snapshot |
| M | Quantity_As_Per_022026 | int | | snapshot |
| N | Quantity_As_Per_032026 | int | | snapshot |
| O | Quantity_As_Per_042026 | int | | snapshot |
| P | Quantity_As_Per_052026 | int | | snapshot |
| Q | Quantity_As_Per_062026 | int | | snapshot |
| R | sales | int | 0, 1, 2, -1 | `=S{r}-F{r}` (71 rows), `R3 = =Q3-F3` |
| S | Quantity_072026 | int | | snapshot |
| T | Qty_29082026 | int | | snapshot |
| U | Qty_30092026 | int | | snapshot (`U3 = =F3`) |
| V | Obsolete | int (1/blank) | 1 | 34 rows flagged |

- **Potential primary key:** none in the sheet. `ID` is a row-position formula with duplicates. `Item_Code` is **not unique** (106 rows, 48 distinct codes; e.g. `TYRE-1756514` × 6, `FILTER-01` × 5). You need a **surrogate key**. A natural candidate is (`Item_Code`, `Brand`, `Description`, `Purchased_Date`), but its uniqueness is **not verified** and row 97 has no `Purchased_Date`.
- **Foreign keys:** `Category` → `Partner_Rule_Table.Product Type`. All 20 Stock_Master categories exist in the rule table.
- **Relationships:** each month's `Sales_Log_YYYYMM` is a copy of Stock_Master rows plus sales columns. `ID` and `Item_Code` are carried across, but the IDs do not reliably match.
- **Stock history:** the quantity snapshots are stored as **columns**. They should become rows (item batch × period) in a database.

---

### 3.3 Sales_Log_YYYYMM (8 sheets; only 202608 visible) — monthly sales and partner split

**Purpose:** a month-end snapshot of each stock batch. It records quantity sold that month, actual selling price, revenue, cost, gross profit, and each partner's share.

The column layout **changes over time**:

| Sheet | Header row | Qty sold col | Actual price col | Revenue | Cost | GP | RuleType | A.L_Rate | KALI_Rate | KALI_Share | A.L_Share |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 202601 | 1 | M `Quantity_Sold` | N | P | Q | R | S | T | U | V | W |
| 202602 | 1 | K `Quantity_Sold` | L | O | P | Q | R | S | T | U | V |
| 202603 | 3 | K `Quantity_Sold` | L | O | P | Q | R | S | T | U | V |
| 202604 | 3 | K `Current_Sales_Quantity` | L | O | P | Q | R | S | T | U | V |
| 202605 | 2 | K `Current_Sales_Quantity` | L | O | P | Q | R | S | T | U | V |
| 202606 | 1 | K `Current_Sales_Quantity` | L | O | P | Q | R | S | T | U | V |
| 202607 | 1 | K `sales` | L | O | P | Q | R | S | T | U | V |
| 202608 | 1 | G `Current_Sales` | J | M | N | O | P | Q | R | S | T |

Common columns (202602–202607 layout): `ID, Item_Code, Description, Brand, Category, Current_Quantity, Unit, Cost (RM), Selling_Price (RM), Purchased_Date, Quantity_Sold, Actual_Selling_Price, Checked_Date, After_Sales_Quantity, Revenue_Per_Sales, Cost_Per_Sale, Gross_Profit, RuleType, A.L_Rate, KALI_Rate, KALI_Share, A.L_Share`.

Sheet-specific extras:
- **202601:** `Selling_Code`, `Maximum_Price_To_Discount`, `Outstanding_Qty` (`=F-M`). Hidden columns G–J and O–W.
- **202603:** `B1 = "Calculation Date"`, `C1 = 2026-01-04` (the date looks stale for a March sheet). Column G hidden.
- **202604:** `A1 = "Calculation Date"`, `B1 = 2026-02-05`.
- **202608:** no `Unit` or `Purchased_Date` columns. There are 50 hidden rows (filtered).

**Sample (Sales_Log_202608, visible):**

| Item_Code | Category | Current_Quantity | Current_Sales | Cost | Selling_Price | Actual_Selling_Price | Revenue | Cost_Per_Sale | Gross_Profit | RuleType | A.L_Rate | KALI_Rate | KALI_Share | A.L_Share |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BAT-CHARGE | Car Battery Besar | -1 | 3 | 0 | 8 | 8 | 24 | 0 | 24 | Shared_50 | 0.5 | 0.5 | 12 | 12 |
| BAT-NS40 | Car Battery | 0 | 2 | 142.3 | 195 | 195 | 390 | 284.6 | 105.4 | Fixed_Per_Unit | 10 | LEFTOVER | 370 | 20 |

- **Potential primary key:** none reliable. `ID` repeats (e.g. 202606 has ID 3 twice). Use a surrogate key, or (period, stock batch).
- **Foreign keys:** `Category` → `Partner_Rule_Table.Product Type` (VLOOKUP). `Item_Code`/`ID` → Stock_Master (by copy only, no lookup).
- **Relationships:** `RuleType`, `A.L_Rate` and `KALI_Rate` are looked up live from Partner_Rule_Table. `Partner_Summary` aggregates `KALI_Share` / `A.L_Share` by `Category` from the latest month.

**Monthly totals (cached values):**

| Sheet | Revenue | Cost | Gross_Profit | KALI_Share | A.L_Share | Note |
|---|---|---|---|---|---|---|
| 202601 | 4342.00 | 2242.26 | 2099.74 | 4000.00 | 342.00 | |
| 202602 | 3207.00 | 3207.00 | 0.00 | 2986.50 | 220.50 | cost bug, see §5 |
| 202603 | 3115.00 | 3029.00 | 86.00 | 2848.50 | 266.50 | cost bug, see §5 |
| 202604 | 2976.00 | 1809.90 | 1166.10 | 2718.50 | 257.50 | |
| 202605 | 1542.00 | 908.70 | 633.30 | 1425.50 | 116.50 | |
| 202606 | 1366.00 | 835.70 | *not computed* | 1268.00 | 98.00 | GP formula bug, see §5 |
| 202607 | 1451.00 | 899.50 | *not computed* | 1346.00 | 105.00 | GP formula bug, see §5 |
| 202608 | 1615.00 | 1062.50 | 552.50 | 1475.00 | 140.00 | matches Partner_Summary |

In every month, `KALI_Share + A.L_Share = Revenue`. The split is on **revenue, not gross profit** (see §4.3).

---

### 3.4 Partner_Rule_Table (visible) — partner profit-sharing rules

**Purpose:** defines, per product category, how revenue is split between the two partners.

Table `Table2` = A1:E23. Validation: `B2:B23` ∈ {`Fixed_Per_Unit`, `Fixed_Per_Job`, `Fixed_Per_Service`}. The list also includes `Shared_50`. `C2:C23` must be numeric.

| Col | Header | Type | Meaning |
|---|---|---|---|
| A | Product Type | str | Category key (**PK**) |
| B | Rule Type | enum | `Fixed_Per_Unit` / `Fixed_Per_Job` / `Fixed_Per_Service` / `Shared_50` |
| C | Partner B Rate (Amin) | number | Becomes `A.L_Rate` in Sales_Log |
| D | Partner A Rate (KaLi Motor) | `"LEFTOVER"` or number | Becomes `KALI_Rate` in Sales_Log |
| E | Notes | str (Malay) | Not used by formulas (VLOOKUP range is A:D) |

Full contents:

| Product Type | Rule Type | Partner B (Amin) | Partner A (KaLi Motor) | Notes |
|---|---|---|---|---|
| Car Tyre | Fixed_Per_Unit | 10 | LEFTOVER | RM10 setiap tayar |
| Car Battery | Fixed_Per_Unit | 10 | LEFTOVER | RM10 setiap bateri |
| Car Engine OIl-L | Fixed_Per_Unit | 8 | LEFTOVER | RM8 setiap unit |
| Car Engine Oil-S | Fixed_Per_Unit | 2 | LEFTOVER | RM2 setiap unit |
| Car Tube | Fixed_Per_Unit | 8 | LEFTOVER | Semua saiz |
| Car Tyre Strip | Fixed_Per_Job | 0.5 | 0.5 | Harga ditetapkan B |
| Car Tyre Swap | Fixed_Per_Unit | 4 | LEFTOVER | Caj RM8 sepasang |
| Car Tyre Change Cust | Fixed_Per_Service | 6 | LEFTOVER | Caj servis RM12 |
| Used Car Tyre | Shared_50 | 0.5 | 0.5 | Harga ditetapkan B |
| Car Battery Charge | Shared_50 | 0.5 | 0.5 | Harga ditetapkan B |
| Car Pump Head | Shared_50 | 0.5 | 0.5 | Harga ditetapkan B |
| Battery Water | Fixed_Per_Unit | 1 | LEFTOVER | RM1 setiap unit |
| Bike Coolant Fluid | Fixed_Per_Unit | 2 | LEFTOVER | RM2 setiap unit |
| Bike Engine Oil | Fixed_Per_Unit | 2 | LEFTOVER | RM2 setiap unit |
| Car Brake Fluid | Fixed_Per_Unit | 2 | LEFTOVER | RM2 setiap unit |
| Oil Filter | Fixed_Per_Unit | 5 | LEFTOVER | RM 5 setiap unit |
| Steering Fluid | Fixed_Per_Unit | 2 | LEFTOVER | RM2 setiap unit |
| Car Battery Kecil | Shared_50 | 0.5 | 0.5 | Harga ditetapkan A |
| Car Battery Besar | Shared_50 | 0.5 | 0.5 | Harga ditetapkan A |
| Bike Battery | Shared_50 | 0.5 | 0.5 | Harga ditetapkan A |
| Lorry Battery | Shared_50 | 0.5 | 0.5 | Harga ditetapkan A |
| Bike Tyre | Shared_50 | 0.5 | 0.5 | RM48 |

**Partner identity:**
- **Partner A** is **KaLi Motor** (`KALI_*` columns). This is the workshop.
- **Partner B** is **Amin** (`A.L_*` columns).

Category keys are case-sensitive in appearance (`Car Engine OIl-L` has a capital I). VLOOKUP matching is case-insensitive, but a database join may not be, so keep the exact strings.

---

### 3.5 Partner_Summary (visible) — monthly settlement

**Purpose:** per-category totals of partner shares and the final payment to KaLi Motor. Merged cells: `B1:D1`, `I1:K1`. Data sits in I71:L98.

This sheet looks like a **Google Sheets pivot table pasted as values**. The headers read `SUM of A.L_Share` / `SUM of KALI_Share`, and there is no pivot part in the file. It does **not** update when Sales_Log changes. The values match `Sales_Log_202608` (A.L 140, KALI 1475).

| Cell | Content |
|---|---|
| J71 | 2026-08-01 (period) |
| I72:K72 | `Category`, `SUM of A.L_Share`, `SUM of KALI_Share` |
| I74:K91 | 18 categories with totals (e.g. Car Tyre 60 / 773, Car Battery 20 / 370) |
| I92:K92 | Grand Total: 140 / 1475 |
| J93:K93 | `Gaji Anol` (wages): **-100** |
| J94:K94 | `Bil Api` (electricity bill): `=32.65*0.6` → **19.59** |
| L94 | `=K94+K93+K92` → 1394.59 |
| J95:K95 | `Rental`: **500** |
| J98:K98 | `Total Payment to KALI`: `=SUM(K92:K96)` → **1894.59** |

- **Potential PK:** (period, Category).
- **FK:** Category → Partner_Rule_Table.
- **Settlement adjustments** (wages, electricity at 60%, rental) are **hard-coded literals** with no source table.

---

### 3.6 KALI_Inventory_List (visible) — shared equipment (closest match for "Inventory_List")

Table `Machinery_Equipments` = A1:C7. No formulas.

| Machine/Equipment | Brand/Color | Quantity |
|---|---|---|
| Tyre Changer Machine | Falco/Orange | 1 |
| Tyre Changer Machine | Guiliano/Blue | 1 |
| Air Blow Gun | | 2 |
| Aur Compressor *(typo: Air)* | | 3 |
| Battery Charger Machine | | 1 |
| Car Jack | | 4 |

- **PK:** none. Use a surrogate key; (Machine, Brand) is not unique when Brand is blank.
- **Relationships:** none. This is a capital equipment list, not saleable stock.

---

### 3.7 Legacy/hidden sheets

| Sheet | Purpose | Notable |
|---|---|---|
| Stock_Master_01 | Older Stock_Master (to 04/2026), has `Unit` column | `A = ROW()-2`; `G Current_Sales_Quantity = =IF(F{r}=-1,-1,O{r}-F{r})` |
| Stock_Master_Pricelist | Price list: `ID, Item_Code, Description, Brand, Cost, Selling_Price, Limit_Discount(RM)` | Only place with a **maximum discount** field. `A = ROW()-1` |
| KALI_Stock | KaLi Motor's own stock list (`Min_Quantity`, `Unit`, `Selling_Code`, `Price_to_Discount`, `Outstanding_Quantity`, `Checked_On`) | Has **8 categories not in Partner_Rule_Table**: `Car Bearings`, `Car Brake`, `Car Engine OIl`, `Car Engine Oil`, `Car Screw`, `Car Sealant`, `Car Spark Plug`, `Car Tyre ` (trailing space). Cost formulas `=43/F16`, `=260/F21` |
| Stock_Archiv | Oldest stock list (`Location`, `Remarks`, `Purchase_Date = "old"`) | Remarks look like price codes (`BDPZ`). No formulas |

`Min_Quantity` (reorder level) and `Unit` exist only in legacy sheets and in Sales_Log `Unit`. They are not in the current Stock_Master.

---

## 4. Business rules (from formulas)

Formulas are quoted verbatim. Column letters follow the 202602–202607 layout unless stated otherwise. Formulas in O:V are **array formulas** anchored in the first data row (e.g. `O2:O1001`).

### 4.1 Revenue

```
202601:  P = N2:N1000*M2:M1000
202602–05: O = L*K   (e.g. =L4:L1056*K4:K1056)
202606/07: O = IF((L2:L1001<>"")*(K2:K1001<>""), L2:L1001*K2:K1001, "")
202608:  M = IF(AND(J{r}<>"",G{r}<>""),J{r}*G{r},0)
```
**Revenue = Actual_Selling_Price × Quantity_Sold.**

`Actual_Selling_Price` defaults to the list price. The formulas are `L = =I{r}` (202604–07), `=IF(K{r}=0,0,I{r})` (202604) and `J = =I{r}` (202608). Users overwrite it with a literal when the price differs (e.g. `=I41 -9` in 202607, which is a RM9 discount).

### 4.2 Cost and gross profit

```
202601:     Q = H*M                 R = P-Q
202602/03:  P = I*K   ← uses Selling_Price, not Cost (bug)   Q = O-P
202604/05:  P = H*K                 Q = O-P
202606/07:  P = IF((H<>"")*(K<>""),H*K,"")
            Q = IF(AND(O2:O1001<>"",P2:P1001<>""),O2:O1001-P2:P1001,"")   ← broken (see §5)
202608:     N = IF(H<>"",H*G,0)     O = M-N
```
**Cost_Per_Sale = Cost (RM) × Quantity_Sold. Gross_Profit = Revenue − Cost_Per_Sale.**

### 4.3 Partner rule lookup

```
RuleType  = IF(E="","", VLOOKUP(E, Partner_Rule_Table!A:D, 2, FALSE))
A.L_Rate  = IF(E="","", VLOOKUP(E, Partner_Rule_Table!A:D, 3, FALSE))
KALI_Rate = IF(E="","", VLOOKUP(E, Partner_Rule_Table!A:D, 4, FALSE))
```

### 4.4 Partner B (Amin) share — `A.L_Share`

```
=IF(R="","",
  IF(L<=0, 0,
   IF(R="Fixed_Per_Unit",    S*K,
    IF(R="Fixed_Per_Job",     S*K,
     IF(R="Fixed_Per_Service", S*K,
      IF(R="Shared_50",        O*0.5,
       0))))))
```
In plain terms:
- If the actual price is ≤ 0, the share is 0.
- For `Fixed_Per_Unit`, `Fixed_Per_Job` and `Fixed_Per_Service`, the share is **A.L_Rate × Quantity_Sold**.
- For `Shared_50`, the share is **Revenue × 0.5**.

### 4.5 Partner A (KaLi Motor) share — `KALI_Share`

```
=IF(R="","",
  IF(K=0, 0,
   IF(R="Shared_50", O*0.5,
      O-V)))
```
In plain terms:
- If quantity sold is 0, the share is 0.
- For `Shared_50`, the share is **Revenue × 0.5**.
- Otherwise the share is **Revenue − A.L_Share**. This is the "LEFTOVER" rule.

**Important:** the split applies to **revenue**, not gross profit. KaLi Motor's share includes the stock cost. `KALI_Rate` is **never used numerically**. It only documents `LEFTOVER` vs `0.5`. For `Shared_50` the 0.5 is hard-coded in the formula, not read from the rate column.

Check against the workbook: Car Tyre Strip, 18 sold × RM10 = RM180. `A.L = 0.5 × 18 = 9` and `KALI = 171`. This matches Partner_Summary (9 / 171).

### 4.6 Stock quantity rules

```
Sales_Log 202602–05:   After_Sales_Quantity N = F-K
Sales_Log 202606/07:   N = IF(AND(F<>"",F<>0,F<>-1),F-K,0)
Sales_Log 202608:      L = IF(F-G < 0,0,F-G)
Sales_Log 202601:      Outstanding_Qty X = F-M
Stock_Master:          Current_Sales G = T-F    (last snapshot − current qty)
                       sales R = S-F            (07/2026 snapshot − current qty)
Stock_Master_01:       G = IF(F=-1,-1,O-F)
```
- **`Current_Quantity = -1` is a sentinel for non-stock or service items** (battery charging, tyre change/swap). These items are never depleted. Later formulas exclude them explicitly.
- Quantity sold is **derived** from the difference between month-end stock counts (`previous snapshot − current`).
- After-sales quantity is clamped at 0 (202608).

### 4.7 Settlement (Partner_Summary)

```
Total Payment to KALI = Σ KALI_Share + Gaji Anol(-100) + Bil Api(=32.65*0.6) + Rental(500)
                      = 1475 − 100 + 19.59 + 500 = 1894.59
```
The adjustment lines, the 60% electricity factor and the amounts are literals. The workbook does not explain why wages are negative or why rental and electricity are added to KaLi's payment.

### 4.8 Other formulas and data validation

- ID formulas: `=ROW()-1`, `=ROW()-2`, `=ROW()-3`. These are not stable keys.
- Unit cost derived from a lump sum: `=43/F4`, `=260/F17` (202601, KALI_Stock), `=320/2` (Stock_Master H21).
- Literal arithmetic: `=25*3`, `=37-15`, `=4100 + 900` (202601).
- Data validation (Google Sheets style): date columns use `OR(NOT(ISERROR(DATEVALUE(x))), AND(ISNUMBER(x), LEFT(CELL("format", x))="D"))`. Price columns use "number and not a date".

---

## 5. Data quality issues and formula defects

| # | Sheet / Cell | Issue | Impact |
|---|---|---|---|
| 1 | Sales_Log_202602 `P2`, 202603 `P4` | `Cost_Per_Sale = I*K` uses **Selling_Price** instead of `Cost (RM)` | GP = 0 (Feb) and GP = 86 (Mar) are wrong. Partner shares are unaffected because they use revenue |
| 2 | Sales_Log_202606 / 202607 `Q2` | `IF(AND(O2:O1001<>"", …), …)`: `AND` collapses the array to one value, so the formula returns a single cell | Gross_Profit is **blank for every row** in Jun and Jul |
| 3 | Sales_Log_202602 `L82..L87` | `Actual_Selling_Price = =170*K{r}` (already multiplied by qty), then `Revenue = L*K` | Revenue is counted as 170 × qty² for those rows |
| 4 | Sales_Log_202601 `I89`, `K89` | `=SUM(#REF!)` | Broken reference |
| 5 | Sales_Log_202608 `T2` (A.L_Share) | Innermost `IF(P="Shared_50", M*0.5` has no else branch, so it returns `FALSE` for unknown rule types (earlier months return 0) | Unknown rule gives FALSE, not 0 |
| 6 | Stock_Master `A` | Mixed `ROW()-1/-2/-3` produces duplicate IDs (e.g. 12, 14, 17 appear twice) | ID is not a key |
| 7 | Stock_Master `B` | Item_Code repeats across batches, brands and descriptions (48 distinct / 106 rows) | Item_Code is a SKU group, not a row key |
| 8 | Stock_Master snapshot headers | Inconsistent naming (`_202512`, `_022026`, `Quantity_072026`, `Qty_29082026`) | Needs normalising to period rows |
| 9 | Sales_Log_202603 `C1` | "Calculation Date" = 2026-01-04 on the March sheet | Stale metadata |
| 10 | Partner_Summary | Static pasted values, not live | Must be recomputed in the app |
| 11 | Categories | `Car Engine OIl-L` (capital I); KALI_Stock has `Car Tyre ` (trailing space) and 7 categories with no rule | Needs normalisation. Missing rules would give `#N/A` |
| 12 | Brand | `ChuanShi`, `ChuanShi `, `Chuan Shi`; `Sonix99`, `Sonix 99`; `NIL` used for "no brand" | Needs normalisation |
| 13 | Rule `Car Tyre Strip` | `Fixed_Per_Job` with rates 0.5/0.5. The formula pays Amin **RM0.50 per job**, not 50% | The rate may have been meant as 50%. Needs your confirmation |
| 14 | Sales_Log_202605 `M` | `Checked_Date` stored as text `'30/05/2026'` | Parse as DD/MM/YYYY on import |

---

## 6. Requirements cross-check

| Requirement | Found in Excel | Sheet | Column/Cell | Action |
|---|---|---|---|---|
| Product category | **Yes** | Stock_Master, Sales_Log_*, Partner_Rule_Table | Stock_Master `E Category`; Rule table `A Product Type` | Create a `categories` table keyed by Product Type. Keep the exact strings. Flag the 8 unmatched KALI_Stock categories |
| Stock quantity | **Yes** | Stock_Master | `F Current_Quantity` (+ monthly snapshot cols K–U) | Store current qty per stock batch. Normalise snapshots into a `stock_counts` (batch, period, qty) table. Treat `-1` as a "non-stock/service" flag, not a quantity |
| Selling price | **Yes** | Stock_Master, Sales_Log_*, Stock_Master_Pricelist | Stock_Master `I Selling_Price (RM)`; Sales_Log `Actual_Selling_Price` (L / J in 202608) | List price on the product batch. Actual price per sale record. Optionally import `Limit_Discount(RM)` from the Pricelist |
| Partner rule | **Yes** | Partner_Rule_Table | `B Rule Type` (enum of 4) | Enum `Fixed_Per_Unit`, `Fixed_Per_Job`, `Fixed_Per_Service`, `Shared_50` on the category rule table |
| Partner A rate | **Yes** (as KaLi Motor) | Partner_Rule_Table | `D Partner A Rate (KaLi Motor)`; Sales_Log `T KALI_Rate` | Store it, but note the value is `"LEFTOVER"` or 0.5 and **is not used in calculations**. KaLi's share = revenue − Amin's share (or 50% for Shared_50) |
| Partner B rate | **Yes** (as Amin / "A.L") | Partner_Rule_Table | `C Partner B Rate (Amin)`; Sales_Log `S A.L_Rate` | Numeric rate: RM per unit/job/service for Fixed_*, or 0.5 for Shared_50 |
| Gross profit | **Yes** (partly broken) | Sales_Log_* | `Q Gross_Profit` (O in 202608) | Implement as `Revenue − Cost × Qty` (the correct 202604/05/08 logic). **Do not import cached GP from 202602/03/06/07**; recompute it |

### Additional items found in Excel (not in the requirement list)

| Item | Sheet | Column/Cell | Action |
|---|---|---|---|
| Revenue | Sales_Log_* | `O Revenue_Per_Sales` | `Actual_Selling_Price × Qty_Sold` |
| Cost | Stock_Master, Sales_Log_* | `H Cost (RM)`, `P Cost_Per_Sale` | Unit cost per batch. Recompute cost per sale |
| Partner shares | Sales_Log_* | `U KALI_Share`, `V A.L_Share` | Implement §4.4 / §4.5 exactly |
| Settlement adjustments | Partner_Summary | K93:K95, K98 | Needs a `settlement_adjustments` table (period, label, amount). Business rules need your confirmation |
| Obsolete flag | Stock_Master | `V Obsolete` | Boolean on the batch |
| Unit | Sales_Log_202601–07, legacy | `G Unit` | Missing from the current Stock_Master. Carry it from Sales_Log |
| Min quantity | KALI_Stock, Stock_Archiv | `G Min_Quantity` | Legacy only. Confirm whether it is needed |
| Shared equipment | KALI_Inventory_List | A:C | Separate `equipment` table |

### Conflicts and open questions (to resolve before implementation)

1. **`Sales_Log` and `Inventory_List` do not exist under those names.** Confirm they map to `Sales_Log_YYYYMM` (all 8 months, or 202608 only?) and `KALI_Inventory_List`.
2. **Profit split basis:** the workbook splits **revenue**, not gross profit. Confirm this is intended before implementing.
3. **Historical imports:** should the app import all 8 monthly logs (including the months with broken cost/GP formulas, recomputed) or only the current state?
4. **`Car Tyre Strip` Fixed_Per_Job 0.5:** is it RM0.50 per job (current formula) or a 50% share?
5. **Settlement adjustments** (wages −100, electricity × 0.6, rental +500): are these fixed monthly items or entered each month?
6. **Legacy sheets** (`KALI_Stock`, `Stock_Archiv`, `Stock_Master_01`, `Stock_Master_Pricelist`): import or ignore?
7. **Transaction model:** the workbook records sales as **monthly aggregates** per batch. Should the app keep that model or record individual sales?
