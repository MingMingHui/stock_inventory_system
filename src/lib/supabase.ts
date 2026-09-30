import { createClient } from '@supabase/supabase-js';

// Only the public URL and anon key belong in the browser. Every privilege is
// enforced by Row Level Security and database functions, never by this client.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = createClient(url ?? 'http://localhost:54321', anonKey ?? 'not-configured', {
  auth: {
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

/** Where Google should send the user back to: the app root (hash routes follow). */
export function oauthRedirectUrl(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}`;
}
