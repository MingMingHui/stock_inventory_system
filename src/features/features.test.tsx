import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SalePreview, StockItem } from '../types/database';

vi.mock('./auth/AuthProvider', () => ({ useAuth: vi.fn() }));
vi.mock('../services/stock', () => ({
  adjustStock: vi.fn(),
  searchSellableStock: vi.fn(),
  addStockItem: vi.fn(),
  setMinQuantity: vi.fn(),
  updateStockDetails: vi.fn(),
}));
vi.mock('../services/sales', () => ({ previewSaleLine: vi.fn(), createSale: vi.fn() }));

import { adjustStock, searchSellableStock } from '../services/stock';
import { createSale, previewSaleLine } from '../services/sales';
import { AuthGate } from './auth/AuthGate';
import { useAuth } from './auth/AuthProvider';
import { SaleForm } from './sales/SaleForm';
import { AdjustStockForm } from './stock/StockForms';

const battery: StockItem = {
  id: 'stock-1',
  product_id: 'p-1',
  item_code: 'BAT-NS40',
  description: 'NS40ZL',
  brand: 'Motorlite',
  unit: 'pcs',
  is_non_stock: false,
  category_id: 'c-1',
  category_name: 'Car Battery',
  purchased_date: '2026-08-28',
  unit_cost: 142.3,
  agreed_price: 195,
  quantity: 10,
  min_quantity: null,
  effective_min_quantity: 1,
  status: 'ACTIVE',
  is_obsolete: false,
  obsolete_at: null,
  last_checked_at: null,
  notes: null,
  legacy_ref: null,
  created_at: '',
  updated_at: '',
};

function authState(state: ReturnType<typeof useAuth>['state']) {
  vi.mocked(useAuth).mockReturnValue({ state, isAdmin: false, signInWithGoogle: vi.fn(), signOut: vi.fn() });
}

describe('AuthGate', () => {
  it('asks signed-out visitors to sign in with Google', () => {
    authState({ status: 'signed_out' });
    render(<AuthGate>secret</AuthGate>);
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('rejects Google accounts that are not on the allow-list', () => {
    authState({ status: 'unauthorized', email: 'stranger@gmail.com' });
    render(<AuthGate>secret</AuthGate>);
    expect(screen.getByRole('alert')).toHaveTextContent('stranger@gmail.com is not authorised');
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('renders the application for authorised users', () => {
    authState({ status: 'ready', session: {} as never, access: { email: 'u@example.com', display_name: null, role: 'user' } });
    render(<AuthGate>secret</AuthGate>);
    expect(screen.getByText('secret')).toBeInTheDocument();
  });
});

describe('AdjustStockForm', () => {
  it('requires a reason and sends the quantity the user saw (lost-update guard)', async () => {
    vi.mocked(adjustStock).mockResolvedValue({} as never);
    const onSaved = vi.fn();
    render(<AdjustStockForm item={battery} onClose={vi.fn()} onSaved={onSaved} />);

    await userEvent.type(screen.getByLabelText(/Counted quantity/), '8');
    expect(screen.getByText(/New quantity/)).toHaveTextContent('New quantity: 8 (change -2)');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a reason');
    expect(adjustStock).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText(/Reason/), 'Month-end count');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(adjustStock).toHaveBeenCalledWith('stock-1', 'stock_check', 8, 'Month-end count', 10);
  });

  it('rejects negative and fractional quantities before calling the server', async () => {
    vi.mocked(adjustStock).mockClear();
    render(<AdjustStockForm item={battery} onClose={vi.fn()} onSaved={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/Counted quantity/), '-3');
    await userEvent.type(screen.getByLabelText(/Reason/), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('whole number');
    expect(adjustStock).not.toHaveBeenCalled();
  });
});

describe('SaleForm', () => {
  const preview: SalePreview = {
    stock_item_id: 'stock-1',
    category_name: 'Car Battery',
    stock_before: 10,
    stock_after: 8,
    is_non_stock: false,
    agreed_price: 195,
    actual_price: 170,
    unit_cost: 142.3,
    quantity: 2,
    revenue: 340,
    total_cost: 284.6,
    gross_profit: 55.4,
    rule_type: 'Fixed_Per_Unit',
    partner_a_rate: null,
    partner_a_rate_is_leftover: true,
    partner_b_rate: 10,
    partner_a_share: 320,
    partner_b_share: 20,
    price_drop_ratio: 0.1282,
    price_alert: true,
    price_alert_threshold: 0.1,
    insufficient_stock: false,
  };

  it('shows the database calculation and price alert, and sends only item, quantity and actual price', async () => {
    vi.mocked(searchSellableStock).mockResolvedValue([battery]);
    vi.mocked(previewSaleLine).mockResolvedValue(preview);
    vi.mocked(createSale).mockResolvedValue('sale-1');
    const onSaved = vi.fn();
    render(<SaleForm onClose={vi.fn()} onSaved={onSaved} />);

    await userEvent.type(screen.getByPlaceholderText(/Search stock/), 'NS40');
    await userEvent.click(await screen.findByRole('button', { name: /BAT-NS40/ }));
    const qty = screen.getByLabelText(/Quantity/);
    await userEvent.clear(qty);
    await userEvent.type(qty, '2');
    const price = screen.getByLabelText(/Actual selling price/);
    await userEvent.clear(price);
    await userEvent.type(price, '170');

    expect(await screen.findByText('PRICE ALERT: Actual selling price is 12.8% below agreed price.')).toBeInTheDocument();
    expect(previewSaleLine).toHaveBeenLastCalledWith('stock-1', 2, 170, expect.any(String));

    await userEvent.click(screen.getByRole('button', { name: 'Add to sale' }));
    await userEvent.click(screen.getByRole('button', { name: /Save sale \(1 line\)/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(1));
    expect(createSale).toHaveBeenCalledWith(expect.any(String), [{ stockItemId: 'stock-1', quantity: 2, actualPrice: 170 }], '');
  });
});
