import { NavLink, Outlet } from "react-router-dom";
import { network } from "../network";
import { WalletButton } from "./wallet-button";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? "nav-link nav-link-active" : "nav-link";

export function Layout() {
  return (
    <div className="app">
      <header className="header">
        <div className="container header-inner">
          <NavLink to="/" className="wordmark">
            kticket
          </NavLink>
          <nav className="nav">
            <NavLink to="/events" className={navLinkClass}>
              Events
            </NavLink>
            <NavLink to="/create" className={navLinkClass}>
              Create
            </NavLink>
          </nav>
          <WalletButton />
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
