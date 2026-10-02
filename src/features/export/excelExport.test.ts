// @vitest-environment node
import { Workbook, type Worksheet } from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('../../services/rules', () => ({ listRules: vi.fn() }));
vi.mock('../../services/inventory', () => ({ listInventory: vi.fn() }));
vi.mock('../../services/stock', () => ({ listStock: vi.fn() }));
vi.mock('../../services/sales', () => ({ listSales: vi.fn() }));
vi.mock('../../services/summary', () => ({
  dashboardStats: vi.fn(),
  listExpenses: vi.fn(),
  partnerSummaryByCategory: vi.fn(),
  settlementSummary: vi.fn(),
}));

import { listInventory } from '../../services/inventory';
import { listRules } from '../../services/rules';
import { listSales } from '../../services/sales';
import { listStock } from '../../services/stock';
import { dashboardStats, listExpenses, partnerSummaryByCategory, settlementSummary } from '../../services/summary';
import { buildWorkbook, exportFileName, toCellValue } from './excelExport';
import { EXPORT_PAGE_SIZE, fetchAllPages, loadAllSheets } from './exportData';
import {
  inventoryColumns,
  inventorySheet,
  partnerRuleColumns,
  partnerRuleSheet,
  partnerSummaryCategoryColumns,
  partnerSummarySheet,
  salesLogColumns,
  salesLogSheet,
  stockMasterColumns,
  stockMasterSheet,
} from './exportMappings';
import { inspectWorkbook } from './exportValidation';
import { type ExportSheet, SHEET_NAMES } from './exportTypes';

// Header rows of data/Workshop_Stocklist_2026.xlsx (see docs/excel-inspection.md).
// The export must start with exactly these columns, in this order.
const ORIGINAL_HEADERS = {
  Partner_Rule_Table: ['Product Type', 'Rule Type', 'Partner B Rate (Amin)', 'Partner A Rate (KaLi Motor)', 'Notes'],
  Inventory_List: ['Machine/Equipment', 'Brand/Color', 'Quantity'],
  Stock_Master: [
    'ID', 'Item_Code', 'Description', 'Brand', 'Category', 'Current_Quantity', 'Current_Sales', 'Cost (RM)',
    'Selling_Price (RM)', 'Purchased_Date', 'Quantity_As_Per_202512', 'Quantity_As_Per_202601',
    'Quantity_As_Per_022026', 'Quantity_As_Per_032026', 'Quantity_As_Per_042026', 'Quantity_As_Per_052026',
    'Quantity_As_Per_062026', 'sales', 'Quantity_072026', 'Qty_29082026', 'Qty_30092026', 'Obsolete',
  ],
  Sales_Log: [
    'ID', 'Item_Code', 'Description', 'Brand', 'Category', 'Current_Quantity', 'Current_Sales', 'Cost (RM)',
    'Selling_Price (RM)', 'Actual_Selling_Price', 'Checked_Date', 'After_Sales_Quantity', 'Revenue_Per_Sales',
    'Cost_Per_Sale', 'Gross_Profit', 'RuleType', 'A.L_Rate', 'KALI_Rate', 'KALI_Share', 'A.L_Share',
  ],
  Partner_Summary: ['Category', 'SUM of A.L_Share', 'SUM of KALI_Share'],
} as const;

// ---------------------------------------------------------------- fixtures --

const tyreRule: PartnerRule = {
    id: 'r1', category_id: 'c1', rule_type: 'Fixed_Per_Unit', partner_b_rate: 10, partner_a_rate: null,
    partner_a_rate_is_leftover: true, notes: 'RM10 setiap tayar', effective_from: '2025-01-01', effective_to: null,
    is_active: true, updated_at: '2026-09-30T00:00:00Z', product_categories: { name: 'Car Tyre' },
};
const stripRule: PartnerRule = {
    id: 'r2', category_id: 'c2', rule_type: 'Shared_50', partner_b_rate: 0.5, partner_a_rate: 0.5,
    partner_a_rate_is_leftover: false, notes: null, effective_from: '2026-09-01', effective_to: null,
    is_active: true, updated_at: '2026-09-30T00:00:00Z', product_categories: { name: 'Car Tyre Strip' },
};
const rules = [tyreRule, stripRule];

