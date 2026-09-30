import { supabase } from '../lib/supabase';
import type { PartnerRule, RuleType } from '../types/database';
import { nullIfBlank, run } from './api';

const RULE_COLUMNS =
  'id,category_id,rule_type,partner_b_rate,partner_a_rate,partner_a_rate_is_leftover,notes,' +
  'effective_from,effective_to,is_active,updated_at,product_categories(name)';

export function listRules(): Promise<PartnerRule[]> {
  return run(
    supabase.from('partner_rules').select(RULE_COLUMNS).order('effective_from', { ascending: false }),
    'Unable to load partner rules.',
  );
}

export interface RuleInput {
  category_id: string;
  rule_type: RuleType;
  partner_b_rate: number;
  partner_a_rate: number | null; // null = LEFTOVER
  notes: string;
  effective_from: string;
  effective_to: string;
  is_active: boolean;
}

function toRow(input: RuleInput) {
  const shared = input.rule_type === 'Shared_50';
  return {
    category_id: input.category_id,
    rule_type: input.rule_type,
    partner_b_rate: shared ? 0.5 : input.partner_b_rate,
    partner_a_rate: shared ? 0.5 : input.partner_a_rate,
    partner_a_rate_is_leftover: shared ? false : input.partner_a_rate === null,
    notes: nullIfBlank(input.notes),
    effective_from: input.effective_from,
    effective_to: nullIfBlank(input.effective_to),
    is_active: input.is_active,
  };
}

export function saveRule(id: string | null, input: RuleInput): Promise<null> {
  const row = toRow(input);
  return run(
    id ? supabase.from('partner_rules').update(row).eq('id', id) : supabase.from('partner_rules').insert(row),
    'Unable to save the partner rule.',
  );
}

export function deleteRule(id: string): Promise<null> {
  return run(supabase.from('partner_rules').delete().eq('id', id), 'Unable to delete the partner rule.');
}
