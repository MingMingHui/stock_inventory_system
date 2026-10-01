import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toast';
import type { ItemAnalytics, SalesLogRow } from '../types/database';

vi.mock('./auth/AuthProvider', () => ({ useAuth: vi.fn() }));
vi.mock('../services/sales', () => ({ listSales: vi.fn(), voidSaleItem: vi.fn(), voidSale: vi.fn() }));
vi.mock('../services/reference', () => ({ listCategories: vi.fn(async () => []) }));
vi.mock('../services/telegram', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/telegram')>()),
  createTelegramLinkCode: vi.fn(),
  getMyTelegramLink: vi.fn(),
  unlinkMyTelegram: vi.fn(),
}));
vi.mock('../services/analytics', () => ({
  analyticsMonthly: vi.fn(async () => []),
  analyticsCategories: vi.fn(async () => []),
  analyticsItems: vi.fn(),
}));

import { listSales, voidSale, voidSaleItem } from '../services/sales';
import { analyticsItems } from '../services/analytics';
import { createTelegramLinkCode, getMyTelegramLink, telegramDeepLink } from '../services/telegram';
import { Layout } from '../components/Layout';
import { SalesAnalyticsPage } from './analytics/SalesAnalyticsPage';
import { useAuth } from './auth/AuthProvider';
import { SalesLogPage } from './sales/SalesLogPage';
import { TelegramLinkDialog } from './telegram/TelegramLinkDialog';

function asRole(role: 'admin' | 'user') {
  vi.mocked(useAuth).mockReturnValue({
    state: { status: 'ready', session: {} as never, access: { email: `${role}@example.com`, display_name: null, role } },
    isAdmin: role === 'admin',
    signInWithGoogle: vi.fn(),
    signOut: vi.fn(),
  });
}

function saleLine(n: number): SalesLogRow {
  return {
    id: `line-${n}`, sale_id: 'bulk-sale', sale_date: '2026-10-01', source: 'app', is_void: false, seller: 'admin@example.com',
    notes: null, line_no: n, stock_item_id: `stock-${n}`, product_id: `p-${n}`, item_code: `ITEM-${n}`, description: `Item ${n}`,
    brand: null, category_id: 'c', category_name: 'Car Tyre', stock_before: 10, quantity: 2, stock_after: 8, agreed_price: 150,
    actual_price: 150, unit_cost: 100, revenue: 300, total_cost: 200, gross_profit: 100, rule_type: 'Fixed_Per_Unit',
    partner_a_rate: null, partner_a_rate_is_leftover: true, partner_b_rate: 10, partner_a_share: 280, partner_b_share: 20,
    price_drop_ratio: 0, price_alert: false, legacy_ref: null, created_at: '', void_reason: null, voided_at: null, voided_by_label: null,
  };
}

describe('bulk sale void (Sales Log)', () => {
  it('shows an individual Void action on every line and voids only the chosen line', async () => {
    asRole('admin');
    vi.mocked(listSales).mockResolvedValue({ rows: [1, 2, 3, 4, 5].map(saleLine), total: 5 });
    vi.mocked(voidSaleItem).mockResolvedValue(null);
    render(
      <ToastProvider>
        <SalesLogPage />
      </ToastProvider>,
    );

    const buttons = await screen.findAllByRole('button', { name: /^Void sale line/ });
    expect(buttons).toHaveLength(5);

    await userEvent.click(screen.getByRole('button', { name: /Void sale line ITEM-3/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Void this sale line only: ITEM-3');
    await userEvent.type(within(dialog).getByRole('textbox'), 'wrong size');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Void sale' }));

    await waitFor(() => expect(voidSaleItem).toHaveBeenCalledTimes(1));
    expect(voidSaleItem).toHaveBeenCalledWith('line-3', 'wrong size');
    expect(voidSale).not.toHaveBeenCalled();
  });

  it('shows no void action to normal users or on voided lines', async () => {
    asRole('user');
    vi.mocked(listSales).mockResolvedValue({ rows: [saleLine(1)], total: 1 });
    const { unmount } = render(
      <ToastProvider>
        <SalesLogPage />
      </ToastProvider>,
    );
    await screen.findByText('ITEM-1');
    expect(screen.queryByRole('button', { name: /Void sale line/ })).not.toBeInTheDocument();
    unmount();

    asRole('admin');
    vi.mocked(listSales).mockResolvedValue({ rows: [{ ...saleLine(1), is_void: true }, saleLine(2)], total: 2 });
    render(
      <ToastProvider>
        <SalesLogPage />
      </ToastProvider>,
    );
    await screen.findByText('ITEM-2');
    expect(screen.getAllByRole('button', { name: /Void sale line/ })).toHaveLength(1);
  });
});

describe('navigation', () => {
  it('shows Sales Analytics to admins only', () => {
    asRole('admin');
    const { unmount } = render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );
    const adminTabs = Array.from(screen.getByRole('navigation', { name: 'Main' }).querySelectorAll('a')).map((a) => a.textContent);
    expect(adminTabs).toEqual([
      'Partner Rule Table', 'Kali Inventory List', 'Stock Master', 'Sales Log', 'Partner Summary', 'Sales Analytics',
    ]);
    unmount();

    asRole('user');
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: 'Sales Analytics' })).not.toBeInTheDocument();
  });
});