const machine: InventoryItem = { id: 'i1', name: 'Tyre Changer Machine', brand: 'Falco/Orange', category: null, quantity: 1, status: 'ACTIVE', notes: null, updated_at: '2026-09-30T00:00:00Z' };
const inventory: InventoryItem[] = [
  machine,
  { id: 'i2', name: 'Car Jack', brand: null, category: null, quantity: 4, status: 'ACTIVE', notes: null, updated_at: '2026-09-30T00:00:00Z' },
];

const stockBase: StockItem = {
  id: 's1', product_id: 'p1', item_code: 'BAT-1L', description: 'Fujiya Battery Water (1 litre)', brand: 'Fujiya',
  unit: null, is_non_stock: false, category_id: 'c3', category_name: 'Battery Water', purchased_date: '2025-10-21',
  unit_cost: 1.8, agreed_price: 4, quantity: 25, min_quantity: null, effective_min_quantity: 1, status: 'ACTIVE',
  is_obsolete: false, obsolete_at: null, last_checked_at: null, notes: null, legacy_ref: 'Stock_Master!R3',
  created_at: '2026-09-30T00:00:00Z', updated_at: '2026-09-30T00:00:00Z', obsolete_remarks: null, fifo_rank: 1,
  active_batch_count: 1,
};
const stock: StockItem[] = [
  stockBase,
  { ...stockBase, id: 's2', item_code: 'BAT-CHARGE', description: 'Battery charge', brand: null, is_non_stock: true, quantity: 0, purchased_date: null, unit_cost: 0, agreed_price: 8, status: 'ACTIVE' },
  { ...stockBase, id: 's3', item_code: 'TYRE-1756514', quantity: 0, status: 'OBSOLETE', is_obsolete: true, unit_cost: 142.3, agreed_price: 215 },
];

const saleBase: SalesLogRow = {
  id: 'l1', sale_id: 'sale1', sale_date: '2026-08-31', source: 'excel_import', is_void: false, seller: 'Excel import',
  notes: null, line_no: 1, stock_item_id: 's9', product_id: 'p9', item_code: 'BAT-NS40', description: 'NS40ZL',
  brand: 'Motorlite', category_id: 'c4', category_name: 'Car Battery', stock_before: 2, quantity: 2, stock_after: 0,
  agreed_price: 195, actual_price: 195, unit_cost: 142.3, revenue: 390, total_cost: 284.6, gross_profit: 105.4,
  rule_type: 'Fixed_Per_Unit', partner_a_rate: null, partner_a_rate_is_leftover: true, partner_b_rate: 10,
  partner_a_share: 370, partner_b_share: 20, price_drop_ratio: 0, price_alert: false, legacy_ref: null,
  created_at: '2026-09-30T00:00:00Z', void_reason: null, voided_at: null, voided_by_label: null,
};
const sales: SalesLogRow[] = [
  saleBase,
  {
    ...saleBase, id: 'l2', line_no: 2, item_code: 'BAT-CHARGE', description: 'Battery charge', brand: null,
    category_name: 'Car Battery Besar', stock_before: null, stock_after: null, quantity: 3, agreed_price: 8,
    actual_price: 8, unit_cost: 0, revenue: 24, total_cost: 0, gross_profit: 24, rule_type: 'Shared_50',
    partner_a_rate: 0.5, partner_a_rate_is_leftover: false, partner_b_rate: 0.5, partner_a_share: 12, partner_b_share: 12,
  },
];

