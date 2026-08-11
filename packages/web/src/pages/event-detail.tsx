import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchEvent, type EventDetail } from "../api/client";
import { executeBuy, type BuyState } from "../api/buy-machine";
import { useWallet } from "../hooks/use-wallet";
import { capacityLabel, priceLabel, shortAddress, whenLabel } from "../lib/format";

export default function EventDetailPage() {
  const { covenantId } = useParams<{ covenantId: string }>();
  const { state, connect } = useWallet();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buy, setBuy] = useState<BuyState>({ phase: "idle" });
  const pendingBuy = useRef(false);
  const buying = buy.phase === "loading" || buy.phase === "building" || buy.phase === "broadcasting";

  const load = useCallback(async () => {
    if (!covenantId) return;
    setLoading(true);
    setError(null);
    try {
      const e = await fetchEvent(covenantId);
      setEvent(e);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      setError(msg.includes("not found") ? "Event does not exist." : "Could not load event.");
    } finally {
      setLoading(false);
    }
  }, [covenantId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (buy.phase !== "success" || !covenantId) return;
    let cancelled = false;
    fetchEvent(covenantId)
      .then((e) => {
        if (cancelled) return;
        console.log(
          `[event-detail] refreshed availability after buy: ${e.availability.sold} sold, ${e.availability.left} left`,
        );
        setEvent(e);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[event-detail] failed to refresh availability after buy", err);
      });
    return () => {
      cancelled = true;
    };
  }, [buy.phase, covenantId]);

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
    if (!event || event.availability.left === 0) {
      pendingBuy.current = false;
      return;
    }
    pendingBuy.current = false;
    handleBuy();
  }, [state.status, event, handleBuy]);

  const handleConnectThenBuy = useCallback(() => {
    pendingBuy.current = true;
    connect();
  }, [connect]);

  if (loading) {
    return (
      <section>
        <div className="skeleton skeleton-heading" aria-hidden="true" />
        <div className="skeleton skeleton-text" aria-hidden="true" />
        <div className="buy-cta">
          <div className="skeleton skeleton-btn-block" aria-hidden="true" />
        </div>
        <div className="stat-cards">
          <div className="skeleton skeleton-stat-card" aria-hidden="true" />
          <div className="skeleton skeleton-stat-card" aria-hidden="true" />
          <div className="skeleton skeleton-stat-card" aria-hidden="true" />
        </div>
      </section>
    );
  }

  if (error || !event) {
    return (
      <section>
        <p className="empty-title">{error ?? "Event not found."}</p>
        <div className="empty-actions empty-actions-start">
          <Link to="/" className="btn btn-secondary btn-sm">
            Back to events
          </Link>
        </div>
      </section>
    );
  }

  const connected = state.status === "connected";
  const soldOut = event.availability.left === 0;
  const verified = event.event.verified;

  return (
    <section>
      <Link to="/" className="btn btn-link btn-sm btn-link-clean">
        &larr; All events
      </Link>

      <h2 className="page-heading">{event.event.name}</h2>
      <p className="page-sub">{whenLabel(event.event.date, event.event.time || undefined)}</p>

      {verified ? (
        <div className="trust-anchor">
          <span className="badge badge-ok" aria-label="verified">
            Verified on-chain
          </span>
          <span className="trust-anchor-address">
            Organized by <span className="mono">{shortAddress(event.event.organizer_address)}</span>
          </span>
        </div>
      ) : (
        <div className="trust-anchor trust-anchor-unverified">
          <span className="badge badge-error">Unverified</span>
          <span className="trust-anchor-copy">
            This event could not be verified against the chain.
          </span>
        </div>
      )}

      <div className="buy-cta">
        {!verified ? (
          <button type="button" className="btn btn-primary btn-lg btn-block" disabled>
            Cannot buy — unverified event
          </button>
        ) : buy.phase === "success" ? (
          <div className="status">
            <div className="status-icon status-icon-ok">
              <span>&#10003;</span>
            </div>
            <p className="status-title">You're in. Ticket received.</p>
            <p className="status-copy">{event.event.name} &middot; {whenLabel(event.event.date, event.event.time || undefined)}</p>
            <p className="status-detail mono">TX: {buy.txid}</p>
            <div className="form-actions">
              <Link to="/tickets" className="btn btn-primary">
                View my tickets
              </Link>
              <Link to="/" className="btn btn-secondary">
                Browse events
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
        ) : buy.phase === "building" ? (
          <div className="status">
            <div className="spinner" />
            <p className="status-copy">Building transaction...</p>
          </div>
        ) : buy.phase === "broadcasting" ? (
          <div className="status">
            <div className="spinner" />
            <p className="status-copy">Sending to Kaspa...</p>
          </div>
        ) : soldOut ? (
          <button type="button" className="btn btn-primary btn-lg btn-sold-out" disabled>
            Sold out
          </button>
        ) : connected ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block"
              onClick={handleBuy}
              disabled={buying}
            >
              {buying ? "Buying ticket…" : "Buy ticket"}
            </button>
            <p className="note">
              {priceLabel(event.event.price)} per ticket. Your wallet shows the full
              change UTXO being re-sent — you're only spending the ticket price.
            </p>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            onClick={handleConnectThenBuy}
          >
            Connect wallet to buy
          </button>
        )}
      </div>

      <div className="stat-cards">
        <div className="card stat-card">
          <p className="stub-label">Price</p>
          <p className="stub-value">{priceLabel(event.event.price)}</p>
        </div>
        <div className="card stat-card">
          <p className="stub-label">Capacity</p>
          <p className="stub-value">{capacityLabel(event.event.capacity)}</p>
        </div>
        <div className="card stat-card">
          <p className="stub-label">Available</p>
          <p className="stub-value">{event.availability.left} left</p>
        </div>
      </div>
    </section>
  );
}
