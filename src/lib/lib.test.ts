import { describe, expect, it, vi } from 'vitest';
import { monthLabel, monthRange, shiftMonth, toIsoDate } from './dates';
import { AppError, toAppError, toUserMessage } from './errors';
import { describeRule, formatMoney, formatPercent, priceAlertMessage } from './format';
import { isMoney, isWholeNumber, parseNumber } from './numbers';
import { ilikeAny, sanitizeSearchTerm } from './search';

describe('toUserMessage', () => {
  const fallback = 'Unable to save stock quantity. Please try again.';

  it('shows our own validation messages from the database', () => {
    expect(toUserMessage({ code: '23514', message: 'Line 1: only 3 in stock' }, fallback)).toBe('Line 1: only 3 in stock.');
    expect(
      toUserMessage({ code: '40001', message: 'Stock quantity changed from 9 to 10 since it was loaded. Refresh and try again.' }, fallback),
    ).toContain('changed from 9 to 10');
  });

  it('never exposes raw constraint or relation errors', () => {
    const raw = { code: '23514', message: 'new row for relation "stock_items" violates check constraint "stock_items_check"' };
    expect(toUserMessage(raw, fallback)).toBe(fallback);
    expect(toUserMessage({ code: 'XX000', message: 'internal error at pg_foo.c' }, fallback)).toBe(fallback);
  });

  it('maps permission, duplicate, session and network errors', () => {
    expect(toUserMessage({ code: '42501', message: 'Administrator access required' }, fallback)).toBe('Only administrators can do this.');
    expect(toUserMessage({ code: '42501', message: 'new row violates row-level security policy' }, fallback)).toBe(
      'You do not have permission to do this.',
    );
    expect(toUserMessage({ code: '23505', message: 'duplicate key value' }, fallback)).toBe('That record already exists.');
    expect(toUserMessage({ code: 'PGRST301', message: 'JWT expired' }, fallback)).toBe('Your session has expired. Please sign in again.');
    expect(toUserMessage(new TypeError('Failed to fetch'), fallback)).toMatch(/Unable to reach the server/);
  });

  it('logs technical details but returns a friendly AppError', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const err = toAppError({ code: '23505', message: 'duplicate key value violates unique constraint "x"' }, fallback);
    expect(err).toBeInstanceOf(AppError);
    expect(err.userMessage).toBe('That record already exists.');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('formatting', () => {
  it('formats Malaysian ringgit with two decimals', () => {
    expect(formatMoney(1894.59)).toMatch(/RM\s?1,894\.59/);
    expect(formatMoney(null)).toBe('—');
  });

  it('builds the price alert message from the database drop ratio', () => {
    expect(priceAlertMessage(0.125)).toBe('PRICE ALERT: Actual selling price is 12.5% below agreed price.');
    expect(priceAlertMessage(0.1)).toBe('PRICE ALERT: Actual selling price is 10% below agreed price.');
    expect(priceAlertMessage(-0.2)).toBeNull();
    expect(priceAlertMessage(null)).toBeNull();
  });

  it('describes rules in plain language', () => {
    expect(describeRule('Fixed_Per_Unit', 10)).toMatch(/RM\s?10\.00 per unit/);
    expect(describeRule('Shared_50', 0.5)).toBe('50% of revenue');
    expect(formatPercent(0.1282)).toBe('12.8%');
  });
});

describe('dates', () => {
  it('computes month ranges including February and leap years', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2028-02').to).toBe('2028-02-29');
    expect(monthRange('2026-08')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(() => monthRange('2026-13')).toThrow();
  });

  it('shifts months across years and formats local dates without timezone drift', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(toIsoDate(new Date(2026, 8, 30, 23, 59))).toBe('2026-09-30');
    expect(monthLabel('2026-09-01')).toMatch(/September 2026/);
  });
});

describe('search sanitising', () => {
  it('removes PostgREST filter syntax so input cannot add filters', () => {
    expect(sanitizeSearchTerm('tyre),quantity.gt.0,(x')).toBe('tyre quantity.gt.0 x');
    expect(sanitizeSearchTerm("a'b\"c%d*e\\f")).toBe('a b c d e f');
    expect(sanitizeSearchTerm('   ')).toBe('');
  });

  it('builds an ilike OR filter or nothing for blank input', () => {
    expect(ilikeAny(['item_code', 'description'], ' 175/65 ')).toBe('item_code.ilike.*175/65*,description.ilike.*175/65*');
    expect(ilikeAny(['item_code'], ',,,')).toBeNull();
  });
});

describe('number validation', () => {
  it('parses form input strictly', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('12.50')).toBe(12.5);
    expect(parseNumber('1e3')).toBeNaN();
    expect(parseNumber('12abc')).toBeNaN();
  });

  it('validates quantities and money', () => {
    expect(isWholeNumber(3)).toBe(true);
    expect(isWholeNumber(-1)).toBe(false);
    expect(isWholeNumber(0, { min: 1 })).toBe(false);
    expect(isWholeNumber(2.5)).toBe(false);
    expect(isMoney(195)).toBe(true);
    expect(isMoney(12.5)).toBe(true);
    expect(isMoney(12.345)).toBe(false);
    expect(isMoney(-100)).toBe(false);
    expect(isMoney(-100, { allowNegative: true })).toBe(true);
    expect(isMoney(Number.NaN)).toBe(false);
  });
});
