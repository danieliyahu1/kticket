import { useEffect, useState } from "react";
import { fetchEventsList, ServerError, type EventListItem } from "../api/client";
import { Empty, OfflineEmpty } from "../components/empty";
import { EventCard } from "../components/event-card";
import { useCreateDialog } from "../components/create-dialog-context";

function BrowseEmpty() {
  const { openCreate } = useCreateDialog();
  return (
    <Empty
      title="No events yet."
      sub="Be the first to create one."
      actionLabel="Create an event"
      onAction={openCreate}
    />
  );
}

export default function EventsPage() {
  const [events, setEvents] = useState<EventListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setOffline(false);
      setLoading(true);
      try {
        const list = await fetchEventsList();
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
  }, [retryKey]);

  return (
    <div>
      {loading ? (
        <div className="event-list">
          <p className="note" role="status">
            Loading events…
          </p>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton skeleton-row" aria-hidden="true" />
          ))}
        </div>
      ) : offline ? (
        <OfflineEmpty onRetry={() => setRetryKey((k) => k + 1)} />
      ) : events.length > 0 ? (
        <div className="event-list">
          {events.map((event) => (
            <EventCard key={event.covenant_id} event={event} />
          ))}
        </div>
      ) : (
        <BrowseEmpty />
      )}
    </div>
  );
}
