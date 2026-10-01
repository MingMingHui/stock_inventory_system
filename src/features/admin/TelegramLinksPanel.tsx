import { useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { useToast } from '../../components/Toast';
import { Badge } from '../../components/ui';
import { useLoader } from '../../hooks/useLoader';
import { formatDateTime } from '../../lib/format';
import { listTelegramLinks, setTelegramLinkActive } from '../../services/telegram';
import type { TelegramUserLink } from '../../types/database';

export function TelegramLinksPanel() {
  const toast = useToast();
  const links = useLoader(listTelegramLinks, 'telegram-links', 'Unable to load Telegram links.');
  const [changing, setChanging] = useState<TelegramUserLink | null>(null);

  const columns: Column<TelegramUserLink>[] = [
    {
      key: 'user',
      header: 'User',
      render: (l) => (
        <div className="cell-stack">
          <strong>{l.authorized_users?.display_name ?? l.authorized_users?.email ?? '—'}</strong>
          <small className="muted">{l.authorized_users?.email}</small>
        </div>
      ),
    },
    { key: 'tg', header: 'Telegram', render: (l) => (l.telegram_username ? `@${l.telegram_username}` : `id ${l.telegram_user_id}`) },
    { key: 'status', header: 'Status', render: (l) => (l.is_active ? <Badge tone="ok">active</Badge> : <Badge tone="danger">deactivated</Badge>) },
    { key: 'linked', header: 'Linked', render: (l) => formatDateTime(l.linked_at) },
    { key: 'seen', header: 'Last used', render: (l) => formatDateTime(l.last_seen_at) },
    {
      key: 'actions',
      header: 'Actions',
      render: (l) => (
        <button type="button" className={`btn btn-small${l.is_active ? ' btn-danger-outline' : ''}`} onClick={() => setChanging(l)}>
          {l.is_active ? 'Deactivate' : 'Reactivate'}
        </button>
      ),
    },
  ];

  return (
    <div>
      <p className="muted">
        Telegram accounts linked by users with a one-time code. The bot only works for active links of active users;
        disabling a user under Users also blocks their Telegram access.
      </p>
      <DataTable
        caption="Telegram links"
        columns={columns}
        rows={links.data ?? []}
        rowKey={(l) => l.id}
        loading={links.loading}
        error={links.error}
        emptyMessage="No Telegram accounts linked yet."
      />
      {changing && (
        <ConfirmDialog
          title={changing.is_active ? 'Deactivate Telegram link' : 'Reactivate Telegram link'}
          message={
            changing.is_active
              ? 'The bot will immediately stop accepting commands from this Telegram account.'
              : 'The bot will accept commands from this Telegram account again.'
          }
          confirmLabel={changing.is_active ? 'Deactivate' : 'Reactivate'}
          destructive={changing.is_active}
          onConfirm={async () => {
            await setTelegramLinkActive(changing.id, !changing.is_active);
            toast.success('Telegram link updated.');
            links.reload();
          }}
          onClose={() => setChanging(null)}
        />
      )}
    </div>
  );
}
