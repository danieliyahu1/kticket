import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchAllListings, ServerError, type ListingSummary } from "../api/client";
import { executePurchase, type ResaleState } from "../api/resale-machine";
import { Empty, OfflineEmpty } from "../components/empty";
import { useWallet } from "../hooks/use-wallet";
import { priceLabel, shortAddress, whenLabel } from "../lib/format";

function MarketplaceCard({
  listing,
  onSold,
}: {
  listing: ListingSummary;
  onSold: () => void;
}) {
  const { state, connect } = useWallet();
  const [buy, setBuy] = useState<ResaleState>({ phase: "idle" });
  const connected = state.status === "connected";
  const busy = buy.phase === "loading" || buy.phase === "building" || buy.phase === "broadcasting";
  const mine = connected && state.publicKey.slice(-64) === listing.seller_pkh;

  const handleBuy = useCallback(async () => {
    if (state.status !== "connected" || !state.accounts[0]) return;
    await executePurchase(setBuy, {
      ticketId: listing.ticket_id,
      publicKey: state.publicKey,
      address: state.accounts[0],
    });
    onSold();
  }, [state, listing.ticket_id, onSold]);

  return (
    <div className="ticket">
      <div className="ticket-main">
        <h3 className="ticket-name">
          <Link to={`/events/${listing.covenant_id}`}>{listing.event_name}</Link>
        </h3>
        <p className="ticket-line">{whenLabel(listing.event_date)}</p>
        <p className="ticket-line">
          Seller <span className="mono">{shortAddress(listing.seller_pkh)}</span>
        </p>

        {buy.phase === "error" ? (
          <div className="checkin-error" role="alert">
            <p>{buy.message}</p>
            <button
              type="button"
              className="button button-link button-sm"
              onClick={() => setBuy({ phase: "idle" })}
            >
              Try again
            </button>
          </div>
        ) : busy ? (
          <div className="checkin-status" role="status">
            <div className="spinner spinner-sm" />
            <span>
              {buy.phase === "building"
                ? "Confirming in your wallet…"
                : "Putting it on the chain…"}
            </span>
          </div>
        ) : buy.phase === "success" ? (
          <p className="checkin-copy" role="status">
            It's yours — find it under My tickets.
          </p>
        ) : null}
      </div>
      <div className="ticket-perforation" />
      <div className="ticket-stub">
        {mine ? (
          <span className="stub-value">Your listing</span>
        ) : buy.phase === "success" || busy ? null : !connected ? (
          <button type="button" className="button button-primary button-sm" onClick={connect}>
            Connect to buy
          </button>
        ) : (
          <button
            type="button"
            className="button button-primary button-sm"
            onClick={handleBuy}
            disabled={busy}
          >
            Buy · {priceLabel(listing.price)}
          </button>
        )}
      </div>
    </div>
  );
}

export default function MarketplacePage() {
  const [listings, setListings] = useState<ListingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const load = useCallback(async () => {
    setOffline(false);
    setLoading(true);
    try {
      setListings(await fetchAllListings());
    } catch (err) {
      console.error("[marketplace] failed to load", err);
      if (err instanceof ServerError) {
        setOffline(true);
      } else {
        setListings([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, retryKey]);

  return (
    <div>
      {loading ? (
        <div className="event-list">
          <p className="note" role="status">
            Loading tickets on sale…
          </p>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton skeleton-row" aria-hidden="true" />
          ))}
        </div>
      ) : offline ? (
        <OfflineEmpty onRetry={() => setRetryKey((k) => k + 1)} />
      ) : listings.length === 0 ? (
        <Empty
          title="No tickets on sale."
          sub="Check back soon, or list one of your own."
          actionLabel="Browse events"
          actionTo="/"
        />
      ) : (
        <div className="ticket-group-list">
          {listings.map((listing) => (
            <MarketplaceCard key={listing.ticket_id} listing={listing} onSold={load} />
          ))}
        </div>
      )}
    </div>
  );
}