const batterySummary: CategorySummary = { category_id: 'c4', category_name: 'Car Battery', line_count: 1, quantity: 2, revenue: 390, total_cost: 284.6, gross_profit: 105.4, partner_a_share: 370, partner_b_share: 20 };
const tyreSummary: CategorySummary = { category_id: 'c1', category_name: 'Car Tyre', line_count: 3, quantity: 6, revenue: 833, total_cost: 600, gross_profit: 233, partner_a_share: 773, partner_b_share: 60 };
const byCategory = [batterySummary, tyreSummary];
const totals: DashboardStats = {
  sale_line_count: 14, total_quantity: 30, total_revenue: 1615, gross_profit: 552.5, partner_a_share: 1475,
  partner_b_share: 140, price_alert_count: 0, low_stock_count: 0, out_of_stock_count: 0, obsolete_count: 0,
};
const settlements: SettlementSummary[] = [
  {
    period_month: '2026-08-01', sale_line_count: 14, total_revenue: 1615, total_cost: 1062.5, gross_profit: 552.5,
    partner_a_share: 1475, partner_b_share: 140, partner_a_adjustments: 419.59, partner_b_adjustments: 0,
    partner_a_payable: 1894.59, partner_b_payable: 140, is_finalized: true,
  },
];
const expenses: OperatingExpense[] = [
  { id: 'e1', period_month: '2026-08-01', expense_category_id: 'x1', partner_id: 'pa', base_amount: null, share_ratio: null, amount: -100, description: 'Gaji Anol', expense_categories: { name: 'Employee Salary' }, partners: { name: 'KaLi Motor', code: 'A' } },
  { id: 'e2', period_month: '2026-08-01', expense_category_id: 'x2', partner_id: 'pa', base_amount: 32.65, share_ratio: 0.6, amount: 19.59, description: 'Bil Api', expense_categories: { name: 'Electricity' }, partners: { name: 'KaLi Motor', code: 'A' } },
  { id: 'e3', period_month: '2026-08-01', expense_category_id: 'x3', partner_id: 'pa', base_amount: null, share_ratio: null, amount: 500, description: null, expense_categories: { name: 'Rental' }, partners: { name: 'KaLi Motor', code: 'A' } },
];

const summary = () =>
  partnerSummarySheet({
    from: '2026-08-01', to: '2026-08-31', filterLabel: 'All categories, all products', byCategory, totals, settlements, expenses,
  });

// ----------------------------------------------------------------- helpers --

/** Writes the workbook to .xlsx bytes and opens it again, as Excel would. */
async function roundTrip(sheets: ExportSheet[]): Promise<Workbook> {
  const generated = await buildWorkbook(sheets);
  const bytes = await generated.xlsx.writeBuffer();
  const reopened = new Workbook();
  await reopened.xlsx.load(bytes);
  return reopened;
}

function sheetOf(workbook: Workbook, name: string): Worksheet {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) throw new Error(`Missing sheet ${name}`);
  return sheet;
}

function rowValues(sheet: Worksheet, rowNo: number): unknown[] {
  const values = sheet.getRow(rowNo).values as unknown[];
  return values.slice(1); // ExcelJS rows are 1-based
}

function headerRow(sheet: Worksheet, rowNo = 1): string[] {
  return rowValues(sheet, rowNo).map((v) => (v === undefined ? '' : String(v)));
}

function utc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function expectStatic(workbook: Workbook) {
  const issues = inspectWorkbook(workbook, []);
  expect(issues.formulaCells).toEqual([]);
  expect(issues.errorCells).toEqual([]);
  expect(issues.invalidCells).toEqual([]);
}

// ------------------------------------------------------------------- tests --

describe('export mapping matches the original workbook', () => {
  const mapped = {
    Partner_Rule_Table: partnerRuleColumns,
    Inventory_List: inventoryColumns,
    Stock_Master: stockMasterColumns,
    Sales_Log: salesLogColumns,
    Partner_Summary: partnerSummaryCategoryColumns,
  };

  it.each(SHEET_NAMES)('%s keeps the original columns first, in order and unrenamed', (name) => {
    const original = ORIGINAL_HEADERS[name];
    const headers = mapped[name].map((c) => c.header);
    expect(headers.slice(0, original.length)).toEqual([...original]);
    expect(new Set(headers).size).toBe(headers.length);
  });

  it('uses the original worksheet names in workbook order', () => {
    expect(SHEET_NAMES).toEqual(['Partner_Rule_Table', 'Inventory_List', 'Stock_Master', 'Sales_Log', 'Partner_Summary']);
  });

  // The workbook is git-ignored (business data), so this is skipped where it is absent (CI).
  it('fixture headers equal the headers in data/Workshop_Stocklist_2026.xlsx', async (ctx) => {
    const workbook = new Workbook();
    try {
      await workbook.xlsx.readFile('data/Workshop_Stocklist_2026.xlsx'); // read only; never written
    } catch (error) {
      // exceljs checks existence itself and throws "File not found: <path>".
      if (error instanceof Error && error.message.startsWith('File not found')) return ctx.skip();
      throw error;
    }
    const read = (sheet: string, row: number, from: number, count: number) =>
      (sheetOf(workbook, sheet).getRow(row).values as unknown[])
        .slice(from, from + count)
        .map((v) => String(v ?? '').trim());
    expect(read('Partner_Rule_Table', 1, 1, 5)).toEqual([...ORIGINAL_HEADERS.Partner_Rule_Table]);
    expect(read('KALI_Inventory_List', 1, 1, 3)).toEqual([...ORIGINAL_HEADERS.Inventory_List]);
    expect(read('Stock_Master', 2, 1, 22)).toEqual([...ORIGINAL_HEADERS.Stock_Master]);
    expect(read('Sales_Log_202608', 1, 1, 20)).toEqual([...ORIGINAL_HEADERS.Sales_Log]);
    expect(read('Partner_Summary', 72, 9, 3)).toEqual([...ORIGINAL_HEADERS.Partner_Summary]);
  }, 60_000);
});

