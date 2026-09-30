import { toAppError } from '../lib/errors';

interface Result<T> {
  data: T | null;
  error: unknown;
  count?: number | null;
}

export interface PageRequest<S extends string = string> {
  page: number; // 1-based
  pageSize: number;
  sort: { column: S; ascending: boolean };
}

export interface Page<T> {
  rows: T[];
  total: number;
}

export function pageBounds(page: number, pageSize: number): { from: number; to: number } {
  const from = Math.max(0, (page - 1) * pageSize);
  return { from, to: from + pageSize - 1 };
}

/** Await a Supabase query/RPC and return its data, or throw a user-friendly AppError. */
export async function run<T>(query: PromiseLike<Result<unknown>>, fallback: string): Promise<T> {
  let result: Result<unknown>;
  try {
    result = await query;
  } catch (error) {
    throw toAppError(error, fallback);
  }
  if (result.error) throw toAppError(result.error, fallback);
  return result.data as T;
}

/** Same as run() for queries created with { count: 'exact' } and .range(). */
export async function runPage<T>(query: PromiseLike<Result<unknown>>, fallback: string): Promise<Page<T>> {
  let result: Result<unknown>;
  try {
    result = await query;
  } catch (error) {
    throw toAppError(error, fallback);
  }
  if (result.error) throw toAppError(result.error, fallback);
  return { rows: (result.data ?? []) as T[], total: result.count ?? 0 };
}

/** Empty strings from form inputs become NULL. */
export function nullIfBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
