// Turns technical errors into messages users can act on, while logging the
// technical details for debugging. Database messages are only shown when they
// come from our own validation (RAISE EXCEPTION in the migrations), never raw
// constraint or relation names.

export class AppError extends Error {
  readonly userMessage: string;
  readonly code: string | undefined;

  constructor(userMessage: string, code?: string, cause?: unknown) {
    super(userMessage, { cause });
    this.name = 'AppError';
    this.userMessage = userMessage;
    this.code = code;
  }
}

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  status?: unknown;
}

// SQLSTATEs raised by our own functions with messages written for users.
const OWN_MESSAGE_CODES = new Set(['22023', 'P0002', '23514', '40001', '55000', '23P01']);

const TECHNICAL_HINTS = /relation|constraint|column|violates|syntax|function .*\(|permission denied for/i;

export function toUserMessage(error: unknown, fallback: string): string {
  if (error instanceof AppError) return error.userMessage;
  const e = (typeof error === 'object' && error !== null ? error : {}) as ErrorLike;
  const code = typeof e.code === 'string' ? e.code : undefined;
  const message = typeof e.message === 'string' ? e.message : '';

  if (code === '42501' || e.status === 403) {
    return message.startsWith('Administrator')
      ? 'Only administrators can do this.'
      : 'You do not have permission to do this.';
  }
  if (code === 'PGRST301' || code === 'PGRST303' || /JWT expired/i.test(message)) {
    return 'Your session has expired. Please sign in again.';
  }
  if (code === '23505') return 'That record already exists.';
  if (code === '23503') return 'This record is still in use and cannot be removed.';
  if (code && OWN_MESSAGE_CODES.has(code) && message && !TECHNICAL_HINTS.test(message)) {
    return message.endsWith('.') ? message : `${message}.`;
  }
  if (/Failed to fetch|NetworkError|network/i.test(message)) {
    return 'Unable to reach the server. Check your connection and try again.';
  }
  return fallback;
}

/** Log technical details (never secrets — the Supabase client does not expose them) and wrap. */
export function toAppError(error: unknown, fallback: string): AppError {
  if (error instanceof AppError) return error;
  console.error(fallback, error);
  const code =
    typeof error === 'object' && error !== null && typeof (error as ErrorLike).code === 'string'
      ? ((error as ErrorLike).code as string)
      : undefined;
  return new AppError(toUserMessage(error, fallback), code, error);
}
