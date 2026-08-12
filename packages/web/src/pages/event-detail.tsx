import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchEvent, ServerError, type EventDetail } from "../api/client";
import { executeBuy, type BuyState } from "../api/buy-machine";
import { useWallet } from "../hooks/use-wallet";
import { OfflineEmpty, Empty } from "../components/empty";
import { priceLabel, shortAddress, whenLabel } from "../lib/format";

export default function EventDetailPage() {
  const { covenantId } = useParams<{ covenantId: string }>();
  const { state, connect } = useWallet();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [buy, setBuy] = useState<BuyState>({ phase: "idle" });
  const pendingBuy = useRef(false);
  const buying = buy.phase === "loading" || buy.phase === "building" || buy.phase === "broadcasting";

  const load = useCallback(async () => {
    if (!covenantId) return;
    setLoading(true);
    setError(null);
    setOffline(false);
    try {
      const e = await fetchEvent(covenantId);
      setEvent(e);
    } catch (err) {
      if (err instanceof ServerError) {
        setOffline(true);
      } else {
        const msg = err instanceof Error ? err.message : "";
        setError(msg.includes("not found") ? "Event does not exist." : "Could not load event.");
      }
    } finally {
      setLoading(false);
    }
  }, [covenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleBuy = useCallback(async () => {
    if (!covenantId || !event || state.status !== "connected" || !state.accounts[0]) return;
    await executeBuy(setBuy, {
      covenantId,
      publicKey: state.publicKey,
      address: state.accounts[0],
    });
  }, [covenantId, event, state]);

  useEffect(() => {
    if (!pendingBuy.current) return;
    if (state.status !== "connected") return;
    pendingBuy.current = false;
    handleBuy();
  }, [state.status, handleBuy]);

  const handleConnectThenBuy = useCallback(() => {
    pendingBuy.current = true;
    connect();
  }, [connect]);

  if (loading) {
    return (
      <div>
        <div className="skeleton skeleton-title" aria-hidden="true" />
        <div className="skeleton skeleton-line" aria-hidden="true" />
        <div className="skeleton skeleton-row" aria-hidden="true" />
      </div>
    );
  }

  if (error || !event) {
    if (offline) {
      return <OfflineEmpty onRetry={load} />;
    }
    return (
      <Empty
        title={error ?? "Event not found."}
        sub="It may have been removed or isn't on this network."
        actionLabel="Back to events"
        actionTo="/"
      />
    );
  }

  const connected = state.status === "connected";
  const verified = event.event.verified;

  return (
    <article>
      <Link to="/" className="page-back">
        &larr; All events
      </Link>

      <header className="token-hero">
        <h1 className="token-name">{event.event.name}</h1>
        <p className="token-when">{whenLabel(event.event.date, event.event.time || undefined)}</p>

        {verified ? (
          <p className="token-status">
            <span className="token-status-dot" aria-hidden="true" />
            Verified on-chain
          </p>
        ) : (
          <p className="token-status token-status-pending">
            <span className="token-status-dot" aria-hidden="true" />
            Unverified
          </p>
        )}
      </header>

      <div className="buy-cta">
        {!verified ? (
          <button type="button" className="button button-full" disabled>
            Cannot buy
          </button>
        ) : buy.phase === "success" ? (
          <div className="status">
            <div className="status-icon status-icon-ok">
              <span>&#10003;</span>
            </div>
            <p className="status-title">You're in.</p>
            <p className="status-copy">Your ticket is on the chain.</p>
            <div className="form-actions">
              <Link to="/tickets" className="button button-primary">
                View my tickets
              </Link>
            </div>
          </div>
        ) : buy.phase === "error" ? (
          <div className="status">
            <div className="status-icon status-icon-error">
              <span>&#10007;</span>
            </div>
            <p className="status-title">{buy.message}</p>
            <p className="status-copy">No ticket was issued.</p>
          </div>
        ) : buy.phase === "building" || buy.phase === "broadcasting" ? (
          <div className="status">
            <div className="spinner" />
            <p className="status-copy">
              {buy.phase === "building" ? "Confirming in your wallet…" : "Putting it on the chain…"}
            </p>
          </div>
        ) : (
          <button
            type="button"
            className="button button-primary button-full"
            onClick={connected ? handleBuy : handleConnectThenBuy}
            disabled={buying}
          >
            {buying ? "Buying…" : `Buy ticket · ${priceLabel(event.event.price)}`}
          </button>
        )}
      </div>

      <dl className="token-details">
        <div className="token-detail">
          <dt>When</dt>
          <dd className="token-detail-plain">
            {whenLabel(event.event.date, event.event.time || undefined)}
          </dd>
        </div>
        <div className="token-detail">
          <dt>Price</dt>
          <dd className="token-detail-plain">{priceLabel(event.event.price)}</dd>
        </div>
        <div className="token-detail">
          <dt>Organized by</dt>
          <dd>{shortAddress(event.event.organizer_address)}</dd>
        </div>
      </dl>
    </article>
  );
}
