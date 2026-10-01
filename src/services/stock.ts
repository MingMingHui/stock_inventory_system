import { ilikeAny } from '../lib/search';
import { supabase } from '../lib/supabase';
import type { StockAdjustment, StockAdjustmentType, StockItem, StockStatus } from '../types/database';
import { type Page, type PageRequest, nullIfBlank, pageBounds, run, runPage } from './api';

export const STOCK_COLUMNS =
  'id,product_id,item_code,description,brand,unit,is_non_stock,category_id,category_name,purchased_date,' +
  'unit_cost,agreed_price,quantity,min_quantity,effective_min_quantity,status,is_obsolete,obsolete_at,' +
  'last_checked_at,notes,legacy_ref,created_at,updated_at,obsolete_remarks,fifo_rank,active_batch_count';

export type StockSort = 'item_code' | 'description' | 'category_name' | 'quantity' | 'agreed_price' | 'status' | 'updated_at';

export interface StockFilters {
  search: string;
  status: StockStatus | '';
  categoryId: string;
  includeObsolete: boolean;
}

export function listStock(filters: StockFilters, req: PageRequest<StockSort>): Promise<Page<StockItem>> {
  const { from, to } = pageBounds(req.page, req.pageSize);
  let query = supabase.from('stock_items_view').select(STOCK_COLUMNS, { count: 'exact' });
  const or = ilikeAny(['item_code', 'description', 'brand'], filters.search);
  if (or) query = query.or(or);
  if (filters.status) query = query.eq('status', filters.status);
  else if (!filters.includeObsolete) query = query.eq('is_obsolete', false);
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId);
  return runPage(
    query
      .order(req.sort.column, { ascending: req.sort.ascending })
      // Duplicated items: earliest purchase first (FIFO), undated batches last.
      .order('purchased_date', { ascending: true, nullsFirst: false })
      .order('id')
      .range(from, to),
    'Unable to load stock.',
  );
}

/** Sellable stock for the sale form (server-side search, small result set), FIFO within each item. */
export function searchSellableStock(term: string): Promise<StockItem[]> {
  let query = supabase.from('stock_items_view').select(STOCK_COLUMNS).eq('is_obsolete', false);
  const or = ilikeAny(['item_code', 'description', 'brand', 'category_name'], term);
  if (or) query = query.or(or);
  return run(
    query
      .order('item_code')
      .order('description')
      .order('brand', { nullsFirst: true })
      .order('fifo_rank', { ascending: true })
      .limit(20),
    'Unable to search stock.',
  );
}

export interface NewStockInput {
  categoryId: string;
  itemCode: string;
  description: string;
  brand: string;
  unit: string;
  isNonStock: boolean;
  purchasedDate: string;
  unitCost: number;
  agreedPrice: number;
  quantity: number;
  minQuantity: number | null;
  notes: string;
}

export function addStockItem(input: NewStockInput): Promise<string> {
  return run(
    supabase.rpc('add_stock_item', {
      p_category_id: input.categoryId,
      p_item_code: input.itemCode,
      p_description: input.description,
      p_brand: nullIfBlank(input.brand),
      p_unit: nullIfBlank(input.unit),
      p_is_non_stock: input.isNonStock,
      p_purchased_date: nullIfBlank(input.purchasedDate),
      p_unit_cost: input.unitCost,
      p_agreed_price: input.agreedPrice,
      p_quantity: input.isNonStock ? 0 : input.quantity,
      p_min_quantity: input.minQuantity,
      p_notes: nullIfBlank(input.notes),
    }),
    'Unable to add the stock item.',
  );
}

export function adjustStock(
  stockItemId: string,
  type: Extract<StockAdjustmentType, 'receive' | 'stock_check' | 'amendment'>,
  quantity: number,
  reason: string,
  expectedQuantity: number,
): Promise<StockAdjustment> {
  return run(
    supabase.rpc('adjust_stock', {
      p_stock_item_id: stockItemId,
      p_type: type,
      p_quantity: quantity,
      p_reason: reason,
      p_expected_quantity: expectedQuantity,
    }),
    'Unable to save stock quantity. Please try again.',
  );
}

export function setMinQuantity(stockItemId: string, minQuantity: number | null): Promise<null> {
  return run(
    supabase.rpc('set_stock_min_quantity', { p_stock_item_id: stockItemId, p_min_quantity: minQuantity }),
    'Unable to save the minimum quantity.',
  );
}

export function setObsolete(stockItemId: string, isObsolete: boolean): Promise<null> {
  return run(
    supabase.rpc('set_stock_obsolete', { p_stock_item_id: stockItemId, p_is_obsolete: isObsolete }),
    'Unable to change the obsolete status.',
  );
}

export interface StockDetailsInput {
  purchasedDate: string;
  unitCost: number;
  agreedPrice: number;
  notes: string;
}

/** Admin only (enforced by RLS + column grants). */
export function updateStockDetails(stockItemId: string, input: StockDetailsInput): Promise<null> {
  return run(
    supabase
      .from('stock_items')
      .update({
        purchased_date: nullIfBlank(input.purchasedDate),
        unit_cost: input.unitCost,
        agreed_price: input.agreedPrice,
        notes: nullIfBlank(input.notes),
      })
      .eq('id', stockItemId),
    'Unable to save the stock details.',
  );
}

export function listAdjustments(stockItemId: string): Promise<StockAdjustment[]> {
  return run(
    supabase
      .from('stock_adjustments')
      .select('id,stock_item_id,adjustment_type,previous_quantity,new_quantity,quantity_change,reason,created_by_label,created_at')
      .eq('stock_item_id', stockItemId)
      .order('created_at', { ascending: false })
      .limit(100),
    'Unable to load the stock history.',
  );
}
