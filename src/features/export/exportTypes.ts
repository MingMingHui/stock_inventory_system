// Types for the Excel export. The export only maps and formats values that the
// database has already calculated; it never derives money or stock figures.

/** Worksheet names of the original workbook (data/Workshop_Stocklist_2026.xlsx), in workbook order. */
export const SHEET_NAMES = ['Partner_Rule_Table', 'Inventory_List', 'Stock_Master', 'Sales_Log', 'Partner_Summary'] as const;
export type SheetName = (typeof SHEET_NAMES)[number];

/**
 * How a value is written:
 * - text: string cell
 * - integer / money / rate: numeric cell (a non-numeric string such as "LEFTOVER" stays text)
 * - date / month: Excel date from a "YYYY-MM-DD" string
 * - flag: 1 when true, blank otherwise (as the original "Obsolete" column)
 */
export type CellKind = 'text' | 'integer' | 'money' | 'rate' | 'date' | 'month' | 'flag';

/** One column of an export table: original Excel header + explicit source field. */
export interface ExportColumn<T> {
  header: string;
  kind: CellKind;
  width: number;
  value: (row: T, index: number) => unknown;
}

/** A table with its values already read from the rows (columns and cells in final order). */
export interface ResolvedTable {
  title?: string;
  columns: { header: string; kind: CellKind; width: number }[];
  rows: unknown[][];
}

export interface ExportSheet {
  name: SheetName;
  tables: ResolvedTable[];
}
