// Telegram bot conversation logic. Runtime-agnostic (Deno Edge Function in
// production, Node/Vitest in tests): all I/O goes through the injected
// `Database` and `TelegramClient`.
//
// Security model (see docs/telegram-integration.md):
//  * Every update is authorized by the database (tg_* functions map the stable
//    Telegram user ID to an active, allow-listed user) before anything is shown.
//  * Writes run through tg_execute(), which calls the SAME database functions as
//    the web app (add_stock_item, adjust_stock, create_sale) under that user's
//    identity. This file never calculates money; it only formats database values.
//  * Buttons carry a per-step random nonce + an index into server-side options,
//    so old or forged buttons cannot select anything the user was not offered.
//  * Private chats only.

// ---------------------------------------------------------------------------
// Telegram types (subset)
// ---------------------------------------------------------------------------
export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type Keyboard = InlineButton[][];

export interface TelegramClient {
  sendMessage(chatId: number, text: string, keyboard?: Keyboard): Promise<void>;
  answerCallback(callbackQueryId: string, text?: string): Promise<void>;
  clearButtons(chatId: number, messageId: number): Promise<void>;
}

export interface DbError {
  code?: string;
  message: string;
}

export interface Database {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<{ data: T | null; error: DbError | null }>;
  loadSession(telegramUserId: number): Promise<SessionState | null>;
  saveSession(telegramUserId: number, state: SessionState): Promise<void>;
}

export interface BotDeps {
  db: Database;
  tg: TelegramClient;
  /** Configured bot username/alias (without @). Commands addressed to another bot are ignored. */
  botUsername?: string | null;
  now?: () => Date;
  nonce?: () => string;
}

// ---------------------------------------------------------------------------
// Session state (stored server-side in public.telegram_sessions)
// ---------------------------------------------------------------------------
export type Flow = 'stock_add' | 'stock_adjust' | 'sale';
type Step =
  | 'find_item'
  | 'pick_product'
  | 'pick_batch'
  | 'purchase_date'
  | 'sale_date'
  | 'quantity'
  | 'unit_cost'
  | 'agreed_price'
  | 'adjust_type'
  | 'reason'
  | 'actual_price'
  | 'confirm';

export interface ProductOption {
  product_id: string;
  item_code: string;
  description: string;
  brand: string | null;
  category_name: string;
  unit: string | null;
  is_non_stock: boolean;
  available: number;
  batch_count: number;
  last_unit_cost: number | null;
  last_agreed_price: number | null;
}

export interface BatchOption {
  stock_item_id: string;
  purchased_date: string | null;
  quantity: number;
  unit_cost: number;
  agreed_price: number;
  fifo_rank: number;
  item_code: string;
  description: string;
  is_non_stock: boolean;
}

interface Option {
  kind: 'category' | 'product' | 'batch';
  id: string;
}

type AdjustmentType = 'receive' | 'stock_check' | 'amendment';

interface FlowData {
  products?: ProductOption[];
  product?: ProductOption;
  batches?: BatchOption[];
  batch?: BatchOption;
  purchased_date?: string;
  sale_date?: string;
  quantity?: number;
  unit_cost?: string;
  agreed_price?: string;
  adjustment_type?: AdjustmentType;
  reason?: string;
  actual_price?: string;
}

export interface SessionState {
  flow?: Flow;
  step?: Step;
  nonce?: string;
  expires_at?: string;
  data?: FlowData;
  options?: Option[];
  pending?: { action: 'add_stock' | 'adjust_stock' | 'sale'; payload: Record<string, unknown> };
  last_nonce?: string;
  last_result?: unknown;
}

interface SalePreview {
  stock_before: number | null;
  stock_after: number | null;
  is_non_stock: boolean;
  agreed_price: number;
  actual_price: number;
  quantity: number;
  revenue: number;
  total_cost: number;
  gross_profit: number;
  rule_type: string;
  partner_a_share: number;
  partner_b_share: number;
  price_drop_ratio: number | null;
  price_alert: boolean;
  insufficient_stock: boolean;
}

// ---------------------------------------------------------------------------
// Constants and messages
// ---------------------------------------------------------------------------
const SESSION_MINUTES = 15;
const MAX_MONEY = 1_000_000;
const MAX_QUANTITY = 100_000;

