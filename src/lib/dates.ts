// Calendar helpers. Dates are handled as local "YYYY-MM-DD" strings to avoid
// timezone shifts (Malaysia is UTC+8; toISOString() would move dates back).

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function today(): string {
  return toIsoDate(new Date());
}

/** "YYYY-MM" for a date (default: today). */
export function monthKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

export function isMonthKey(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** "2026-02" -> { from: "2026-02-01", to: "2026-02-28" } */
export function monthRange(key: string): { from: string; to: string } {
  if (!isMonthKey(key)) throw new Error(`Invalid month: ${key}`);
  const [y, m] = key.split('-').map(Number) as [number, number];
  const lastDay = new Date(y, m, 0).getDate();
  return { from: `${key}-01`, to: `${key}-${pad(lastDay)}` };
}

/** "2026-09" -> "September 2026" */
export function monthLabel(keyOrDate: string): string {
  const key = keyOrDate.slice(0, 7);
  if (!isMonthKey(key)) return keyOrDate;
  const [y, m] = key.split('-').map(Number) as [number, number];
  return new Date(y, m - 1, 1).toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
}

export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return monthKey(new Date(y, m - 1 + delta, 1));
}
