import { useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Alert } from '../../components/ui';
import { useLoader } from '../../hooks/useLoader';
import { toUserMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { createTelegramLinkCode, getMyTelegramLink, telegramDeepLink, unlinkMyTelegram } from '../../services/telegram';
import type { TelegramLinkCode } from '../../types/database';

/** Lets the signed-in user connect their Telegram account to the bot with a one-time code. */
export function TelegramLinkDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const link = useLoader(getMyTelegramLink, 'my-telegram-link', 'Unable to load your Telegram link.');
  const [code, setCode] = useState<TelegramLinkCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setCode(await createTelegramLinkCode());
    } catch (e) {
      setError(toUserMessage(e, 'Unable to create a Telegram link code.'));
    } finally {
      setBusy(false);
    }
  }

  const current = link.data;
  return (
    <Modal title="Telegram bot" onClose={onClose}>
      <div className="form-grid">
        <p className="muted">
          Use the workshop Telegram bot to add stock, adjust stock and record sales. Your Telegram account must be
          linked to this login first; the bot uses your role and permissions.
        </p>
        {link.loading && !current && <p role="status">Checking link…</p>}
        {link.error && <Alert tone="error">{link.error}</Alert>}
        {current?.is_active && (
          <Alert tone="success">
            Linked to Telegram {current.telegram_username ? `@${current.telegram_username}` : 'account'} since{' '}
            {formatDateTime(current.linked_at)}.
          </Alert>
        )}
        {current && !current.is_active && (
          <Alert tone="warning">
            Your Telegram access was deactivated by an administrator. Ask an administrator to reactivate it.
          </Alert>
        )}

        {current && !current.is_active ? null : code ? (
          <div className="link-code" aria-live="polite">
            {code.bot_username ? (
              <>
                <p>
                  Open the bot and press <strong>Start</strong> (link valid until {formatDateTime(code.expires_at)}, single use):
                </p>
                <a className="btn btn-primary" href={telegramDeepLink(code.bot_username, code.code)} target="_blank" rel="noreferrer">
                  Open @{code.bot_username.replace(/^@/, '')} in Telegram
                </a>
                <p className="muted small">Or send this message to the bot:</p>
              </>
            ) : (
              <p className="muted small">
                The bot username is not configured yet (Admin → Settings). Send this message to the workshop bot:
              </p>
            )}
            <code className="link-code-text">/start {code.code}</code>
          </div>
        ) : (
          <button type="button" className="btn btn-primary" onClick={generate} disabled={busy}>
            {busy ? 'Creating…' : current?.is_active ? 'Link a different Telegram account' : 'Link my Telegram account'}
          </button>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          {current?.is_active && (
            <button type="button" className="btn btn-danger-outline" onClick={() => setConfirmUnlink(true)}>
              Unlink Telegram
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {confirmUnlink && (
        <ConfirmDialog
          title="Unlink Telegram"
          message="The bot will stop accepting commands from your Telegram account immediately."
          confirmLabel="Unlink"
          destructive
          onConfirm={async () => {
            await unlinkMyTelegram();
            toast.success('Telegram unlinked.');
            setCode(null);
            link.reload();
          }}
          onClose={() => setConfirmUnlink(false)}
        />
      )}
    </Modal>
  );
}
