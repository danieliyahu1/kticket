import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchEvent, type EventDetail } from "../api/client";
import { executeBuy, type BuyState } from "../api/buy-machine";
import { useWallet } from "../hooks/use-wallet";
import { saveTicket } from "../api/ticket-store";

const WHEN_FORMAT = {
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
} as const;

function whenLabel(date: string): string {
  if (!date) return "";
  return new Intl.DateTimeFormat("en", WHEN_FORMAT).format(new Date(date));
}

function priceLabel(price: number): string {
  return price === 0 ? "Free" : `${price} KAS`;
}

function capacityLabel(capacity: number): string {
  return `${capacity} ${capacity === 1 ? "ticket" : "tickets"}`;
}

export default function EventDetailPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const { state, connect } = useWallet();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buy, setBuy] = useState<BuyState>({ phase: "idle" });

  const load = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);
    setError(null);
    try {
      const e = await fetchEvent(eventId);
      setEvent(e);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      setError(msg.includes("not found") ? "Event does not exist." : "Could not load event.");
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleBuy = useCallback(async () => {
    if (!eventId || !event || state.status !== "connected" || !state.accounts[0]) return;
    await executeBuy(setBuy, {
      eventId,
      publicKey: state.publicKey,
      address: state.accounts[0],
    });
  }, [eventId, event, state]);

  useEffect(() => {
    if (buy.phase === "success" && event) {
      saveTicket({
        ticketId: `${buy.txid.toLowerCase()}:0`,
        eventId: event.event.event_id,
        eventName: event.event.name,
        eventDate: event.event.date,
        eventTime: new Date(event.event.date).toISOString(),
        price: event.event.price,
        buyTxId: buy.txid.toLowerCase(),
        orgPkh: event.buy_info.event_owner,
        acquiredAt: Date.now(),
      });
    }
  }, [buy.phase]);

  if (loading) {
    return (
      <section>
        <div className="status">
          <div className="spinner" />
          <p className="status-copy">Loading event...</p>
        </div>
      </section>
    );
  }

  if (error || !event) {
    return (
      <section>
        <p className="empty-title">{error ?? "Event not found."}</p>
        <div className="empty-actions" style={{ justifyContent: "flex-start" }}>
          <Link to="/" className="btn btn-secondary btn-sm">
            Back to events
          </Link>
        </div>
      </section>
    );
  }

  const connected = state.status === "connected";
  const soldOut = event.availability.left === 0;

  return (
    <section>
      <Link to="/" className="btn btn-link btn-sm" style={{ paddingLeft: 0 }}>
        &larr; All events
      </Link>

      <h2 className="page-heading">{event.event.name}</h2>
      <p className="page-sub">{whenLabel(event.event.date)}</p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-4)", marginTop: "var(--space-5)" }}>
        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          <p className="stub-label">Price</p>
          <p className="stub-value">{priceLabel(event.event.price)}</p>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          <p className="stub-label">Capacity</p>
          <p className="stub-value">{capacityLabel(event.event.capacity)}</p>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 0 }}>
          <p className="stub-label">Available</p>
          <p className="stub-value">{event.availability.left} left</p>
        </div>
      </div>

      {buy.phase === "success" ? (
        <div className="status" style={{ marginTop: "var(--space-6)" }}>
          <div className="status-icon status-icon-ok">
            <span>&#10003;</span>
          </div>
          <p className="status-title">You're in. Ticket received.</p>
          <p className="status-copy">{event.event.name} &middot; {whenLabel(event.event.date)}</p>
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
        <div className="status" style={{ marginTop: "var(--space-6)" }}>
          <div className="status-icon status-icon-error">
            <span>&#10007;</span>
          </div>
          <p className="status-title">{buy.message}</p>
          <p className="status-copy">No ticket was issued.</p>
        </div>
      ) : buy.phase === "building" ? (
        <div className="status" style={{ marginTop: "var(--space-6)" }}>
          <div className="spinner" />
          <p className="status-copy">Building transaction...</p>
        </div>
      ) : buy.phase === "broadcasting" ? (
        <div className="status" style={{ marginTop: "var(--space-6)" }}>
          <div className="spinner" />
          <p className="status-copy">Sending to Kaspa...</p>
        </div>
      ) : soldOut ? (
        <div style={{ marginTop: "var(--space-6)" }}>
          <p className="status-title">Sold out.</p>
        </div>
      ) : connected ? (
        <div style={{ marginTop: "var(--space-6)" }}>
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={handleBuy}
          >
            Buy ticket
          </button>
          {event.event.price > 0 && (
            <p className="note">
              Price: {event.event.price} KAS per ticket. Payment from your wallet.
            </p>
          )}
        </div>
      ) : (
        <div style={{ marginTop: "var(--space-6)" }}>
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={connect}
          >
            Connect wallet to buy
          </button>
        </div>
      )}
    </section>
  );
}
