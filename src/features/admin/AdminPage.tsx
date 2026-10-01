import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { PageHeader } from '../../components/ui';
import { useAuth } from '../auth/AuthProvider';
import { AuditLogPanel } from './AuditLogPanel';
import { ExpenseCategoriesPanel } from './ExpenseCategoriesPanel';
import { PriceAlertsPanel } from './PriceAlertsPanel';
import { SettingsPanel } from './SettingsPanel';
import { TelegramLinksPanel } from './TelegramLinksPanel';
import { UsersPanel } from './UsersPanel';

const SECTIONS = [
  { id: 'users', label: 'Users' },
  { id: 'alerts', label: 'Price alerts' },
  { id: 'settings', label: 'Settings' },
  { id: 'expenses', label: 'Expense items' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'audit', label: 'Audit log' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

/** Admin area. Hidden from normal users, and every action is also enforced by RLS. */
export function AdminPage() {
  const { isAdmin } = useAuth();
  const [section, setSection] = useState<SectionId>('users');
  if (!isAdmin) return <Navigate to="/stock" replace />;

  return (
    <section>
      <PageHeader title="Administration" description="Users, configuration, price alerts and the audit trail." />
      <div className="subtabs" role="tablist" aria-label="Administration sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={section === s.id}
            className={`subtab${section === s.id ? ' subtab-active' : ''}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {section === 'users' && <UsersPanel />}
        {section === 'alerts' && <PriceAlertsPanel />}
        {section === 'settings' && <SettingsPanel />}
        {section === 'expenses' && <ExpenseCategoriesPanel />}
        {section === 'telegram' && <TelegramLinksPanel />}
        {section === 'audit' && <AuditLogPanel />}
      </div>
    </section>
  );
}