export const MESSAGES = {
  privateOnly: 'For security, I only work in a private chat. Please message me directly.',
  notLinked:
    'This Telegram account is not linked to the workshop app.\n\n' +
    'To link it: sign in to the web app → Telegram → "Link my Telegram account", then open the link or send the /start code it shows.',
  disabled: 'Your access is disabled. Please contact an administrator.',
  expired: 'This interaction has expired. Start again with /sale, /stock_add or /stock_adjust.',
  staleButton: 'That button is no longer active. Use the latest message, or start again.',
  cancelled: 'Cancelled. Nothing was saved.',
  useButtons: 'Please choose one of the buttons above, or send /cancel.',
  generic: 'Something went wrong. Nothing was saved. Please try again.',
  staleStock:
    'The stock quantity changed since you selected it (someone else updated it). Nothing was saved. Please start again to see the current quantity.',
  noFlow: 'Send /sale, /stock_add or /stock_adjust to start, or /help for all commands.',
};

const HELP =
  'Workshop bot commands:\n' +
  '/sale – record a sale\n' +
  '/stock_add – add new stock (a new purchase batch)\n' +
  '/stock_adjust – receive stock, stock check or correct a quantity\n' +
  '/stock <code or name> – look up stock levels\n' +
  '/whoami – show the linked account\n' +
  '/cancel – cancel the current action\n\n' +
  'Batches are listed oldest purchase first (FIFO).';

const FLOW_TITLE: Record<Flow, string> = {
  stock_add: 'Add new stock',
  stock_adjust: 'Adjust stock',
  sale: 'Record a sale',
};

const FLOW_MODE: Record<Flow, 'add' | 'adjust' | 'sale'> = {
  stock_add: 'add',
  stock_adjust: 'adjust',
  sale: 'sale',
};

