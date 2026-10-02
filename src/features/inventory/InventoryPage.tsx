import { useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { Pagination } from '../../components/Pagination';
import { useToast } from '../../components/Toast';
import { InventoryStatusBadge, PageHeader, SearchInput, SelectField, TextField } from '../../components/ui';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useLoader } from '../../hooks/useLoader';
import { useTableState } from '../../hooks/useTableState';
import { toUserMessage } from '../../lib/errors';
import { formatDateTime, formatQuantity } from '../../lib/format';
import { isWholeNumber, parseNumber } from '../../lib/numbers';
import { type InventorySort, deleteInventoryItem, listInventory, saveInventoryItem } from '../../services/inventory';
import { INVENTORY_STATUSES, type InventoryItem, type InventoryStatus } from '../../types/database';
import { useAuth } from '../auth/AuthProvider';
import { ExportButtons } from '../export/ExportButtons';
import { loadInventorySheet } from '../export/exportData';

export function InventoryPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const term = useDebouncedValue(search);
  const table = useTableState<InventorySort>({ column: 'name', ascending: true });
  const data = useLoader(() => listInventory(term, table.request), `${term}|${table.key}`);
  const [editing, setEditing] = useState<InventoryItem | 'new' | null>(null);
  const [deleting, setDeleting] = useState<InventoryItem | null>(null);

  const columns: Column<InventoryItem, InventorySort>[] = [
    { key: 'name', header: 'Item', sortKey: 'name', render: (r) => <strong>{r.name}</strong> },
    { key: 'brand', header: 'Brand / colour', render: (r) => r.brand ?? '—' },
    { key: 'category', header: 'Category', sortKey: 'category', render: (r) => r.category ?? '—' },
    { key: 'qty', header: 'Quantity', sortKey: 'quantity', align: 'right', render: (r) => formatQuantity(r.quantity) },
    { key: 'status', header: 'Status', sortKey: 'status', render: (r) => <InventoryStatusBadge status={r.status} /> },
    { key: 'updated', header: 'Last updated', sortKey: 'updated_at', render: (r) => formatDateTime(r.updated_at) },
  ];
  if (isAdmin) {
    columns.push({
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="row-actions">
          <button type="button" className="btn btn-small" onClick={() => setEditing(r)}>
            Edit
          </button>
          <button type="button" className="btn btn-small btn-danger-outline" onClick={() => setDeleting(r)}>
            Delete
          </button>
        </div>
      ),
    });
  }

  return (
    <section>
      <PageHeader
        title="Kali Inventory List"
        description="Machinery and equipment shared in the workshop (not for sale)."
        actions={
          <>
            <ExportButtons sheet="Inventory_List" loadSheet={() => loadInventorySheet(term, table.sort)} />
            {isAdmin ? (
              <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
                Add item
              </button>
            ) : (
              <span className="read-only-note">Read only — administrators maintain this list.</span>
            )}
          </>
        }
      />
      <div className="toolbar">
        <SearchInput
          label="Search item, brand or category"
          value={search}
          onChange={(v) => {
            setSearch(v);
            table.setPage(1);
          }}
        />
      </div>
      <DataTable
        caption="Shared inventory"
        columns={columns}
        rows={data.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={data.loading}
        error={data.error}
        emptyMessage={term ? `No inventory matches “${term}”.` : 'No inventory items yet.'}
        sort={table.sort}
        onSort={table.toggleSort}
      />
      <Pagination page={table.page} pageSize={table.pageSize} total={data.data?.total ?? 0} onPage={table.setPage} />
      {editing && (
        <InventoryForm
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast.success('Inventory item saved.');
            data.reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete inventory item"
          message={`Delete “${deleting.name}”? Consider setting its status to Disposed instead to keep a record.`}
          confirmLabel="Delete"
          destructive
          onConfirm={async () => {
            await deleteInventoryItem(deleting.id);
            toast.success('Inventory item deleted.');
            data.reload();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

function InventoryForm({ item, onClose, onSaved }: { item: InventoryItem | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item?.name ?? '');
  const [brand, setBrand] = useState(item?.brand ?? '');
  const [category, setCategory] = useState(item?.category ?? '');
  const [quantity, setQuantity] = useState(String(item?.quantity ?? 1));
  const [status, setStatus] = useState<InventoryStatus>(item?.status ?? 'ACTIVE');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const qty = parseNumber(quantity);
    if (!name.trim()) return setError('Enter the item name.');
    if (!isWholeNumber(qty)) return setError('Quantity must be a whole number, zero or more.');
    setBusy(true);
    setError(null);
    try {
      await saveInventoryItem(item?.id ?? null, { name, brand, category, quantity: qty, status, notes });
      onSaved();
    } catch (e) {
      setError(toUserMessage(e, 'Unable to save the inventory item.'));
      setBusy(false);
    }
  }

  return (
    <Modal title={item ? 'Edit inventory item' : 'Add inventory item'} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <TextField label="Item" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        <TextField label="Brand / colour" value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={80} />
        <TextField label="Category" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} />
        <TextField
          label="Quantity"
          inputMode="numeric"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          required
        />
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value as InventoryStatus)}>
          {INVENTORY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ').toLowerCase()}
            </option>
          ))}
        </SelectField>
        <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
