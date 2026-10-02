// Explicit mapping from application/database fields to the columns of the
// original workbook (data/Workshop_Stocklist_2026.xlsx). Column order follows
// the workbook; columns that only exist in the application are appended after
// the original ones. Every value is a stored or database-calculated figure —
// nothing here recalculates revenue, cost, profit, shares or stock.
// See docs/excel-export.md.

import type {
  CategorySummary,
  DashboardStats,
  InventoryItem,
  OperatingExpense,
  PartnerRule,
  SalesLogRow,
  SettlementSummary,
  StockItem,
} from '../../types/database';
import type { ExportColumn, ExportSheet, ResolvedTable } from './exportTypes';

export function resolveTable<T>(columns: ExportColumn<T>[], rows: T[], title?: string): ResolvedTable {
  return {
    title,
    columns: columns.map(({ header, kind, width }) => ({ header, kind, width })),
    rows: rows.map((row, index) => columns.map((c) => c.value(row, index))),
  };
}

/** Sequence number, like the original row-position "ID" columns (not a database key). */
const rowNumber = (_: unknown, index: number) => index + 1;
const blank = () => null;
const partnerARate = (r: { partner_a_rate: number | null; partner_a_rate_is_leftover: boolean }) =>
  r.partner_a_rate_is_leftover ? 'LEFTOVER' : r.partner_a_rate;

// Partner_Rule_Table!A1:E1, then application columns.
export const partnerRuleColumns: ExportColumn<PartnerRule>[] = [
  { header: 'Product Type', kind: 'text', width: 22, value: (r) => r.product_categories?.name },
  { header: 'Rule Type', kind: 'text', width: 19, value: (r) => r.rule_type },
  { header: 'Partner B Rate (Amin)', kind: 'rate', width: 20, value: (r) => r.partner_b_rate },
  { header: 'Partner A Rate (KaLi Motor)', kind: 'rate', width: 24, value: partnerARate },
  { header: 'Notes', kind: 'text', width: 24, value: (r) => r.notes },
  { header: 'Effective_From', kind: 'date', width: 14, value: (r) => r.effective_from },
  { header: 'Effective_To', kind: 'date', width: 14, value: (r) => r.effective_to },
  { header: 'Active', kind: 'flag', width: 8, value: (r) => r.is_active },
];

// KALI_Inventory_List!A1:C1 (the "Inventory_List" sheet), then application columns.
export const inventoryColumns: ExportColumn<InventoryItem>[] = [
  { header: 'Machine/Equipment', kind: 'text', width: 24, value: (r) => r.name },
  { header: 'Brand/Color', kind: 'text', width: 16, value: (r) => r.brand },
  { header: 'Quantity', kind: 'integer', width: 11, value: (r) => r.quantity },
  { header: 'Category', kind: 'text', width: 16, value: (r) => r.category },
  { header: 'Status', kind: 'text', width: 14, value: (r) => r.status },
  { header: 'Notes', kind: 'text', width: 30, value: (r) => r.notes },
];

// Stock_Master!A2:V2, then application columns. The month-end count columns
// (K–U) were point-in-time columns of the 2026 workbook; the application keeps
// stock history as adjustments instead, so they are exported blank.
export const stockMasterColumns: ExportColumn<StockItem>[] = [
  { header: 'ID', kind: 'integer', width: 7, value: rowNumber },
  { header: 'Item_Code', kind: 'text', width: 18, value: (r) => r.item_code },
  { header: 'Description', kind: 'text', width: 40, value: (r) => r.description },
  { header: 'Brand', kind: 'text', width: 16, value: (r) => r.brand },
  { header: 'Category', kind: 'text', width: 20, value: (r) => r.category_name },
  // Original convention: -1 marks a non-stock (service) item.
  { header: 'Current_Quantity', kind: 'integer', width: 17, value: (r) => (r.is_non_stock ? -1 : r.quantity) },
  { header: 'Current_Sales', kind: 'integer', width: 14, value: blank },
  { header: 'Cost (RM)', kind: 'money', width: 13, value: (r) => r.unit_cost },
  { header: 'Selling_Price (RM)', kind: 'money', width: 18, value: (r) => r.agreed_price },
  { header: 'Purchased_Date', kind: 'date', width: 15, value: (r) => r.purchased_date },
  { header: 'Quantity_As_Per_202512', kind: 'integer', width: 12, value: blank },
  { header: 'Quantity_As_Per_202601', kind: 'integer', width: 12, value: blank },
  { header: 'Quantity_As_Per_022026', kind: 'integer', width: 12, value: blank },
  { header: 'Quantity_As_Per_032026', kind: 'integer', width: 12, value: blank },
  { header: 'Quantity_As_Per_042026', kind: 'integer', width: 12, value: blank },
  { header: 'Quantity_As_Per_052026', kind: 'integer', width: 12, value: blank },
  { header: 'Quantity_As_Per_062026', kind: 'integer', width: 12, value: blank },
  { header: 'sales', kind: 'integer', width: 8, value: blank },
  { header: 'Quantity_072026', kind: 'integer', width: 12, value: blank },
  { header: 'Qty_29082026', kind: 'integer', width: 12, value: blank },
  { header: 'Qty_30092026', kind: 'integer', width: 12, value: blank },
  { header: 'Obsolete', kind: 'flag', width: 10, value: (r) => r.is_obsolete },
  { header: 'Status', kind: 'text', width: 14, value: (r) => r.status },
  { header: 'Unit', kind: 'text', width: 8, value: (r) => r.unit },
  { header: 'Min_Quantity', kind: 'integer', width: 13, value: (r) => r.effective_min_quantity },
];

