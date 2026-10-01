import { ilikeAny } from '../lib/search';
import { supabase } from '../lib/supabase';
import type { SalePreview, SalesLogRow } from '../types/database';
import { type Page, type PageRequest, nullIfBlank, pageBounds, run, runPage } from './api';

const SALES_COLUMNS =
  'id,sale_id,sale_date,source,is_void,seller,notes,line_no,stock_item_id,product_id,item_code,description,brand,' +
  'category_id,category_name,stock_before,quantity,stock_after,agreed_price,actual_price,unit_cost,revenue,' +
  'total_cost,gross_profit,rule_type,partner_a_rate,partner_a_rate_is_leftover,partner_b_rate,partner_a_share,' +
  'partner_b_share,price_drop_ratio,price_alert,legacy_ref,created_at,void_reason,voided_at,voided_by_label';

export type SalesSort = 'sale_date' | 'item_code' | 'category_name' | 'revenue' | 'gross_profit' | 'created_at';

export interface SalesFilters {
  from: string;
  to: string;
  search: string;
  categoryId: string;
  priceAlertOnly: boolean;
  includeVoid: boolean;
}

export function listSales(filters: SalesFilters, req: PageRequest<SalesSort>): Promise<Page<SalesLogRow>> {
  const { from, to } = pageBounds(req.page, req.pageSize);
  let query = supabase
    .from('sales_log_view')
    .select(SALES_COLUMNS, { count: 'exact' })
    .gte('sale_date', filters.from)
    .lte('sale_date', filters.to);
  const or = ilikeAny(['item_code', 'description', 'brand', 'seller'], filters.search);
  if (or) query = query.or(or);
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId);
  if (filters.priceAlertOnly) query = query.eq('price_alert', true);
  if (!filters.includeVoid) query = query.eq('is_void', false);
  return runPage(
    query
      .order(req.sort.column, { ascending: req.sort.ascending })
      .order('created_at', { ascending: false })
      .order('line_no')
      .range(from, to),
    'Unable to load the sales log.',
  );
}

export async function previewSaleLine(
  stockItemId: string,
  quantity: number,
  actualPrice: number,
  saleDate: string,
): Promise<SalePreview> {
  const rows = await run<SalePreview[]>(
    supabase.rpc('preview_sale_line', {
      p_stock_item_id: stockItemId,
      p_quantity: quantity,
      p_actual_price: actualPrice,
      p_sale_date: saleDate,
    }),
    'Unable to calculate this sale.',
  );
  const first = rows[0];
  if (!first) throw new Error('Preview returned no rows');
  return first;
}

export interface SaleLineInput {
  stockItemId: string;
  quantity: number;
  actualPrice: number;
}

/** Agreed price, cost and partner rates are read by the database — never sent from here. */
export function createSale(saleDate: string, lines: SaleLineInput[], notes: string): Promise<string> {
  return run(
    supabase.rpc('create_sale', {
      p_sale_date: saleDate,
      p_items: lines.map((l) => ({ stock_item_id: l.stockItemId, quantity: l.quantity, actual_price: l.actualPrice })),
      p_notes: nullIfBlank(notes),
    }),
    'Unable to record the sale. Please try again.',
  );
}

export function voidSale(saleId: string, reason: string): Promise<null> {
  return run(supabase.rpc('void_sale', { p_sale_id: saleId, p_reason: reason }), 'Unable to void the sale.');
}

/** Voids one sale line only (admin). Stock for that line is returned in the same transaction. */
export function voidSaleItem(saleItemId: string, reason: string): Promise<null> {
  return run(
    supabase.rpc('void_sale_item', { p_sale_item_id: saleItemId, p_reason: reason }),
    'Unable to void the sale line.',
  );
}
