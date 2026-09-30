import { DataTable, type Column } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { useLoader } from '../../hooks/useLoader';
import { formatDateTime, formatQuantity } from '../../lib/format';
import { listAdjustments } from '../../services/stock';
import type { StockAdjustment, StockItem } from '../../types/database';

const TYPE_LABEL: Record<StockAdjustment['adjustment_type'], string> = {
  initial: 'Opening quantity',
  receive: 'Received',
  stock_check: 'Stock check',
  amendment: 'Amendment',
  sale: 'Sale',
  sale_void: 'Sale voided',
};

export function StockHistory({ item, onClose }: { item: StockItem; onClose: () => void }) {
  const history = useLoader(() => listAdjustments(item.id), item.id, 'Unable to load the stock history.');

  const columns: Column<StockAdjustment>[] = [
    { key: 'when', header: 'When', render: (r) => formatDateTime(r.created_at) },
    { key: 'type', header: 'Type', render: (r) => TYPE_LABEL[r.adjustment_type] },
    { key: 'prev', header: 'Before', align: 'right', render: (r) => formatQuantity(r.previous_quantity) },
    { key: 'new', header: 'After', align: 'right', render: (r) => formatQuantity(r.new_quantity) },
    {
      key: 'change',
      header: 'Change',
      align: 'right',
      render: (r) => (
        <span className={r.quantity_change < 0 ? 'negative' : undefined}>
          {r.quantity_change > 0 ? '+' : ''}
          {r.quantity_change}
        </span>
      ),
    },
    { key: 'reason', header: 'Reason', render: (r) => r.reason },
    { key: 'by', header: 'By', render: (r) => r.created_by_label },
  ];

  return (
    <Modal title={`History — ${item.item_code} ${item.description}`} onClose={onClose} wide>
      <DataTable
        caption="Stock history"
        columns={columns}
        rows={history.data ?? []}
        rowKey={(r) => r.id}
        loading={history.loading}
        error={history.error}
        emptyMessage="No stock changes recorded."
      />
    </Modal>
  );
}
