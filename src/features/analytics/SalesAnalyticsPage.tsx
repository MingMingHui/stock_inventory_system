import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { BarList, ColumnChart, Sparkline } from '../../components/charts';
import { DataTable, type Column } from '../../components/DataTable';
import { Pagination } from '../../components/Pagination';
import { Alert, Badge, Money, PageHeader, SearchInput, SelectField, SummaryCard, TextField } from '../../components/ui';
import { useLoader } from '../../hooks/useLoader';
import { monthKey, monthLabel, monthRange, shiftMonth } from '../../lib/dates';
import { formatDate, formatMoney, formatPercent, formatQuantity } from '../../lib/format';
import { analyticsCategories, analyticsItems, analyticsMonthly } from '../../services/analytics';
import type { ItemAnalytics, SalesClassification, SalesPattern } from '../../types/database';
import { useAuth } from '../auth/AuthProvider';

const PAGE_SIZE = 25;
const RECENT_MONTHS = 3;

const CLASS_TONE: Record<SalesClassification, 'ok' | 'muted' | 'warn'> = {
  'BEST SELLER': 'ok',
  NORMAL: 'muted',
  'LOW SELLER': 'warn',
};

const PATTERN_TONE: Record<SalesPattern, 'ok' | 'warn' | 'info' | 'muted' | 'danger'> = {
  GROWING: 'ok',
  DECLINING: 'warn',
  STABLE: 'info',
  SEASONAL: 'info',
  SPORADIC: 'muted',
  'NO RECENT SALES': 'danger',
};

type ItemSort = 'revenue' | 'units' | 'gross_profit' | 'current_stock' | 'item_code';

function shortMonth(iso: string): string {
  const [y, m] = iso.split('-');
  return `${new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-MY', { month: 'short' })} ${y?.slice(2)}`;
}

