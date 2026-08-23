import { NavLink, Outlet } from "react-router-dom";
import { network } from "../network";
import { HeaderActions } from "./header-actions";

export function Layout() {
  return (
    <div className="app">
      <header className="app-header">
        <div className="header-top">
          <NavLink to="/" className="app-title">
            kticket
          </NavLink>
          <HeaderActions />
        </div>
        <nav className="app-nav">
          <NavLink to="/marketplace" className="app-nav-link">
            Marketplace
          </NavLink>
          <NavLink to="/" className="app-nav-link" end>
            Events
          </NavLink>
          <NavLink to="/tickets" className="app-nav-link">
            My tickets
          </NavLink>
          <NavLink to="/my-events" className="app-nav-link">
            My events
          </NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      <footer className="app-footer">
        <p>On {network.label}</p>
      </footer>
    </div>
  );
}