// Sales_Log_202608!A1:T1 (the latest "Sales_Log" layout), then application columns.
// Every amount is the snapshot stored on the sale line by calculate_sale_line().
export const salesLogColumns: ExportColumn<SalesLogRow>[] = [
  { header: 'ID', kind: 'integer', width: 7, value: rowNumber },
  { header: 'Item_Code', kind: 'text', width: 18, value: (r) => r.item_code },
  { header: 'Description', kind: 'text', width: 34, value: (r) => r.description },
  { header: 'Brand', kind: 'text', width: 14, value: (r) => r.brand },
  { header: 'Category', kind: 'text', width: 20, value: (r) => r.category_name },
  { header: 'Current_Quantity', kind: 'integer', width: 17, value: (r) => r.stock_before },
  { header: 'Current_Sales', kind: 'integer', width: 14, value: (r) => r.quantity },
  { header: 'Cost (RM)', kind: 'money', width: 13, value: (r) => r.unit_cost },
  { header: 'Selling_Price (RM)', kind: 'money', width: 18, value: (r) => r.agreed_price },
  { header: 'Actual_Selling_Price', kind: 'money', width: 20, value: (r) => r.actual_price },
  { header: 'Checked_Date', kind: 'date', width: 13, value: (r) => r.sale_date },
  { header: 'After_Sales_Quantity', kind: 'integer', width: 20, value: (r) => r.stock_after },
  { header: 'Revenue_Per_Sales', kind: 'money', width: 18, value: (r) => r.revenue },
  { header: 'Cost_Per_Sale', kind: 'money', width: 14, value: (r) => r.total_cost },
  { header: 'Gross_Profit', kind: 'money', width: 13, value: (r) => r.gross_profit },
  { header: 'RuleType', kind: 'text', width: 17, value: (r) => r.rule_type },
  { header: 'A.L_Rate', kind: 'rate', width: 9, value: (r) => r.partner_b_rate },
  { header: 'KALI_Rate', kind: 'rate', width: 11, value: partnerARate },
  { header: 'KALI_Share', kind: 'money', width: 12, value: (r) => r.partner_a_share },
  { header: 'A.L_Share', kind: 'money', width: 12, value: (r) => r.partner_b_share },
  { header: 'Recorded_By', kind: 'text', width: 20, value: (r) => r.seller },
  { header: 'Price_Alert', kind: 'flag', width: 11, value: (r) => r.price_alert },
  { header: 'Void', kind: 'flag', width: 7, value: (r) => r.is_void },
];

// Partner_Summary!I72:K72 (pivot by category), then application columns.
export const partnerSummaryCategoryColumns: ExportColumn<CategorySummary>[] = [
  { header: 'Category', kind: 'text', width: 22, value: (r) => r.category_name },
  { header: 'SUM of A.L_Share', kind: 'money', width: 18, value: (r) => r.partner_b_share },
  { header: 'SUM of KALI_Share', kind: 'money', width: 18, value: (r) => r.partner_a_share },
  { header: 'Sale_Lines', kind: 'integer', width: 18, value: (r) => r.line_count },
  { header: 'Quantity', kind: 'integer', width: 14, value: (r) => r.quantity },
  { header: 'Revenue_Per_Sales', kind: 'money', width: 18, value: (r) => r.revenue },
  { header: 'Cost_Per_Sale', kind: 'money', width: 14, value: (r) => r.total_cost },
  { header: 'Gross_Profit', kind: 'money', width: 13, value: (r) => r.gross_profit },
];