describe('Partner_Rule_Table sheet', () => {
  it('exports rules with static values', async () => {
    const wb = await roundTrip([partnerRuleSheet(rules)]);
    const ws = sheetOf(wb, 'Partner_Rule_Table');
    expect(headerRow(ws).slice(0, 5)).toEqual([...ORIGINAL_HEADERS.Partner_Rule_Table]);
    expect(rowValues(ws, 2).slice(0, 7)).toEqual(['Car Tyre', 'Fixed_Per_Unit', 10, 'LEFTOVER', 'RM10 setiap tayar', utc('2025-01-01'), undefined]);
    expect(rowValues(ws, 3).slice(0, 4)).toEqual(['Car Tyre Strip', 'Shared_50', 0.5, 0.5]);
    expect(ws.getCell('E3').value).toBeNull(); // null notes stay empty, not "null"
    expect(ws.getCell('H2').value).toBe(1); // Active
    expectStatic(wb);
  });
});

describe('Inventory_List sheet', () => {
  it('exports quantities as numbers', async () => {
    const wb = await roundTrip([inventorySheet(inventory)]);
    const ws = sheetOf(wb, 'Inventory_List');
    expect(headerRow(ws).slice(0, 3)).toEqual([...ORIGINAL_HEADERS.Inventory_List]);
    expect(rowValues(ws, 2).slice(0, 3)).toEqual(['Tyre Changer Machine', 'Falco/Orange', 1]);
    expect(ws.getCell('C3').value).toBe(4);
    expect(ws.getCell('B3').value).toBeNull();
    expectStatic(wb);
  });
});

describe('Stock_Master sheet', () => {
  it('exports quantities, purchase dates, statuses and the obsolete flag', async () => {
    const wb = await roundTrip([stockMasterSheet(stock)]);
    const ws = sheetOf(wb, 'Stock_Master');
    expect(headerRow(ws).slice(0, 22)).toEqual([...ORIGINAL_HEADERS.Stock_Master]);
    expect(rowValues(ws, 2).slice(0, 10)).toEqual([1, 'BAT-1L', 'Fujiya Battery Water (1 litre)', 'Fujiya', 'Battery Water', 25, undefined, 1.8, 4, utc('2025-10-21')]);
    expect(ws.getCell('J2').numFmt).toBe('dd/mm/yyyy');
    expect(ws.getCell('H2').numFmt).toBe('[$RM]#,##0.00');
    expect(ws.getCell('F3').value).toBe(-1); // non-stock (service) item, as in the original
    expect(ws.getCell('J3').value).toBeNull(); // no purchase date
    expect(ws.getCell('V2').value).toBeNull();
    expect(ws.getCell('V4').value).toBe(1); // Obsolete
    expect(ws.getCell('W2').value).toBe('ACTIVE');
    expect(ws.getCell('W4').value).toBe('OBSOLETE');
    expect(ws.getCell('I4').value).toBe(215);
    expectStatic(wb);
  });
});

describe('Sales_Log sheet', () => {
  it('exports stored sale-line values, not formulas', async () => {
    const wb = await roundTrip([salesLogSheet(sales)]);
    const ws = sheetOf(wb, 'Sales_Log');
    expect(headerRow(ws).slice(0, 20)).toEqual([...ORIGINAL_HEADERS.Sales_Log]);
    expect(rowValues(ws, 2).slice(0, 20)).toEqual([
      1, 'BAT-NS40', 'NS40ZL', 'Motorlite', 'Car Battery', 2, 2, 142.3, 195, 195, utc('2026-08-31'), 0,
      390, 284.6, 105.4, 'Fixed_Per_Unit', 10, 'LEFTOVER', 370, 20,
    ]);
    // Shared_50 service line: no stock before/after, numeric rates.
    expect(ws.getCell('F3').value).toBeNull();
    expect(ws.getCell('L3').value).toBeNull();
    expect(ws.getCell('Q3').value).toBe(0.5);
    expect(ws.getCell('R3').value).toBe(0.5);
    expect(ws.getCell('S3').value).toBe(12);
    expect(ws.getCell('T3').value).toBe(12);
    expect(ws.getCell('M2').numFmt).toBe('[$RM]#,##0.00');
    expectStatic(wb);
  });
});

