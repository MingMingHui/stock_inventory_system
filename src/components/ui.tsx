import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { formatMoney } from '../lib/format';
import type { InventoryStatus, StockStatus } from '../types/database';

const STATUS_TEXT: Record<StockStatus, string> = {
  ACTIVE: 'Active',
  LOW_STOCK: 'LOW STOCK',
  OUT_OF_STOCK: 'Out of stock',
  OBSOLETE: 'Obsolete',
};

const STATUS_TONE: Record<StockStatus, string> = {
  ACTIVE: 'ok',
  LOW_STOCK: 'warn',
  OUT_OF_STOCK: 'danger',
  OBSOLETE: 'muted',
};

export function StockStatusBadge({ status }: { status: StockStatus }) {
  return <span className={`badge badge-${STATUS_TONE[status]}`}>{STATUS_TEXT[status]}</span>;
}

const INVENTORY_TONE: Record<InventoryStatus, string> = {
  ACTIVE: 'ok',
  UNDER_REPAIR: 'warn',
  INACTIVE: 'muted',
  DISPOSED: 'muted',
};

export function InventoryStatusBadge({ status }: { status: InventoryStatus }) {
  return <span className={`badge badge-${INVENTORY_TONE[status]}`}>{status.replace('_', ' ').toLowerCase()}</span>;
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Money({ value, strong = false }: { value: number | null | undefined; strong?: boolean }) {
  const negative = typeof value === 'number' && value < 0;
  const text = formatMoney(value);
  return <span className={`money${negative ? ' negative' : ''}`}>{strong ? <strong>{text}</strong> : text}</span>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Alert({ tone, children }: { tone: 'info' | 'warning' | 'error' | 'success'; children: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'error' || tone === 'warning' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function SummaryCard({ label, value, tone }: { label: string; value: ReactNode; tone?: 'warn' | 'danger' }) {
  return (
    <div className={`summary-card${tone ? ` summary-card-${tone}` : ''}`}>
      <span className="summary-label">{label}</span>
      <span className="summary-value">{value}</span>
    </div>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
}

export function TextField({ label, hint, ...input }: FieldProps) {
  return (
    <label className="field">
      <span>
        {label}
        {input.required && <span className="required" aria-hidden="true"> *</span>}
      </span>
      <input {...input} />
      {hint && <small className="hint">{hint}</small>}
    </label>
  );
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: string;
  children: ReactNode;
}

export function SelectField({ label, hint, children, ...select }: SelectFieldProps) {
  return (
    <label className="field">
      <span>
        {label}
        {select.required && <span className="required" aria-hidden="true"> *</span>}
      </span>
      <select {...select}>{children}</select>
      {hint && <small className="hint">{hint}</small>}
    </label>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="checkbox-field">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
      {hint && <small className="hint">{hint}</small>}
    </label>
  );
}

export function SearchInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="field field-search">
      <span className="sr-only">{label}</span>
      <input type="search" placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} maxLength={80} />
    </label>
  );
}