const settlementColumns: ExportColumn<SettlementSummary>[] = [
  { header: 'Month', kind: 'month', width: 22, value: (r) => r.period_month },
  { header: 'Revenue', kind: 'money', width: 18, value: (r) => r.total_revenue },
  { header: 'Cost', kind: 'money', width: 18, value: (r) => r.total_cost },
  { header: 'Gross_Profit', kind: 'money', width: 18, value: (r) => r.gross_profit },
  { header: 'KALI_Share', kind: 'money', width: 14, value: (r) => r.partner_a_share },
  { header: 'KALI_Adjustments', kind: 'money', width: 18, value: (r) => r.partner_a_adjustments },
  { header: 'Total Payment to KALI', kind: 'money', width: 14, value: (r) => r.partner_a_payable },
  { header: 'A.L_Share', kind: 'money', width: 13, value: (r) => r.partner_b_share },
  { header: 'A.L_Adjustments', kind: 'money', width: 16, value: (r) => r.partner_b_adjustments },
  { header: 'Total Payment to A.L', kind: 'money', width: 20, value: (r) => r.partner_b_payable },
  { header: 'Status', kind: 'text', width: 10, value: (r) => (r.is_finalized ? 'finalized' : 'open') },
];

const expenseColumns: ExportColumn<OperatingExpense>[] = [
  { header: 'Month', kind: 'month', width: 22, value: (r) => r.period_month },
  { header: 'Item', kind: 'text', width: 18, value: (r) => r.expense_categories?.name },
  { header: 'Partner', kind: 'text', width: 18, value: (r) => r.partners?.name },
  { header: 'Bill_Amount', kind: 'money', width: 18, value: (r) => r.base_amount },
  { header: 'Share_Ratio', kind: 'rate', width: 14, value: (r) => r.share_ratio },
  { header: 'Amount', kind: 'money', width: 18, value: (r) => r.amount },
  { header: 'Description', kind: 'text', width: 14, value: (r) => r.description },
];

export interface PartnerSummaryData {
  from: string;
  to: string;
  /** e.g. "All categories, all products" or "Car Tyre" */
  filterLabel: string;
  byCategory: CategorySummary[];
  /** Period totals from dashboard_stats; null when a category/product filter is applied. */
  totals: DashboardStats | null;
  settlements: SettlementSummary[];
  expenses: OperatingExpense[];
}

export function partnerRuleSheet(rows: PartnerRule[]): ExportSheet {
  return { name: 'Partner_Rule_Table', tables: [resolveTable(partnerRuleColumns, rows)] };
}

export function inventorySheet(rows: InventoryItem[]): ExportSheet {
  return { name: 'Inventory_List', tables: [resolveTable(inventoryColumns, rows)] };
}

export function stockMasterSheet(rows: StockItem[]): ExportSheet {
  return { name: 'Stock_Master', tables: [resolveTable(stockMasterColumns, rows)] };
}

export function salesLogSheet(rows: SalesLogRow[]): ExportSheet {
  return { name: 'Sales_Log', tables: [resolveTable(salesLogColumns, rows)] };
}

/**
 * Same blocks as the original sheet: period, the category pivot with its Grand
 * Total, then the settlement (payments) and the adjustment items behind it.
 */
export function partnerSummarySheet(data: PartnerSummaryData): ExportSheet {
  const period: ExportColumn<PartnerSummaryData>[] = [
    { header: 'Period_From', kind: 'date', width: 0, value: (r) => r.from },
    { header: 'Period_To', kind: 'date', width: 0, value: (r) => r.to },
    { header: 'Filter', kind: 'text', width: 0, value: (r) => r.filterLabel },
  ];
  const byCategory = resolveTable(partnerSummaryCategoryColumns, data.byCategory);
  if (data.totals) {
    // Grand Total of the original pivot, taken from dashboard_stats (not summed here).
    byCategory.rows.push(['Grand Total', data.totals.partner_b_share, data.totals.partner_a_share]);
  }
  return {
    name: 'Partner_Summary',
    tables: [
      resolveTable(period, [data]),
      byCategory,
      resolveTable(settlementColumns, data.settlements, 'Monthly settlement'),
      resolveTable(expenseColumns, data.expenses, 'Settlement adjustments'),
    ],
  };
}