describe('Partner_Summary sheet', () => {
  it('exports category totals, Grand Total, settlement and adjustments as values', async () => {
    const wb = await roundTrip([summary()]);
    const ws = sheetOf(wb, 'Partner_Summary');
    expect(headerRow(ws, 1)).toEqual(['Period_From', 'Period_To', 'Filter']);
    expect(rowValues(ws, 2)).toEqual([utc('2026-08-01'), utc('2026-08-31'), 'All categories, all products']);
    expect(headerRow(ws, 4).slice(0, 3)).toEqual([...ORIGINAL_HEADERS.Partner_Summary]);
    expect(rowValues(ws, 5).slice(0, 3)).toEqual(['Car Battery', 20, 370]);
    expect(rowValues(ws, 6).slice(0, 3)).toEqual(['Car Tyre', 60, 773]);
    expect(rowValues(ws, 7)).toEqual(['Grand Total', 140, 1475]); // from dashboard_stats
    expect(ws.getCell('A9').value).toBe('Monthly settlement');
    expect(ws.getCell('G10').value).toBe('Total Payment to KALI');
    expect(rowValues(ws, 11)).toEqual([utc('2026-08-01'), 1615, 1062.5, 552.5, 1475, 419.59, 1894.59, 140, 0, 140, 'finalized']);
    expect(ws.getCell('A13').value).toBe('Settlement adjustments');
    expect(rowValues(ws, 15).slice(0, 6)).toEqual([utc('2026-08-01'), 'Employee Salary', 'KaLi Motor', undefined, undefined, -100]);
    expect(rowValues(ws, 16).slice(0, 6)).toEqual([utc('2026-08-01'), 'Electricity', 'KaLi Motor', 32.65, 0.6, 19.59]);
    expect(rowValues(ws, 17).slice(0, 6)).toEqual([utc('2026-08-01'), 'Rental', 'KaLi Motor', undefined, undefined, 500]);
    expectStatic(wb);
  });

  it('omits the Grand Total when a category or product filter is applied', async () => {
    const sheet = partnerSummarySheet({
      from: '2026-08-01', to: '2026-08-31', filterLabel: 'Car Tyre, all products', byCategory: [tyreSummary], totals: null, settlements, expenses: [],
    });
    const wb = await roundTrip([sheet]);
    const ws = sheetOf(wb, 'Partner_Summary');
    expect(rowValues(ws, 5).slice(0, 3)).toEqual(['Car Tyre', 60, 773]);
    expect(ws.getCell('A6').value).toBeNull();
  });
});

describe('complete workbook', () => {
  it('contains the five sheets with zero formula and error cells', async () => {
    const wb = await roundTrip([
      partnerRuleSheet(rules),
      inventorySheet(inventory),
      stockMasterSheet(stock),
      salesLogSheet(sales),
      summary(),
    ]);
    expect(wb.worksheets.map((w) => w.name)).toEqual([...SHEET_NAMES]);
    const issues = inspectWorkbook(wb, SHEET_NAMES);
    expect(issues).toEqual({ formulaCells: [], errorCells: [], invalidCells: [], missingSheets: [] });
  });

  it('writes headers and no data rows for empty datasets', async () => {
    const wb = await roundTrip([
      partnerRuleSheet([]),
      inventorySheet([]),
      stockMasterSheet([]),
      salesLogSheet([]),
      partnerSummarySheet({ from: '2026-10-01', to: '2026-10-31', filterLabel: 'All', byCategory: [], totals: null, settlements: [], expenses: [] }),
    ]);
    for (const name of ['Partner_Rule_Table', 'Inventory_List', 'Stock_Master', 'Sales_Log'] as const) {
      const ws = sheetOf(wb, name);
      expect(headerRow(ws).slice(0, ORIGINAL_HEADERS[name].length)).toEqual([...ORIGINAL_HEADERS[name]]);
      expect(ws.actualRowCount).toBe(1);
    }
    expect(headerRow(sheetOf(wb, 'Partner_Summary'), 4).slice(0, 3)).toEqual([...ORIGINAL_HEADERS.Partner_Summary]);
    expectStatic(wb);
  });

  it('validation detects formula cells', async () => {
    const wb = await buildWorkbook([inventorySheet(inventory)]);
    sheetOf(wb, 'Inventory_List').getCell('D2').value = { formula: 'C2*2' };
    expect(inspectWorkbook(wb, SHEET_NAMES).formulaCells).toEqual(['Inventory_List!D2']);
    expect(inspectWorkbook(wb, SHEET_NAMES).missingSheets).toHaveLength(4);
  });
});

