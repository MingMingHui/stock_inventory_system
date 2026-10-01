/** Primary tabs, in order. `adminOnly` tabs are shown to administrators only (also enforced by the database). */
export const PRIMARY_TABS = [
  { to: '/partner-rules', label: 'Partner Rule Table', adminOnly: false },
  { to: '/inventory', label: 'Kali Inventory List', adminOnly: false },
  { to: '/stock', label: 'Stock Master', adminOnly: false },
  { to: '/sales', label: 'Sales Log', adminOnly: false },
  { to: '/partner-summary', label: 'Partner Summary', adminOnly: false },
  { to: '/sales-analytics', label: 'Sales Analytics', adminOnly: true },
] as const;
