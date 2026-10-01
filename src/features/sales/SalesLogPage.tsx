import { useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { Pagination } from '../../components/Pagination';
import { useToast } from '../../components/Toast';
import { Badge, CheckboxField, Money, PageHeader, SearchInput, SelectField, TextField } from '../../components/ui';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useLoader } from '../../hooks/useLoader';
import { useTableState } from '../../hooks/useTableState';
import { monthKey, monthLabel, monthRange } from '../../lib/dates';
import { formatDate, formatPercent, formatQuantity, formatRate } from '../../lib/format';
import { listCategories } from '../../services/reference';
import { type SalesFilters, type SalesSort, listSales, voidSaleItem } from '../../services/sales';
import type { SalesLogRow } from '../../types/database';
import { useAuth } from '../auth/AuthProvider';
import { SaleForm } from './SaleForm';

export function SalesLogPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [month, setMonth] = useState(monthKey());
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [priceAlertOnly, setPriceAlertOnly] = useState(false);
  const [includeVoid, setIncludeVoid] = useState(false);
  const term = useDebouncedValue(search);
  const table = useTableState<SalesSort>({ column: 'sale_date', ascending: false });
  const range = monthRange(month);
  const filters: SalesFilters = { ...range, search: term, categoryId, priceAlertOnly, includeVoid };
  const data = useLoader(() => listSales(filters, table.request), `${JSON.stringify(filters)}|${table.key}`);
  const categories = useLoader(listCategories, 'categories');
  const [recording, setRecording] = useState(false);
  const [voiding, setVoiding] = useState<SalesLogRow | null>(null);
  const resetPage = () => table.setPage(1);

  const columns: Column<SalesLogRow, SalesSort>[] = [
    {
      key: 'date',
      header: 'Sale date',
      sortKey: 'sale_date',
      render: (r) => (
        <div className="cell-stack">
          <span>{formatDate(r.sale_date)}</span>
          {r.source === 'excel_import' && <small className="muted">Excel (monthly)</small>}
          {r.is_void && (
            <span title={r.void_reason ? `Void: ${r.void_reason}` : undefined}>
              <Badge tone="muted">void</Badge>
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      sortKey: 'item_code',
      render: (r) => (
        <div className="cell-stack">
          <strong>{r.item_code}</strong>
          <span>{r.description}</span>
        </div>
      ),
    },
    { key: 'category', header: 'Category', sortKey: 'category_name', render: (r) => r.category_name },
    { key: 'before', header: 'Stock before', align: 'right', render: (r) => formatQuantity(r.stock_before) },
    { key: 'qty', header: 'Sales qty', align: 'right', render: (r) => <strong>{formatQuantity(r.quantity)}</strong> },
    { key: 'after', header: 'After sale', align: 'right', render: (r) => formatQuantity(r.stock_after) },
    { key: 'agreed', header: 'Agreed price', align: 'right', render: (r) => <Money value={r.agreed_price} /> },
    {
      key: 'actual',
      header: 'Actual price (per item)',
      align: 'right',
      render: (r) => (
        <div className="cell-stack align-right">
          <Money value={r.actual_price} />
          {r.price_alert && (
            <Badge tone="danger">
              {formatPercent(r.price_drop_ratio)} below
            </Badge>
          )}
        </div>
      ),
    },
    { key: 'revenue', header: 'Total revenue', sortKey: 'revenue', align: 'right', render: (r) => <Money value={r.revenue} strong /> },
    { key: 'unit_cost', header: 'Cost per item', align: 'right', render: (r) => <Money value={r.unit_cost} /> },
    { key: 'cost', header: 'Total cost', align: 'right', render: (r) => <Money value={r.total_cost} /> },
    { key: 'gp', header: 'Gross profit', sortKey: 'gross_profit', align: 'right', render: (r) => <Money value={r.gross_profit} /> },
    { key: 'rule', header: 'Rule type', render: (r) => <code>{r.rule_type}</code> },
    {
      key: 'a_rate',
      header: 'Partner A rate',
      align: 'right',
      render: (r) => (r.partner_a_rate_is_leftover ? 'LEFTOVER' : formatRate(r.partner_a_rate)),
    },
    { key: 'b_rate', header: 'Partner B rate', align: 'right', render: (r) => formatRate(r.partner_b_rate) },
    { key: 'a_share', header: 'Partner A share', align: 'right', render: (r) => <Money value={r.partner_a_share} /> },
    { key: 'b_share', header: 'Partner B share', align: 'right', render: (r) => <Money value={r.partner_b_share} /> },
    { key: 'seller', header: 'Recorded by', render: (r) => r.seller },
  ];
  if (isAdmin) {
    // Every line has its own Void action; it voids that line only (void_sale_item).
    columns.push({
      key: 'actions',
      header: 'Actions',
      render: (r) =>
        r.is_void ? null : (
          <button
            type="button"
            className="btn btn-small btn-danger-outline"
            onClick={() => setVoiding(r)}
            aria-label={`Void sale line ${r.item_code} ${r.description}, quantity ${r.quantity}`}
          >
            Void sale
          </button>
        ),
    });
  }

  return (
    <section>
      <PageHeader
        title="Sales Log"
        description="Each sale records the agreed and actual price, the partner rule and rates in force, and the resulting shares."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setRecording(true)}>
            Record sale
          </button>
        }
      />
      <div className="toolbar">
        <TextField
          label="Month"
          type="month"
          value={month}
          onChange={(e) => {
            if (e.target.value) {
              setMonth(e.target.value);
              resetPage();
            }
          }}
        />
        <SearchInput
          label="Search product or seller"
          value={search}
          onChange={(v) => {
            setSearch(v);
            resetPage();
          }}
        />
        <SelectField
          label="Category"
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            resetPage();
          }}
        >
          <option value="">All categories</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <CheckboxField
          label="Price alerts only"
          checked={priceAlertOnly}
          onChange={(v) => {
            setPriceAlertOnly(v);
            resetPage();
          }}
        />
        <CheckboxField
          label="Include voided"
          checked={includeVoid}
          onChange={(v) => {
            setIncludeVoid(v);
            resetPage();
          }}
        />
      </div>
      <DataTable
        caption={`Sales for ${monthLabel(month)}`}
        columns={columns}
        rows={data.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={data.loading}
        error={data.error}
        emptyMessage={`No sales found for ${monthLabel(month)}.`}
        sort={table.sort}
        onSort={table.toggleSort}
        rowClassName={(r) => (r.is_void ? 'row-void' : r.price_alert ? 'row-warn' : undefined)}
      />
      <Pagination page={table.page} pageSize={table.pageSize} total={data.data?.total ?? 0} onPage={table.setPage} />

      {recording && (
        <SaleForm
          onClose={() => setRecording(false)}
          onSaved={(alerts) => {
            setRecording(false);
            toast.success('Sale recorded. Stock has been updated.');
            if (alerts > 0) toast.warning(`${alerts} line(s) sold at least 10% below the agreed price — visible to administrators.`);
            data.reload();
          }}
        />
      )}
      {voiding && (
        <ConfirmDialog
          title="Void sale"
          message={`Void this sale line only: ${voiding.item_code} ${voiding.description}, quantity ${formatQuantity(voiding.quantity)}, ${formatDate(voiding.sale_date)}${voiding.source === 'app' ? '. Its stock will be returned' : ''}. Other lines of the same sale are not affected. The line stays in the log marked as void.`}
          confirmLabel="Void sale"
          destructive
          reasonLabel="Reason"
          onConfirm={async (reason) => {
            await voidSaleItem(voiding.id, reason);
            toast.success('Sale line voided.');
            data.reload();
          }}
          onClose={() => setVoiding(null)}
        />
      )}
    </section>
  );
}
