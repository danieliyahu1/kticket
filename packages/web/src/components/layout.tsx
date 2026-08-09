import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useWallet } from "../hooks/use-wallet";
import { network } from "../network";
import { HeaderActions } from "./header-actions";

function PageTransition({ children }: { children: React.ReactNode }) {
  const { key } = useLocation();
  return (
    <div className="page-transition" key={key}>
      {children}
    </div>
  );
}

export function Layout() {
  const { state } = useWallet();
  const connected = state.status === "connected";

  return (
    <div className="app">
      <header className="header">
        <div className="container header-inner">
          <div className="header-left">
            <NavLink to="/" className="wordmark">
              kticket
            </NavLink>
            {connected && (
              <NavLink to="/tickets" className="sub-nav">
                Tickets
              </NavLink>
            )}
          </div>
          <HeaderActions />
        </div>
      </header>
      <main className="page">
        <div className="container">
          <PageTransition>
            <Outlet />
          </PageTransition>
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
