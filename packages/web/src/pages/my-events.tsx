import { useEffect, useState } from "react";
import { useWallet } from "../hooks/use-wallet";
import { useAuth } from "../auth/AuthProvider";
import { fetchEventsList, ServerError, type EventListItem } from "../api/client";
import { Empty, OfflineEmpty } from "../components/empty";
import { EventCard } from "../components/event-card";
import { useCreateDialog } from "../components/create-dialog-context";

function MyEventsEmpty() {
  const { openCreate } = useCreateDialog();
  return (
    <Empty
      title="No events yet."
      sub="Create your first event."
      actionLabel="Create an event"
      onAction={openCreate}
    />
  );
}

export default function MyEventsPage() {
  const { state, connect } = useWallet();
  const auth = useAuth();
  const connected = state.status === "connected";
  const authed = auth.status === "ready";
  const [events, setEvents] = useState<EventListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (state.status !== "connected" || auth.status !== "ready") {
      setLoading(false);
      setEvents([]);
      return;
    }
    const organizer = state.accounts[0];
    let cancelled = false;
    async function load() {
      setOffline(false);
      setLoading(true);
      try {
        const list = await fetchEventsList(organizer);
        if (!cancelled) setEvents(list);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ServerError) {
          setOffline(true);
        } else {
          setEvents([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [state.status, auth.status, state.status === "connected" ? state.accounts[0] : undefined, retryKey]);

  return (
    <div>
      {!connected ? (
        <Empty
          title="Events you created live here."
          sub="Connect your wallet to see them."
          actionLabel="Connect wallet"
          onAction={connect}
        />
      ) : !authed ? (
        <div className="checkin-status" role="status">
          <div className="spinner spinner-sm" />
          <span>Signing you in…</span>
        </div>
      ) : offline ? (
        <OfflineEmpty onRetry={() => setRetryKey((k) => k + 1)} />
      ) : loading ? (
        <div className="event-list">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton skeleton-row" aria-hidden="true" />
          ))}
        </div>
      ) : events.length > 0 ? (
        <div className="event-list">
          {events.map((event) => (
            <EventCard key={event.covenant_id} event={event} />
          ))}
        </div>
      ) : (
        <MyEventsEmpty />
      )}
    </div>
  );
}
