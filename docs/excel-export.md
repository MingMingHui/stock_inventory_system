# Excel export

Every main tab can export its data to an Excel `.xlsx` file. The worksheets follow the structure of the original workbook `data/Workshop_Stocklist_2026.xlsx`.

The export is a **data export**. Every cell holds a static value that the application has already stored or calculated in the database. The file contains **no formulas**, and the browser recalculates nothing.

## Export options

| Button | Where | Result |
|---|---|---|
| **Export to Excel** | Partner Rule Table, Kali Inventory List, Stock Master, Sales Log, Partner Summary | One worksheet for that tab, using the tab's current filters |
| **Export all** | Same tabs | One workbook with all five worksheets (see [Full workbook](#full-workbook)) |

While an export runs, both buttons are disabled and read **Exporting…**, so a double click cannot produce duplicate files.

- On success, the app shows *Excel export completed.*
- On failure, it shows *Unable to export the data. Please try again.* Session-expired, permission and network failures keep the app's usual specific messages.
- Technical details go to the browser console only.

## File names

The date is the export date, in local time:

| Export | File name |
|---|---|
| Partner Rule Table | `Workshop_Partner_Rule_Table_YYYY-MM-DD.xlsx` |
| Kali Inventory List | `Workshop_Inventory_List_YYYY-MM-DD.xlsx` |
| Stock Master | `Workshop_Stock_Master_YYYY-MM-DD.xlsx` |
| Sales Log | `Workshop_Sales_Log_YYYY-MM-DD.xlsx` |
| Partner Summary | `Workshop_Partner_Summary_YYYY-MM-DD.xlsx` |
| Export all | `Workshop_Stocklist_Export_YYYY-MM-DD.xlsx` |

The browser saves the file. Browsers never overwrite an existing download; they add a suffix instead.

## Filter behaviour

**Export to Excel** exports the **complete dataset for the tab's current filters and sort order**. That means every page of results, not only the page on screen.

| Tab | Filters applied |
|---|---|
| Partner Rule Table | The rows shown, which depend on *Show ended and inactive rules* |
| Kali Inventory List | Search text |
| Stock Master | Search, status, category, *Include obsolete* |
| Sales Log | Month, search, category, *Price alerts only*, *Include voided* |
| Partner Summary | Month or date range, category, product |

Exporting does not change the page or its filters.

### Full workbook

**Export all** fills the worksheet of the tab you are on with that tab's current filters, as above. The other worksheets get their complete data:

| Worksheet | When it is not the current tab |
|---|---|
| Partner_Rule_Table | All rules, including ended and inactive ones |
| Inventory_List | All items |
| Stock_Master | All batches, including obsolete ones (flagged in `Obsolete`, as in the original) |
| Sales_Log | All non-void sale lines in the period |
| Partner_Summary | The period, all categories and products |

The **period** comes from the current tab:

- On Sales Log, it is the selected month.
- On Partner Summary, it is the selected month or date range.
- On every other tab, it is the current calendar month.

## Worksheets and column mapping

Each sheet starts with the **original workbook's columns, in the original order and with the original names**. Columns that exist only in the application come **after** them. Header row 1 holds the column names.

The mapping is explicit, in `src/features/export/exportMappings.ts`. It never depends on database column order.

### Partner_Rule_Table (original: `Partner_Rule_Table!A1:E1`)

| Excel column | Source |
|---|---|
| Product Type | `product_categories.name` |
| Rule Type | `partner_rules.rule_type` |
| Partner B Rate (Amin) | `partner_b_rate` (number) |
| Partner A Rate (KaLi Motor) | `LEFTOVER` when `partner_a_rate_is_leftover`, otherwise `partner_a_rate` (number) |
| Notes | `notes` |
| *Effective_From, Effective_To, Active* | Application columns. Rules are effective-dated in the app. `Active` is 1 or blank. |

### Inventory_List (original: `KALI_Inventory_List!A1:C1`)

| Excel column | Source |
|---|---|
| Machine/Equipment | `inventory_items.name` |
| Brand/Color | `brand` |
| Quantity | `quantity` |
| *Category, Status, Notes* | Application columns |

### Stock_Master (original: `Stock_Master!A2:V2`)

| Excel column | Source |
|---|---|
| ID | Row number in the export, like the original row-position ID. It is not a database key. |
| Item_Code, Description, Brand, Category | `stock_items_view` |
| Current_Quantity | `quantity`. Service (non-stock) items are written as **-1**, the original workbook's convention. |
| Current_Sales | Blank. Not stored by the application. |
| Cost (RM) | `unit_cost` |
| Selling_Price (RM) | `agreed_price` |
| Purchased_Date | `purchased_date` (Excel date) |
| Quantity_As_Per_202512 … Qty_30092026, sales (11 columns, K–U) | Blank. These were point-in-time monthly count columns of the 2026 workbook. The application records stock history as adjustments instead (see the History dialog). The columns are kept so `Obsolete` stays in column V. |
| Obsolete | 1 when `is_obsolete`, otherwise blank (as in the original) |
| *Status, Unit, Min_Quantity* | Application columns. `Min_Quantity` is the effective minimum used for the low-stock status. |

### Sales_Log (original: `Sales_Log_202608!A1:T1`, the latest monthly layout)

Every amount is the snapshot stored on the sale line by the database (`calculate_sale_line`) and read from `sales_log_view`.

| Excel column | Source |
|---|---|
| ID | Row number in the export |
| Item_Code, Description, Brand, Category | `sales_log_view` |
| Current_Quantity | `stock_before` (blank for service items) |
| Current_Sales | `quantity` |
| Cost (RM) | `unit_cost` |
| Selling_Price (RM) | `agreed_price` |
| Actual_Selling_Price | `actual_price` |
| Checked_Date | `sale_date`. The app records each sale on its own date, where the original recorded one month-end check date. |
| After_Sales_Quantity | `stock_after` |
| Revenue_Per_Sales | `revenue` |
| Cost_Per_Sale | `total_cost` |
| Gross_Profit | `gross_profit` |
| RuleType | `rule_type` |
| A.L_Rate | `partner_b_rate` (Partner B, Amin) |
| KALI_Rate | `LEFTOVER` or `partner_a_rate` (Partner A, KaLi Motor) |
| KALI_Share | `partner_a_share` |
| A.L_Share | `partner_b_share` |
| *Recorded_By, Price_Alert, Void* | Application columns. `Price_Alert` and `Void` are 1 or blank. |

### Partner_Summary (original: pivot at `Partner_Summary!I71:K98`)

The sheet has the same blocks as the original, starting at A1:

1. **Period**: `Period_From`, `Period_To` and the category/product `Filter`.
2. **By category** (original pivot): `Category`, `SUM of A.L_Share`, `SUM of KALI_Share`, followed by the application columns `Sale_Lines`, `Quantity`, `Revenue_Per_Sales`, `Cost_Per_Sale` and `Gross_Profit`. The values come from `partner_summary_by_category`.
   - **Grand Total** comes from `dashboard_stats`, not from adding up rows.
   - It is left out when a category or product filter is applied, because it covers all categories.
3. **Monthly settlement**: one row per month from `settlement_summary`. Columns: revenue, cost, gross profit, each partner's share, adjustments, `Total Payment to KALI` / `Total Payment to A.L` (payable), and `Status` (open/finalized). This block always covers all categories, as on the page.
4. **Settlement adjustments**: the expense items (`operating_expenses`) behind the adjustments. Columns: month, item, partner, bill amount, share ratio, amount and description. In the original these were the *Gaji Anol*, *Bil Api* and *Rental* lines.

## Data types and formatting

| Kind | Cell | Format |
|---|---|---|
| Quantities, IDs | Number | `0` |
| Money | Number. `RM` is never part of the value. | `[$RM]#,##0.00` (from the original workbook) |
| Rates | Number, or the text `LEFTOVER` | General |
| Dates | Excel date | `dd/mm/yyyy` |
| Months (Partner_Summary) | Excel date (1st of month) | `mmm-yyyy` (from the original) |
| Flags | `1`, or blank | General |
| Missing values | Empty cell. Never `null`, `undefined` or `NaN`. | |

Header rows are bold and column widths are set. Single-table sheets freeze the header row.

## No formulas

The workbook is generated in the browser with [ExcelJS](https://github.com/exceljs/exceljs), using static values only. Before the download starts, `assertValidWorkbook()` (`src/features/export/exportValidation.ts`) checks the generated workbook. The export fails rather than download a file that contains any of the following:

- a formula cell
- an Excel error value (`#REF!`, `#VALUE!`, `#NAME?`, `#DIV/0!` and the like)
- a `null`, `undefined` or `NaN` text cell
- a non-finite number
- a missing worksheet

## Authorization

The export uses **the same service functions and queries as the pages** (`listRules`, `listInventory`, `listStock`, `listSales`, and the summary RPCs). They run in the signed-in user's session with the anon key, so Row Level Security applies exactly as it does on screen. Users export only data they can already see.

There is no export endpoint, no service-role key and no database change.

## Implementation

```text
src/features/export/
  exportTypes.ts       sheet names (original workbook) and column types
  exportMappings.ts    explicit header → field mapping per sheet
  exportData.ts        loads all pages through the existing services
  excelExport.ts       builds, validates and downloads the workbook
  exportValidation.ts  formula/error/blank-value checks
  ExportButtons.tsx    the two buttons, loading state and messages
```

- Paginated lists are read 500 rows per request until the filtered total is reached. If the server ever returns a short page before the end, the export fails rather than skip rows.
- ExcelJS (about 256 kB gzipped) is loaded only when an export starts, so it does not slow down the app.
- The export works on GitHub Pages: everything runs in the browser.

## Tests

`src/features/export/excelExport.test.ts`:

- Each sheet's export columns start with the original workbook's headers, in order and unrenamed. When `data/Workshop_Stocklist_2026.xlsx` is present locally, the test also confirms those reference headers against the real file (read only). In CI the file is absent and that check is skipped.
- Each sheet is generated, written to `.xlsx`, reopened and checked: sheet names, headers, values, number and date types, blanks, the empty-dataset case, and **zero formula and error cells**.
- Data loading reads every page, refuses truncated pages, and builds **Export all** from the current tab plus complete data for the others.

`src/features/export/ExportButtons.test.tsx` covers the loading state, the double-click guard and the success and failure messages.

## Limitations

- Stock_Master `Current_Sales` and the monthly count columns (K–U) are exported blank (see above).
- Sales_Log uses the latest monthly layout (`Sales_Log_202608`). Older monthly sheets had extra columns (`Unit`, `Purchased_Date`), which are not reproduced.
- The original Partner_Summary block sat at `I71`. The export starts at `A1`.
- Partner names in Sales_Log and Partner_Summary headers follow the original workbook (`KALI` = Partner A, KaLi Motor; `A.L` = Partner B, Amin), even if partner names are changed in the app.
- Generation happens in memory in the browser. That is fine for the current data volumes (hundreds of rows) and for many years of sales, but it is not designed for hundreds of thousands of rows.
