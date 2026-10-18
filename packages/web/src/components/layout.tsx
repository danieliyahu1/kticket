import { NavLink, Outlet } from "react-router-dom";
import { networkLabel } from "../config/runtime";
import { useRuntimeConfig } from "../config/RuntimeConfigProvider";
import { useNetworkQuiet, useNetworkSwitching } from "../hooks/use-network-switching";
import { useWallet } from "../hooks/use-wallet";
import { useWalletNotices } from "../hooks/use-wallet-notices";
import { GitHubLink } from "./github-link";
import { HeaderActions } from "./header-actions";
import { ToastViewport } from "./toast";

export function Layout() {
  const { state } = useWallet();
  const config = useRuntimeConfig();
  const switching = useNetworkSwitching();
  const quiet = useNetworkQuiet();
  useWalletNotices();
  // The banner explains steady-state drift; while an action owns the switch the
  // toast already says what is happening (KTK-172).
  const networkMismatch =
    state.status === "connected" && state.networkMismatch && !switching && !quiet;

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
          <NavLink to="/" className="app-nav-link" end>
            Events
          </NavLink>
          <NavLink to="/marketplace" className="app-nav-link">
            Marketplace
          </NavLink>
          <NavLink to="/tickets" className="app-nav-link">
            My tickets
          </NavLink>
          <NavLink to="/my-events" className="app-nav-link">
            My events
          </NavLink>
        </nav>
      </header>
      {networkMismatch && (
        <div className="network-warning" role="status">
          Your wallet&apos;s address is for a different network. kticket runs on{" "}
          {networkLabel(config)} — selling and checking in may fail.
        </div>
      )}
      <main className="app-main">
        <Outlet />
      </main>
      <footer className="app-footer">
        <p>On {networkLabel(config)}</p>
        <GitHubLink />
      </footer>
      <ToastViewport />
    </div>
  );
}
