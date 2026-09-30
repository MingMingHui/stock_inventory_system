import { useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Badge, CheckboxField, PageHeader, SelectField, TextField } from '../../components/ui';
import { useLoader } from '../../hooks/useLoader';
import { today } from '../../lib/dates';
import { toUserMessage } from '../../lib/errors';
import { describeRule, formatDate, formatRate } from '../../lib/format';
import { parseNumber } from '../../lib/numbers';
import { listCategories } from '../../services/reference';
import { deleteRule, listRules, saveRule } from '../../services/rules';
import { RULE_TYPES, type PartnerRule, type ProductCategory, type RuleType } from '../../types/database';
import { RULE_TYPE_HELP } from '../../lib/ruleTypes';
import { useAuth } from '../auth/AuthProvider';

function isCurrent(rule: PartnerRule, on: string): boolean {
  return rule.is_active && rule.effective_from <= on && (rule.effective_to === null || rule.effective_to >= on);
}

export function PartnerRulesPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const rules = useLoader(listRules, 'rules', 'Unable to load partner rules.');
  const categories = useLoader(listCategories, 'categories');
  const [editing, setEditing] = useState<PartnerRule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PartnerRule | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const now = today();

  const rows = (rules.data ?? [])
    .filter((r) => showHistory || isCurrent(r, now) || r.effective_from > now)
    .sort((a, b) =>
      (a.product_categories?.name ?? '').localeCompare(b.product_categories?.name ?? '') ||
      a.effective_from.localeCompare(b.effective_from),
    );

  const columns: Column<PartnerRule>[] = [
    { key: 'category', header: 'Product category', render: (r) => r.product_categories?.name ?? '—' },
    { key: 'type', header: 'Rule type', render: (r) => <code>{r.rule_type}</code> },
    { key: 'b', header: 'Partner B rate (Amin)', align: 'right', render: (r) => formatRate(r.partner_b_rate) },
    {
      key: 'a',
      header: 'Partner A rate (KaLi Motor)',
      align: 'right',
      render: (r) => (r.partner_a_rate_is_leftover ? 'LEFTOVER' : formatRate(r.partner_a_rate)),
    },
    { key: 'meaning', header: 'Partner B receives', render: (r) => describeRule(r.rule_type, r.partner_b_rate) },
    {
      key: 'dates',
      header: 'Effective',
      render: (r) => `${formatDate(r.effective_from)} – ${r.effective_to ? formatDate(r.effective_to) : 'open'}`,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        !r.is_active ? (
          <Badge tone="muted">inactive</Badge>
        ) : isCurrent(r, now) ? (
          <Badge tone="ok">current</Badge>
        ) : r.effective_from > now ? (
          <Badge tone="info">scheduled</Badge>
        ) : (
          <Badge tone="muted">ended</Badge>
        ),
    },
    { key: 'notes', header: 'Notes', render: (r) => r.notes ?? '' },
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
        title="Partner Rule Table"
        description="How each product category's revenue is split between Partner A (KaLi Motor) and Partner B (Amin). Every sale stores the rule and rates it used."
        actions={
          isAdmin && (
            <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
              Add rule
            </button>
          )
        }
      />
      <details className="help">
        <summary>How the rule types work</summary>
        <dl>
          {RULE_TYPES.map((t) => (
            <div key={t}>
              <dt>
                <code>{t}</code>
              </dt>
              <dd>{RULE_TYPE_HELP[t]}</dd>
            </div>
          ))}
        </dl>
        <p>
          The split is applied to <strong>revenue</strong> (actual price × quantity), as in the original workbook.
          Partner B receives nothing when the actual price is zero.
        </p>
      </details>
      <div className="toolbar">
        <CheckboxField label="Show ended and inactive rules" checked={showHistory} onChange={setShowHistory} />
      </div>
      <DataTable
        caption="Partner rules"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={rules.loading}
        error={rules.error}
        emptyMessage="No partner rules found."
      />
      {editing && (
        <RuleForm
          rule={editing === 'new' ? null : editing}
          categories={categories.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast.success('Partner rule saved.');
            rules.reload();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete partner rule"
          message={`Delete the ${deleting.rule_type} rule for ${deleting.product_categories?.name ?? 'this category'}? Rules already used by sales cannot be deleted — set an end date instead.`}
          confirmLabel="Delete"
          destructive
          onConfirm={async () => {
            await deleteRule(deleting.id);
            toast.success('Partner rule deleted.');
            rules.reload();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

function RuleForm({
  rule,
  categories,
  onClose,
  onSaved,
}: {
  rule: PartnerRule | null;
  categories: ProductCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [categoryId, setCategoryId] = useState(rule?.category_id ?? '');
  const [ruleType, setRuleType] = useState<RuleType>(rule?.rule_type ?? 'Fixed_Per_Unit');
  const [bRate, setBRate] = useState(rule ? String(rule.partner_b_rate) : '');
  const [aLeftover, setALeftover] = useState(rule ? rule.partner_a_rate_is_leftover : true);
  const [aRate, setARate] = useState(rule?.partner_a_rate != null ? String(rule.partner_a_rate) : '');
  const [notes, setNotes] = useState(rule?.notes ?? '');
  const [from, setFrom] = useState(rule?.effective_from ?? today());
  const [to, setTo] = useState(rule?.effective_to ?? '');
  const [active, setActive] = useState(rule?.is_active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shared = ruleType === 'Shared_50';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const b = shared ? 0.5 : parseNumber(bRate);
    const a = shared ? 0.5 : aLeftover ? null : parseNumber(aRate);
    if (!categoryId) return setError('Choose a product category.');
    if (b === null || Number.isNaN(b) || b < 0) return setError('Partner B rate must be zero or more.');
    if (!aLeftover && !shared && (a === null || Number.isNaN(a) || a < 0))
      return setError('Enter Partner A rate or choose LEFTOVER.');
    if (to && to < from) return setError('The end date must be on or after the start date.');
    setBusy(true);
    setError(null);
    try {
      await saveRule(rule?.id ?? null, {
        category_id: categoryId,
        rule_type: ruleType,
        partner_b_rate: b,
        partner_a_rate: a,
        notes,
        effective_from: from,
        effective_to: to,
        is_active: active,
      });
      onSaved();
    } catch (e) {
      setError(toUserMessage(e, 'Unable to save the partner rule.'));
      setBusy(false);
    }
  }

  return (
    <Modal title={rule ? 'Edit partner rule' : 'Add partner rule'} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <SelectField label="Product category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
          <option value="">Choose…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Rule type"
          value={ruleType}
          onChange={(e) => setRuleType(e.target.value as RuleType)}
          hint={RULE_TYPE_HELP[ruleType]}
        >
          {RULE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </SelectField>
        {!shared && (
          <>
            <TextField
              label="Partner B rate (Amin), RM"
              inputMode="decimal"
              value={bRate}
              onChange={(e) => setBRate(e.target.value)}
              required
            />
            <CheckboxField label="Partner A (KaLi Motor) receives the LEFTOVER" checked={aLeftover} onChange={setALeftover} />
            {!aLeftover && (
              <TextField
                label="Partner A rate (informational)"
                inputMode="decimal"
                value={aRate}
                onChange={(e) => setARate(e.target.value)}
                hint="Not used in calculations: Partner A always receives revenue minus Partner B's share."
              />
            )}
          </>
        )}
        <TextField label="Effective from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
        <TextField
          label="Effective to"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          hint="Leave blank for open-ended. To change a rate, end the old rule and add a new one."
        />
        <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
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
            {busy ? 'Saving…' : 'Save rule'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
