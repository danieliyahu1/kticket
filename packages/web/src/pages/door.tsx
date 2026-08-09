import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchEventsList, type EventListItem } from "../api/client";
import { organizerPkh } from "../api/crypto";
import { useWallet } from "../hooks/use-wallet";
import { whenLabel } from "../lib/format";
import { network } from "../network";

export default function DoorPage() {
  const { state, connect } = useWallet();
  const [events, setEvents] = useState<EventListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (state.status !== "connected") {
      setEvents([]);
      setSelectedId(null);
      return;
    }
    const publicKey = state.publicKey;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const list = await fetchEventsList(organizerPkh(publicKey));
        if (!cancelled) setEvents(list);
      } catch {
        if (!cancelled) setEvents([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [state]);

  const selected = useMemo(
    () => events.find((e) => e.covenant_id === selectedId) ?? null,
    [events, selectedId],
  );

  return (
    <div data-theme="dark" className="door">
      <header className="door-header">
        <span className="door-wordmark">kticket</span>
        <span className="door-badge">Door</span>
      </header>
      <main className="door-main">
        {selected ? (
          <>
            <div className="door-status">
              <span className="door-status-dot" aria-hidden="true" />
              Scanning
            </div>
            <h1 className="door-title">{selected.name}</h1>
            <p className="door-sub">{whenLabel(selected.date)}</p>
            <div className="door-frame">Scanning for tickets</div>
            <button
              type="button"
              className="btn btn-link"
              onClick={() => setSelectedId(null)}
            >
              Choose another event
            </button>
          </>
        ) : state.status === "connected" && loading ? (
          <>
            <div className="door-status">
              <span className="door-status-dot" aria-hidden="true" />
              Loading...
            </div>
            <div className="skeleton skeleton-heading" aria-hidden="true" />
            <div className="skeleton skeleton-text" aria-hidden="true" />
          </>
        ) : state.status === "connected" && events.length > 0 ? (
          <>
            <div className="door-status">
              <span className="door-status-dot" aria-hidden="true" />
              Standing by
            </div>
            <h1 className="door-title">Choose an event</h1>
            <p className="door-sub">Select the event to scan tickets for.</p>
            <div className="door-event-list">
              {events.map((event) => (
                <button
                  key={event.covenant_id}
                  type="button"
                  className="door-event-card"
                  onClick={() => setSelectedId(event.covenant_id)}
                >
                  <span className="door-event-name">{event.name}</span>
                  <span className="door-event-date">{whenLabel(event.date)}</span>
                </button>
              ))}
            </div>
          </>
        ) : state.status === "connected" ? (
          <>
            <div className="door-status">
              <span className="door-status-dot" aria-hidden="true" />
              Standing by
            </div>
            <h1 className="door-title">No events to scan.</h1>
            <p className="door-sub">Create an event first, then come back to the door.</p>
            <Link to="/create" className="btn btn-primary">
              Create an event
            </Link>
          </>
        ) : state.status === "connecting" ? (
          <div className="status">
            <div className="spinner" />
            <p className="status-copy">Connecting...</p>
          </div>
        ) : (
          <>
            <div className="door-status">
              <span className="door-status-dot" aria-hidden="true" />
              Waiting
            </div>
            <h1 className="door-title">The door is locked.</h1>
            <p className="door-sub">Connect your wallet to start scanning tickets at the door.</p>
            <button type="button" className="btn btn-primary" onClick={connect}>
              Connect wallet
            </button>
          </>
        )}
      </main>
      <footer className="door-foot">On {network.label}</footer>
    </div>
  );
}
