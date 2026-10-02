import { useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DataTable, type Column } from '../../components/DataTable';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Money, PageHeader, SelectField, SummaryCard, TextField } from '../../components/ui';
import { useLoader } from '../../hooks/useLoader';
import { monthKey, monthLabel, monthRange } from '../../lib/dates';
import { formatMoney, formatQuantity } from '../../lib/format';
import { listCategories, listPartners, listProducts } from '../../services/reference';
import {
  applyRecurringExpenses,
  dashboardStats,
  finalizeSettlement,
  partnerSummaryByCategory,
  reopenSettlement,
  settlementSummary,
} from '../../services/summary';
import type { CategorySummary, SettlementSummary } from '../../types/database';
import { useAuth } from '../auth/AuthProvider';
import { ExportButtons } from '../export/ExportButtons';
import { loadPartnerSummarySheet } from '../export/exportData';
import { ExpensesPanel } from './ExpensesPanel';

type Mode = 'month' | 'range';

export function PartnerSummaryPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('month');
  const [month, setMonth] = useState(monthKey());
  const [rangeFrom, setRangeFrom] = useState(monthRange(monthKey()).from);
  const [rangeTo, setRangeTo] = useState(monthRange(monthKey()).to);
  const [categoryId, setCategoryId] = useState('');
  const [productId, setProductId] = useState('');
  const [confirm, setConfirm] = useState<'finalize' | 'reopen' | null>(null);

  const { from, to } = mode === 'month' ? monthRange(month) : { from: rangeFrom, to: rangeTo };
  const validRange = from <= to;
  const periodKey = `${from}|${to}`;
  const guard = <T,>(fn: () => Promise<T>, empty: T) => () => (validRange ? fn() : Promise.resolve(empty));

  const stats = useLoader(guard(() => dashboardStats(from, to), null), periodKey);
  const byCategory = useLoader(
    guard(() => partnerSummaryByCategory(from, to, categoryId, productId), [] as CategorySummary[]),
    `${periodKey}|${categoryId}|${productId}`,
  );
  const settlements = useLoader(guard(() => settlementSummary(from, to), [] as SettlementSummary[]), periodKey);
  const categories = useLoader(listCategories, 'categories');
  const products = useLoader(() => listProducts(categoryId), `products|${categoryId}`);
  const partners = useLoader(listPartners, 'partners');
  const partnerA = partners.data?.find((p) => p.code === 'A');
  const partnerB = partners.data?.find((p) => p.code === 'B');
  const aName = partnerA?.name ?? 'Partner A';
  const bName = partnerB?.name ?? 'Partner B';

  const reloadAll = () => {
    stats.reload();
    byCategory.reload();
    settlements.reload();
  };

  const selectedSettlement = mode === 'month' ? settlements.data?.[0] : undefined;
  const monthStart = `${month}-01`;
  const isPastMonth = month < monthKey();
  const filtered = Boolean(categoryId || productId);

  const categoryColumns: Column<CategorySummary>[] = [
    { key: 'cat', header: 'Category', render: (r) => r.category_name },
    { key: 'lines', header: 'Sale lines', align: 'right', render: (r) => formatQuantity(r.line_count) },
    { key: 'qty', header: 'Quantity', align: 'right', render: (r) => formatQuantity(r.quantity) },
    { key: 'rev', header: 'Revenue', align: 'right', render: (r) => <Money value={r.revenue} /> },
    { key: 'cost', header: 'Cost', align: 'right', render: (r) => <Money value={r.total_cost} /> },
    { key: 'gp', header: 'Gross profit', align: 'right', render: (r) => <Money value={r.gross_profit} /> },
    { key: 'a', header: `${aName} (A) share`, align: 'right', render: (r) => <Money value={r.partner_a_share} strong /> },
    { key: 'b', header: `${bName} (B) share`, align: 'right', render: (r) => <Money value={r.partner_b_share} strong /> },
  ];

  const settlementColumns: Column<SettlementSummary>[] = [
    {
      key: 'month',
      header: 'Month',
      render: (r) => (
        <span>
          {monthLabel(r.period_month)} {r.is_finalized ? <Badge tone="ok">finalized</Badge> : <Badge tone="muted">open</Badge>}
        </span>
      ),
    },
    { key: 'rev', header: 'Revenue', align: 'right', render: (r) => <Money value={r.total_revenue} /> },
    { key: 'cost', header: 'Cost', align: 'right', render: (r) => <Money value={r.total_cost} /> },
    { key: 'gp', header: 'Gross profit', align: 'right', render: (r) => <Money value={r.gross_profit} /> },
    { key: 'a', header: `${aName} share`, align: 'right', render: (r) => <Money value={r.partner_a_share} /> },
    { key: 'aadj', header: `${aName} adjustments`, align: 'right', render: (r) => <Money value={r.partner_a_adjustments} /> },
    { key: 'apay', header: `Payable to ${aName}`, align: 'right', render: (r) => <Money value={r.partner_a_payable} strong /> },
    { key: 'b', header: `${bName} share`, align: 'right', render: (r) => <Money value={r.partner_b_share} /> },
    { key: 'badj', header: `${bName} adjustments`, align: 'right', render: (r) => <Money value={r.partner_b_adjustments} /> },
    { key: 'bpay', header: `Payable to ${bName}`, align: 'right', render: (r) => <Money value={r.partner_b_payable} strong /> },
  ];

  const s = stats.data;

  return (
    <section>
      <PageHeader
        title="Partner Summary"
        description={`Revenue split and monthly settlement. Payable to ${aName} = ${aName}'s share + its adjustments (rental, electricity, wages).`}
        actions={
          <ExportButtons
            sheet="Partner_Summary"
            period={validRange ? { from, to } : undefined}
            loadSheet={() => {
              if (!validRange) return Promise.reject(new Error('Invalid date range'));
              const category = categories.data?.find((c) => c.id === categoryId)?.name ?? 'All categories';
              const product = products.data?.find((p) => p.id === productId);
              const filterLabel = `${category}, ${product ? `${product.item_code} — ${product.description}` : 'all products'}`;
              return loadPartnerSummarySheet({ from, to, categoryId, productId, filterLabel });
            }}
          />
        }
      />
      <div className="toolbar">
        <SelectField label="Period" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="month">Month</option>
          <option value="range">Date range</option>
        </SelectField>
        {mode === 'month' ? (
          <TextField label="Month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        ) : (
          <>
            <TextField label="From" type="date" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
            <TextField label="To" type="date" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
          </>
        )}
        <SelectField
          label="Category"
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            setProductId('');
          }}
        >
          <option value="">All categories</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Product" value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">All products</option>
          {(products.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.item_code} — {p.description}
              {p.brand ? ` (${p.brand})` : ''}
            </option>
          ))}
        </SelectField>
      </div>
      {!validRange && <Alert tone="error">The start date must be on or before the end date.</Alert>}

      <div className="summary-grid" aria-busy={stats.loading}>
        <SummaryCard label="Sale lines" value={formatQuantity(s?.sale_line_count)} />
        <SummaryCard label="Total revenue" value={<Money value={s?.total_revenue} />} />
        <SummaryCard label="Gross profit" value={<Money value={s?.gross_profit} />} />
        <SummaryCard label={`${aName} (A) share`} value={<Money value={s?.partner_a_share} />} />
        <SummaryCard label={`${bName} (B) share`} value={<Money value={s?.partner_b_share} />} />
        <SummaryCard label="Price alerts" value={formatQuantity(s?.price_alert_count)} tone={s?.price_alert_count ? 'warn' : undefined} />
        <SummaryCard label="Low stock items" value={formatQuantity(s?.low_stock_count)} tone={s?.low_stock_count ? 'warn' : undefined} />
        <SummaryCard label="Out of stock items" value={formatQuantity(s?.out_of_stock_count)} tone={s?.out_of_stock_count ? 'danger' : undefined} />
        <SummaryCard label="Obsolete items" value={formatQuantity(s?.obsolete_count)} />
      </div>
      {stats.error && <Alert tone="error">{stats.error}</Alert>}

      <h2>By category{filtered ? ' (filtered)' : ''}</h2>
      <DataTable
        caption="Partner shares by category"
        columns={categoryColumns}
        rows={byCategory.data ?? []}
        rowKey={(r) => r.category_id}
        loading={byCategory.loading}
        error={byCategory.error}
        emptyMessage={mode === 'month' ? `No sales found for ${monthLabel(month)}.` : 'No sales found for this period.'}
      />

      <h2>Monthly settlement</h2>
      {filtered && <p className="muted">Settlement figures always cover all categories and products.</p>}
      <DataTable
        caption="Monthly settlement"
        columns={settlementColumns}
        rows={settlements.data ?? []}
        rowKey={(r) => r.period_month}
        loading={settlements.loading}
        error={settlements.error}
        emptyMessage="No months in this period."
      />

      {mode === 'month' && partnerA && (
        <>
          <ExpensesPanel
            month={month}
            partners={partners.data ?? []}
            defaultPartnerId={partnerA.id}
            locked={Boolean(selectedSettlement?.is_finalized)}
            onChanged={reloadAll}
          />
          {isAdmin && (
            <div className="settlement-actions">
              {selectedSettlement?.is_finalized ? (
                <button type="button" className="btn" onClick={() => setConfirm('reopen')}>
                  Reopen {monthLabel(month)}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      try {
                        const added = await applyRecurringExpenses(monthStart);
                        toast.success(added ? `${added} recurring item(s) added.` : 'Recurring items are already present.');
                        reloadAll();
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : 'Unable to add recurring items.');
                      }
                    }}
                  >
                    Add recurring items (wages)
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!isPastMonth}
                    title={isPastMonth ? undefined : 'Only completed months can be finalized'}
                    onClick={() => setConfirm('finalize')}
                  >
                    Finalize {monthLabel(month)}
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}

      {confirm === 'finalize' && selectedSettlement && (
        <ConfirmDialog
          title={`Finalize ${monthLabel(month)}`}
          message={`Lock ${monthLabel(month)}? Recurring items are added first, then the totals are saved: payable to ${aName} ${formatMoney(selectedSettlement.partner_a_payable)} before recurring items. No sales or expenses can then be changed for this month unless it is reopened.`}
          confirmLabel="Finalize"
          onConfirm={async () => {
            await finalizeSettlement(monthStart, '');
            toast.success(`${monthLabel(month)} finalized.`);
            reloadAll();
          }}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'reopen' && (
        <ConfirmDialog
          title={`Reopen ${monthLabel(month)}`}
          message="Reopening removes the saved settlement so sales and expenses can be corrected. The reason is kept in the audit log."
          confirmLabel="Reopen"
          destructive
          reasonLabel="Reason"
          onConfirm={async (reason) => {
            await reopenSettlement(monthStart, reason);
            toast.success(`${monthLabel(month)} reopened.`);
            reloadAll();
          }}
          onClose={() => setConfirm(null)}
        />
      )}
    </section>
  );
}
