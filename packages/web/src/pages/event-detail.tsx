import { buildEventMeta } from "@kticket/kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchEvent, fetchEventListings, ServerError, type EventDetail, type ListingSummary } from "../api/client";
import { executeBuy, type BuyState } from "../api/buy-machine";
import { executePurchase, type ResaleState } from "../api/resale-machine";
import { useDocumentMeta } from "../hooks/use-document-meta";
import { usePendingAction } from "../hooks/use-pending-action";
import { useWallet } from "../hooks/use-wallet";
import { OfflineEmpty, Empty } from "../components/empty";
import { ShareEventButton } from "../components/share-event";
import { priceLabel, shortAddress, whenLabel } from "../lib/format";

export default function EventDetailPage() {
  const { covenantId } = useParams<{ covenantId: string }>();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [buy, setBuy] = useState<BuyState>({ phase: "idle" });
  const buyFlow = usePendingAction({ onReset: () => setBuy({ phase: "idle" }) });
  const buying = buy.phase === "loading" || buy.phase === "building" || buy.phase === "broadcasting";

  const load = useCallback(async () => {
    if (!covenantId) return;
    setLoading(true);
    setEvent(null);
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

  // Align the browser's title, description, and canonical link with the event
  // that is visible right now (KTK-162). Same builder as the server shell.
  const documentMeta = useMemo(
    () => (event ? buildEventMeta(event.event, window.location.origin) : null),
    [event],
  );
  useDocumentMeta(documentMeta);

  const handleBuy = useCallback(() => {
    if (!covenantId || !event) return;
    void buyFlow.start(({ publicKey, address }) =>
      executeBuy(setBuy, {
        covenantId,
        publicKey,
        address,
        isCurrent: buyFlow.isCurrent,
      }),
    );
  }, [covenantId, event, buyFlow.start, buyFlow.isCurrent]);

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

        <ShareEventButton covenantId={event.event.covenant_id} />
      </header>

      <div className="buy-cta">
        {!verified ? (
          <button type="button" className="button button-full" disabled>
            Cannot buy
          </button>
        ) : buy.phase === "success" ? (
          <div className="status">
            <div className={buy.status === "settled" ? "status-icon status-icon-ok" : "status-icon"}>
              {buy.status === "settled" ? <span>&#10003;</span> : <div className="spinner" />}
            </div>
            <p className="status-title">
              {buy.status === "settled" ? "You're in." : "Almost there."}
            </p>
            <p className="status-copy">
              {buy.status === "settled"
                ? "Your ticket is on the chain."
                : "Your payment is broadcast; the ticket appears under My tickets as soon as the network accepts it."}
            </p>
            <div className="form-actions">
              <Link to="/tickets" className="button button-primary">
                View my tickets
              </Link>
            </div>
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
            onClick={handleBuy}
            disabled={buying || buyFlow.running}
          >
            {buying || buyFlow.running ? "Buying…" : `Buy ticket · ${priceLabel(event.event.price)} + 0.5 KAS deposit`}
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
        <div className="token-detail">
          <dt>Event id</dt>
          <dd className="token-detail-plain mono">{event.event.covenant_id}</dd>
        </div>
      </dl>

      {verified && <Listings covenantId={event.event.covenant_id} />}
    </article>
  );
}

function Listings({ covenantId }: { covenantId: string }) {
  const [listings, setListings] = useState<ListingSummary[] | null>(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    setOffline(false);
    try {
      setListings(await fetchEventListings(covenantId));
    } catch (err) {
      console.error("[listings] failed to load", err);
      if (err instanceof ServerError) setOffline(true);
      else setListings([]);
    }
  }, [covenantId]);

  useEffect(() => {
    load();
  }, [load]);

  if (offline) return null;
  if (!listings) {
    return (
      <section aria-busy="true">
        <div className="skeleton skeleton-row" aria-hidden="true" />
      </section>
    );
  }
  if (listings.length === 0) return null;

  return (
    <section>
      <h2 className="section-heading">Tickets for sale</h2>
      {listings.map((listing) => (
        <ListingRow key={listing.ticket_id} listing={listing} onSold={load} />
      ))}
    </section>
  );
}

function ListingRow({
  listing,
  onSold,
}: {
  listing: ListingSummary;
  onSold: () => void;
}) {
  const { state } = useWallet();
  const [buy, setBuy] = useState<ResaleState>({ phase: "idle" });
  const purchase = usePendingAction({ onReset: () => setBuy({ phase: "idle" }) });
  const busy = buy.phase === "loading" || buy.phase === "building" || buy.phase === "broadcasting";
  const mine =
    state.status === "connected" && state.publicKey.slice(-64) === listing.seller_pkh;

  const handleBuy = useCallback(() => {
    void purchase.start(async ({ publicKey, address }) => {
      await executePurchase(setBuy, {
        ticketId: listing.ticket_id,
        publicKey,
        address,
        isCurrent: purchase.isCurrent,
      });
      onSold();
    });
  }, [listing.ticket_id, onSold, purchase.start, purchase.isCurrent]);

  return (
    <div className="ticket">
      <div className="ticket-main">
        <p className="ticket-line">
          Seller <span className="mono">{shortAddress(listing.seller_pkh)}</span>
        </p>
        {busy ? (
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
            {buy.status === "settled"
              ? "It's yours — find it under My Tickets."
              : "The payment is on its way; the ticket appears once the network accepts it."}
          </p>
        ) : null}
      </div>
      <div className="ticket-perforation" />
      <div className="ticket-stub">
        {mine ? (
          <span className="stub-value">Your listing</span>
        ) : buy.phase === "success" || busy || purchase.running ? null : (
          <button
            type="button"
            className="button button-primary button-sm"
            onClick={handleBuy}
            disabled={busy || purchase.running}
          >
             Buy · {priceLabel(listing.price)} + 0.5 KAS deposit
          </button>
        )}
      </div>
    </div>
  );
}
