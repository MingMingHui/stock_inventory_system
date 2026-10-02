import { useRef, useState } from 'react';
import { useToast } from '../../components/Toast';
import { toUserMessage } from '../../lib/errors';
import { downloadWorkbook, exportFileName } from './excelExport';
import { type ExportPeriod, currentMonthPeriod, loadAllSheets } from './exportData';
import type { ExportSheet, SheetName } from './exportTypes';

const FAILED = 'Unable to export the data. Please try again.';

/**
 * "Export to Excel" (this tab, with its current filters, all pages) and
 * "Export all" (all five sheets). Only data the user can already read is
 * exported: the queries are the page's own, under the user's session and RLS.
 */
export function ExportButtons({
  sheet,
  loadSheet,
  period,
}: {
  sheet: SheetName;
  loadSheet: () => Promise<ExportSheet>;
  /** Period for Sales_Log and Partner_Summary in "Export all" (default: current month). */
  period?: ExportPeriod;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<'sheet' | 'all' | null>(null);
  // Guards double clicks that arrive before the disabled state renders.
  const running = useRef(false);

  async function run(kind: 'sheet' | 'all') {
    if (running.current) return;
    running.current = true;
    setBusy(kind);
    try {
      const sheets =
        kind === 'sheet' ? [await loadSheet()] : await loadAllSheets(period ?? currentMonthPeriod(), { sheet, load: loadSheet });
      await downloadWorkbook(sheets, exportFileName(kind === 'sheet' ? sheet : 'all'));
      toast.success('Excel export completed.');
    } catch (e) {
      console.error('Excel export failed', e);
      toast.error(toUserMessage(e, FAILED));
    } finally {
      running.current = false;
      setBusy(null);
    }
  }

  return (
    <>
      <button type="button" className="btn" disabled={busy !== null} onClick={() => run('sheet')}>
        {busy === 'sheet' ? 'Exporting…' : 'Export to Excel'}
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy !== null}
        onClick={() => run('all')}
        title="All five sheets in one workbook"
      >
        {busy === 'all' ? 'Exporting…' : 'Export all'}
      </button>
    </>
  );
}