describe('Telegram linking', () => {
  it('creates a one-time code and shows the deep link for the configured bot', async () => {
    asRole('user');
    vi.mocked(getMyTelegramLink).mockResolvedValue(null);
    vi.mocked(createTelegramLinkCode).mockResolvedValue({ code: 'c'.repeat(64), expires_at: '2026-10-01T10:10:00Z', bot_username: 'KaliWorkshopBot' });
    render(
      <ToastProvider>
        <TelegramLinkDialog onClose={vi.fn()} />
      </ToastProvider>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Link my Telegram account' }));
    expect(await screen.findByRole('link', { name: /Open @KaliWorkshopBot/ })).toHaveAttribute(
      'href',
      `https://t.me/KaliWorkshopBot?start=${'c'.repeat(64)}`,
    );
    expect(screen.getByText(`/start ${'c'.repeat(64)}`)).toBeInTheDocument();
  });

  it('does not offer relinking after an administrator deactivated the link', async () => {
    asRole('user');
    vi.mocked(getMyTelegramLink).mockResolvedValue({ telegram_username: 'staff', linked_at: '', last_seen_at: null, is_active: false });
    render(
      <ToastProvider>
        <TelegramLinkDialog onClose={vi.fn()} />
      </ToastProvider>,
    );
    expect(await screen.findByText(/deactivated by an administrator/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Link/ })).not.toBeInTheDocument();
  });

  it('builds safe deep links', () => {
    expect(telegramDeepLink('@Kali_Bot', 'abc')).toBe('https://t.me/Kali_Bot?start=abc');
  });
});

describe('Sales Analytics', () => {
  const item = (code: string, classification: ItemAnalytics['classification'], pattern: ItemAnalytics['pattern']): ItemAnalytics => ({
    product_id: code, item_code: code, description: `${code} desc`, brand: null, category_name: 'Car Tyre', units: 10, revenue: 1000,
    gross_profit: 400, avg_selling_price: 100, line_count: 5, months_with_sales: 4, months_without_sales: 2, units_recent: 0,
    monthly_units: [1, 2, 3, 0, 2, 2], current_stock: 25, oldest_stock_date: '2026-01-01', classification, pattern,
  });

  it('shows classifications and patterns from the database and filters them', async () => {
    asRole('admin');
    vi.mocked(analyticsItems).mockResolvedValue([item('BEST1', 'BEST SELLER', 'GROWING'), item('LOW1', 'LOW SELLER', 'NO RECENT SALES')]);
    render(
      <MemoryRouter>
        <SalesAnalyticsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('BEST1')).toBeInTheDocument();
    expect(screen.getAllByText('LOW SELLER').length).toBeGreaterThan(0);
    expect(screen.getByText(/stock 25, sold 0 in last 3 months, 2 months without sales/)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Item analysis' });
    expect(within(table).getByText('LOW1')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Classification'), 'BEST SELLER');
    expect(within(table).queryByText('LOW1')).not.toBeInTheDocument();
    expect(within(table).getByText('BEST1')).toBeInTheDocument();
    expect(analyticsItems).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), 6, 3);
  });

  it('is not available to normal users', () => {
    asRole('user');
    render(
      <MemoryRouter>
        <SalesAnalyticsPage />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('heading', { name: 'Sales Analytics' })).not.toBeInTheDocument();
  });
});
