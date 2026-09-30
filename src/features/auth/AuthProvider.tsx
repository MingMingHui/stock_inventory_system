import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toUserMessage } from '../../lib/errors';
import { oauthRedirectUrl, supabase } from '../../lib/supabase';
import type { MyAccess } from '../../types/database';

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed_out'; message?: string }
  | { status: 'unauthorized'; email: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; session: Session; access: MyAccess };

interface AuthApi {
  state: AuthState;
  isAdmin: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

async function resolveAccess(session: Session | null): Promise<AuthState> {
  if (!session) return { status: 'signed_out' };
  // The allow-list is checked by the database (verified email + active entry).
  const { data, error } = await supabase.rpc('get_my_access');
  if (error) {
    console.error('get_my_access failed', error);
    return { status: 'error', message: toUserMessage(error, 'Unable to check your access. Please try again.') };
  }
  const access = (data as MyAccess[] | null)?.[0];
  return access
    ? { status: 'ready', session, access }
    : { status: 'unauthorized', email: session.user.email ?? 'this account' };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    const apply = (session: Session | null) => {
      resolveAccess(session).then((next) => {
        if (active) setState(next);
      });
    };

    supabase.auth.getSession().then(({ data }) => apply(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') return;
      // Defer: calling Supabase inside this callback can deadlock the auth lock.
      window.setTimeout(() => apply(session), 0);
    });

    // Remove the one-time OAuth ?code= from the address bar after sign-in.
    if (new URLSearchParams(window.location.search).has('code')) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    }

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: oauthRedirectUrl(), queryParams: { prompt: 'select_account' } },
    });
    if (error) {
      console.error('Google sign-in failed', error);
      setState({ status: 'signed_out', message: 'Google sign-in could not be started. Please try again.' });
    }
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setState({ status: 'signed_out' });
  }, []);

  const value = useMemo<AuthApi>(
    () => ({
      state,
      isAdmin: state.status === 'ready' && state.access.role === 'admin',
      signInWithGoogle,
      signOut,
    }),
    [state, signInWithGoogle, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
