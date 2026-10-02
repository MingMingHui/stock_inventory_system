// Loads export data through the existing service functions, so the export uses
// exactly the same queries, filters, sort order and RLS-protected access as the
// pages. Paginated lists are read page by page until the whole filtered result
// is collected (not just the page on screen).

import { monthKey, monthRange } from '../../lib/dates';
import type { Page, PageRequest } from '../../services/api';
import { type InventorySort, listInventory } from '../../services/inventory';
import { listRules } from '../../services/rules';
import { type SalesFilters, type SalesSort, listSales } from '../../services/sales';
import { type StockFilters, type StockSort, listStock } from '../../services/stock';
import { dashboardStats, listExpenses, partnerSummaryByCategory, settlementSummary } from '../../services/summary';
import type { PartnerRule } from '../../types/database';
import {
  inventorySheet,
  partnerRuleSheet,
  partnerSummarySheet,
  salesLogSheet,
  stockMasterSheet,
} from './exportMappings';
import { type ExportSheet, SHEET_NAMES, type SheetName } from './exportTypes';

/** Below the Supabase API row cap (1000 by default). */
export const EXPORT_PAGE_SIZE = 500;
const MAX_PAGES = 1000;

export async function fetchAllPages<T>(load: (page: number, pageSize: number) => Promise<Page<T>>): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await load(page, EXPORT_PAGE_SIZE);
    rows.push(...result.rows);
    if (rows.length >= result.total || result.rows.length === 0) return rows;
    // A short page before the end means the server capped the page size: rows would be skipped.
    if (result.rows.length < EXPORT_PAGE_SIZE) throw new Error('Export page was truncated by the server');
  }
  throw new Error('Export exceeded the maximum number of pages');
}

const request = <S extends string>(page: number, pageSize: number, sort: PageRequest<S>['sort']): PageRequest<S> => ({
  page,
  pageSize,
  sort,
});

export interface ExportPeriod {
  from: string;
  to: string;
}

export function currentMonthPeriod(): ExportPeriod {
  return monthRange(monthKey());
}

/** All rules (including ended and inactive ones), ordered as on the Partner Rule Table page. */
export async function loadAllPartnerRules(): Promise<PartnerRule[]> {
  const rules = await listRules();
  return [...rules].sort(
    (a, b) =>
      (a.product_categories?.name ?? '').localeCompare(b.product_categories?.name ?? '') ||
      a.effective_from.localeCompare(b.effective_from),
  );
}

export async function loadInventorySheet(
  search = '',
  sort: PageRequest<InventorySort>['sort'] = { column: 'name', ascending: true },
): Promise<ExportSheet> {
  return inventorySheet(await fetchAllPages((page, size) => listInventory(search, request(page, size, sort))));
}

export async function loadStockSheet(
  filters: StockFilters,
  sort: PageRequest<StockSort>['sort'] = { column: 'item_code', ascending: true },
): Promise<ExportSheet> {
  return stockMasterSheet(await fetchAllPages((page, size) => listStock(filters, request(page, size, sort))));
}

export async function loadSalesSheet(
  filters: SalesFilters,
  sort: PageRequest<SalesSort>['sort'] = { column: 'sale_date', ascending: true },
): Promise<ExportSheet> {
  return salesLogSheet(await fetchAllPages((page, size) => listSales(filters, request(page, size, sort))));
}

export interface SummaryFilters extends ExportPeriod {
  categoryId: string;
  productId: string;
  /** Shown in the sheet, e.g. "Car Tyre — all products". */
  filterLabel: string;
}

export async function loadPartnerSummarySheet(filters: SummaryFilters): Promise<ExportSheet> {
  const { from, to, categoryId, productId } = filters;
  const filtered = Boolean(categoryId || productId);
  const [byCategory, totals, settlements, expenses] = await Promise.all([
    partnerSummaryByCategory(from, to, categoryId, productId),
    filtered ? Promise.resolve(null) : dashboardStats(from, to),
    settlementSummary(from, to),
    listExpenses(from.slice(0, 7) + '-01', to.slice(0, 7) + '-01'),
  ]);
  return partnerSummarySheet({ from, to, filterLabel: filters.filterLabel, byCategory, totals, settlements, expenses });
}

/**
 * The complete workbook. The sheet of the tab the user is on uses that tab's
 * current filters (`current`); the other sheets use their complete data, with
 * Sales_Log and Partner_Summary limited to `period`.
 */
export async function loadAllSheets(
  period: ExportPeriod,
  current?: { sheet: SheetName; load: () => Promise<ExportSheet> },
): Promise<ExportSheet[]> {
  const defaults: Record<SheetName, () => Promise<ExportSheet>> = {
    Partner_Rule_Table: async () => partnerRuleSheet(await loadAllPartnerRules()),
    Inventory_List: () => loadInventorySheet(),
    Stock_Master: () => loadStockSheet({ search: '', status: '', categoryId: '', includeObsolete: true }),
    Sales_Log: () =>
      loadSalesSheet({ ...period, search: '', categoryId: '', priceAlertOnly: false, includeVoid: false }),
    Partner_Summary: () =>
      loadPartnerSummarySheet({ ...period, categoryId: '', productId: '', filterLabel: 'All categories, all products' }),
  };
  if (current) defaults[current.sheet] = current.load;
  return Promise.all(SHEET_NAMES.map((name) => defaults[name]()));
}
