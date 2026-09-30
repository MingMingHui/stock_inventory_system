import { lazy, Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { AuthGate } from './features/auth/AuthGate';
import { AuthProvider } from './features/auth/AuthProvider';

// Each page is loaded on demand to keep the first download small on mobile.
const PartnerRulesPage = lazy(() => import('./features/partners/PartnerRulesPage').then((m) => ({ default: m.PartnerRulesPage })));
const InventoryPage = lazy(() => import('./features/inventory/InventoryPage').then((m) => ({ default: m.InventoryPage })));
const StockMasterPage = lazy(() => import('./features/stock/StockMasterPage').then((m) => ({ default: m.StockMasterPage })));
const SalesLogPage = lazy(() => import('./features/sales/SalesLogPage').then((m) => ({ default: m.SalesLogPage })));
const PartnerSummaryPage = lazy(() =>
  import('./features/reports/PartnerSummaryPage').then((m) => ({ default: m.PartnerSummaryPage })),
);
const AdminPage = lazy(() => import('./features/admin/AdminPage').then((m) => ({ default: m.AdminPage })));

const loading = <p role="status">Loading…</p>;

// HashRouter keeps deep links working on GitHub Pages, which cannot rewrite
// unknown paths to index.html.
export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <AuthGate>
          <HashRouter>
            <Suspense fallback={loading}>
              <Routes>
                <Route element={<Layout />}>
                  <Route index element={<Navigate to="/stock" replace />} />
                  <Route path="partner-rules" element={<PartnerRulesPage />} />
                  <Route path="inventory" element={<InventoryPage />} />
                  <Route path="stock" element={<StockMasterPage />} />
                  <Route path="sales" element={<SalesLogPage />} />
                  <Route path="partner-summary" element={<PartnerSummaryPage />} />
                  <Route path="admin" element={<AdminPage />} />
                  <Route path="*" element={<Navigate to="/stock" replace />} />
                </Route>
              </Routes>
            </Suspense>
          </HashRouter>
        </AuthGate>
      </AuthProvider>
    </ToastProvider>
  );
}
