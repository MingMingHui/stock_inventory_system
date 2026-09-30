// Builds PostgREST filters from free text safely. The search term becomes a
// value inside an `or=(...)` filter string, so characters that are syntax there
// (commas, parentheses, quotes, wildcards, backslashes) are removed. Values are
// still sent as parameters by PostgREST — this is about filter syntax, not SQL.

const FILTER_SYNTAX = /[,()"'\\%*:]/g;

export function sanitizeSearchTerm(term: string): string {
  return term.replace(FILTER_SYNTAX, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** ["item_code","description"], "tyre 175" -> "item_code.ilike.*tyre 175*,description.ilike.*tyre 175*" */
export function ilikeAny(columns: readonly string[], term: string): string | null {
  const clean = sanitizeSearchTerm(term);
  if (!clean) return null;
  return columns.map((column) => `${column}.ilike.*${clean}*`).join(',');
}
