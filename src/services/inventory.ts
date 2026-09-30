import { ilikeAny } from '../lib/search';
import { supabase } from '../lib/supabase';
import type { InventoryItem, InventoryStatus } from '../types/database';
import { type Page, type PageRequest, nullIfBlank, pageBounds, run, runPage } from './api';

export type InventorySort = 'name' | 'category' | 'quantity' | 'status' | 'updated_at';

export function listInventory(search: string, req: PageRequest<InventorySort>): Promise<Page<InventoryItem>> {
  const { from, to } = pageBounds(req.page, req.pageSize);
  let query = supabase
    .from('inventory_items')
    .select('id,name,brand,category,quantity,status,notes,updated_at', { count: 'exact' });
  const or = ilikeAny(['name', 'brand', 'category'], search);
  if (or) query = query.or(or);
  return runPage(
    query.order(req.sort.column, { ascending: req.sort.ascending }).order('id').range(from, to),
    'Unable to load the inventory list.',
  );
}

export interface InventoryInput {
  name: string;
  brand: string;
  category: string;
  quantity: number;
  status: InventoryStatus;
  notes: string;
}

export function saveInventoryItem(id: string | null, input: InventoryInput): Promise<null> {
  const row = {
    name: input.name.trim(),
    brand: nullIfBlank(input.brand),
    category: nullIfBlank(input.category),
    quantity: input.quantity,
    status: input.status,
    notes: nullIfBlank(input.notes),
  };
  return run(
    id ? supabase.from('inventory_items').update(row).eq('id', id) : supabase.from('inventory_items').insert(row),
    'Unable to save the inventory item.',
  );
}

export function deleteInventoryItem(id: string): Promise<null> {
  return run(supabase.from('inventory_items').delete().eq('id', id), 'Unable to delete the inventory item.');
}
