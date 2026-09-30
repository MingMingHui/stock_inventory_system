import { useState } from 'react';
import { toUserMessage } from '../lib/errors';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  /** When set, the user must type a reason (stored in the audit trail). */
  reasonLabel?: string;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  destructive = false,
  reasonLabel,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsReason = Boolean(reasonLabel);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setError(toUserMessage(e, 'The action could not be completed. Please try again.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${destructive ? 'btn-danger' : 'btn-primary'}`}
            onClick={confirm}
            disabled={busy || (needsReason && reason.trim() === '')}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
      {reasonLabel && (
        <label className="field">
          <span>{reasonLabel}</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} required />
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
