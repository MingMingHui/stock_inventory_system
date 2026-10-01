import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BatchOption,
  type Database,
  type DbError,
  type InlineButton,
  type Keyboard,
  MESSAGES,
  type ProductOption,
  type SessionState,
  type TelegramClient,
  type TgUpdate,
  friendlyError,
  BotError,
  handleUpdate,
  malaysiaToday,
  parseCommand,
  parseDate,
  parseMoney,
  parseQuantity,
} from './bot.ts';

// ---------------------------------------------------------------------------
// Test harness: in-memory sessions, scripted database functions, captured replies
// ---------------------------------------------------------------------------
type RpcHandler = (args: Record<string, unknown>) => { data?: unknown; error?: DbError };

const TG_ID = 4242;
const NOW = new Date('2026-10-01T02:00:00Z'); // 10:00 in Malaysia

const battery: ProductOption = {
  product_id: 'p-ns40',
  item_code: 'BAT-NS40',
  description: 'NS40ZL',
  brand: 'Motorlite',
  category_name: 'Car Battery',
  unit: 'pcs',
  is_non_stock: false,
  available: 13,
  batch_count: 2,
  last_unit_cost: 142.3,
  last_agreed_price: 195,
};

const batches: BatchOption[] = [
  { stock_item_id: 's-old', purchased_date: '2026-01-05', quantity: 3, unit_cost: 142.3, agreed_price: 195, fifo_rank: 1, item_code: 'BAT-NS40', description: 'NS40ZL', is_non_stock: false },
  { stock_item_id: 's-new', purchased_date: '2026-06-20', quantity: 10, unit_cost: 142.3, agreed_price: 195, fifo_rank: 2, item_code: 'BAT-NS40', description: 'NS40ZL', is_non_stock: false },
];

class Harness {
  sessions = new Map<number, SessionState>();
  calls: { fn: string; args: Record<string, unknown> }[] = [];
  replies: { text: string; keyboard?: Keyboard }[] = [];
  handlers: Record<string, RpcHandler> = {};
  claimed = new Set<number>();
  nextUpdate = 1;
  nonceCounter = 0;
  now = NOW;

  constructor() {
    this.handlers = {
      tg_claim_update: (a) => {
        const id = a.p_update_id as number;
        const fresh = !this.claimed.has(id);
        this.claimed.add(id);
        return { data: fresh };
      },
      tg_whoami: () => ({ data: [{ email: 'staff@example.com', display_name: 'Staff', role: 'user' }] }),
      tg_list_categories: () => ({ data: [{ id: 'c-bat', name: 'Car Battery' }, { id: 'c-tyre', name: 'Car Tyre' }] }),
      tg_list_products: () => ({ data: [battery] }),
      tg_list_batches: () => ({ data: batches }),
      tg_preview_sale: (a) => ({
        data: {
          stock_before: 10, stock_after: 10 - (a.p_quantity as number), is_non_stock: false, agreed_price: 195,
          actual_price: Number(a.p_actual_price), quantity: a.p_quantity, revenue: 340, total_cost: 284.6,
          gross_profit: 55.4, rule_type: 'Fixed_Per_Unit', partner_a_share: 320, partner_b_share: 20,
          price_drop_ratio: 0.1282, price_alert: true, insufficient_stock: false,
        },
      }),
      tg_execute: () => ({ data: { status: 'ok', action: 'sale', sale_id: 'ab12cd34-0000', stock_after: 8, price_alert: true } }),
    };
  }

  db: Database = {
    rpc: async <T,>(fn: string, args: Record<string, unknown>) => {
      this.calls.push({ fn, args });
      const handler = this.handlers[fn];
      if (!handler) throw new Error(`unexpected rpc ${fn}`);
      const result = handler(args);
      return { data: (result.data ?? null) as T | null, error: result.error ?? null };
    },
    loadSession: async (id) => structuredClone(this.sessions.get(id) ?? null),
    saveSession: async (id, state) => {
      this.sessions.set(id, structuredClone(state));
    },
  };

  tg: TelegramClient = {
    sendMessage: async (_chat, text, keyboard) => {
      this.replies.push({ text, keyboard });
    },
    answerCallback: vi.fn(async () => undefined),
    clearButtons: vi.fn(async () => undefined),
  };

  async send(text: string, chatType = 'private') {
    const update: TgUpdate = {
      update_id: this.nextUpdate++,
      message: { message_id: 1, chat: { id: TG_ID, type: chatType }, from: { id: TG_ID, username: 'staff' }, text },
    };
    await this.deliver(update);
  }

