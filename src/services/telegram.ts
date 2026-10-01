import { supabase } from '../lib/supabase';
import type { MyTelegramLink, TelegramLinkCode, TelegramUserLink } from '../types/database';
import { run } from './api';

/** One-time code (10 minutes) to send to the bot as /start <code>. */
export async function createTelegramLinkCode(): Promise<TelegramLinkCode> {
  const rows = await run<TelegramLinkCode[]>(
    supabase.rpc('create_telegram_link_code'),
    'Unable to create a Telegram link code.',
  );
  const first = rows[0];
  if (!first) throw new Error('No link code returned');
  return first;
}

export async function getMyTelegramLink(): Promise<MyTelegramLink | null> {
  const rows = await run<MyTelegramLink[]>(supabase.rpc('get_my_telegram_link'), 'Unable to load your Telegram link.');
  return rows[0] ?? null;
}

export function unlinkMyTelegram(): Promise<null> {
  return run(supabase.rpc('unlink_my_telegram'), 'Unable to unlink Telegram.');
}

/** Admin: all linked Telegram accounts. */
export function listTelegramLinks(): Promise<TelegramUserLink[]> {
  return run(
    supabase
      .from('telegram_user_links')
      .select('id,telegram_user_id,telegram_username,is_active,linked_at,last_seen_at,authorized_users(email,display_name)')
      .order('linked_at', { ascending: false }),
    'Unable to load Telegram links.',
  );
}

export function setTelegramLinkActive(id: string, isActive: boolean): Promise<null> {
  return run(
    supabase.from('telegram_user_links').update({ is_active: isActive }).eq('id', id),
    'Unable to change the Telegram link.',
  );
}

/** Deep link that opens the bot with the code pre-filled. */
export function telegramDeepLink(botUsername: string, code: string): string {
  return `https://t.me/${encodeURIComponent(botUsername.replace(/^@/, ''))}?start=${encodeURIComponent(code)}`;
}
