import { useState } from 'react';
import { DataTable, type Column } from '../../components/DataTable';
import { Pagination } from '../../components/Pagination';
import { Money, TextField } from '../../components/ui';
import { useLoader } from '../../hooks/useLoader';
import { useTableState } from '../../hooks/useTableState';
import { monthKey, monthLabel, monthRange } from '../../lib/dates';
import { formatDate, formatPercent } from '../../lib/format';
import { type SalesSort, listSales } from '../../services/sales';
import type { SalesLogRow } from '../../types/database';

/** Sales made at least the configured threshold (default 10%) below the agreed price. */
export function PriceAlertsPanel() {
  const [month, setMonth] = useState(monthKey());
  const table = useTableState<SalesSort>({ column: 'sale_date', ascending: false });
  const filters = { ...monthRange(month), search: '', categoryId: '', priceAlertOnly: true, includeVoid: false };
  const data = useLoader(() => listSales(filters, table.request), `${month}|${table.key}`);

  const columns: Column<SalesLogRow, SalesSort>[] = [
    { key: 'date', header: 'Date', sortKey: 'sale_date', render: (r) => formatDate(r.sale_date) },
    { key: 'product', header: 'Product', sortKey: 'item_code', render: (r) => `${r.item_code} — ${r.description}` },
    { key: 'qty', header: 'Qty', align: 'right', render: (r) => r.quantity },
    { key: 'agreed', header: 'Agreed', align: 'right', render: (r) => <Money value={r.agreed_price} /> },
    { key: 'actual', header: 'Actual', align: 'right', render: (r) => <Money value={r.actual_price} /> },
    { key: 'drop', header: 'Below agreed', align: 'right', render: (r) => <strong className="negative">{formatPercent(r.price_drop_ratio)}</strong> },
    { key: 'seller', header: 'Recorded by', render: (r) => r.seller },
  ];

  return (
    <div>
      <div className="toolbar">
        <TextField label="Month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
      </div>
      <DataTable
        caption="Price alerts"
        columns={columns}
        rows={data.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={data.loading}
        error={data.error}
        emptyMessage={`No price alerts for ${monthLabel(month)}.`}
        sort={table.sort}
        onSort={table.toggleSort}
      />
      <Pagination page={table.page} pageSize={table.pageSize} total={data.data?.total ?? 0} onPage={table.setPage} />
    </div>
  );
}
