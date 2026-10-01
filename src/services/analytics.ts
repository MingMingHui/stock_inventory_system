import { supabase } from '../lib/supabase';
import type { CategoryAnalytics, ItemAnalytics, MonthlyAnalytics } from '../types/database';
import { run } from './api';

// All aggregation happens in PostgreSQL (see docs/sales-analytics.md); these
// calls return a handful of summary rows, never raw sales.

export function analyticsMonthly(fromMonth: string, toMonth: string): Promise<MonthlyAnalytics[]> {
  return run(
    supabase.rpc('analytics_monthly', { p_from_month: fromMonth, p_to_month: toMonth }),
    'Unable to load monthly sales.',
  );
}

export function analyticsCategories(from: string, to: string): Promise<CategoryAnalytics[]> {
  return run(supabase.rpc('analytics_categories', { p_from: from, p_to: to }), 'Unable to load category sales.');
}

export function analyticsItems(asOf: string, months: number, recentMonths: number): Promise<ItemAnalytics[]> {
  return run(
    supabase.rpc('analytics_items', { p_as_of: asOf, p_months: months, p_recent_months: recentMonths }),
    'Unable to load item analysis.',
  );
}
