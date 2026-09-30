import { supabase } from '../lib/supabase';
import type {
  CategorySummary,
  DashboardStats,
  ExpenseCategory,
  MonthlySettlement,
  OperatingExpense,
  SettlementSummary,
} from '../types/database';
import { nullIfBlank, run } from './api';

export async function dashboardStats(from: string, to: string): Promise<DashboardStats | null> {
  const rows = await run<DashboardStats[]>(
    supabase.rpc('dashboard_stats', { p_from: from, p_to: to }),
    'Unable to load the summary figures.',
  );
  return rows[0] ?? null;
}

export function partnerSummaryByCategory(
  from: string,
  to: string,
  categoryId: string,
  productId: string,
): Promise<CategorySummary[]> {
  return run(
    supabase.rpc('partner_summary_by_category', {
      p_from: from,
      p_to: to,
      p_category_id: categoryId || null,
      p_product_id: productId || null,
    }),
    'Unable to load the partner summary.',
  );
}

export function settlementSummary(from: string, to: string): Promise<SettlementSummary[]> {
  return run(
    supabase.rpc('settlement_summary', { p_from: from, p_to: to }),
    'Unable to load the monthly settlement.',
  );
}

export function listExpenses(fromMonth: string, toMonth: string): Promise<OperatingExpense[]> {
  return run(
    supabase
      .from('operating_expenses')
      .select(
        'id,period_month,expense_category_id,partner_id,base_amount,share_ratio,amount,description,' +
          'expense_categories(name),partners(name,code)',
      )
      .gte('period_month', fromMonth)
      .lte('period_month', toMonth)
      .order('period_month')
      .order('created_at'),
    'Unable to load expenses.',
  );
}

export interface ExpenseInput {
  periodMonth: string; // YYYY-MM-01
  expenseCategoryId: string;
  partnerId: string;
  /** Variable bill (e.g. electricity) — the database computes amount = bill x share ratio. */
  baseAmount: number | null;
  shareRatio: number | null;
  /** Fixed amount (used when there is no bill/ratio). Negative deducts from the partner. */
  amount: number | null;
  description: string;
}

export function saveExpense(id: string | null, input: ExpenseInput): Promise<null> {
  const usesBill = input.baseAmount !== null && input.shareRatio !== null;
  const row = {
    period_month: input.periodMonth,
    expense_category_id: input.expenseCategoryId,
    partner_id: input.partnerId,
    base_amount: usesBill ? input.baseAmount : null,
    share_ratio: usesBill ? input.shareRatio : null,
    // Placeholder satisfies NOT NULL; the database trigger replaces it with bill x ratio.
    amount: usesBill ? 1 : input.amount,
    description: nullIfBlank(input.description),
  };
  return run(
    id ? supabase.from('operating_expenses').update(row).eq('id', id) : supabase.from('operating_expenses').insert(row),
    'Unable to save the expense.',
  );
}

export function deleteExpense(id: string): Promise<null> {
  return run(supabase.from('operating_expenses').delete().eq('id', id), 'Unable to delete the expense.');
}

export function listExpenseCategories(): Promise<ExpenseCategory[]> {
  return run(
    supabase
      .from('expense_categories')
      .select('id,name,description,default_partner_id,default_amount,default_share_ratio,is_recurring,is_active,sort_order')
      .order('sort_order')
      .order('name'),
    'Unable to load expense categories.',
  );
}

export interface ExpenseCategoryInput {
  name: string;
  description: string;
  defaultPartnerId: string;
  defaultAmount: number | null;
  defaultShareRatio: number | null;
  isRecurring: boolean;
  isActive: boolean;
  sortOrder: number;
}

export function saveExpenseCategory(id: string | null, input: ExpenseCategoryInput): Promise<null> {
  const row = {
    name: input.name.trim(),
    description: nullIfBlank(input.description),
    default_partner_id: input.defaultPartnerId || null,
    default_amount: input.defaultAmount,
    default_share_ratio: input.defaultShareRatio,
    is_recurring: input.isRecurring,
    is_active: input.isActive,
    sort_order: input.sortOrder,
  };
  return run(
    id ? supabase.from('expense_categories').update(row).eq('id', id) : supabase.from('expense_categories').insert(row),
    'Unable to save the expense category.',
  );
}

export function applyRecurringExpenses(periodMonth: string): Promise<number> {
  return run(supabase.rpc('apply_recurring_expenses', { p_period_month: periodMonth }), 'Unable to add recurring items.');
}

export function finalizeSettlement(periodMonth: string, notes: string): Promise<MonthlySettlement> {
  return run(
    supabase.rpc('finalize_settlement', { p_period_month: periodMonth, p_notes: nullIfBlank(notes) }),
    'Unable to finalize the settlement.',
  );
}

export function reopenSettlement(periodMonth: string, reason: string): Promise<null> {
  return run(
    supabase.rpc('reopen_settlement', { p_period_month: periodMonth, p_reason: reason }),
    'Unable to reopen the settlement.',
  );
}
