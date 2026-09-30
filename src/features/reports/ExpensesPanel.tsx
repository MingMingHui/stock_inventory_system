import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Badge, Money, SelectField, TextField } from '../../components/ui';
import { useLoader } from '../../hooks/useLoader';
import { monthLabel } from '../../lib/dates';
import { toUserMessage } from '../../lib/errors';
import { formatMoney, formatPercent } from '../../lib/format';
import { isMoney, parseNumber } from '../../lib/numbers';
import { deleteExpense, listExpenseCategories, listExpenses, saveExpense } from '../../services/summary';
import type { ExpenseCategory, OperatingExpense, Partner } from '../../types/database';
import { useAuth } from '../auth/AuthProvider';

interface Props {
  month: string; // YYYY-MM
  partners: Partner[];
  defaultPartnerId: string;
  locked: boolean;
  onChanged: () => void;
}

export function ExpensesPanel({ month, partners, defaultPartnerId, locked, onChanged }: Props) {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const periodMonth = `${month}-01`;
  const expenses = useLoader(() => listExpenses(periodMonth, periodMonth), periodMonth, 'Unable to load expenses.');
  const categories = useLoader(listExpenseCategories, 'expense-categories');
  const [editing, setEditing] = useState<OperatingExpense | 'new' | null>(null);
  const [deleting, setDeleting] = useState<OperatingExpense | null>(null);
  const canEdit = isAdmin && !locked;

  const changed = (message: string) => {
    toast.success(message);
    expenses.reload();
    onChanged();
  };

  const columns: Column<OperatingExpense>[] = [
    { key: 'cat', header: 'Item', render: (r) => r.expense_categories?.name ?? '—' },
    { key: 'partner', header: 'Applies to', render: (r) => r.partners?.name ?? '—' },
    {
      key: 'calc',
      header: 'Calculation',
      render: (r) =>
        r.base_amount !== null && r.share_ratio !== null
          ? `${formatMoney(r.base_amount)} bill × ${formatPercent(r.share_ratio, 0)}`
          : 'fixed amount',
    },
    {
      key: 'amount',
      header: 'Adjustment',
      align: 'right',
      render: (r) => (
        <span>
          <Money value={r.amount} strong /> {r.amount < 0 ? <Badge tone="muted">deducted</Badge> : <Badge tone="info">added</Badge>}
        </span>
      ),
    },
    { key: 'desc', header: 'Description', render: (r) => r.description ?? '' },
  ];
  if (canEdit) {
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
    <div className="expenses-panel">
      <div className="section-header">
        <h2>Rental, electricity, wages and other adjustments — {monthLabel(month)}</h2>
        {canEdit && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            Add expense
          </button>
        )}
      </div>
      {locked && <p className="muted">This month is finalized; reopen it to change expenses.</p>}
      <DataTable
        caption={`Adjustments for ${monthLabel(month)}`}
        columns={columns}
        rows={expenses.data ?? []}
        rowKey={(r) => r.id}
        loading={expenses.loading}
        error={expenses.error}
        emptyMessage={`No rental, electricity, wages or other adjustments recorded for ${monthLabel(month)}.`}
      />
      {editing && (
        <ExpenseForm
          expense={editing === 'new' ? null : editing}
          periodMonth={periodMonth}
          categories={(categories.data ?? []).filter((c) => c.is_active || (editing !== 'new' && c.id === editing.expense_category_id))}
          partners={partners}
          defaultPartnerId={defaultPartnerId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            changed('Expense saved.');
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete expense"
          message={`Delete ${deleting.expense_categories?.name ?? 'this item'} (${formatMoney(deleting.amount)}) from ${monthLabel(month)}?`}
          confirmLabel="Delete"
          destructive
          onConfirm={async () => {
            await deleteExpense(deleting.id);
            changed('Expense deleted.');
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function ExpenseForm({
  expense,
  periodMonth,
  categories,
  partners,
  defaultPartnerId,
  onClose,
  onSaved,
}: {
  expense: OperatingExpense | null;
  periodMonth: string;
  categories: ExpenseCategory[];
  partners: Partner[];
  defaultPartnerId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [categoryId, setCategoryId] = useState(expense?.expense_category_id ?? '');
  const category = categories.find((c) => c.id === categoryId);
  const [partnerId, setPartnerId] = useState(expense?.partner_id ?? defaultPartnerId);
  const [bill, setBill] = useState(expense?.base_amount != null ? String(expense.base_amount) : '');
  const [amount, setAmount] = useState(expense ? String(expense.amount) : '');
  const [description, setDescription] = useState(expense?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const usesBill = category?.default_share_ratio != null;

  function chooseCategory(id: string) {
    setCategoryId(id);
    const next = categories.find((c) => c.id === id);
    if (next?.default_partner_id) setPartnerId(next.default_partner_id);
    if (next?.default_amount != null && !expense) setAmount(String(next.default_amount));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!category) return setError('Choose an expense item.');
    const billValue = parseNumber(bill);
    const amountValue = parseNumber(amount);
    if (usesBill && !isMoney(billValue)) return setError('Enter the bill amount, e.g. 32.65.');
    if (!usesBill && (!isMoney(amountValue, { allowNegative: true }) || amountValue === 0))
      return setError('Enter a non-zero amount, e.g. 500 or -100.');
    setBusy(true);
    setError(null);
    try {
      await saveExpense(expense?.id ?? null, {
        periodMonth,
        expenseCategoryId: category.id,
        partnerId,
        baseAmount: usesBill ? billValue : null,
        shareRatio: usesBill ? category.default_share_ratio : null,
        amount: usesBill ? null : amountValue,
        description,
      });
      onSaved();
    } catch (e) {
      setError(toUserMessage(e, 'Unable to save the expense.'));
      setBusy(false);
    }
  }

  return (
    <Modal title={expense ? 'Edit expense' : `Add expense — ${monthLabel(periodMonth)}`} onClose={onClose}>
      <form onSubmit={submit} className="form-grid" noValidate>
        <SelectField
          label="Item"
          value={categoryId}
          onChange={(e) => chooseCategory(e.target.value)}
          required
          hint={category?.description ?? undefined}
        >
          <option value="">Choose…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.is_recurring ? ' (recurring)' : ''}
            </option>
          ))}
        </SelectField>
        <SelectField label="Applies to" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
          {partners.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} (Partner {p.code})
            </option>
          ))}
        </SelectField>
        {usesBill ? (
          <TextField
            label="Bill amount (RM)"
            inputMode="decimal"
            value={bill}
            onChange={(e) => setBill(e.target.value)}
            required
            hint={`The database records ${formatPercent(category?.default_share_ratio ?? null, 0)} of the bill.`}
          />
        ) : (
          <TextField
            label="Amount (RM)"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            hint="Positive adds to the payable (e.g. rental 500); negative deducts (e.g. wages -100)."
          />
        )}
        <TextField label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
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
