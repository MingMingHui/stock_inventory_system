import { useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { Pagination } from '../../components/Pagination';
import { useToast } from '../../components/Toast';
import { CheckboxField, Money, PageHeader, SearchInput, SelectField, StockStatusBadge } from '../../components/ui';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useLoader } from '../../hooks/useLoader';
import { useTableState } from '../../hooks/useTableState';
import { formatDate, formatQuantity } from '../../lib/format';
import { listCategories } from '../../services/reference';
import { type StockFilters, type StockSort, listStock, setObsolete } from '../../services/stock';
import { STOCK_STATUSES, type StockItem, type StockStatus } from '../../types/database';
import { useAuth } from '../auth/AuthProvider';
import { ExportButtons } from '../export/ExportButtons';
import { loadStockSheet } from '../export/exportData';
import { AddStockForm, AdjustStockForm, MinQuantityForm, StockDetailsForm } from './StockForms';
import { StockHistory } from './StockHistory';

type Dialog =
  | { kind: 'add' }
  | { kind: 'adjust'; item: StockItem }
  | { kind: 'min'; item: StockItem }
  | { kind: 'details'; item: StockItem }
  | { kind: 'history'; item: StockItem }
  | { kind: 'obsolete'; item: StockItem };

export function StockMasterPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StockStatus | ''>('');
  const [categoryId, setCategoryId] = useState('');
  const [includeObsolete, setIncludeObsolete] = useState(false);
  const term = useDebouncedValue(search);
  const table = useTableState<StockSort>({ column: 'item_code', ascending: true });
  const filters: StockFilters = { search: term, status, categoryId, includeObsolete };
  const data = useLoader(() => listStock(filters, table.request), `${JSON.stringify(filters)}|${table.key}`);
  const categories = useLoader(listCategories, 'categories');
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const resetPage = () => table.setPage(1);
  const done = (message: string) => {
    setDialog(null);
    toast.success(message);
    data.reload();
  };

  const columns: Column<StockItem, StockSort>[] = [
    {
      key: 'item',
      header: 'Item',
      sortKey: 'item_code',
      render: (r) => (
        <div className="cell-stack">
          <strong>{r.item_code}</strong>
          <span>{r.description}</span>
          {r.brand && <small className="muted">{r.brand}</small>}
        </div>
      ),
    },
    { key: 'category', header: 'Category', sortKey: 'category_name', render: (r) => r.category_name },
    {
      key: 'qty',
      header: 'Quantity',
      sortKey: 'quantity',
      align: 'right',
      render: (r) =>
        r.is_non_stock ? (
          <span className="muted" title="Service item — stock is not tracked">
            service
          </span>
        ) : (
          <span>
            <strong>{formatQuantity(r.quantity)}</strong>
            {r.unit && <small className="muted"> {r.unit}</small>}
            <small className="muted block">min {r.effective_min_quantity}</small>
          </span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      render: (r) => (
        <div className="cell-stack">
          <StockStatusBadge status={r.status} />
          {r.is_obsolete && r.obsolete_remarks && <small className="muted">{r.obsolete_remarks}</small>}
        </div>
      ),
    },
    { key: 'cost', header: 'Cost', align: 'right', render: (r) => <Money value={r.unit_cost} /> },
    { key: 'price', header: 'Agreed price', sortKey: 'agreed_price', align: 'right', render: (r) => <Money value={r.agreed_price} /> },
    {
      key: 'purchased',
      header: 'Purchased',
      render: (r) => (
        <div className="cell-stack">
          <span>{formatDate(r.purchased_date)}</span>
          {r.fifo_rank !== null && r.active_batch_count > 1 && (
            <small className={r.fifo_rank === 1 ? 'fifo-first' : 'muted'} title="FIFO: earliest purchase is used first">
              {r.fifo_rank === 1 ? 'FIFO: use first' : `FIFO ${r.fifo_rank} of ${r.active_batch_count}`}
            </small>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="row-actions">
          {!r.is_non_stock && !r.is_obsolete && (
            <button type="button" className="btn btn-small btn-primary" onClick={() => setDialog({ kind: 'adjust', item: r })}>
              Adjust
            </button>
          )}
          {!r.is_non_stock && (
            <button type="button" className="btn btn-small" onClick={() => setDialog({ kind: 'min', item: r })}>
              Min qty
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={() => setDialog({ kind: 'history', item: r })}>
            History
          </button>
          {isAdmin && (
            <button type="button" className="btn btn-small" onClick={() => setDialog({ kind: 'details', item: r })}>
              Edit
            </button>
          )}
          <button
            type="button"
            className="btn btn-small btn-danger-outline"
            onClick={() => setDialog({ kind: 'obsolete', item: r })}
          >
            {r.is_obsolete ? 'Restore' : 'Obsolete'}
          </button>
        </div>
      ),
    },
  ];

  return (
    <section>
      <PageHeader
        title="Stock Master"
        description="Stock on hand by purchase batch, earliest purchase first (FIFO). Every quantity change is recorded with a reason and the user who made it. An older batch that reaches zero while a newer batch exists is retired automatically (auto-rule obsolete)."
        actions={
          <>
            <ExportButtons sheet="Stock_Master" loadSheet={() => loadStockSheet(filters, table.sort)} />
            <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'add' })}>
              Add stock
            </button>
          </>
        }
      />
      <div className="toolbar">
        <SearchInput
          label="Search code, description or brand"
          value={search}
          onChange={(v) => {
            setSearch(v);
            resetPage();
          }}
        />
        <SelectField
          label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as StockStatus | '');
            resetPage();
          }}
        >
          <option value="">All (except obsolete)</option>
          {STOCK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, ' ').toLowerCase()}
            </option>
          ))}
        </SelectField>
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
          label="Include obsolete"
          checked={includeObsolete}
          onChange={(v) => {
            setIncludeObsolete(v);
            resetPage();
          }}
        />
      </div>
      <DataTable
        caption="Stock items"
        columns={columns}
        rows={data.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={data.loading}
        error={data.error}
        emptyMessage="No stock items match these filters."
        sort={table.sort}
        onSort={table.toggleSort}
        rowClassName={(r) => (r.status === 'LOW_STOCK' ? 'row-warn' : r.status === 'OUT_OF_STOCK' ? 'row-danger' : undefined)}
      />
      <Pagination page={table.page} pageSize={table.pageSize} total={data.data?.total ?? 0} onPage={table.setPage} />

      {dialog?.kind === 'add' && (
        <AddStockForm categories={categories.data ?? []} onClose={() => setDialog(null)} onSaved={() => done('Stock item added.')} />
      )}
      {dialog?.kind === 'adjust' && (
        <AdjustStockForm item={dialog.item} onClose={() => setDialog(null)} onSaved={() => done('Stock quantity saved.')} />
      )}
      {dialog?.kind === 'min' && (
        <MinQuantityForm item={dialog.item} onClose={() => setDialog(null)} onSaved={() => done('Minimum quantity saved.')} />
      )}
      {dialog?.kind === 'details' && (
        <StockDetailsForm item={dialog.item} onClose={() => setDialog(null)} onSaved={() => done('Stock details saved.')} />
      )}
      {dialog?.kind === 'history' && <StockHistory item={dialog.item} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'obsolete' && (
        <ConfirmDialog
          title={dialog.item.is_obsolete ? 'Restore stock item' : 'Mark stock item obsolete'}
          message={
            dialog.item.is_obsolete
              ? `Make ${dialog.item.item_code} (${dialog.item.description}) available for sale again?`
              : `Mark ${dialog.item.item_code} (${dialog.item.description}) as obsolete? It will no longer be offered for sale. Its history and past sales are kept.`
          }
          confirmLabel={dialog.item.is_obsolete ? 'Restore' : 'Mark obsolete'}
          destructive={!dialog.item.is_obsolete}
          onConfirm={async () => {
            await setObsolete(dialog.item.id, !dialog.item.is_obsolete);
            toast.success(dialog.item.is_obsolete ? 'Stock item restored.' : 'Stock item marked obsolete.');
            data.reload();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}
