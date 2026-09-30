import { useState } from 'react';
import { DataTable, type Column } from '../../components/DataTable';
import { Pagination } from '../../components/Pagination';
import { Badge, SearchInput } from '../../components/ui';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useLoader } from '../../hooks/useLoader';
import { formatDateTime } from '../../lib/format';
import { listAuditLogs } from '../../services/admin';
import type { AuditLog } from '../../types/database';

const PAGE_SIZE = 25;

function describeChange(log: AuditLog): string {
  if (log.action !== 'UPDATE' || !log.changed_fields) return '';
  return log.changed_fields
    .map((field) => `${field}: ${JSON.stringify(log.old_data?.[field] ?? null)} → ${JSON.stringify(log.new_data?.[field] ?? null)}`)
    .join('; ');
}

export function AuditLogPanel() {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebouncedValue(search);
  const logs = useLoader(() => listAuditLogs(term, page, PAGE_SIZE), `${term}|${page}`, 'Unable to load the audit log.');

  const columns: Column<AuditLog>[] = [
    { key: 'when', header: 'When', render: (l) => formatDateTime(l.occurred_at) },
    { key: 'who', header: 'Who', render: (l) => l.actor_label },
    {
      key: 'action',
      header: 'Action',
      render: (l) => <Badge tone={l.action === 'DELETE' ? 'danger' : l.action === 'INSERT' ? 'ok' : 'info'}>{l.action.toLowerCase()}</Badge>,
    },
    { key: 'table', header: 'Record', render: (l) => <code>{l.table_name}</code> },
    { key: 'changes', header: 'Changes', className: 'cell-wrap', render: (l) => describeChange(l) },
  ];

  return (
    <div>
      <div className="toolbar">
        <SearchInput
          label="Search table, user or record id"
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
        />
      </div>
      <DataTable
        caption="Audit log"
        columns={columns}
        rows={logs.data?.rows ?? []}
        rowKey={(l) => String(l.id)}
        loading={logs.loading}
        error={logs.error}
        emptyMessage="No audit entries found."
      />
      <Pagination page={page} pageSize={PAGE_SIZE} total={logs.data?.total ?? 0} onPage={setPage} />
    </div>
  );
}