const ADJUST_LABEL: Record<AdjustmentType, string> = {
  receive: 'Receive new stock',
  stock_check: 'Stock check (count)',
  amendment: 'Correct quantity',
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------
export class BotError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export function money(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return `RM${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function percent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined) return '—';
  return `${(Number(ratio) * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

/** Malaysian calendar date (business dates use Asia/Kuala_Lumpur, like the database). */
export function malaysiaToday(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** Accepts YYYY-MM-DD or DD/MM/YYYY. Returns ISO date or null. */
export function parseDate(input: string, today: string): string | null {
  const text = input.trim();
  let y: number;
  let m: number;
  let d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  const iso = date.toISOString().slice(0, 10);
  if (iso > today || y < 2000) return null;
  return iso;
}

export function parseQuantity(input: string, min: number): number | null {
  const text = input.trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= MAX_QUANTITY ? n : null;
}

/** Money with up to 2 decimals; "RM" prefix and thousands commas allowed. Returns a decimal string. */
export function parseMoney(input: string): string | null {
  const text = input.trim().replace(/^rm\s*/i, '').replace(/,/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text);
  return n <= MAX_MONEY ? text : null;
}

export function parseCommand(text: string, botUsername?: string | null): { name: string; arg: string } | null {
  const match = /^\/([a-z_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const target = match[2];
  if (target && botUsername && target.toLowerCase() !== botUsername.replace(/^@/, '').toLowerCase()) return null;
  return { name: (match[1] ?? '').toLowerCase(), arg: (match[3] ?? '').trim() };
}

/** Same policy as the web app: only our own validation messages reach users. */
export function friendlyError(error: unknown): string {
  const code = error instanceof BotError ? error.code : undefined;
  const message = error instanceof Error ? error.message : '';
  switch (message) {
    case 'TG_NOT_LINKED':
      return MESSAGES.notLinked;
    case 'TG_CODE_INVALID':
      return 'That link code is not valid. Generate a new one in the web app (Telegram → Link my Telegram account).';
    case 'TG_CODE_EXPIRED':
      return 'That link code has expired (codes are valid for 10 minutes). Generate a new one in the web app.';
    case 'TG_CODE_USED':
      return 'That link code has already been used. Generate a new one in the web app.';
    case 'TG_USER_INACTIVE':
    case 'TG_LINK_DEACTIVATED':
      return MESSAGES.disabled;
  }
  if (code === '40001') return MESSAGES.staleStock;
  if (code === '42501') {
    return message.startsWith('Administrator') ? 'Only administrators can do this.' : MESSAGES.disabled;
  }
  const own = ['22023', 'P0002', '23514', '55000', '23P01'];
  if (code && own.includes(code) && message && !/relation|constraint|column|violates|syntax|permission denied/i.test(message)) {
    const clean = message.replace(/^Line \d+: /, '');
    return `${clean.charAt(0).toUpperCase()}${clean.slice(1)}${clean.endsWith('.') ? '' : '.'} Nothing was saved.`;
  }
  return MESSAGES.generic;
}

function productLabel(p: ProductOption, flow: Flow): string {
  const stock = p.is_non_stock ? 'service' : flow === 'stock_add' ? `stock ${p.available}` : `${p.available} in stock`;
  return `${p.item_code} · ${p.description}${p.brand ? ` (${p.brand})` : ''} · ${stock}`.slice(0, 60);
}

function batchLabel(b: BatchOption, index: number): string {
  if (b.is_non_stock) return `Service · ${money(b.agreed_price)}`;
  const date = b.purchased_date ?? 'no purchase date';
  return `${index === 0 ? '⭐ ' : ''}${date} | Qty: ${b.quantity}`;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------
class Conversation {
  private readonly deps: Required<Pick<BotDeps, 'now' | 'nonce'>> & BotDeps;

  constructor(
    deps: BotDeps,
    private readonly user: TgUser,
    private readonly chatId: number,
  ) {
    this.deps = {
      ...deps,
      now: deps.now ?? (() => new Date()),
      nonce: deps.nonce ?? randomNonce,
    };
  }

  // ---- I/O ----------------------------------------------------------------
  reply(text: string, keyboard?: Keyboard): Promise<void> {
    return this.deps.tg.sendMessage(this.chatId, text, keyboard);
  }

  async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.deps.db.rpc<T>(fn, { p_telegram_user_id: this.user.id, ...args });
    if (error) throw new BotError(error.message, error.code);
    return data as T;
  }

  async load(): Promise<SessionState> {
    return (await this.deps.db.loadSession(this.user.id)) ?? {};
  }

  save(state: SessionState): Promise<void> {
    return this.deps.db.saveSession(this.user.id, state);
  }

  private today(): string {
    return malaysiaToday(this.deps.now());
  }

  private expiry(): string {
    return new Date(this.deps.now().getTime() + SESSION_MINUTES * 60_000).toISOString();
  }

  private keepHistory(state: SessionState): SessionState {
    return { last_nonce: state.last_nonce, last_result: state.last_result };
  }

  private button(text: string, nonce: string, ref: string): InlineButton {
    return { text, callback_data: `${nonce}|${ref}` };
  }

  private withCancel(nonce: string, rows: Keyboard): Keyboard {
    return [...rows, [this.button('✖ Cancel', nonce, 'a:cancel')]];
  }

  // ---- entry points ---------------------------------------------------------
  async onText(text: string): Promise<void> {
    const command = parseCommand(text, this.deps.botUsername);
    if (text.startsWith('/') && !command) return; // addressed to another bot

    if (command?.name === 'start' && command.arg) {
      await this.link(command.arg);
      return;
    }

    const me = await this.call<{ email: string; display_name: string | null; role: string }[]>('tg_whoami', {});
    const account = me[0];
    if (!account) throw new BotError('TG_NOT_LINKED', '42501');

    if (command) {
      switch (command.name) {
        case 'start':
        case 'help':
          await this.reply(`Hello ${account.display_name ?? account.email}.\n\n${HELP}`);
          return;
        case 'whoami':
          await this.reply(`Linked to ${account.email} (${account.role}).`);
          return;
        case 'cancel':
          await this.save(this.keepHistory(await this.load()));
          await this.reply(MESSAGES.cancelled);
          return;
        case 'stock':
          await this.lookup(command.arg);
          return;
        case 'sale':
        case 'stock_add':
        case 'stock_adjust':
          await this.startFlow(command.name as Flow);
          return;
        default:
          await this.reply(`Unknown command. ${MESSAGES.noFlow}`);
          return;
      }
    }

    await this.onInput(text);
  }

  async onCallback(data: string): Promise<void> {
    await this.call('tg_whoami', {});
    const [nonce = '', ref = ''] = data.split('|');
    const state = await this.load();

    if (ref === 'a:confirm') {
      await this.confirm(state, nonce);
      return;
    }
    if (!state.flow || nonce !== state.nonce) {
      await this.reply(MESSAGES.staleButton);
      return;
    }
    if (this.isExpired(state)) {
      await this.save(this.keepHistory(state));
      await this.reply(MESSAGES.expired);
      return;
    }
    if (ref === 'a:cancel') {
      await this.save(this.keepHistory(state));
      await this.reply(MESSAGES.cancelled);
      return;
    }
    if (ref.startsWith('a:')) {
      await this.onAction(state, ref.slice(2));
      return;
    }
    const index = Number(ref);
    const option = Number.isInteger(index) ? state.options?.[index] : undefined;
    if (!option) {
      await this.reply(MESSAGES.staleButton);
      return;
    }
    await this.onOption(state, option);
  }

  // ---- linking & lookup ---------------------------------------------------------
  private async link(code: string): Promise<void> {
    const rows = await this.call<{ display_name: string | null; email: string; role: string }[]>('tg_link_account', {
      p_code: code.trim(),
      p_telegram_username: this.user.username ?? null,
      p_chat_id: this.chatId,
    });
    const account = rows[0];
    await this.reply(
      `✅ Linked to ${account?.display_name ?? account?.email ?? 'your account'} (${account?.role ?? 'user'}).\n\n${HELP}`,
    );
  }

  private async lookup(term: string): Promise<void> {
    if (!term) {
      await this.reply('Send /stock followed by part of the item code or name, e.g. /stock NS40');
      return;
    }
    const products = await this.call<ProductOption[]>('tg_list_products', { p_mode: 'adjust', p_category_id: null, p_search: term });
    if (products.length === 0) {
      await this.reply(`No stock items match "${term}".`);
      return;
    }
    const lines = products.slice(0, 10).map((p) => `${p.item_code} · ${p.description}${p.brand ? ` (${p.brand})` : ''}: ${p.available} in stock (${p.batch_count} batch${p.batch_count === 1 ? '' : 'es'})`);
    await this.reply(`Stock for "${term}":\n\n${lines.join('\n')}`);
  }

  // ---- flows -------------------------------------------------------------------
  private isExpired(state: SessionState): boolean {
    return !state.expires_at || new Date(state.expires_at).getTime() < this.deps.now().getTime();
  }

  private async startFlow(flow: Flow): Promise<void> {
    const previous = await this.load();
    const state: SessionState = { ...this.keepHistory(previous), flow, step: 'find_item', data: {} };
    await this.prompt(state);
  }

  /** Shows the prompt for state.step with a fresh nonce and saves the session. */
  private async prompt(state: SessionState, intro?: string): Promise<void> {
    const nonce = this.deps.nonce();
    const next: SessionState = { ...state, nonce, expires_at: this.expiry(), options: [] };
    const data = next.data ?? {};
    const flow = next.flow as Flow;
    const prefix = intro ? `${intro}\n\n` : '';
    let text: string;
    let rows: Keyboard = [];

    switch (next.step) {
      case 'find_item': {
        const categories = await this.call<{ id: string; name: string }[]>('tg_list_categories', {});
        next.options = categories.map((c) => ({ kind: 'category' as const, id: c.id }));
        rows = pairs(categories.map((c, i) => this.button(c.name.slice(0, 30), nonce, String(i))));
        text = `${FLOW_TITLE[flow]}\n\nSelect a product category, or type part of the item code or name:`;
        break;
      }
      case 'pick_product': {
        const products = data.products ?? [];
        next.options = products.map((p) => ({ kind: 'product' as const, id: p.product_id }));
        rows = products.map((p, i) => [this.button(productLabel(p, flow), nonce, String(i))]);
        text = 'Select item (or type to search again):';
        break;
      }
      case 'pick_batch': {
        const batches = data.batches ?? [];
        next.options = batches.map((b) => ({ kind: 'batch' as const, id: b.stock_item_id }));
        rows = batches.map((b, i) => [this.button(batchLabel(b, i), nonce, String(i))]);
        text =
          `${data.product?.item_code} – ${data.product?.description}\n\n` +
          'Stock batches, oldest purchase first (FIFO). Select the batch:';
        break;
      }
      case 'purchase_date':
      case 'sale_date': {
        const today = this.today();
        rows = [[this.button(`Today (${today})`, nonce, 'a:today'), this.button('Yesterday', nonce, 'a:yesterday')]];
        text = `${next.step === 'purchase_date' ? 'Purchase date' : 'Sale date'}: choose below or type a date (DD/MM/YYYY).`;
        break;
      }
      case 'quantity': {
        if (flow === 'sale') {
          const b = data.batch;
          text = b?.is_non_stock
            ? 'How many were sold (jobs / services)? Type a whole number.'
            : `Available in this batch: ${b?.quantity}.\nSales quantity? Type a whole number.`;
        } else if (flow === 'stock_adjust') {
          const type = data.adjustment_type ?? 'receive';
          text =
            type === 'receive'
              ? `Current quantity: ${data.batch?.quantity}.\nHow many were received? Type a whole number.`
              : `Current quantity: ${data.batch?.quantity}.\nType the ${type === 'stock_check' ? 'counted' : 'correct'} quantity.`;
        } else {
          text = 'Quantity purchased? Type a whole number.';
        }
        break;
      }
      case 'unit_cost': {
        const last = data.product?.last_unit_cost;
        if (last !== null && last !== undefined) rows = [[this.button(`Use ${money(last)} (last cost)`, nonce, 'a:last_cost')]];
        text = 'Cost per unit (RM)? Type an amount like 142.30.';
        break;
      }
      case 'agreed_price': {
        const current = data.product?.last_agreed_price;
        if (current !== null && current !== undefined) {
          rows = [[this.button(`Use ${money(current)} (current price)`, nonce, 'a:current_price')]];
        }
        text = 'Agreed selling price (RM)? Type an amount.';
        break;
      }
      case 'adjust_type': {
        rows = (Object.keys(ADJUST_LABEL) as AdjustmentType[]).map((t) => [this.button(ADJUST_LABEL[t], nonce, `a:${t}`)]);
        text = `${data.product?.item_code} – batch ${data.batch?.purchased_date ?? 'undated'}, qty ${data.batch?.quantity}.\nWhat kind of change?`;
        break;
      }
      case 'reason':
        text = 'Reason for this change? (e.g. "month-end count", "delivery from supplier")';
        break;
      case 'actual_price': {
        const agreed = data.batch?.agreed_price;
        rows = [[this.button(`Agreed price ${money(agreed)}`, nonce, 'a:agreed')]];
        text = `Agreed selling price: ${money(agreed)}.\nActual selling price per item? Choose or type an amount.`;
        break;
      }
      case 'confirm': {
        const summary = await this.buildConfirmation(next);
        if (!summary) return; // buildConfirmation already moved the user back a step
        text = summary.text;
        rows = [[this.button(summary.confirmLabel, nonce, 'a:confirm'), this.button('✖ Cancel', nonce, 'a:cancel')]];
        await this.save(next);
        await this.reply(prefix + text, rows);
        return;
      }
      default:
        await this.reply(MESSAGES.noFlow);
        return;
    }

    await this.save(next);
    await this.reply(prefix + text, this.withCancel(nonce, rows));
  }

  private async onOption(state: SessionState, option: Option): Promise<void> {
    const data = { ...(state.data ?? {}) };
    const flow = state.flow as Flow;
    if (option.kind === 'category' && state.step === 'find_item') {
      const products = await this.call<ProductOption[]>('tg_list_products', {
        p_mode: FLOW_MODE[flow],
        p_category_id: option.id,
        p_search: null,
      });
      if (products.length === 0) {
        await this.reply('No items available in that category. Choose another category or type to search.');
        return;
      }
      await this.prompt({ ...state, step: 'pick_product', data: { ...data, products } });
      return;
    }
    if (option.kind === 'product' && state.step === 'pick_product') {
      const product = data.products?.find((p) => p.product_id === option.id);
      if (!product) return this.reply(MESSAGES.staleButton);
      data.product = product;
      if (flow === 'stock_add') {
        await this.prompt({ ...state, step: 'purchase_date', data }, `Item: ${product.item_code} – ${product.description}`);
        return;
      }
      const allBatches = await this.call<BatchOption[]>('tg_list_batches', { p_product_id: product.product_id });
      // FIFO order comes from the database; a sale can only use batches that still have stock.
      const batches = flow === 'sale' ? allBatches.filter((b) => b.is_non_stock || b.quantity > 0) : allBatches;
      if (batches.length === 0) {
        await this.reply('This item has no active stock batches. Choose another item.');
        return;
      }
      data.batches = batches;
      if (batches.length === 1) {
        // Only one batch: select it, but tell the user which one.
        data.batch = batches[0];
        const b = batches[0] as BatchOption;
        const intro = b.is_non_stock
          ? `Item: ${product.item_code} – ${product.description} (service)`
          : `Item: ${product.item_code} – ${product.description}\nOnly batch: bought ${b.purchased_date ?? 'undated'}, qty ${b.quantity}`;
        await this.prompt({ ...state, step: flow === 'sale' ? 'sale_date' : 'adjust_type', data }, intro);
        return;
      }
      await this.prompt({ ...state, step: 'pick_batch', data });
      return;
    }
    if (option.kind === 'batch' && state.step === 'pick_batch') {
      const batch = data.batches?.find((b) => b.stock_item_id === option.id);
      if (!batch) return this.reply(MESSAGES.staleButton);
      data.batch = batch;
      await this.prompt({ ...state, step: flow === 'sale' ? 'sale_date' : 'adjust_type', data });
      return;
    }
    await this.reply(MESSAGES.staleButton);
  }

  private async onAction(state: SessionState, action: string): Promise<void> {
    const data = { ...(state.data ?? {}) };
    const today = this.today();
    switch (`${state.step}:${action}`) {
      case 'purchase_date:today':
      case 'purchase_date:yesterday':
        data.purchased_date = action === 'today' ? today : addDays(today, -1);
        await this.prompt({ ...state, step: 'quantity', data });
        return;
      case 'sale_date:today':
      case 'sale_date:yesterday':
        data.sale_date = action === 'today' ? today : addDays(today, -1);
        await this.prompt({ ...state, step: 'quantity', data });
        return;
      case 'unit_cost:last_cost':
        data.unit_cost = String(data.product?.last_unit_cost ?? '');
        await this.prompt({ ...state, step: 'agreed_price', data });
        return;
      case 'agreed_price:current_price':
        data.agreed_price = String(data.product?.last_agreed_price ?? '');
        await this.prompt({ ...state, step: 'confirm', data });
        return;
      case 'adjust_type:receive':
      case 'adjust_type:stock_check':
      case 'adjust_type:amendment':
        data.adjustment_type = action as AdjustmentType;
        await this.prompt({ ...state, step: 'quantity', data });
        return;
      case 'actual_price:agreed':
        data.actual_price = String(data.batch?.agreed_price ?? '');
        await this.prompt({ ...state, step: 'confirm', data });
        return;
      default:
        await this.reply(MESSAGES.staleButton);
    }
  }

  private async onInput(text: string): Promise<void> {
    const state = await this.load();
    if (!state.flow) {
      await this.reply(MESSAGES.noFlow);
      return;
    }
    if (this.isExpired(state)) {
      await this.save(this.keepHistory(state));
      await this.reply(MESSAGES.expired);
      return;
    }
    const flow = state.flow;
    const data = { ...(state.data ?? {}) };
    const today = this.today();

    switch (state.step) {
      case 'find_item':
      case 'pick_product': {
        const term = text.trim().slice(0, 60);
        const products = await this.call<ProductOption[]>('tg_list_products', {
          p_mode: FLOW_MODE[flow],
          p_category_id: null,
          p_search: term,
        });
        if (products.length === 0) {
          await this.reply(`No ${flow === 'sale' ? 'sellable ' : ''}items match "${term}". Try another code or name.`);
          return;
        }
        await this.prompt({ ...state, step: 'pick_product', data: { ...data, products } });
        return;
      }
      case 'purchase_date':
      case 'sale_date': {
        const date = parseDate(text, today);
        if (!date) {
          await this.reply('Please type a valid date that is not in the future, e.g. 05/01/2026.');
          return;
        }
        if (state.step === 'purchase_date') data.purchased_date = date;
        else data.sale_date = date;
        await this.prompt({ ...state, step: 'quantity', data });
        return;
      }
      case 'quantity': {
        const min = flow === 'stock_adjust' && data.adjustment_type !== 'receive' ? 0 : 1;
        const quantity = parseQuantity(text, min);
        if (quantity === null) {
          await this.reply(`Please type a whole number${min === 1 ? ' of 1 or more' : ' of 0 or more'}.`);
          return;
        }
        if (flow === 'sale' && data.batch && !data.batch.is_non_stock && quantity > data.batch.quantity) {
          await this.reply(`Only ${data.batch.quantity} in this batch. Type a smaller quantity, or /cancel.`);
          return;
        }
        data.quantity = quantity;
        const nextStep: Step = flow === 'sale' ? 'actual_price' : flow === 'stock_adjust' ? 'reason' : 'unit_cost';
        await this.prompt({ ...state, step: nextStep, data });
        return;
      }
      case 'unit_cost':
      case 'agreed_price':
      case 'actual_price': {
        const amount = parseMoney(text);
        if (amount === null) {
          await this.reply('Please type an amount like 12.50 (up to 2 decimals).');
          return;
        }
        if (state.step === 'unit_cost') {
          data.unit_cost = amount;
          await this.prompt({ ...state, step: 'agreed_price', data });
        } else if (state.step === 'agreed_price') {
          data.agreed_price = amount;
          await this.prompt({ ...state, step: 'confirm', data });
        } else {
          data.actual_price = amount;
          await this.prompt({ ...state, step: 'confirm', data });
        }
        return;
      }
      case 'reason': {
        const reason = text.trim();
        if (reason.length === 0 || reason.length > 500) {
          await this.reply('Please type a reason (up to 500 characters).');
          return;
        }
        data.reason = reason;
        await this.prompt({ ...state, step: 'confirm', data });
        return;
      }
      default:
        await this.reply(MESSAGES.useButtons);
    }
  }

  /** Builds the confirmation text and the pending action. Returns null if the user was sent back a step. */
  private async buildConfirmation(state: SessionState): Promise<{ text: string; confirmLabel: string } | null> {
    const data = state.data ?? {};
    const product = data.product;
    const batch = data.batch;
    switch (state.flow) {
      case 'stock_add': {
        state.pending = {
          action: 'add_stock',
          payload: {
            product_id: product?.product_id,
            purchased_date: data.purchased_date,
            quantity: data.quantity,
            unit_cost: data.unit_cost,
            agreed_price: data.agreed_price,
          },
        };
        return {
          confirmLabel: '✅ Confirm',
          text:
            'Confirm stock addition?\n\n' +
            `Item: ${product?.item_code} – ${product?.description}${product?.brand ? ` (${product.brand})` : ''}\n` +
            `Purchase date: ${data.purchased_date}\n` +
            `Quantity: ${data.quantity}\n` +
            `Cost: ${money(data.unit_cost)} per unit\n` +
            `Agreed selling price: ${money(data.agreed_price)}`,
        };
      }
      case 'stock_adjust': {
        const type = data.adjustment_type ?? 'receive';
        const current = batch?.quantity ?? 0;
        const result = type === 'receive' ? current + (data.quantity ?? 0) : data.quantity ?? 0;
        state.pending = {
          action: 'adjust_stock',
          payload: {
            stock_item_id: batch?.stock_item_id,
            adjustment_type: type,
            quantity: data.quantity,
            reason: data.reason,
            expected_quantity: current, // the database rejects the change if stock moved meanwhile
          },
        };
        return {
          confirmLabel: '✅ Confirm',
          text:
            'Confirm stock adjustment?\n\n' +
            `Item: ${product?.item_code} – ${product?.description}\n` +
            `Batch purchased: ${batch?.purchased_date ?? 'undated'}\n` +
            `Change: ${ADJUST_LABEL[type]}\n` +
            `Quantity: ${current} → ${result}\n` +
            `Reason: ${data.reason}`,
        };
      }
      case 'sale': {
        // Calculation by the database (same function as the web app's preview).
        const preview = await this.call<SalePreview>('tg_preview_sale', {
          p_stock_item_id: batch?.stock_item_id,
          p_quantity: data.quantity,
          p_actual_price: data.actual_price,
          p_sale_date: data.sale_date,
        });
        if (preview.insufficient_stock) {
          await this.prompt(
            { ...state, step: 'quantity' },
            `Only ${preview.stock_before} left in this batch now (stock changed). Type a smaller quantity.`,
          );
          return null;
        }
        state.pending = {
          action: 'sale',
          payload: {
            stock_item_id: batch?.stock_item_id,
            quantity: data.quantity,
            actual_price: data.actual_price,
            sale_date: data.sale_date,
          },
        };
        const alert = preview.price_alert
          ? '\n\n⚠ PRICE ALERT\n' +
            `Agreed Price: ${money(preview.agreed_price)}\n` +
            `Actual Price: ${money(preview.actual_price)}\n` +
            `Difference: ${percent(preview.price_drop_ratio)}\n\n` +
            'This sale requires attention.'
          : '';
        return {
          confirmLabel: '✅ Confirm Sale',
          text:
            'Confirm Sale\n\n' +
            `Item: ${product?.item_code} – ${product?.description}\n` +
            (batch?.is_non_stock ? '' : `Purchase Date: ${batch?.purchased_date ?? 'undated'}\n`) +
            `Sale Date: ${data.sale_date}\n` +
            `Quantity: ${preview.quantity}\n\n` +
            `Agreed Price: ${money(preview.agreed_price)}\n` +
            `Actual Price: ${money(preview.actual_price)}\n\n` +
            `Revenue: ${money(preview.revenue)}\n` +
            `Cost: ${money(preview.total_cost)}\n` +
            `Gross Profit: ${money(preview.gross_profit)}\n` +
            `Partner A share: ${money(preview.partner_a_share)}\n` +
            `Partner B share: ${money(preview.partner_b_share)}` +
            (preview.is_non_stock ? '' : `\nStock after sale: ${preview.stock_after}`) +
            alert,
        };
      }
      default:
        return null;
    }
  }

  private async confirm(state: SessionState, nonce: string): Promise<void> {
    // tg_execute validates the nonce against the stored pending action, runs the
    // operation in one transaction and refuses repeats ("already_done").
    const result = await this.call<{
      status: 'ok' | 'already_done' | 'expired';
      action?: string;
      sale_id?: string;
      stock_after?: number | null;
      quantity?: number;
      previous_quantity?: number;
      new_quantity?: number;
      price_alert?: boolean;
    }>('tg_execute', { p_nonce: nonce });

    if (result.status === 'already_done') {
      await this.reply('This was already recorded. Nothing was saved twice.');
      return;
    }
    if (result.status === 'expired') {
      await this.reply(state.flow ? MESSAGES.staleButton : MESSAGES.expired);
      return;
    }
    switch (result.action) {
      case 'sale':
        await this.reply(
          'Sale successfully recorded.\n\n' +
            `Sales ID: ${String(result.sale_id).slice(0, 8).toUpperCase()}` +
            (result.stock_after === null || result.stock_after === undefined ? '' : `\nStock remaining: ${result.stock_after}`) +
            (result.price_alert ? '\n\n⚠ Price alert recorded for administrators.' : ''),
        );
        return;
      case 'add_stock':
        await this.reply(`Stock added: ${result.quantity} unit(s). It now appears in Stock Master.`);
        return;
      case 'adjust_stock':
        await this.reply(`Stock updated: ${result.previous_quantity} → ${result.new_quantity}.`);
        return;
      default:
        await this.reply('Done.');
    }
  }
}

function pairs<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

function randomNonce(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Update handler
// ---------------------------------------------------------------------------
export async function handleUpdate(update: TgUpdate, deps: BotDeps): Promise<void> {
  const callback = update.callback_query;
  const message = update.message ?? callback?.message;
  const from = update.message?.from ?? callback?.from;
  const chat = message?.chat;
  if (!from || !chat) return;

  if (callback) {
    await deps.tg.answerCallback(callback.id);
    if (callback.message) await deps.tg.clearButtons(chat.id, callback.message.message_id);
  }

  // Telegram retries deliveries: process each update once.
  const claim = await deps.db.rpc<boolean>('tg_claim_update', { p_update_id: update.update_id, p_telegram_user_id: from.id });
  if (claim.error) {
    console.error('tg_claim_update failed', claim.error.code);
    await deps.tg.sendMessage(chat.id, MESSAGES.generic);
    return;
  }
  if (claim.data === false) return;

  if (chat.type !== 'private') {
    await deps.tg.sendMessage(chat.id, MESSAGES.privateOnly);
    return;
  }

  const conversation = new Conversation(deps, from, chat.id);
  try {
    if (callback?.data) await conversation.onCallback(callback.data);
    else if (update.message?.text) await conversation.onText(update.message.text);
  } catch (error) {
    if (!(error instanceof BotError)) console.error('telegram bot error', error instanceof Error ? error.message : error);
    await conversation.reply(friendlyError(error));
  }
}
