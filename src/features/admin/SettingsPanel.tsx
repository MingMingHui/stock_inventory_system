import { useState } from 'react';
import { useToast } from '../../components/Toast';
import { useLoader } from '../../hooks/useLoader';
import { toUserMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { listSettings, updateSetting } from '../../services/reference';
import type { AppSetting } from '../../types/database';

const LABELS: Record<string, string> = {
  low_stock_default_threshold: 'Default low-stock threshold (units)',
  price_drop_alert_threshold: 'Price alert threshold (0.10 = 10% below agreed price)',
  allow_negative_stock: 'Allow negative stock',
  telegram_bot_username: 'Telegram bot username (without @)',
};

export function SettingsPanel() {
  const settings = useLoader(listSettings, 'settings', 'Unable to load settings.');
  if (settings.error) return <p className="form-error" role="alert">{settings.error}</p>;
  if (!settings.data) return <p role="status">Loading…</p>;
  return (
    <div className="settings-list">
      {settings.data.map((s) => (
        <SettingRow key={s.key} setting={s} onSaved={settings.reload} />
      ))}
    </div>
  );
}

function SettingRow({ setting, onSaved }: { setting: AppSetting; onSaved: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState(setting.value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await updateSetting(setting.key, value);
      toast.success('Setting saved.');
      onSaved();
    } catch (e) {
      setError(toUserMessage(e, 'Unable to save the setting. Check the value format.'));
    } finally {
      setBusy(false);
    }
  }

  const id = `setting-${setting.key}`;
  return (
    <div className="setting-row">
      <label htmlFor={id}>
        <strong>{LABELS[setting.key] ?? setting.key}</strong>
        <small className="hint">{setting.description}</small>
      </label>
      {setting.value_type === 'boolean' ? (
        <select id={id} value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="false">No</option>
          <option value="true">Yes</option>
        </select>
      ) : (
        <input
          id={id}
          inputMode={setting.value_type === 'text' ? 'text' : 'decimal'}
          maxLength={setting.value_type === 'text' ? 200 : 30}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      <button type="button" className="btn btn-primary btn-small" onClick={save} disabled={busy || value === setting.value}>
        Save
      </button>
      <small className="muted">Updated {formatDateTime(setting.updated_at)}</small>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
