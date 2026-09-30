import { useState, type FormEvent } from 'react';
import { DataTable, type Column } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Badge, CheckboxField, SelectField, TextField } from '../../components/ui';
import { useLoader } from '../../hooks/useLoader';
import { toUserMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { listUsers, saveUser } from '../../services/admin';
import type { AppRole, AuthorizedUser } from '../../types/database';
import { useAuth } from '../auth/AuthProvider';

export function UsersPanel() {
  const toast = useToast();
  const { state } = useAuth();
  const me = state.status === 'ready' ? state.access.email : '';
  const users = useLoader(listUsers, 'users', 'Unable to load users.');
  const [editing, setEditing] = useState<AuthorizedUser | 'new' | null>(null);

  const columns: Column<AuthorizedUser>[] = [
    { key: 'email', header: 'Google account', render: (u) => <strong>{u.email}</strong> },
    { key: 'name', header: 'Name', render: (u) => u.display_name ?? '' },
    { key: 'role', header: 'Role', render: (u) => <Badge tone={u.role === 'admin' ? 'info' : 'muted'}>{u.role}</Badge> },
    { key: 'active', header: 'Access', render: (u) => (u.is_active ? <Badge tone="ok">active</Badge> : <Badge tone="danger">disabled</Badge>) },
    { key: 'updated', header: 'Updated', render: (u) => formatDateTime(u.updated_at) },
    {
      key: 'actions',
      header: 'Actions',
      render: (u) => (
        <button type="button" className="btn btn-small" onClick={() => setEditing(u)}>
          Edit
        </button>
      ),
    },
  ];

  return (
    <div>
      <div className="section-header">
        <p className="muted">
          Only Google accounts listed here can use the application. Disabling a user removes access immediately. The
          database refuses to remove the last active administrator.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          Add user
        </button>
      </div>
      <DataTable
        caption="Authorized users"
        columns={columns}
        rows={users.data ?? []}
        rowKey={(u) => u.id}
        loading={users.loading}
        error={users.error}
        emptyMessage="No users."
      />
      {editing && (
        <UserForm
          user={editing === 'new' ? null : editing}
          isSelf={editing !== 'new' && editing.email === me}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast.success('User saved.');
            users.reload();
          }}
        />
      )}
    </div>
  );
}

function UserForm({
  user,
  isSelf,
  onClose,
  onSaved,
}: {
  user: AuthorizedUser | null;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = useState(user?.email ?? '');
  const [displayName, setDisplayName] = useState(user?.display_name ?? '');
  const [role, setRole] = useState<AppRole>(user?.role ?? 'user');
  const [isActive, setIsActive] = useState(user?.is_active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError('Enter a valid email address.');
    setBusy(true);
    setError(null);
    try {
      await saveUser(user?.id ?? null, { email, displayName, role, isActive });
      onSaved();
    } catch (e) {
      setError(toUserMessage(e, 'Unable to save the user.'));
      setBusy(false);
    }
  }

  return (
    <Modal title={user ? 'Edit user' : 'Add user'} onClose={onClose}>
      <form onSubmit={submit} className="form-grid" noValidate>
        <TextField label="Google email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <TextField label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} />
        <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as AppRole)}>
          <option value="user">User — stock, sales and viewing</option>
          <option value="admin">Admin — everything, including users and rules</option>
        </SelectField>
        <CheckboxField label="Access enabled" checked={isActive} onChange={setIsActive} />
        {isSelf && <p className="muted small">You are editing your own account. Removing your admin role ends your admin access.</p>}
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
