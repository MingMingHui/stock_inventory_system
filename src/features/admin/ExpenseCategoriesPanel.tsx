import { useState, type FormEvent } from 'react';
import { DataTable, type Column } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Badge, CheckboxField, Money, SelectField, TextField } from '../../components/ui';
import { useLoader } from '../../hooks/useLoader';
import { toUserMessage } from '../../lib/errors';
import { formatPercent } from '../../lib/format';
import { isMoney, isWholeNumber, parseNumber } from '../../lib/numbers';
import { listPartners } from '../../services/reference';
import { listExpenseCategories, saveExpenseCategory } from '../../services/summary';
import type { ExpenseCategory, Partner } from '../../types/database';

export function ExpenseCategoriesPanel() {
  const toast = useToast();
  const categories = useLoader(listExpenseCategories, 'expense-categories', 'Unable to load expense items.');
  const partners = useLoader(listPartners, 'partners');
  const [editing, setEditing] = useState<ExpenseCategory | 'new' | null>(null);

  const partnerName = (id: string | null) => partners.data?.find((p) => p.id === id)?.name ?? '—';
  const columns: Column<ExpenseCategory>[] = [
    { key: 'name', header: 'Item', render: (c) => <strong>{c.name}</strong> },
    { key: 'partner', header: 'Applies to', render: (c) => partnerName(c.default_partner_id) },
    {
      key: 'how',
      header: 'How it is calculated',
      render: (c) =>
        c.default_share_ratio !== null ? (
          `${formatPercent(c.default_share_ratio, 0)} of the monthly bill`
        ) : c.default_amount !== null ? (
          <span>
            Default <Money value={c.default_amount} />
          </span>
        ) : (
          'entered monthly'
        ),
    },
    { key: 'recurring', header: 'Recurring', render: (c) => (c.is_recurring ? <Badge tone="info">every month</Badge> : '—') },
    { key: 'active', header: 'Status', render: (c) => (c.is_active ? <Badge tone="ok">active</Badge> : <Badge tone="muted">inactive</Badge>) },
    {
      key: 'actions',
      header: 'Actions',
      render: (c) => (
        <button type="button" className="btn btn-small" onClick={() => setEditing(c)}>
          Edit
        </button>
      ),
    },
  ];

  return (
    <div>
      <div className="section-header">
        <p className="muted">
          Expense items adjust what each partner is paid. Recurring items (e.g. wages −RM100) are added to every month
          automatically when a month is finalized. Items with a share ratio (e.g. electricity 60%) take the monthly bill.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          Add item
        </button>
      </div>
      <DataTable
        caption="Expense items"
        columns={columns}
        rows={categories.data ?? []}
        rowKey={(c) => c.id}
        loading={categories.loading}
        error={categories.error}
        emptyMessage="No expense items yet."
      />
      {editing && (
        <ExpenseCategoryForm
          category={editing === 'new' ? null : editing}
          partners={partners.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast.success('Expense item saved.');
            categories.reload();
          }}
        />
      )}
    </div>
  );
}

type Kind = 'fixed' | 'bill';

function ExpenseCategoryForm({
  category,
  partners,
  onClose,
  onSaved,
}: {
  category: ExpenseCategory | null;
  partners: Partner[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(category?.name ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const [partnerId, setPartnerId] = useState(category?.default_partner_id ?? partners.find((p) => p.code === 'A')?.id ?? '');
  const [kind, setKind] = useState<Kind>(category?.default_share_ratio != null ? 'bill' : 'fixed');
  const [amount, setAmount] = useState(category?.default_amount != null ? String(category.default_amount) : '');
  const [ratio, setRatio] = useState(category?.default_share_ratio != null ? String(category.default_share_ratio) : '');
  const [recurring, setRecurring] = useState(category?.is_recurring ?? false);
  const [active, setActive] = useState(category?.is_active ?? true);
  const [sortOrder, setSortOrder] = useState(String(category?.sort_order ?? 0));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const amountValue = parseNumber(amount);
    const ratioValue = parseNumber(ratio);
    const order = parseNumber(sortOrder);
    if (!name.trim()) return setError('Enter a name.');
    if (kind === 'bill' && (ratioValue === null || Number.isNaN(ratioValue) || ratioValue <= 0 || ratioValue > 1))
      return setError('The share ratio must be between 0 and 1 (e.g. 0.6 for 60%).');
    if (kind === 'fixed' && amountValue !== null && !isMoney(amountValue, { allowNegative: true }))
      return setError('Enter an amount like 500 or -100.');
    if (recurring && (kind !== 'fixed' || !amountValue)) return setError('A recurring item needs a fixed, non-zero amount.');
    if (recurring && !partnerId) return setError('Choose which partner a recurring item applies to.');
    if (!isWholeNumber(order)) return setError('Sort order must be a whole number.');
    setBusy(true);
    setError(null);
    try {
      await saveExpenseCategory(category?.id ?? null, {
        name,
        description,
        defaultPartnerId: partnerId,
        defaultAmount: kind === 'fixed' ? amountValue : null,
        defaultShareRatio: kind === 'bill' ? ratioValue : null,
        isRecurring: recurring,
        isActive: active,
        sortOrder: order,
      });
      onSaved();
    } catch (e) {
      setError(toUserMessage(e, 'Unable to save the expense item.'));
      setBusy(false);
    }
  }

  return (
    <Modal title={category ? 'Edit expense item' : 'Add expense item'} onClose={onClose}>
      <form onSubmit={submit} className="form-grid" noValidate>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        <SelectField label="Applies to" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
          <option value="">Choose each month</option>
          {partners.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} (Partner {p.code})
            </option>
          ))}
        </SelectField>
        <SelectField label="Calculation" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="fixed">Fixed amount</option>
          <option value="bill">Share of a monthly bill</option>
        </SelectField>
        {kind === 'fixed' ? (
          <TextField
            label="Default amount (RM)"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            hint="Negative deducts from the partner (e.g. wages -100)."
          />
        ) : (
          <TextField label="Share ratio" inputMode="decimal" value={ratio} onChange={(e) => setRatio(e.target.value)} hint="0.6 = 60% of the bill." />
        )}
        {kind === 'fixed' && <CheckboxField label="Recurring — add automatically every month" checked={recurring} onChange={setRecurring} />}
        <TextField label="Sort order" inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
        <CheckboxField label="Active" checked={active} onChange={setActive} />
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
