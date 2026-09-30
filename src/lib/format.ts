// Display formatting only. No financial arithmetic happens in the browser.

const money = new Intl.NumberFormat('en-MY', {
  style: 'currency',
  currency: 'MYR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const integer = new Intl.NumberFormat('en-MY', { maximumFractionDigits: 0 });

const rate = new Intl.NumberFormat('en-MY', { maximumFractionDigits: 4 });

export function formatMoney(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : money.format(value);
}

export function formatQuantity(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : integer.format(value);
}

export function formatRate(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : rate.format(value);
}

/** 0.125 -> "12.5%" */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined) return '—';
  return `${(ratio * 100).toFixed(digits).replace(/\.0+$/, '')}%`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('en-MY', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Human description of a rule's Partner B rate, e.g. "RM10.00 per unit" or "50% of revenue". */
export function describeRule(ruleType: string, partnerBRate: number): string {
  switch (ruleType) {
    case 'Fixed_Per_Unit':
      return `${formatMoney(partnerBRate)} per unit`;
    case 'Fixed_Per_Job':
      return `${formatMoney(partnerBRate)} per job`;
    case 'Fixed_Per_Service':
      return `${formatMoney(partnerBRate)} per service`;
    case 'Shared_50':
      return '50% of revenue';
    default:
      return formatRate(partnerBRate);
  }
}

export function priceAlertMessage(dropRatio: number | null | undefined): string | null {
  if (dropRatio === null || dropRatio === undefined || dropRatio <= 0) return null;
  return `PRICE ALERT: Actual selling price is ${formatPercent(dropRatio)} below agreed price.`;
}
