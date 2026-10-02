import type { Workbook } from 'exceljs';

// Checks a generated workbook before it is downloaded (and in tests): static
// values only, no Excel error values, no "undefined"/"null"/"NaN" text.

const ERROR_TEXT = /^#(REF!|VALUE!|NAME\?|DIV\/0!|N\/A|NUM!|NULL!)$/;
const LEAKED_TEXT = new Set(['undefined', 'null', 'NaN']);

export interface WorkbookIssues {
  formulaCells: string[];
  errorCells: string[];
  invalidCells: string[];
  missingSheets: string[];
}

export function inspectWorkbook(workbook: Workbook, expectedSheets: readonly string[]): WorkbookIssues {
  const issues: WorkbookIssues = { formulaCells: [], errorCells: [], invalidCells: [], missingSheets: [] };
  for (const name of expectedSheets) if (!workbook.getWorksheet(name)) issues.missingSheets.push(name);
  workbook.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const ref = `${sheet.name}!${cell.address}`;
        const value: unknown = cell.value;
        const isObject = typeof value === 'object' && value !== null && !(value instanceof Date);
        if (isObject && ('formula' in value || 'sharedFormula' in value)) issues.formulaCells.push(ref);
        else if (isObject && 'error' in value) issues.errorCells.push(ref);
        else if (typeof value === 'string' && ERROR_TEXT.test(value)) issues.errorCells.push(ref);
        else if (typeof value === 'string' && LEAKED_TEXT.has(value)) issues.invalidCells.push(ref);
        else if (typeof value === 'number' && !Number.isFinite(value)) issues.invalidCells.push(ref);
        else if (value instanceof Date && Number.isNaN(value.getTime())) issues.invalidCells.push(ref);
      });
    });
  });
  return issues;
}

export function assertValidWorkbook(workbook: Workbook, expectedSheets: readonly string[]): void {
  const { formulaCells, errorCells, invalidCells, missingSheets } = inspectWorkbook(workbook, expectedSheets);
  const problems = [...formulaCells, ...errorCells, ...invalidCells, ...missingSheets];
  if (problems.length > 0) {
    throw new Error(`Export validation failed: ${problems.slice(0, 10).join(', ')}`);
  }
}
