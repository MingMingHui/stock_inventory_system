import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type ToastTone = 'success' | 'error' | 'warning';

interface ToastMessage {
  id: number;
  tone: ToastTone;
  text: string;
}

interface ToastApi {
  success: (text: string) => void;
  error: (text: string) => void;
  warning: (text: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  const dismiss = useCallback((id: number) => setMessages((list) => list.filter((m) => m.id !== id)), []);

  const push = useCallback(
    (tone: ToastTone, text: string) => {
      const id = nextId++;
      setMessages((list) => [...list.slice(-3), { id, tone, text }]);
      window.setTimeout(() => dismiss(id), tone === 'success' ? 4000 : 8000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (text) => push('success', text),
      error: (text) => push('error', text),
      warning: (text) => push('warning', text),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {messages.map((m) => (
          <div key={m.id} className={`toast toast-${m.tone}`} role={m.tone === 'error' ? 'alert' : 'status'}>
            <span>{m.text}</span>
            <button type="button" className="toast-close" onClick={() => dismiss(m.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
