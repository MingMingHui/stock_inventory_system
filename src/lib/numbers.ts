// Form-input validation. The database re-validates everything; these checks
// only give users immediate, friendly feedback.

/** Parse a form value: null for blank, NaN for invalid. */
export function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

export function isWholeNumber(value: number | null, { min = 0 }: { min?: number } = {}): value is number {
  return value !== null && Number.isInteger(value) && value >= min;
}

/** Money with at most 2 decimals, zero or more. */
export function isMoney(value: number | null, { allowNegative = false } = {}): value is number {
  if (value === null || Number.isNaN(value)) return false;
  if (!allowNegative && value < 0) return false;
  return Math.abs(value) <= 1_000_000 && /^-?\d+(\.\d{1,2})?$/.test(String(value));
}
