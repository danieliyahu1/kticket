import { Link } from "react-router-dom";
import { useWallet } from "../hooks/use-wallet";
import { network } from "../network";

export default function HomePage() {
  const { state, connect } = useWallet();
  const connected = state.status === "connected";

  return (
    <section className="hero">
      <h1 className="hero-title">{connected ? "You're connected." : "Tickets on the chain."}</h1>
      <p className="hero-sub">
        {connected
          ? "Your events live on Kaspa — no accounts, no databases. Create one now, or see what's already on."
          : "Create an event, sell tickets, and let anyone in who holds one. No accounts. No databases. Just Kaspa."}
      </p>
      <div className="hero-actions">
        {connected ? (
          <>
            <Link to="/create" className="btn btn-primary btn-lg">
              Create an event
            </Link>
            <Link to="/events" className="btn btn-secondary btn-lg">
              Browse events
            </Link>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary btn-lg" onClick={connect}>
              Connect wallet
            </button>
            <Link to="/events" className="btn btn-secondary btn-lg">
              Browse events
            </Link>
          </>
        )}
      </div>
      <p className="hero-note">Live on {network.label} — connect with your Kasware wallet.</p>
    </section>
  );
}
