// Row types for the tables, views and functions in supabase/migrations.
// PostgREST returns PostgreSQL numeric values as JSON numbers; money is always
// calculated and rounded in the database — the UI only displays it.

export type AppRole = 'admin' | 'user';
export type RuleType = 'Fixed_Per_Unit' | 'Fixed_Per_Job' | 'Fixed_Per_Service' | 'Shared_50';
export type StockStatus = 'ACTIVE' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'OBSOLETE';
export type StockAdjustmentType = 'initial' | 'receive' | 'stock_check' | 'amendment' | 'sale' | 'sale_void';
export type InventoryStatus = 'ACTIVE' | 'UNDER_REPAIR' | 'INACTIVE' | 'DISPOSED';
export type SaleSource = 'app' | 'excel_import';

export const RULE_TYPES: readonly RuleType[] = ['Fixed_Per_Unit', 'Fixed_Per_Job', 'Fixed_Per_Service', 'Shared_50'];
export const STOCK_STATUSES: readonly StockStatus[] = ['ACTIVE', 'LOW_STOCK', 'OUT_OF_STOCK', 'OBSOLETE'];
export const INVENTORY_STATUSES: readonly InventoryStatus[] = ['ACTIVE', 'UNDER_REPAIR', 'INACTIVE', 'DISPOSED'];

export interface MyAccess {
  email: string;
  display_name: string | null;
  role: AppRole;
}

export interface Partner {
  id: string;
  code: 'A' | 'B';
  name: string;
  short_code: string;
  description: string | null;
}

export interface ProductCategory {
  id: string;
  name: string;
  description: string | null;
}

export interface PartnerRule {
  id: string;
  category_id: string;
  rule_type: RuleType;
  partner_b_rate: number;
  partner_a_rate: number | null;
  partner_a_rate_is_leftover: boolean;
  notes: string | null;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  updated_at: string;
  product_categories?: { name: string } | null;
}

export interface StockItem {
  id: string;
  product_id: string;
  item_code: string;
  description: string;
  brand: string | null;
  unit: string | null;
  is_non_stock: boolean;
  category_id: string;
  category_name: string;
  purchased_date: string | null;
  unit_cost: number;
  agreed_price: number;
  quantity: number;
  min_quantity: number | null;
  effective_min_quantity: number;
  status: StockStatus;
  is_obsolete: boolean;
  obsolete_at: string | null;
  last_checked_at: string | null;
  notes: string | null;
  legacy_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface StockAdjustment {
  id: string;
  stock_item_id: string;
  adjustment_type: StockAdjustmentType;
  previous_quantity: number;
  new_quantity: number;
  quantity_change: number;
  reason: string;
  created_by_label: string;
  created_at: string;
}

export interface InventoryItem {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  quantity: number;
  status: InventoryStatus;
  notes: string | null;
  updated_at: string;
}

export interface SalesLogRow {
  id: string;
  sale_id: string;
  sale_date: string;
  source: SaleSource;
  is_void: boolean;
  seller: string;
  notes: string | null;
  line_no: number;
  stock_item_id: string | null;
  product_id: string;
  item_code: string;
  description: string;
  brand: string | null;
  category_id: string;
  category_name: string;
  stock_before: number | null;
  quantity: number;
  stock_after: number | null;
  agreed_price: number;
  actual_price: number;
  unit_cost: number;
  revenue: number;
  total_cost: number;
  gross_profit: number;
  rule_type: RuleType;
  partner_a_rate: number | null;
  partner_a_rate_is_leftover: boolean;
  partner_b_rate: number;
  partner_a_share: number;
  partner_b_share: number;
  price_drop_ratio: number | null;
  price_alert: boolean;
  legacy_ref: string | null;
  created_at: string;
}

export interface SalePreview {
  stock_item_id: string;
  category_name: string;
  stock_before: number | null;
  stock_after: number | null;
  is_non_stock: boolean;
  agreed_price: number;
  actual_price: number;
  unit_cost: number;
  quantity: number;
  revenue: number;
  total_cost: number;
  gross_profit: number;
  rule_type: RuleType;
  partner_a_rate: number | null;
  partner_a_rate_is_leftover: boolean;
  partner_b_rate: number;
  partner_a_share: number;
  partner_b_share: number;
  price_drop_ratio: number | null;
  price_alert: boolean;
  price_alert_threshold: number;
  insufficient_stock: boolean;
}

export interface CategorySummary {
  category_id: string;
  category_name: string;
  line_count: number;
  quantity: number;
  revenue: number;
  total_cost: number;
  gross_profit: number;
  partner_a_share: number;
  partner_b_share: number;
}

export interface SettlementSummary {
  period_month: string;
  sale_line_count: number;
  total_revenue: number;
  total_cost: number;
  gross_profit: number;
  partner_a_share: number;
  partner_b_share: number;
  partner_a_adjustments: number;
  partner_b_adjustments: number;
  partner_a_payable: number;
  partner_b_payable: number;
  is_finalized: boolean;
}

export interface DashboardStats {
  sale_line_count: number;
  total_quantity: number;
  total_revenue: number;
  gross_profit: number;
  partner_a_share: number;
  partner_b_share: number;
  price_alert_count: number;
  low_stock_count: number;
  out_of_stock_count: number;
  obsolete_count: number;
}

export interface ExpenseCategory {
  id: string;
  name: string;
  description: string | null;
  default_partner_id: string | null;
  default_amount: number | null;
  default_share_ratio: number | null;
  is_recurring: boolean;
  is_active: boolean;
  sort_order: number;
}

export interface OperatingExpense {
  id: string;
  period_month: string;
  expense_category_id: string;
  partner_id: string;
  base_amount: number | null;
  share_ratio: number | null;
  amount: number;
  description: string | null;
  expense_categories?: { name: string } | null;
  partners?: { name: string; code: string } | null;
}

export interface MonthlySettlement {
  id: string;
  period_month: string;
  partner_a_payable: number;
  partner_b_payable: number;
  finalized_at: string;
  finalized_by_label: string;
  notes: string | null;
}

export interface AuthorizedUser {
  id: string;
  email: string;
  display_name: string | null;
  role: AppRole;
  is_active: boolean;
  updated_at: string;
}

export interface AppSetting {
  key: string;
  value: string;
  value_type: 'integer' | 'numeric' | 'boolean';
  description: string;
  updated_at: string;
}

export interface AuditLog {
  id: number;
  table_name: string;
  record_id: string | null;
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  changed_fields: string[] | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  actor_label: string;
  occurred_at: string;
}
