// Generates the .xlsx file in the browser (works on GitHub Pages: no server).
// Cells are written as static values with Excel number formats; no formulas.
// exceljs is loaded on first export only, so it does not grow the main bundle.

import type { Workbook, Worksheet } from 'exceljs';
import { today } from '../../lib/dates';
import { assertValidWorkbook } from './exportValidation';
import type { CellKind, ExportSheet, ResolvedTable, SheetName } from './exportTypes';

type ExcelJSModule = typeof import('exceljs');

// Number formats taken from the original workbook.
const NUMBER_FORMATS: Partial<Record<CellKind, string>> = {
  money: '[$RM]#,##0.00',
  integer: '0',
  date: 'dd/mm/yyyy',
  month: 'mmm-yyyy',
};

/** Numeric cell value from a database number (PostgREST may return numerics as strings). */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** "YYYY-MM-DD" (or a timestamp starting with it) as a UTC date, so Excel shows the same calendar day. */
function toDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, day));
  return date.getUTCDate() === day ? date : null; // rejects impossible dates such as 2026-02-30
}

/** The value written to a cell; null leaves the cell empty. */
export function toCellValue(kind: CellKind, value: unknown): string | number | Date | null {
  if (value === null || value === undefined || value === '') return null;
  switch (kind) {
    case 'integer':
    case 'money':
    case 'rate': {
      const n = toNumber(value);
      // Text such as "LEFTOVER" in a rate column stays text, as in the original workbook.
      if (n === null) return typeof value === 'string' ? value : null;
      return n;
    }
    case 'date':
    case 'month':
      return toDate(value);
    case 'flag':
      return value === true ? 1 : null;
    case 'text':
      return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
  }
}

function writeTable(sheet: Worksheet, table: ResolvedTable, startRow: number): number {
  let rowNo = startRow;
  if (table.title) {
    sheet.getCell(rowNo, 1).value = table.title;
    sheet.getCell(rowNo, 1).font = { bold: true, size: 12 };
    rowNo += 1;
  }
  const header = sheet.getRow(rowNo);
  table.columns.forEach((c, i) => {
    header.getCell(i + 1).value = c.header;
  });
  header.font = { bold: true };
  rowNo += 1;
  for (const values of table.rows) {
    const row = sheet.getRow(rowNo);
    table.columns.forEach((c, i) => {
      const value = toCellValue(c.kind, values[i]);
      if (value === null) return;
      const cell = row.getCell(i + 1);
      cell.value = value;
      const format = NUMBER_FORMATS[c.kind];
      if (format && typeof value !== 'string') cell.numFmt = format;
    });
    rowNo += 1;
  }
  return rowNo;
}

function addSheet(workbook: Workbook, spec: ExportSheet): void {
  const sheet = workbook.addWorksheet(spec.name);
  let rowNo = 1;
  spec.tables.forEach((table, index) => {
    if (index > 0) rowNo += 1; // one blank row between blocks
    rowNo = writeTable(sheet, table, rowNo);
  });
  const widths: number[] = [];
  for (const table of spec.tables) {
    table.columns.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, c.width, c.header.length + 2);
    });
  }
  widths.forEach((width, i) => {
    sheet.getColumn(i + 1).width = width;
  });
  if (spec.tables.length === 1) sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

/** Builds and validates the workbook. Throws if any formula or error value is present. */
export async function buildWorkbook(sheets: ExportSheet[]): Promise<Workbook> {
  const mod = (await import('exceljs')) as ExcelJSModule & { default?: ExcelJSModule };
  const { Workbook } = mod.default ?? mod;
  const workbook = new Workbook();
  workbook.creator = 'Workshop Stock & Sales';
  workbook.created = new Date();
  for (const sheet of sheets) addSheet(workbook, sheet);
  assertValidWorkbook(
    workbook,
    sheets.map((s) => s.name),
  );
  return workbook;
}

/** e.g. Workshop_Stock_Master_2026-10-02.xlsx, or Workshop_Stocklist_Export_2026-10-02.xlsx for all sheets. */
export function exportFileName(sheet: SheetName | 'all', date: string = today()): string {
  return sheet === 'all' ? `Workshop_Stocklist_Export_${date}.xlsx` : `Workshop_${sheet}_${date}.xlsx`;
}

export async function downloadWorkbook(sheets: ExportSheet[], fileName: string): Promise<void> {
  const workbook = await buildWorkbook(sheets);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Revoke later: some browsers start the download asynchronously.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
