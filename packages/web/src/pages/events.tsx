import { Link } from "react-router-dom";
import { useWallet } from "../hooks/use-wallet";

export default function EventsPage() {
  const { state } = useWallet();
  const connected = state.status === "connected";

  return (
    <section>
      <h2 className="page-heading">Events</h2>
      <div className="empty">
        <p className="empty-title">
          {connected ? "Nothing on the chain yet." : "Events live on the chain."}
        </p>
        <p className="empty-sub">
          {connected
            ? "Be the first. Put an event on Kaspa and start selling tickets."
            : "Connect your wallet to browse what's on — and put your own event on the chain."}
        </p>
        <div className="empty-actions">
          {connected ? (
            <Link to="/create" className="btn btn-primary">
              Create an event
            </Link>
          ) : (
            <Link to="/" className="btn btn-primary">
              Connect wallet
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
