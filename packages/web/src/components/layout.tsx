import { Link, Outlet } from "react-router-dom";
import { WalletButton } from "./wallet-button";

export function Layout() {
  return (
    <div>
      <header>
        <nav>
          <Link to="/">kticket</Link>
          <Link to="/events">Events</Link>
          <Link to="/create">Create Event</Link>
          <WalletButton />
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
