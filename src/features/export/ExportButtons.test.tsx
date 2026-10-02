import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { AppError } from '../../lib/errors';

vi.mock('./excelExport', () => ({
  downloadWorkbook: vi.fn(),
  exportFileName: (sheet: string) => `Workshop_${sheet}_2026-10-02.xlsx`,
}));
vi.mock('./exportData', () => ({
  currentMonthPeriod: () => ({ from: '2026-10-01', to: '2026-10-31' }),
  loadAllSheets: vi.fn(),
}));

import { ExportButtons } from './ExportButtons';
import { downloadWorkbook } from './excelExport';
import { loadAllSheets } from './exportData';
import type { ExportSheet } from './exportTypes';

const sheet: ExportSheet = { name: 'Stock_Master', tables: [] };

function setup(loadSheet = vi.fn(async () => sheet)) {
  render(
    <ToastProvider>
      <ExportButtons sheet="Stock_Master" loadSheet={loadSheet} />
    </ToastProvider>,
  );
  return loadSheet;
}

describe('ExportButtons', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exports the current tab once, shows progress and confirms', async () => {
    let finish: () => void = () => {};
    vi.mocked(downloadWorkbook).mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const loadSheet = setup();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Export to Excel' }));
    const busy = await screen.findByRole('button', { name: 'Exporting…' });
    expect(busy).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export all' })).toBeDisabled();
    await user.click(busy); // ignored while running

    finish();
    expect(await screen.findByText('Excel export completed.')).toBeInTheDocument();
    expect(loadSheet).toHaveBeenCalledTimes(1);
    expect(downloadWorkbook).toHaveBeenCalledWith([sheet], 'Workshop_Stock_Master_2026-10-02.xlsx');
    expect(screen.getByRole('button', { name: 'Export to Excel' })).toBeEnabled();
  });

  it('exports all sheets with the current tab as an override', async () => {
    vi.mocked(loadAllSheets).mockResolvedValue([sheet]);
    const loadSheet = setup();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export all' }));
    await waitFor(() => expect(downloadWorkbook).toHaveBeenCalledWith([sheet], 'Workshop_all_2026-10-02.xlsx'));
    expect(loadAllSheets).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-31' }, { sheet: 'Stock_Master', load: loadSheet });
  });

  it('shows a friendly message without technical details on failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setup(vi.fn(async () => Promise.reject(new Error('relation "stock_items_view" does not exist'))));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export to Excel' }));
    expect(await screen.findByText('Unable to export the data. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText(/stock_items_view/)).not.toBeInTheDocument();
    expect(downloadWorkbook).not.toHaveBeenCalled();
  });

  it('keeps the existing permission message for authorization failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setup(vi.fn(async () => Promise.reject(new AppError('You do not have permission to do this.', '42501'))));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export to Excel' }));
    expect(await screen.findByText('You do not have permission to do this.')).toBeInTheDocument();
  });
});