  async press(button: InlineButton | undefined) {
    if (!button) throw new Error('button not found');
    await this.deliver({
      update_id: this.nextUpdate++,
      callback_query: {
        id: `cb${this.nextUpdate}`,
        from: { id: TG_ID },
        data: button.callback_data,
        message: { message_id: 2, chat: { id: TG_ID, type: 'private' } },
      },
    });
  }

  deliver(update: TgUpdate) {
    return handleUpdate(update, {
      db: this.db,
      tg: this.tg,
      botUsername: 'KaliWorkshopBot',
      now: () => this.now,
      nonce: () => `n${++this.nonceCounter}`,
    });
  }

  last() {
    const reply = this.replies.at(-1);
    if (!reply) throw new Error('no reply');
    return reply;
  }

  button(label: RegExp | string): InlineButton | undefined {
    const rows = this.last().keyboard ?? [];
    return rows.flat().find((b) => (typeof label === 'string' ? b.text === label : label.test(b.text)));
  }

  rpcCalls(fn: string) {
    return this.calls.filter((c) => c.fn === fn);
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------
describe('authorization', () => {
  it('rejects Telegram users that are not linked', async () => {
    h.handlers.tg_whoami = () => ({ error: { code: '42501', message: 'TG_NOT_LINKED' } });
    await h.send('/sale');
    expect(h.last().text).toBe(MESSAGES.notLinked);
    expect(h.rpcCalls('tg_list_categories')).toHaveLength(0);
  });

  it('re-checks authorization on every button press', async () => {
    await h.send('/sale');
    const category = h.button('Car Battery');
    h.handlers.tg_whoami = () => ({ error: { code: '42501', message: 'TG_NOT_LINKED' } }); // disabled meanwhile
    await h.press(category);
    expect(h.last().text).toBe(MESSAGES.notLinked);
    expect(h.rpcCalls('tg_list_products')).toHaveLength(0);
  });

  it('only works in private chats', async () => {
    await h.send('/sale', 'group');
    expect(h.last().text).toBe(MESSAGES.privateOnly);
    expect(h.rpcCalls('tg_whoami')).toHaveLength(0);
  });

  it('processes a retried (duplicate) update only once', async () => {
    const update: TgUpdate = {
      update_id: 77,
      message: { message_id: 1, chat: { id: TG_ID, type: 'private' }, from: { id: TG_ID }, text: '/help' },
    };
    await h.deliver(update);
    await h.deliver(update);
    expect(h.replies).toHaveLength(1);
  });

  it('ignores commands addressed to another bot', async () => {
    await h.send('/sale@SomeOtherBot');
    expect(h.replies).toHaveLength(0);
    await h.send('/sale@KaliWorkshopBot');
    expect(h.last().text).toMatch(/Record a sale/);
  });

  it('ignores forged button indexes and old nonces', async () => {
    await h.send('/sale');
    await h.press({ text: 'x', callback_data: 'n1|99' });
    expect(h.last().text).toBe(MESSAGES.staleButton);
    await h.press({ text: 'x', callback_data: 'n-forged|0' });
    expect(h.last().text).toBe(MESSAGES.staleButton);
    expect(h.rpcCalls('tg_list_products')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------
describe('linking', () => {
  it('links with /start <code> using the stable Telegram user id', async () => {
    h.handlers.tg_link_account = () => ({ data: [{ display_name: 'Staff', email: 'staff@example.com', role: 'user' }] });
    await h.send(`/start ${'a'.repeat(64)}`);
    expect(h.rpcCalls('tg_link_account')[0]?.args).toMatchObject({
      p_code: 'a'.repeat(64),
      p_telegram_user_id: TG_ID,
      p_telegram_username: 'staff',
      p_chat_id: TG_ID,
    });
    expect(h.last().text).toMatch(/Linked to Staff \(user\)/);
  });

  it.each([
    ['TG_CODE_EXPIRED', /expired/],
    ['TG_CODE_USED', /already been used/],
    ['TG_CODE_INVALID', /not valid/],
    ['TG_LINK_DEACTIVATED', /disabled/],
  ])('explains %s', async (code, expected) => {
    h.handlers.tg_link_account = () => ({ error: { code: '22023', message: code } });
    await h.send(`/start ${'b'.repeat(64)}`);
    expect(h.last().text).toMatch(expected);
  });
});

// ---------------------------------------------------------------------------
// Sale flow
// ---------------------------------------------------------------------------
async function goToBatches() {
  await h.send('/sale');
  await h.send('NS40');
  await h.press(h.button(/BAT-NS40/));
}

describe('sale', () => {
  it('lists batches FIFO, lets the user pick another batch, previews via the database and confirms', async () => {
    await goToBatches();
    const rows = (h.last().keyboard ?? []).flat().map((b) => b.text);
    expect(rows.slice(0, 2)).toEqual(['⭐ 2026-01-05 | Qty: 3', '2026-06-20 | Qty: 10']); // oldest first

    await h.press(h.button('2026-06-20 | Qty: 10')); // explicit choice of the newer batch
    await h.press(h.button(/^Today/));
    await h.send('12');
    expect(h.last().text).toMatch(/Only 10 in this batch/); // checked before any database call
    await h.send('2');
    expect(h.last().text).toMatch(/Agreed selling price: RM195\.00/);
    await h.send('170');

    expect(h.rpcCalls('tg_preview_sale')[0]?.args).toEqual({
      p_telegram_user_id: TG_ID,
      p_stock_item_id: 's-new',
      p_quantity: 2,
      p_actual_price: '170',
      p_sale_date: malaysiaToday(NOW),
    });
    const confirmation = h.last().text;
    expect(confirmation).toMatch(/Confirm Sale/);
    expect(confirmation).toMatch(/Revenue: RM340\.00/);
    expect(confirmation).toMatch(/Gross Profit: RM55\.40/);
    expect(confirmation).toMatch(/⚠ PRICE ALERT[\s\S]*Difference: 12\.8%[\s\S]*This sale requires attention\./);

    // The pending action is stored server-side; the button only carries the nonce.
    const session = h.sessions.get(TG_ID);
    expect(session?.pending).toEqual({
      action: 'sale',
      payload: { stock_item_id: 's-new', quantity: 2, actual_price: '170', sale_date: malaysiaToday(NOW) },
    });
    const confirm = h.button('✅ Confirm Sale');
    expect(confirm?.callback_data).toBe(`${session?.nonce}|a:confirm`);

    await h.press(confirm);
    expect(h.rpcCalls('tg_execute')[0]?.args).toEqual({ p_telegram_user_id: TG_ID, p_nonce: session?.nonce });
    expect(h.last().text).toMatch(/Sale successfully recorded\.[\s\S]*Sales ID: AB12CD34[\s\S]*Stock remaining: 8/);
  });

  it('reports a repeated confirmation without saving twice', async () => {
    h.handlers.tg_execute = () => ({ data: { status: 'already_done', result: {} } });
    await h.press({ text: 'Confirm', callback_data: 'n9|a:confirm' });
    expect(h.last().text).toMatch(/already recorded/);
  });

  it('maps database refusals to clear messages and never shows raw errors', async () => {
    h.handlers.tg_execute = () => ({ error: { code: '23514', message: 'Line 1: only 3 in stock' } });
    await h.press({ text: 'Confirm', callback_data: 'n1|a:confirm' });
    expect(h.last().text).toBe('Only 3 in stock. Nothing was saved.');

    h.handlers.tg_execute = () => ({ error: { code: '40001', message: 'Stock quantity changed from 9 to 10' } });
    await h.press({ text: 'Confirm', callback_data: 'n1|a:confirm' });
    expect(h.last().text).toBe(MESSAGES.staleStock);

    h.handlers.tg_execute = () => ({ error: { code: 'XX000', message: 'relation "x" does not exist at character 4' } });
    await h.press({ text: 'Confirm', callback_data: 'n1|a:confirm' });
    expect(h.last().text).toBe(MESSAGES.generic);
  });

  it('sends the user back when stock ran out before confirmation', async () => {
    h.handlers.tg_preview_sale = () => ({
      data: { stock_before: 1, insufficient_stock: true, quantity: 2 },
    });
    await goToBatches();
    await h.press(h.button(/^⭐/));
    await h.press(h.button(/^Today/));
    await h.send('2');
    await h.press(h.button(/Agreed price/));
    expect(h.last().text).toMatch(/Only 1 left in this batch now/);
    expect(h.sessions.get(TG_ID)?.step).toBe('quantity');
    expect(h.sessions.get(TG_ID)?.pending).toBeUndefined();
  });

  it('cancels and expires interactions', async () => {
    await h.send('/sale');
    await h.press(h.button('✖ Cancel'));
    expect(h.last().text).toBe(MESSAGES.cancelled);
    expect(h.sessions.get(TG_ID)?.flow).toBeUndefined();

    await h.send('/sale');
    h.now = new Date(NOW.getTime() + 16 * 60_000);
    await h.send('NS40');
    expect(h.last().text).toBe(MESSAGES.expired);
  });

  it('validates typed values', async () => {
    await goToBatches();
    await h.press(h.button(/^⭐/));
    await h.send('31/12/2099');
    expect(h.last().text).toMatch(/valid date/);
    await h.send('30/09/2026');
    await h.send('-1');
    expect(h.last().text).toMatch(/whole number of 1 or more/);
    await h.send('1');
    await h.send('12.345');
    expect(h.last().text).toMatch(/up to 2 decimals/);
  });
});

// ---------------------------------------------------------------------------
// Stock flows
// ---------------------------------------------------------------------------
describe('stock', () => {
  it('adjusts a selected batch with the stale-quantity guard', async () => {
    h.handlers.tg_execute = () => ({ data: { status: 'ok', action: 'adjust_stock', previous_quantity: 3, new_quantity: 8 } });
    await h.send('/stock_adjust');
    await h.press(h.button('Car Battery'));
    await h.press(h.button(/BAT-NS40/));
    await h.press(h.button(/^⭐ 2026-01-05/));
    await h.press(h.button('Receive new stock'));
    await h.send('5');
    await h.send('Delivery from supplier');
    expect(h.last().text).toMatch(/Quantity: 3 → 8/);
    expect(h.sessions.get(TG_ID)?.pending).toEqual({
      action: 'adjust_stock',
      payload: { stock_item_id: 's-old', adjustment_type: 'receive', quantity: 5, reason: 'Delivery from supplier', expected_quantity: 3 },
    });
    await h.press(h.button('✅ Confirm'));
    expect(h.last().text).toBe('Stock updated: 3 → 8.');
  });

  it('adds stock using selections for known values', async () => {
    h.handlers.tg_execute = () => ({ data: { status: 'ok', action: 'add_stock', quantity: 4 } });
    await h.send('/stock_add');
    await h.press(h.button('Car Battery'));
    expect(h.rpcCalls('tg_list_products')[0]?.args).toMatchObject({ p_mode: 'add', p_category_id: 'c-bat' });
    await h.press(h.button(/BAT-NS40/));
    await h.press(h.button('Yesterday'));
    await h.send('4');
    await h.press(h.button(/last cost/));
    await h.press(h.button(/current price/));
    expect(h.last().text).toMatch(/Confirm stock addition\?[\s\S]*Purchase date: 2026-09-30[\s\S]*Quantity: 4[\s\S]*Cost: RM142\.30/);
    expect(h.sessions.get(TG_ID)?.pending?.payload).toEqual({
      product_id: 'p-ns40', purchased_date: '2026-09-30', quantity: 4, unit_cost: '142.3', agreed_price: '195',
    });
    await h.press(h.button('✅ Confirm'));
    expect(h.last().text).toMatch(/Stock added: 4 unit/);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe('helpers', () => {
  it('uses the Malaysian date regardless of UTC', () => {
    expect(malaysiaToday(new Date('2026-09-30T17:30:00Z'))).toBe('2026-10-01'); // 01:30 MYT
  });

  it('parses dates, money, quantities and commands strictly', () => {
    expect(parseDate('05/01/2026', '2026-10-01')).toBe('2026-01-05');
    expect(parseDate('2026-02-30', '2026-10-01')).toBeNull();
    expect(parseDate('2026-10-02', '2026-10-01')).toBeNull();
    expect(parseMoney('RM1,234.50')).toBe('1234.50');
    expect(parseMoney('12.345')).toBeNull();
    expect(parseMoney('-5')).toBeNull();
    expect(parseQuantity('0', 1)).toBeNull();
    expect(parseQuantity('0', 0)).toBe(0);
    expect(parseQuantity('1.5', 1)).toBeNull();
    expect(parseCommand('/start abc', 'Bot')).toEqual({ name: 'start', arg: 'abc' });
    expect(parseCommand('/sale@bot', 'Bot')).toEqual({ name: 'sale', arg: '' });
    expect(parseCommand('hello', 'Bot')).toBeNull();
  });

  it('hides technical errors', () => {
    expect(friendlyError(new BotError('permission denied for table sales', '42501'))).toBe(MESSAGES.disabled);
    expect(friendlyError(new Error('boom'))).toBe(MESSAGES.generic);
    expect(friendlyError(new BotError('Administrator access required', '42501'))).toBe('Only administrators can do this.');
  });
});
