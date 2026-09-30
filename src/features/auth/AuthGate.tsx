import type { ReactNode } from 'react';
import { isSupabaseConfigured } from '../../lib/supabase';
import { useAuth } from './AuthProvider';

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="auth-screen">
      <div className="auth-card">
        <h1>Workshop Stock &amp; Sales</h1>
        {children}
      </div>
    </main>
  );
}

/** Renders the app only for signed-in users on the allow-list. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { state, signInWithGoogle, signOut } = useAuth();

  if (!isSupabaseConfigured) {
    return (
      <Centered>
        <p className="form-error" role="alert">
          The application is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see README).
        </p>
      </Centered>
    );
  }

  switch (state.status) {
    case 'loading':
      return (
        <Centered>
          <p role="status">Checking your access…</p>
        </Centered>
      );
    case 'signed_out':
      return (
        <Centered>
          <p>Sign in with the Google account your administrator has authorised.</p>
          {state.message && (
            <p className="form-error" role="alert">
              {state.message}
            </p>
          )}
          <button type="button" className="btn btn-primary btn-large" onClick={signInWithGoogle}>
            Sign in with Google
          </button>
        </Centered>
      );
    case 'unauthorized':
      return (
        <Centered>
          <p className="form-error" role="alert">
            Access denied. <strong>{state.email}</strong> is not authorised to use this application.
          </p>
          <p>Ask an administrator to add your Google account, then sign in again.</p>
          <button type="button" className="btn" onClick={signOut}>
            Sign out
          </button>
        </Centered>
      );
    case 'error':
      return (
        <Centered>
          <p className="form-error" role="alert">
            {state.message}
          </p>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Try again
          </button>
        </Centered>
      );
    case 'ready':
      return <>{children}</>;
  }
}
