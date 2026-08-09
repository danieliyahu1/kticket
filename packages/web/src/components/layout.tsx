import { NavLink, Outlet } from "react-router-dom";
import { network } from "../network";
import { HeaderActions } from "./header-actions";

export function Layout() {
  return (
    <div className="app">
      <header className="header">
        <div className="container header-inner">
          <div className="header-left">
            <NavLink to="/" className="wordmark">
              kticket
            </NavLink>
            <NavLink to="/tickets" className="sub-nav">
              Tickets
            </NavLink>
          </div>
          <HeaderActions />
        </div>
      </header>
      <main className="page">
        <div className="container">
          <Outlet />
        </div>
      </main>
      <footer className="footer">
        <div className="container footer-inner">
          <span>Tickets on the chain.</span>
          <span>On {network.label}</span>
        </div>
      </footer>
    </div>
  );
}
