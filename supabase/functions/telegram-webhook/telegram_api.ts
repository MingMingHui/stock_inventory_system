import type { Keyboard, TelegramClient } from './bot.ts';

/** Minimal Telegram Bot API client. The token is only used in the request URL and is never logged. */
export function createTelegramClient(token: string, fetchFn: typeof fetch = fetch): TelegramClient {
  async function call(method: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      // Log the method and status only — never the URL (it contains the token).
      console.error(`Telegram ${method} failed with HTTP ${response.status}`);
    }
  }

  return {
    sendMessage: (chatId: number, text: string, keyboard?: Keyboard) =>
      call('sendMessage', {
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
        ...(keyboard && keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      }),
    answerCallback: (callbackQueryId: string, text?: string) =>
      call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
    clearButtons: (chatId: number, messageId: number) =>
      call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  };
}
