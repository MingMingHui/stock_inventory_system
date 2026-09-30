import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DataTable } from './DataTable';

vi.mock('../features/auth/AuthProvider', () => ({ useAuth: vi.fn() }));
import { useAuth } from '../features/auth/AuthProvider';
import { Layout } from './Layout';

interface Row {
  id: string;
  name: string;
}

describe('DataTable', () => {
  const columns = [{ key: 'name', header: 'Name', sortKey: 'name' as const, render: (r: Row) => r.name }];

  it('shows the empty state', () => {
    render(<DataTable caption="t" columns={columns} rows={[]} rowKey={(r) => r.id} emptyMessage="No sales found for September 2026." />);
    expect(screen.getByText('No sales found for September 2026.')).toBeInTheDocument();
  });

  it('shows errors as alerts instead of rows', () => {
    render(<DataTable caption="t" columns={columns} rows={[{ id: '1', name: 'x' }]} rowKey={(r) => r.id} error="Unable to load stock." emptyMessage="" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load stock.');
    expect(screen.queryByText('x')).not.toBeInTheDocument();
  });

  it('exposes sort state and requests server-side sorting', async () => {
    const onSort = vi.fn();
    render(
      <DataTable
        caption="t"
        columns={columns}
        rows={[{ id: '1', name: 'Tyre' }]}
        rowKey={(r) => r.id}
        emptyMessage=""
        sort={{ column: 'name', ascending: true }}
        onSort={onSort}
      />,
    );
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(onSort).toHaveBeenCalledWith('name');
  });
});

describe('Layout', () => {
  function renderAs(role: 'admin' | 'user') {
    vi.mocked(useAuth).mockReturnValue({
      state: { status: 'ready', session: {} as never, access: { email: `${role}@example.com`, display_name: null, role } },
      isAdmin: role === 'admin',
      signInWithGoogle: vi.fn(),
      signOut: vi.fn(),
    });
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );
  }

  it('has exactly the five primary tabs in order', () => {
    renderAs('user');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const tabs = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent);
    expect(tabs).toEqual(['Partner Rule Table', 'Kali Inventory List', 'Stock Master', 'Sales Log', 'Partner Summary']);
  });

  it('shows the admin link to admins only', () => {
    renderAs('user');
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('shows the admin link to admins', () => {
    renderAs('admin');
    expect(screen.getByRole('link', { name: 'Admin' })).toBeInTheDocument();
  });
});
