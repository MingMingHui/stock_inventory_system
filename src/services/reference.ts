import { supabase } from '../lib/supabase';
import type { AppSetting, Partner, ProductCategory } from '../types/database';
import { nullIfBlank, run } from './api';

export function listCategories(): Promise<ProductCategory[]> {
  return run(
    supabase.from('product_categories').select('id,name,description').order('name'),
    'Unable to load product categories.',
  );
}

export function createCategory(name: string, description: string): Promise<ProductCategory> {
  return run(
    supabase
      .from('product_categories')
      .insert({ name: name.trim(), description: nullIfBlank(description) })
      .select('id,name,description')
      .single(),
    'Unable to create the category.',
  );
}

export interface ProductOption {
  id: string;
  item_code: string;
  description: string;
  brand: string | null;
}

export function listProducts(categoryId: string): Promise<ProductOption[]> {
  let query = supabase.from('products').select('id,item_code,description,brand');
  if (categoryId) query = query.eq('category_id', categoryId);
  return run(query.order('item_code').order('description').limit(500), 'Unable to load products.');
}

export function listPartners(): Promise<Partner[]> {
  return run(
    supabase.from('partners').select('id,code,name,short_code,description').order('code'),
    'Unable to load partners.',
  );
}

export function listSettings(): Promise<AppSetting[]> {
  return run(
    supabase.from('app_settings').select('key,value,value_type,description,updated_at').order('key'),
    'Unable to load settings.',
  );
}

export function updateSetting(key: string, value: string): Promise<null> {
  return run(supabase.from('app_settings').update({ value: value.trim() }).eq('key', key), 'Unable to save the setting.');
}
