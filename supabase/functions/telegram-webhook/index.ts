// Supabase Edge Function: Telegram webhook.
//
// Secrets (Supabase → Edge Functions → Secrets; never in the frontend):
//   TELEGRAM_BOT_TOKEN        token from @BotFather
//   TELEGRAM_WEBHOOK_SECRET   random string, also given to setWebhook as secret_token
//   TELEGRAM_BOT_USERNAME     optional bot username/alias (without @)
// Provided automatically by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// Deploy with JWT verification OFF (Telegram cannot send a Supabase JWT); the
// request is authenticated by the X-Telegram-Bot-Api-Secret-Token header instead.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { type Database, type SessionState, type TgUpdate, handleUpdate } from './bot.ts';
import { createTelegramClient } from './telegram_api.ts';

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

const ok = () => new Response('ok', { status: 200 });

Deno.serve(async (request: Request): Promise<Response> => {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const secret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!token || !secret || secret.length < 16 || !url || !serviceKey) {
    // Fail closed when not configured.
    return new Response('not configured', { status: 503 });
  }
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!constantTimeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '', secret)) {
    return new Response('unauthorized', { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return new Response('bad request', { status: 400 });
  }
  if (typeof update?.update_id !== 'number') return ok();

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const db: Database = {
    rpc: async (fn, args) => {
      const { data, error } = await supabase.rpc(fn, args);
      return { data, error: error ? { code: error.code, message: error.message } : null };
    },
    loadSession: async (telegramUserId) => {
      const { data, error } = await supabase
        .from('telegram_sessions')
        .select('state')
        .eq('telegram_user_id', telegramUserId)
        .maybeSingle();
      if (error) throw new Error('Unable to load the session');
      return (data?.state as SessionState | undefined) ?? null;
    },
    saveSession: async (telegramUserId, state) => {
      const { error } = await supabase
        .from('telegram_sessions')
        .upsert({ telegram_user_id: telegramUserId, state, updated_at: new Date().toISOString() });
      if (error) throw new Error('Unable to save the session');
    },
  };

  try {
    await handleUpdate(update, {
      db,
      tg: createTelegramClient(token),
      botUsername: Deno.env.get('TELEGRAM_BOT_USERNAME') ?? null,
    });
  } catch (error) {
    console.error('telegram-webhook failed', error instanceof Error ? error.message : 'unknown error');
  }
  // Always 200 after authentication so Telegram does not retry a handled update.
  return ok();
});
