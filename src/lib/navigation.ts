/** The five primary tabs, in order. The admin area is a separate link for admins only. */
export const PRIMARY_TABS = [
  { to: '/partner-rules', label: 'Partner Rule Table' },
  { to: '/inventory', label: 'Kali Inventory List' },
  { to: '/stock', label: 'Stock Master' },
  { to: '/sales', label: 'Sales Log' },
  { to: '/partner-summary', label: 'Partner Summary' },
] as const;
