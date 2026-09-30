import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthProvider';
import { PRIMARY_TABS } from '../lib/navigation';

export function Layout() {
  const { state, isAdmin, signOut } = useAuth();
  const access = state.status === 'ready' ? state.access : null;

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="brand">Workshop Stock &amp; Sales</div>
        <div className="user-menu">
          {isAdmin && (
            <NavLink to="/admin" className={({ isActive }) => `btn btn-small${isActive ? ' btn-primary' : ''}`}>
              Admin
            </NavLink>
          )}
          {access && (
            <span className="user-identity" title={access.email}>
              {access.display_name ?? access.email}
              <span className={`badge badge-${access.role === 'admin' ? 'info' : 'muted'}`}>{access.role}</span>
            </span>
          )}
          <button type="button" className="btn btn-small" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <nav className="tabs" aria-label="Main">
        {PRIMARY_TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={({ isActive }) => `tab${isActive ? ' tab-active' : ''}`}>
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <main id="main" className="content" tabIndex={-1}>
        <Suspense fallback={<p role="status">Loading…</p>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