describe('cell values', () => {
  it('writes numbers, dates and blanks consistently', () => {
    expect(toCellValue('money', '100.50')).toBe(100.5);
    expect(toCellValue('money', Number.NaN)).toBeNull();
    expect(toCellValue('integer', undefined)).toBeNull();
    expect(toCellValue('rate', 'LEFTOVER')).toBe('LEFTOVER');
    expect(toCellValue('text', null)).toBeNull();
    expect(toCellValue('date', '2026-08-31')).toEqual(new Date(Date.UTC(2026, 7, 31)));
    expect(toCellValue('date', '2026-08-31T16:30:00+00:00')).toEqual(new Date(Date.UTC(2026, 7, 31)));
    expect(toCellValue('date', '2026-02-30')).toBeNull();
    expect(toCellValue('date', 'not a date')).toBeNull();
    expect(toCellValue('flag', true)).toBe(1);
    expect(toCellValue('flag', false)).toBeNull();
  });

  it('names files with the export date', () => {
    expect(exportFileName('Stock_Master', '2026-10-02')).toBe('Workshop_Stock_Master_2026-10-02.xlsx');
    expect(exportFileName('all', '2026-10-02')).toBe('Workshop_Stocklist_Export_2026-10-02.xlsx');
  });
});

describe('data loading', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads every page of the filtered result, not just the visible page', async () => {
    const all = Array.from({ length: EXPORT_PAGE_SIZE + 3 }, (_, i) => i);
    const load = vi.fn(async (page: number, size: number) => ({ rows: all.slice((page - 1) * size, page * size), total: all.length }));
    await expect(fetchAllPages(load)).resolves.toEqual(all);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('fails rather than skip rows when the server caps the page size', async () => {
    const load = vi.fn(async () => ({ rows: [1, 2], total: 10 }));
    await expect(fetchAllPages(load)).rejects.toThrow(/truncated/);
  });

  it('builds the complete workbook from the current tab and complete data for the others', async () => {
    vi.mocked(listRules).mockResolvedValue([stripRule, tyreRule]);
    vi.mocked(listInventory).mockResolvedValue({ rows: inventory, total: 2 });
    vi.mocked(listStock).mockResolvedValue({ rows: stock, total: 3 });
    vi.mocked(listSales).mockResolvedValue({ rows: sales, total: 2 });
    vi.mocked(partnerSummaryByCategory).mockResolvedValue(byCategory);
    vi.mocked(dashboardStats).mockResolvedValue(totals);
    vi.mocked(settlementSummary).mockResolvedValue(settlements);
    vi.mocked(listExpenses).mockResolvedValue(expenses);
    const current = inventorySheet([machine]);

    const sheets = await loadAllSheets({ from: '2026-08-01', to: '2026-08-31' }, { sheet: 'Inventory_List', load: async () => current });

    expect(sheets.map((s) => s.name)).toEqual([...SHEET_NAMES]);
    expect(sheets[1]).toBe(current);
    expect(listInventory).not.toHaveBeenCalled();
    expect(sheets[0]?.tables[0]?.rows.map((r) => r[0])).toEqual(['Car Tyre', 'Car Tyre Strip']);
    expect(listStock).toHaveBeenCalledWith({ search: '', status: '', categoryId: '', includeObsolete: true }, expect.anything());
    expect(listSales).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-08-01', to: '2026-08-31', includeVoid: false }),
      expect.anything(),
    );
    expect(partnerSummaryByCategory).toHaveBeenCalledWith('2026-08-01', '2026-08-31', '', '');
    expect(listExpenses).toHaveBeenCalledWith('2026-08-01', '2026-08-01');
  });
});
