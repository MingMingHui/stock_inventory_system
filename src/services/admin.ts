import { ilikeAny } from '../lib/search';
import { supabase } from '../lib/supabase';
import type { AppRole, AuditLog, AuthorizedUser } from '../types/database';
import { type Page, nullIfBlank, pageBounds, run, runPage } from './api';

export function listUsers(): Promise<AuthorizedUser[]> {
  return run(
    supabase.from('authorized_users').select('id,email,display_name,role,is_active,updated_at').order('email'),
    'Unable to load users.',
  );
}

export interface UserInput {
  email: string;
  displayName: string;
  role: AppRole;
  isActive: boolean;
}

export function saveUser(id: string | null, input: UserInput): Promise<null> {
  const row = {
    email: input.email.trim().toLowerCase(),
    display_name: nullIfBlank(input.displayName),
    role: input.role,
    is_active: input.isActive,
  };
  return run(
    id ? supabase.from('authorized_users').update(row).eq('id', id) : supabase.from('authorized_users').insert(row),
    'Unable to save the user.',
  );
}

export function listAuditLogs(search: string, page: number, pageSize: number): Promise<Page<AuditLog>> {
  const { from, to } = pageBounds(page, pageSize);
  let query = supabase
    .from('audit_logs')
    .select('id,table_name,record_id,action,changed_fields,old_data,new_data,actor_label,occurred_at', {
      count: 'exact',
    });
  const or = ilikeAny(['table_name', 'actor_label', 'record_id'], search);
  if (or) query = query.or(or);
  return runPage(query.order('occurred_at', { ascending: false }).range(from, to), 'Unable to load the audit log.');
}