/** Admin-only sales analysis. All figures are aggregated by PostgreSQL. */
export function SalesAnalyticsPage() {
  const { isAdmin } = useAuth();
  const [endMonth, setEndMonth] = useState(monthKey());
  const [months, setMonths] = useState(6);
  const [search, setSearch] = useState('');
  const [classFilter, setClassFilter] = useState<SalesClassification | ''>('');
  const [sort, setSort] = useState<{ column: ItemSort; ascending: boolean }>({ column: 'revenue', ascending: false });
  const [page, setPage] = useState(1);

  const startMonth = shiftMonth(endMonth, -(months - 1));
  const range = { from: monthRange(startMonth).from, to: monthRange(endMonth).to };
  const key = `${endMonth}|${months}`;
  const monthly = useLoader(() => analyticsMonthly(range.from, range.to), `m|${key}`, 'Unable to load monthly sales.');
  const categories = useLoader(() => analyticsCategories(range.from, range.to), `c|${key}`, 'Unable to load category sales.');
  const items = useLoader(() => analyticsItems(range.to, months, RECENT_MONTHS), `i|${key}`, 'Unable to load item analysis.');

  const allItems = useMemo(() => items.data ?? [], [items.data]);
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = allItems.filter(
      (r) =>
        (!classFilter || r.classification === classFilter) &&
        (!term || `${r.item_code} ${r.description} ${r.brand ?? ''} ${r.category_name}`.toLowerCase().includes(term)),
    );
    const dir = sort.ascending ? 1 : -1;
    return [...rows].sort((a, b) =>
      sort.column === 'item_code' ? a.item_code.localeCompare(b.item_code) * dir : ((a[sort.column] ?? 0) - (b[sort.column] ?? 0)) * dir,
    );
  }, [allItems, classFilter, search, sort]);

  if (!isAdmin) return <Navigate to="/stock" replace />;

  const totals = (monthly.data ?? []).reduce(
    (t, m) => ({ units: t.units + m.units, revenue: t.revenue + m.revenue, gp: t.gp + m.gross_profit, lines: t.lines + m.line_count }),
    { units: 0, revenue: 0, gp: 0, lines: 0 },
  );
  const best = allItems.filter((r) => r.classification === 'BEST SELLER');
  const low = allItems.filter((r) => r.classification === 'LOW SELLER');
  const top = [...allItems].filter((r) => r.units > 0).sort((a, b) => b.revenue - a.revenue).slice(0, 8);

  const columns: Column<ItemAnalytics, ItemSort>[] = [
    {
      key: 'item',
      header: 'Item',
      sortKey: 'item_code',
      render: (r) => (
        <div className="cell-stack">
          <strong>{r.item_code}</strong>
          <span>{r.description}</span>
          <small className="muted">
            {r.category_name}
            {r.brand ? ` · ${r.brand}` : ''}
          </small>
        </div>
      ),
    },
    { key: 'units', header: 'Units sold', sortKey: 'units', align: 'right', render: (r) => formatQuantity(r.units) },
    { key: 'revenue', header: 'Revenue', sortKey: 'revenue', align: 'right', render: (r) => <Money value={r.revenue} /> },
    { key: 'avg', header: 'Avg price', align: 'right', render: (r) => <Money value={r.avg_selling_price} /> },
    { key: 'gp', header: 'Gross profit', sortKey: 'gross_profit', align: 'right', render: (r) => <Money value={r.gross_profit} /> },
    { key: 'lines', header: 'Sales', align: 'right', render: (r) => formatQuantity(r.line_count) },
    {
      key: 'trend',
      header: 'Monthly trend',
      render: (r) => (
        <div className="cell-stack">
          <Sparkline values={r.monthly_units} label={`${r.item_code} units per month`} />
          <small className="muted">
            {r.months_with_sales}/{months} months with sales
          </small>
        </div>
      ),
    },
    {
      key: 'stock',
      header: 'Current stock',
      sortKey: 'current_stock',
      align: 'right',
      render: (r) => (
        <div className="cell-stack align-right">
          <span>{formatQuantity(r.current_stock)}</span>
          {r.oldest_stock_date && <small className="muted">since {formatDate(r.oldest_stock_date)}</small>}
        </div>
      ),
    },
    { key: 'pattern', header: 'Pattern', render: (r) => <Badge tone={PATTERN_TONE[r.pattern]}>{r.pattern.toLowerCase()}</Badge> },
    {
      key: 'class',
      header: 'Classification',
      render: (r) => <Badge tone={CLASS_TONE[r.classification]}>{r.classification}</Badge>,
    },
  ];

  const errors = [monthly.error, categories.error, items.error].filter(Boolean);
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <section>
      <PageHeader
        title="Sales Analytics"
        description={`Sales patterns over the last ${months} months up to ${monthLabel(endMonth)}. Voided sales are excluded. Methodology: docs/sales-analytics.md.`}
      />
      <div className="toolbar">
        <TextField label="Up to month" type="month" value={endMonth} onChange={(e) => e.target.value && (setEndMonth(e.target.value), setPage(1))} />
        <SelectField
          label="Observation period"
          value={String(months)}
          onChange={(e) => {
            setMonths(Number(e.target.value));
            setPage(1);
          }}
        >
          <option value="3">3 months</option>
          <option value="6">6 months</option>
          <option value="12">12 months</option>
        </SelectField>
      </div>
      {errors.map((e) => (
        <Alert key={e} tone="error">
          {e}
        </Alert>
      ))}

      <div className="summary-grid">
        <SummaryCard label="Units sold" value={formatQuantity(totals.units)} />
        <SummaryCard label="Revenue" value={<Money value={totals.revenue} />} />
        <SummaryCard label="Gross profit" value={<Money value={totals.gp} />} />
        <SummaryCard label="Sales (lines)" value={formatQuantity(totals.lines)} />
        <SummaryCard label="Best sellers" value={formatQuantity(best.length)} />
        <SummaryCard label="Low sellers" value={formatQuantity(low.length)} tone={low.length ? 'warn' : undefined} />
      </div>

      <div className="analytics-grid">
        <div className="panel">
          <h2>Monthly revenue</h2>
          <ColumnChart
            ariaLabel="Revenue per month"
            data={(monthly.data ?? []).map((m) => ({
              label: shortMonth(m.period_month),
              value: m.revenue,
              title: `${monthLabel(m.period_month)}: ${formatMoney(m.revenue)}, ${m.units} units, ${m.line_count} sales`,
            }))}
            format={formatMoney}
          />
        </div>
        <div className="panel">
          <h2>Top-selling items (revenue)</h2>
          <BarList
            data={top.map((r) => ({ label: `${r.item_code} ${r.description}`, value: r.revenue, title: `${r.units} units` }))}
            format={formatMoney}
            emptyText="No sales in this period."
          />
        </div>
        <div className="panel">
          <h2>Low sellers</h2>
          {low.length === 0 ? (
            <p className="muted">No low sellers in this period.</p>
          ) : (
            <ul className="insight-list">
              {low.slice(0, 8).map((r) => (
                <li key={r.product_id}>
                  <strong>{r.item_code}</strong> {r.description}
                  <span className="muted small">
                    {' '}
                    — stock {r.current_stock}, sold {r.units_recent} in last {RECENT_MONTHS} months, {r.months_without_sales} months
                    without sales
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="panel">
          <h2>Sales by category</h2>
          <BarList
            data={(categories.data ?? []).map((c) => ({
              label: c.category_name,
              value: c.revenue,
              title: `${formatPercent(c.revenue_share)} of revenue, ${c.units} units`,
            }))}
            format={(v) => formatMoney(v)}
            emptyText="No sales in this period."
          />
        </div>
      </div>

      <h2>Monthly summary</h2>
      <DataTable
        caption="Monthly summary"
        columns={[
          { key: 'm', header: 'Month', render: (m) => monthLabel(m.period_month) },
          { key: 'u', header: 'Units', align: 'right', render: (m) => formatQuantity(m.units) },
          { key: 'r', header: 'Revenue', align: 'right', render: (m) => <Money value={m.revenue} /> },
          { key: 'g', header: 'Gross profit', align: 'right', render: (m) => <Money value={m.gross_profit} /> },
          { key: 'n', header: 'Sales (lines)', align: 'right', render: (m) => formatQuantity(m.line_count) },
          { key: 'a', header: 'Avg sale value', align: 'right', render: (m) => <Money value={m.avg_sale_value} /> },
        ]}
        rows={monthly.data ?? []}
        rowKey={(m) => m.period_month}
        loading={monthly.loading}
        emptyMessage="No months selected."
      />

      <h2>Items</h2>
      <div className="toolbar">
        <SearchInput label="Search item or category" value={search} onChange={(v) => (setSearch(v), setPage(1))} />
        <SelectField
          label="Classification"
          value={classFilter}
          onChange={(e) => {
            setClassFilter(e.target.value as SalesClassification | '');
            setPage(1);
          }}
        >
          <option value="">All</option>
          <option value="BEST SELLER">Best sellers</option>
          <option value="NORMAL">Normal</option>
          <option value="LOW SELLER">Low sellers</option>
        </SelectField>
      </div>
      <DataTable
        caption="Item analysis"
        columns={columns}
        rows={pageRows}
        rowKey={(r) => r.product_id}
        loading={items.loading}
        emptyMessage="No items with sales or stock in this period."
        sort={sort}
        onSort={(column) => {
          setSort((s) => (s.column === column ? { column, ascending: !s.ascending } : { column, ascending: column === 'item_code' }));
          setPage(1);
        }}
      />
      <Pagination page={page} pageSize={PAGE_SIZE} total={filtered.length} onPage={setPage} />
    </section>
  );
}
